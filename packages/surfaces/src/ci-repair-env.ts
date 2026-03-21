/**
 * CI Repair evaluation environment.
 *
 * Tests whether Foreman can fix CI failures. Uses real repos with
 * known broken CI and verifies that the repair recipe + harness
 * session actually makes CI green.
 *
 * Task format:
 *   - repo path with a branch that has failing CI
 *   - the CI failure description
 *   - expected: CI should pass after repair
 *
 * Evaluation:
 *   1. Spawn harness session with repair recipe from VersionedStore
 *   2. Check if CI passes after the session
 *   3. Score based on: CI pass, code quality, turn efficiency, cost
 *
 * This directly addresses the "SKIP (no known recipe)" gap.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import {
  ForemanEvalEnv,
  rewardFromMetrics,
  rewardFromJudge,
  type EvalTask,
  type EvalRunResult,
  type EvalScoreResult,
  type EvalSessionMetrics,
} from '@drew/foreman-evals/eval-env'
import type { RewardSignal } from '@drew/foreman-tracing'

const execFileAsync = promisify(execFile)
const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export interface CIRepairTask extends EvalTask {
  repoPath: string
  branch: string
  prNumber?: number
  ciFailureDescription: string
  checkCommands: string[]
}

export class CIRepairEnv extends ForemanEvalEnv {
  readonly name = 'ci-repair'
  private tasks: CIRepairTask[] = []

  constructor(options?: { tasks?: CIRepairTask[]; artifactRoot?: string; traceRoot?: string }) {
    super(options)
    if (options?.tasks) this.tasks = options.tasks
  }

  async loadTasks(): Promise<EvalTask[]> {
    if (this.tasks.length > 0) return this.tasks

    // Auto-discover: find repos with failing CI from operator state
    try {
      const statePath = join(FOREMAN_HOME, 'operator-state.json')
      const state = JSON.parse(await readFile(statePath, 'utf8'))
      const sessions = (state.sessions ?? []) as Array<Record<string, unknown>>

      for (const s of sessions) {
        if (s.status !== 'blocked' || s.ciStatus !== 'fail') continue

        const repoPath = s.repoPath as string
        const branch = s.branch as string
        const repo = repoPath.split('/').pop() ?? ''

        // Try to get CI failure details
        let ciFailure = s.blockerReason as string ?? 'CI failing'
        try {
          const { stdout } = await execFileAsync('gh', ['run', 'list', '--branch', branch, '--status', 'failure', '--limit', '1', '--json', 'conclusion,name,headBranch'], {
            cwd: repoPath,
            timeout: 15_000,
          })
          const runs = JSON.parse(stdout)
          if (runs.length > 0) {
            ciFailure = `${runs[0].name}: ${runs[0].conclusion}`
          }
        } catch { /* gh not available or no runs */ }

        // Detect check commands from repo
        const checkCommands = await detectCheckCommands(repoPath)

        this.tasks.push({
          id: `ci-repair:${repo}:${branch}`,
          goal: `Fix CI failure on ${branch}: ${ciFailure}`,
          repo,
          branch,
          environmentKind: 'ci-repair',
          repoPath,
          prNumber: s.prNumber as number | undefined,
          ciFailureDescription: ciFailure,
          checkCommands,
        })
      }
    } catch { /* no operator state */ }

    return this.tasks
  }

  async resolveArtifacts() {
    const artifacts: Record<string, { kind: string; name: string; versionId: string; content: string }> = {}

    // Load the active repair strategy
    const strategy = await this.store.getActive('repair-strategy', 'ci-repair')
    if (strategy) {
      artifacts['repair-strategy'] = {
        kind: 'repair-strategy',
        name: 'ci-repair',
        versionId: strategy.version.id,
        content: strategy.content,
      }
    }

    // Load the active CLAUDE.md template for repair sessions
    const claudeMd = await this.store.getActive('claudemd-template', 'ci-repair')
    if (claudeMd) {
      artifacts['claudemd-template'] = {
        kind: 'claudemd-template',
        name: 'ci-repair',
        versionId: claudeMd.version.id,
        content: claudeMd.content,
      }
    }

    return artifacts
  }

  async run(task: EvalTask, artifacts: Record<string, { kind: string; name: string; versionId: string; content: string }>): Promise<EvalRunResult> {
    const ciTask = task as CIRepairTask

    // Build the repair prompt
    const repairStrategy = artifacts['repair-strategy']?.content ?? ''
    const claudeMdTemplate = artifacts['claudemd-template']?.content ?? ''

    const goal = [
      `CI is failing on branch ${ciTask.branch}.`,
      ciTask.prNumber ? `PR #${ciTask.prNumber}.` : '',
      `Failure: ${ciTask.ciFailureDescription}`,
      '',
      'Steps:',
      '1. Read the CI logs with `gh run list --branch ' + ciTask.branch + ' --status failure --limit 1` then `gh run view <id> --log-failed`',
      '2. Diagnose the root cause from the logs',
      '3. Fix the code',
      '4. Run checks locally to verify:',
      ...ciTask.checkCommands.map((c) => `   - ${c}`),
      '5. Commit and push the fix',
      '',
      repairStrategy ? `Repair strategy:\n${repairStrategy}` : '',
    ].filter(Boolean).join('\n')

    // Spawn the session
    const { spawnSession } = await import('./session-spawn.js')
    const { enrichMetrics } = await import('./session-metrics.js')

    const spawnResult = await spawnSession({
      repoPath: ciTask.repoPath,
      goal,
      claudeMd: claudeMdTemplate || undefined,
      provider: 'claude',
      timeoutMs: 10 * 60 * 1000,
    })

    let metrics = spawnResult.metrics ?? {
      sessionId: spawnResult.sessionId,
      harness: 'claude' as const,
      repo: ciTask.repo ?? '',
      goal,
      timestamp: new Date().toISOString(),
      exitCode: spawnResult.exitCode,
      success: spawnResult.exitCode === 0,
      durationMs: spawnResult.durationMs,
    }

    metrics = await enrichMetrics(metrics, spawnResult.stdout)

    return {
      task: ciTask,
      metrics,
      resultText: spawnResult.stdout,
      artifacts: Object.fromEntries(
        Object.entries(artifacts).map(([k, v]) => [k, { kind: v.kind, name: v.name, versionId: v.versionId }]),
      ),
    }
  }

  async score(result: EvalRunResult): Promise<EvalScoreResult> {
    const ciTask = result.task as CIRepairTask
    const rewards: RewardSignal[] = []

    // Base metrics rewards
    rewards.push(...rewardFromMetrics(result.metrics))

    // Run check commands to verify the fix
    let checksPass = 0
    let checksTotal = ciTask.checkCommands.length

    if (checksTotal === 0) checksTotal = 1 // avoid division by zero

    for (const cmd of ciTask.checkCommands) {
      try {
        await execFileAsync('bash', ['-c', cmd], {
          cwd: ciTask.repoPath,
          timeout: 120_000,
        })
        checksPass++
      } catch { /* check failed */ }
    }

    const checkPassRate = checksPass / checksTotal
    rewards.push({
      name: 'check_pass_rate',
      value: checkPassRate,
      source: 'deterministic',
      metadata: {
        passed: String(checksPass),
        total: String(checksTotal),
        commands: ciTask.checkCommands.join('; '),
      },
    })

    // Check if changes were committed
    let hasCommit = false
    try {
      const { stdout } = await execFileAsync('git', ['log', '--oneline', '-1', '--since=5 minutes ago'], {
        cwd: ciTask.repoPath,
        timeout: 10_000,
      })
      hasCommit = stdout.trim().length > 0
    } catch { /* ignore */ }

    rewards.push({
      name: 'committed',
      value: hasCommit ? 1 : 0,
      source: 'deterministic',
    })

    // Check if pushed
    let hasPush = false
    try {
      const { stdout } = await execFileAsync('git', ['log', '--oneline', `origin/${ciTask.branch}..HEAD`], {
        cwd: ciTask.repoPath,
        timeout: 10_000,
      })
      hasPush = stdout.trim().length === 0 // no diff = pushed
    } catch { /* ignore */ }

    rewards.push({
      name: 'pushed',
      value: hasPush ? 1 : 0,
      source: 'deterministic',
    })

    // Overall completion
    const allChecksPassed = checkPassRate === 1
    const completion = allChecksPassed && hasCommit ? 'completed' as const
      : checksPass > 0 ? 'partial' as const
      : 'failed' as const

    return {
      rewards,
      taskCompletion: completion,
      summary: `Checks: ${checksPass}/${ciTask.checkCommands.length}${hasCommit ? ', committed' : ''}${hasPush ? ', pushed' : ''}`,
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

async function detectCheckCommands(repoPath: string): Promise<string[]> {
  const checks: string[] = []
  try {
    const pkg = JSON.parse(await readFile(join(repoPath, 'package.json'), 'utf8'))
    const scripts = pkg.scripts ?? {}
    if (scripts.check) checks.push('npm run check')
    else {
      if (scripts['check:types'] || scripts.typecheck) checks.push(scripts['check:types'] ? 'npm run check:types' : 'npm run typecheck')
      if (scripts.lint) checks.push('npm run lint')
      if (scripts.test) checks.push('npm run test')
    }
    if (checks.length === 0 && scripts.build) checks.push('npm run build')
  } catch { /* no package.json */ }

  if (checks.length === 0) {
    try {
      await readFile(join(repoPath, 'Cargo.toml'), 'utf8')
      checks.push('cargo fmt --check', 'cargo clippy -- -D warnings', 'cargo test')
    } catch { /* no Cargo.toml */ }
  }

  return checks
}
