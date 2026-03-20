/**
 * Foreman evaluation environment.
 *
 * Standardized pipeline for evaluating any Foreman artifact:
 *   1. Load versioned artifacts from VersionedStore
 *   2. Run the harness with those artifacts
 *   3. Collect SessionMetrics + tool calls + task completion
 *   4. Judge the output (deterministic + LLM)
 *   5. Write TraceBundle with artifact version attribution
 *   6. Score the artifact versions
 *   7. Feed the optimizer
 *
 * Every evaluatable thing flows through this: CLAUDE.md templates,
 * judge directives, repair recipes, heartbeat configs, system prompts.
 *
 * Concrete environments implement:
 *   - loadTasks()     — what to evaluate
 *   - run()           — execute one task
 *   - score()         — compute reward signals
 *
 * The base handles: artifact versioning, trace writing, metrics,
 * judge dispatch, and optimizer feeding.
 */

import { VersionedStore, type ArtifactVersion } from '@drew/foreman-core'
import { FilesystemTraceStore, type TraceBundle, type RewardSignal, type TraceStore } from '@drew/foreman-tracing'
/** Canonical definition — also defined in surfaces/session-metrics.ts. Keep in sync. */
export type TaskCompletion = 'completed' | 'partial' | 'failed' | 'abandoned' | 'unknown'

export interface EvalSessionMetrics {
  sessionId: string
  harness: string
  repo: string
  goal: string
  timestamp: string
  exitCode: number
  success: boolean
  durationMs: number
  costUsd?: number
  numTurns?: number
  totalToolCalls?: number
  totalToolErrors?: number
}
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

// ─── Types ──────────────────────────────────────────────────────────

export interface EvalTask {
  id: string
  goal: string
  repo?: string
  branch?: string
  environmentKind?: string
  expectedOutcome?: string
  metadata?: Record<string, string>
}

export interface EvalRunResult {
  task: EvalTask
  metrics: EvalSessionMetrics
  resultText: string
  artifacts: Record<string, { kind: string; name: string; versionId: string }>
  metadata?: Record<string, unknown>
}

export interface EvalScoreResult {
  rewards: RewardSignal[]
  taskCompletion: TaskCompletion
  summary: string
}

export interface EvalReport {
  envName: string
  timestamp: string
  tasks: number
  completed: number
  averageScore: number
  results: Array<{
    taskId: string
    goal: string
    completion: TaskCompletion
    score: number
    rewards: RewardSignal[]
    artifactVersions: Record<string, string>
    durationMs: number
    costUsd?: number
  }>
}

// ─── Base environment ───────────────────────────────────────────────

export abstract class ForemanEvalEnv {
  abstract readonly name: string

  protected store: VersionedStore
  protected traceStore: TraceStore

  constructor(options?: { artifactRoot?: string; traceRoot?: string }) {
    this.store = new VersionedStore(options?.artifactRoot)
    this.traceStore = new FilesystemTraceStore(
      options?.traceRoot ?? join(FOREMAN_HOME, 'traces', 'evals'),
    )
  }

  /**
   * Load tasks to evaluate.
   */
  abstract loadTasks(): Promise<EvalTask[]>

  /**
   * Run a single task. Returns metrics + result text.
   * Implementations spawn harness sessions, run checks, etc.
   */
  abstract run(task: EvalTask, artifacts: Record<string, { kind: string; name: string; versionId: string; content: string }>): Promise<EvalRunResult>

  /**
   * Score a run result. Returns reward signals.
   * Implementations use deterministic checks, LLM judges, or both.
   */
  abstract score(result: EvalRunResult): Promise<EvalScoreResult>

  /**
   * Which artifact versions to use for this eval run.
   * Default: use active version of each artifact kind/name.
   * Override to test specific versions or candidates.
   */
  async resolveArtifacts(): Promise<Record<string, { kind: string; name: string; versionId: string; content: string }>> {
    return {}
  }

