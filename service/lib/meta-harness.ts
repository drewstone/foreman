/**
 * Meta-Harness Evolution Loop
 *
 * The outer loop that coordinates code-level optimization:
 *   1. Seed baseline (eval the current harness)
 *   2. For each iteration:
 *      a. Spawn N parallel CC proposers (each reads frontier + traces)
 *      b. Validate proposals (tsc/cargo check)
 *      c. Benchmark valid proposals (run eval suite)
 *      d. Update Pareto frontier
 *      e. Record evolution entries
 *   3. Return frontier with all non-dominated variants
 *
 * Integrates: CodeSurface, ParallelDispatch, TraceInjector, Hypothesis
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CodeSurface, type CodeSurfaceConfig, type EvolutionEntry } from '../../packages/optimizer/src/code-surface.js'
import { parseHypothesis, validateHypothesis, type Hypothesis } from '../../packages/optimizer/src/hypothesis.js'
import { frontierSummary, type ParetoFrontier } from '../../packages/optimizer/src/pareto.js'
import { injectTraces, type TraceInjectionSource } from './trace-injector.js'
import {
  createWorktrees,
  cleanupWorktrees,
  injectStateIntoWorktree,
  runParallelProposers,
} from './parallel-dispatch.js'

export interface MetaHarnessConfig {
  /** CodeSurface configuration */
  surface: CodeSurfaceConfig
  /** Path to the repo being evolved */
  repoPath: string
  /** Path to SKILL.md for the proposer */
  skillPath: string
  /** Number of parallel proposers per iteration */
  parallelism: number
  /** Max iterations */
  maxIterations: number
  /** Model for the proposer (default: opus) */
  proposerModel?: string
  /** Timeout per proposer session in ms (default: 5 min) */
  proposerTimeoutMs?: number
  /** Callback to run the eval suite and return traces */
  runBenchmark: (variantPath: string, cwd: string) => Promise<{
    scores: Record<string, number>
    traces: TraceInjectionSource[]
    passed: boolean
  }>
}

