/**
 * Parallel worktree experiment runner.
 *
 * Runs N experiments in parallel, each in its own git worktree with its own
 * claude session. Scores all results, promotes the best, cleans up the rest.
 *
 * Usage:
 *   import { runExperiments } from './worktree-experiment.js'
 *   const result = await runExperiments({
 *     repoPath: '/path/to/repo',
 *     experiments: [
 *       { name: 'approach-a', goal: 'Implement X using pattern A' },
 *       { name: 'approach-b', goal: 'Implement X using pattern B' },
 *     ],
 *     scorer: async (worktreePath) => ({ score: 7.5, reasons: ['clean'] }),
 *   })
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface Experiment {
  name: string
  goal: string
  systemPrompt?: string
  harness?: 'claude' | 'codex'
  timeoutMs?: number
}

export interface ExperimentScore {
  score: number
  reasons: string[]
}

export interface ExperimentResult {
  experiment: Experiment
  worktreePath: string
  branch: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  score?: ExperimentScore
}

export interface ExperimentRunResult {
  results: ExperimentResult[]
  winner: ExperimentResult | null
  promoted: boolean
}

export type Scorer = (worktreePath: string, experiment: Experiment) => Promise<ExperimentScore>

export interface RunExperimentsOptions {
  repoPath: string
  experiments: Experiment[]
  scorer: Scorer
  baseRef?: string
  maxParallel?: number
  cleanupOnDone?: boolean
  onProgress?: (msg: string) => void
}

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 })
}

async function createWorktree(repoPath: string, name: string, baseRef: string): Promise<{ path: string; branch: string }> {
  const branch = `exp/${name}-${Date.now()}`
  const worktreePath = join(tmpdir(), `foreman-exp-${name}-${Date.now()}`)
  await mkdir(worktreePath, { recursive: true })
  await git(repoPath, 'worktree', 'add', worktreePath, '-b', branch, baseRef)
  return { path: worktreePath, branch }
}

async function removeWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
  try { await git(repoPath, 'worktree', 'remove', worktreePath, '--force') } catch { /* best effort */ }
  try { await git(repoPath, 'branch', '-D', branch) } catch { /* best effort */ }
  try { await rm(worktreePath, { recursive: true, force: true }) } catch { /* best effort */ }
}

async function runSingleExperiment(experiment: Experiment, worktreePath: string): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const harness = experiment.harness ?? 'claude'
  const timeoutMs = experiment.timeoutMs ?? 15 * 60 * 1000

  const start = Date.now()
  let stdout = ''
  let stderr = ''
  let exitCode = 0

  try {
    if (harness === 'codex') {
      const result = await execFileAsync('codex', ['exec', '--full-auto', '-C', worktreePath, experiment.goal], {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      })
      stdout = result.stdout
      stderr = result.stderr
    } else {
      const args = ['--dangerously-skip-permissions', '-p', '--output-format', 'json']
      if (experiment.systemPrompt) {
        args.push('--append-system-prompt', experiment.systemPrompt)
      }
      args.push(experiment.goal)

      const result = await execFileAsync('claude', args, {
        cwd: worktreePath,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      })
      stdout = result.stdout
      stderr = result.stderr
    }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number }
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? String(e)
    exitCode = typeof err.code === 'number' ? err.code : 1
  }

  return { exitCode, stdout, stderr, durationMs: Date.now() - start }
}

export async function runExperiments(options: RunExperimentsOptions): Promise<ExperimentRunResult> {
  const {
    repoPath,
    experiments,
    scorer,
    baseRef = 'HEAD',
    maxParallel = experiments.length,
    cleanupOnDone = true,
    onProgress,
  } = options

  const log = onProgress ?? (() => {})

  // Create worktrees
  log(`Creating ${experiments.length} worktrees...`)
  const worktrees: Array<{ experiment: Experiment; path: string; branch: string }> = []
  for (const exp of experiments) {
    const wt = await createWorktree(repoPath, exp.name, baseRef)
    worktrees.push({ experiment: exp, ...wt })
    log(`  ${exp.name} → ${wt.path} (${wt.branch})`)
  }

  // Run experiments in parallel (respecting maxParallel)
  log(`Running ${worktrees.length} experiments (max parallel: ${maxParallel})...`)
  const results: ExperimentResult[] = []

  for (let i = 0; i < worktrees.length; i += maxParallel) {
    const batch = worktrees.slice(i, i + maxParallel)
    const batchResults = await Promise.all(
      batch.map(async (wt) => {
        log(`  [start] ${wt.experiment.name}`)
        const run = await runSingleExperiment(wt.experiment, wt.path)
        log(`  [done]  ${wt.experiment.name} — exit ${run.exitCode}, ${(run.durationMs / 1000).toFixed(1)}s`)
        return {
          experiment: wt.experiment,
          worktreePath: wt.path,
          branch: wt.branch,
          ...run,
        }
      }),
    )
    results.push(...batchResults)
  }

  // Score all successful experiments
  log('Scoring experiments...')
  for (const result of results) {
    if (result.exitCode === 0) {
      try {
        result.score = await scorer(result.worktreePath, result.experiment)
        log(`  ${result.experiment.name}: ${result.score.score}/10 — ${result.score.reasons.join(', ')}`)
      } catch (e) {
        log(`  ${result.experiment.name}: scoring failed — ${e}`)
      }
    } else {
      log(`  ${result.experiment.name}: skipped (exit ${result.exitCode})`)
    }
  }

  // Pick winner
  const scored = results.filter((r) => r.score)
  scored.sort((a, b) => (b.score?.score ?? 0) - (a.score?.score ?? 0))
  const winner = scored[0] ?? null

  let promoted = false
  if (winner) {
    log(`Winner: ${winner.experiment.name} (${winner.score!.score}/10)`)

    // Merge winner branch into current branch
    try {
      const { stdout: currentBranch } = await git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')
      await git(repoPath, 'merge', winner.branch, '--no-ff', '-m', `feat: promote experiment ${winner.experiment.name}`)
      promoted = true
      log(`Merged ${winner.branch} into ${currentBranch.trim()}`)
    } catch (e) {
      log(`Merge failed: ${e}`)
    }
  } else {
    log('No winner — all experiments failed or scored below threshold.')
  }

  // Cleanup
  if (cleanupOnDone) {
    log('Cleaning up worktrees...')
    for (const wt of worktrees) {
      if (promoted && wt.branch === winner?.branch) continue
      await removeWorktree(repoPath, wt.path, wt.branch)
    }
    // Clean up winner worktree too (branch already merged)
    if (winner && promoted) {
      await removeWorktree(repoPath, winner.worktreePath, winner.branch)
    }
  }

  return { results, winner, promoted }
}