  /**
   * Run the full eval pipeline.
   */
  async evaluate(options?: {
    maxTasks?: number
    dryRun?: boolean
    onProgress?: (msg: string) => void
  }): Promise<EvalReport> {
    const log = options?.onProgress ?? (() => {})
    const maxTasks = options?.maxTasks ?? Infinity

    log(`[${this.name}] Loading tasks...`)
    const allTasks = await this.loadTasks()
    const tasks = allTasks.slice(0, maxTasks)
    log(`[${this.name}] ${tasks.length} tasks (of ${allTasks.length})`)

    log(`[${this.name}] Resolving artifacts...`)
    const artifacts = await this.resolveArtifacts()
    const artifactVersionMap: Record<string, string> = {}
    for (const [key, art] of Object.entries(artifacts)) {
      artifactVersionMap[`${art.kind}/${art.name}PromptVariantId`] = art.versionId
      log(`  ${key}: ${art.kind}/${art.name} @ ${art.versionId}`)
    }

    const results: EvalReport['results'] = []

    for (const task of tasks) {
      log(`[${this.name}] Running: ${task.id} — ${task.goal.slice(0, 80)}`)

      let runResult: EvalRunResult
      try {
        if (options?.dryRun) {
          log(`  [dry-run] Would run task ${task.id}`)
          continue
        }
        runResult = await this.run(task, artifacts)
      } catch (e) {
        log(`  [error] ${e}`)
        continue
      }

      log(`  Exit: ${runResult.metrics.exitCode}, Duration: ${(runResult.metrics.durationMs / 1000).toFixed(1)}s`)

      // Score
      let scoreResult: EvalScoreResult
      try {
        scoreResult = await this.score(runResult)
      } catch (e) {
        log(`  [score error] ${e}`)
        scoreResult = {
          rewards: [{ name: 'error', value: 0, source: 'derived' }],
          taskCompletion: 'failed',
          summary: `Scoring failed: ${e}`,
        }
      }

      const aggregateScore = scoreResult.rewards.length > 0
        ? scoreResult.rewards.reduce((s, r) => s + r.value, 0) / scoreResult.rewards.length
        : 0

      log(`  Score: ${aggregateScore.toFixed(3)} (${scoreResult.taskCompletion}) — ${scoreResult.summary}`)

      // Write TraceBundle — this is what the optimizer reads
      const trace: TraceBundle = {
        task: {
          id: task.id,
          goal: task.goal,
          environmentKind: task.environmentKind ?? 'eval',
        },
        events: [
          { at: runResult.metrics.timestamp, kind: 'run', summary: `Harness: ${runResult.metrics.harness}` },
          { at: new Date().toISOString(), kind: 'score', summary: scoreResult.summary },
        ],
        evidence: scoreResult.rewards.map((r) => ({
          kind: 'reward' as const,
          label: r.name,
          value: String(r.value),
          metadata: r.metadata,
        })),
        outcome: {
          status: scoreResult.taskCompletion === 'completed' ? 'completed' : 'failed',
          summary: scoreResult.summary,
          validated: scoreResult.taskCompletion === 'completed',
        },
        metadata: {
          evalEnv: this.name,
          strategy: task.metadata?.strategy ?? 'default',
          taskShape: task.environmentKind ?? 'eval',
          durationMs: String(runResult.metrics.durationMs),
          costUsd: runResult.metrics.costUsd !== undefined ? String(runResult.metrics.costUsd) : '',
          checkPassRate: scoreResult.taskCompletion === 'completed' ? '1' : '0',
          // Artifact version attribution — this is how the optimizer knows
          // which versions produced this result
          ...artifactVersionMap,
          // Session metrics
          numTurns: String(runResult.metrics.numTurns ?? 0),
          totalToolCalls: String(runResult.metrics.totalToolCalls ?? 0),
          totalToolErrors: String(runResult.metrics.totalToolErrors ?? 0),
          harness: runResult.metrics.harness,
          repo: runResult.metrics.repo,
        },
      }

      const traceId = await this.traceStore.put(trace)
      log(`  Trace: ${traceId}`)

      // Score artifact versions in the VersionedStore
      for (const [, art] of Object.entries(artifacts)) {
        try {
          await this.store.score(art.kind, art.name, art.versionId, {
            judgeId: `${this.name}-eval`,
            score: aggregateScore,
            maxScore: 1,
          })
        } catch { /* version may not exist */ }
      }

      results.push({
        taskId: task.id,
        goal: task.goal,
        completion: scoreResult.taskCompletion,
        score: aggregateScore,
        rewards: scoreResult.rewards,
        artifactVersions: Object.fromEntries(
          Object.entries(artifacts).map(([k, v]) => [k, v.versionId]),
        ),
        durationMs: runResult.metrics.durationMs,
        costUsd: runResult.metrics.costUsd,
      })
    }

    const completed = results.filter((r) => r.completion === 'completed').length
    const avgScore = results.length > 0
      ? results.reduce((s, r) => s + r.score, 0) / results.length
      : 0

    const report: EvalReport = {
      envName: this.name,
      timestamp: new Date().toISOString(),
      tasks: results.length,
      completed,
      averageScore: avgScore,
      results,
    }

    // Persist report
    try {
      const reportDir = join(FOREMAN_HOME, 'traces', 'eval-reports')
      await mkdir(reportDir, { recursive: true })
      await writeFile(
        join(reportDir, `${this.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
        JSON.stringify(report, null, 2) + '\n',
        'utf8',
      )
    } catch { /* best effort */ }

    log(`\n[${this.name}] Complete: ${completed}/${results.length} tasks (avg score ${avgScore.toFixed(3)})`)

    return report
  }

  /**
   * After eval, attempt auto-promotion of artifact versions.
   */
  async autoPromote(options?: { minScores?: number; minImprovement?: number }): Promise<string[]> {
    const promoted: string[] = []
    const kinds = await this.store.listKinds()
    for (const kind of kinds) {
      const names = await this.store.listNames(kind)
      for (const name of names) {
        const result = await this.store.autoPromote(kind, name, options)
        if (result) {
          promoted.push(`${kind}/${name}: promoted ${result.id} (avg ${result.averageScore?.toFixed(3)})`)
        }
      }
    }
    return promoted
  }
}

// ─── Reward signal helpers ──────────────────────────────────────────

export function rewardFromMetrics(metrics: EvalSessionMetrics): RewardSignal[] {
  const rewards: RewardSignal[] = []

  // Completion
  rewards.push({
    name: 'completed',
    value: metrics.success ? 1 : 0,
    source: 'deterministic',
  })

  // Efficiency: fewer turns is better (normalized to 0-1)
  if (metrics.numTurns !== undefined) {
    rewards.push({
      name: 'turn_efficiency',
      value: Math.max(0, 1 - (metrics.numTurns / 30)),
      source: 'derived',
      metadata: { numTurns: String(metrics.numTurns) },
    })
  }

  // Cost efficiency (normalized: $0 = 1.0, $1+ = 0)
  if (metrics.costUsd !== undefined) {
    rewards.push({
      name: 'cost_efficiency',
      value: Math.max(0, 1 - metrics.costUsd),
      source: 'derived',
      metadata: { costUsd: String(metrics.costUsd) },
    })
  }

  // Tool error rate
  if (metrics.totalToolCalls !== undefined && metrics.totalToolCalls > 0) {
    const errorRate = (metrics.totalToolErrors ?? 0) / metrics.totalToolCalls
    rewards.push({
      name: 'tool_reliability',
      value: 1 - errorRate,
      source: 'derived',
      metadata: {
        totalCalls: String(metrics.totalToolCalls),
        totalErrors: String(metrics.totalToolErrors ?? 0),
      },
    })
  }

  // Latency (normalized: <60s = 1.0, >30min = 0)
  rewards.push({
    name: 'latency',
    value: Math.max(0, 1 - metrics.durationMs / (30 * 60 * 1000)),
    source: 'derived',
    metadata: { durationMs: String(metrics.durationMs) },
  })

  return rewards
}

export function rewardFromJudge(judgment: { overallScore: number; maxScore: number; judgeId: string }): RewardSignal {
  return {
    name: 'judge',
    value: judgment.maxScore > 0 ? judgment.overallScore / judgment.maxScore : 0,
    source: 'judge',
    metadata: {
      judgeId: judgment.judgeId,
      rawScore: String(judgment.overallScore),
      maxScore: String(judgment.maxScore),
    },
  }
}