export interface MetaHarnessResult {
  frontier: ParetoFrontier<string>
  iterations: number
  totalProposed: number
  totalValidated: number
  totalFrontier: number
  evolutionLog: EvolutionEntry[]
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[meta-harness ${ts}] ${msg}`)
}

/**
 * Run the full meta-harness evolution loop.
 */
export async function runMetaHarness(config: MetaHarnessConfig): Promise<MetaHarnessResult> {
  const surface = new CodeSurface(config.surface)
  const evolutionLog: EvolutionEntry[] = []
  let totalProposed = 0
  let totalValidated = 0
  let totalFrontier = 0

  // Phase 0: Baseline
  log('Phase 0: evaluating baseline...')
  const baselineResult = await config.runBenchmark(
    config.surface.harnessPath,
    config.surface.cwd,
  )
  surface.seedBaseline(baselineResult.scores)
  injectTraces(config.surface.tracesDir, baselineResult.traces)
  log(`baseline scores: ${JSON.stringify(baselineResult.scores)}`)
  log(frontierSummary(surface.getFrontier()))

  // Phase 1..N: Iterate
  for (let iter = 1; iter <= config.maxIterations; iter++) {
    log(`\n--- Iteration ${iter}/${config.maxIterations} ---`)

    // Create worktrees
    const worktrees = createWorktrees(config.repoPath, config.parallelism, `iter-${iter}`)

    // Inject shared state into each worktree
    const metaDir = join(config.surface.cwd, '.meta-harness')
    for (const wt of worktrees) {
      injectStateIntoWorktree(wt, metaDir)
    }

    // Run parallel proposers
    log(`spawning ${config.parallelism} parallel proposers (${config.proposerModel ?? 'opus'})...`)
    const proposals = await runParallelProposers({
      worktrees,
      skillPath: config.skillPath,
      model: config.proposerModel ?? 'opus',
      timeoutMs: config.proposerTimeoutMs ?? 300_000,
    })

    // Process each proposal
    for (const proposal of proposals) {
      totalProposed++

      if (!proposal.pendingEvalPath) {
        log(`  proposer at ${proposal.worktreePath}: no pending_eval.json produced`)
        continue
      }

      // Parse hypothesis
      const raw = readFileSync(proposal.pendingEvalPath, 'utf8')
      const hypothesis = parseHypothesis(raw, iter)
      if (!hypothesis) {
        log(`  proposer at ${proposal.worktreePath}: failed to parse hypothesis`)
        continue
      }

      // Validate hypothesis discipline
      const validation = validateHypothesis(hypothesis)
      if (!validation.valid) {
        log(`  ${hypothesis.name}: REJECTED — ${validation.rejectionReason}`)
        evolutionLog.push({
          iteration: iter,
          hypothesis,
          scores: null,
          delta: null,
          outcome: 'failed_validation',
          timestamp: new Date().toISOString(),
        })
        surface.recordEvolution(evolutionLog[evolutionLog.length - 1]!)
        continue
      }

      // Read the proposed variant code
      const variantCode = readVariantFromWorktree(proposal.worktreePath, hypothesis, config.surface.harnessPath)
      if (!variantCode) {
        log(`  ${hypothesis.name}: no variant code found at ${hypothesis.filePath}`)
        continue
      }

      // Compile-check
      log(`  ${hypothesis.name}: validating...`)
      const compileOk = validateVariant(config.surface.validateCommand, proposal.worktreePath)
      if (!compileOk) {
        log(`  ${hypothesis.name}: FAILED validation (compile error)`)
        evolutionLog.push({
          iteration: iter,
          hypothesis,
          scores: null,
          delta: null,
          outcome: 'failed_validation',
          timestamp: new Date().toISOString(),
        })
        surface.recordEvolution(evolutionLog[evolutionLog.length - 1]!)
        continue
      }
      totalValidated++

      // Write variant to shared variants dir
      surface.writeVariant(hypothesis.name, variantCode)

      // Benchmark
      log(`  ${hypothesis.name}: benchmarking...`)
      try {
        const benchResult = await config.runBenchmark(
          join(config.surface.variantsDir, `${hypothesis.name}.${config.surface.harnessPath.split('.').pop()}`),
          config.surface.cwd,
        )

        // Inject traces for this variant (CC reads them in next iteration)
        injectTraces(config.surface.tracesDir, benchResult.traces)

        // Compute delta against best-so-far
        const frontier = surface.getFrontier()
        const bestScores = frontier.entries.length > 0
          ? frontier.entries.reduce((acc, e) => {
              for (const [k, v] of Object.entries(e.scores)) {
                acc[k] = Math.max(acc[k] ?? 0, v)
              }
              return acc
            }, {} as Record<string, number>)
          : {}

        const delta: Record<string, number> = {}
        for (const [k, v] of Object.entries(benchResult.scores)) {
          delta[k] = v - (bestScores[k] ?? 0)
        }

        // Try to add to frontier
        const onFrontier = surface.addToFrontier(hypothesis, variantCode, benchResult.scores)
        if (onFrontier) totalFrontier++

        const outcome = onFrontier ? 'frontier' as const : 'dominated' as const
        log(`  ${hypothesis.name}: ${outcome} — scores=${JSON.stringify(benchResult.scores)} delta=${JSON.stringify(delta)}`)

        evolutionLog.push({
          iteration: iter,
          hypothesis,
          scores: benchResult.scores,
          delta,
          outcome,
          timestamp: new Date().toISOString(),
        })
        surface.recordEvolution(evolutionLog[evolutionLog.length - 1]!)
      } catch (e) {
        log(`  ${hypothesis.name}: FAILED benchmark — ${e instanceof Error ? e.message : String(e)}`)
        evolutionLog.push({
          iteration: iter,
          hypothesis,
          scores: null,
          delta: null,
          outcome: 'failed_benchmark',
          timestamp: new Date().toISOString(),
        })
        surface.recordEvolution(evolutionLog[evolutionLog.length - 1]!)
      }
    }

    // Cleanup worktrees
    cleanupWorktrees(config.repoPath, worktrees)
    log(frontierSummary(surface.getFrontier()))
  }

  return {
    frontier: surface.getFrontier(),
    iterations: config.maxIterations,
    totalProposed,
    totalValidated,
    totalFrontier,
    evolutionLog,
  }
}

function readVariantFromWorktree(
  worktreePath: string,
  hypothesis: Hypothesis,
  harnessPath: string,
): string | null {
  // Try the file path from hypothesis first
  if (hypothesis.filePath) {
    const fullPath = join(worktreePath, hypothesis.filePath)
    if (existsSync(fullPath)) return readFileSync(fullPath, 'utf8')
  }
  // Try variants dir
  const ext = harnessPath.split('.').pop() ?? 'ts'
  const variantPath = join(worktreePath, '.meta-harness', 'variants', `${hypothesis.name}.${ext}`)
  if (existsSync(variantPath)) return readFileSync(variantPath, 'utf8')
  return null
}

function validateVariant(command: string, cwd: string): boolean {
  try {
    execSync(command, { cwd, timeout: 60_000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
