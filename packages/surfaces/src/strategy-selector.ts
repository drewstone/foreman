/**
 * Strategy selector.
 *
 * Given a task, picks the best orchestration strategy based on:
 *   1. Scored traces from previous runs (benchmark + real-world)
 *   2. Task shape matching (cargo, npm, terminal, ci-repair, etc.)
 *   3. Memory: repair recipes, environment facts, operator preferences
 *
 * If no data exists for a task shape, falls back to the default strategy
 * and learns from the result.
 *
 * This is the runtime decision-maker. The benchmark populates the data.
 * This reads it and picks.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { FilesystemTraceStore, type TraceBundle } from '@drew/foreman-tracing'
import { FilesystemMemoryStore, type StrategyMemory } from '@drew/foreman-memory'
import type { OrchestrationStrategy } from './benchmark-env.js'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export interface TaskContext {
  repo: string
  repoType?: 'cargo' | 'npm' | 'pnpm' | 'python' | 'go' | 'unknown'
  taskShape: string
  goal: string
  isCI?: boolean
  isFix?: boolean
  isGreenfield?: boolean
}

export interface StrategyScore {
  strategy: string
  taskShape: string
  runs: number
  avgScore: number
  avgCost: number
  avgDuration: number
  completionRate: number
}

export interface StrategySelection {
  strategy: OrchestrationStrategy
  reason: string
  confidence: number
  scores?: StrategyScore
}

const DEFAULT_STRATEGIES: OrchestrationStrategy[] = [
  {
    name: 'single-claude',
    steps: [{ harness: 'claude', role: 'implement', goal: '' }],
  },
  {
    name: 'single-codex',
    steps: [{ harness: 'codex', role: 'implement', goal: '' }],
  },
  {
    name: 'claude-implement-review-fix',
    steps: [
      { harness: 'claude', role: 'implement', goal: '' },
      { harness: 'claude', role: 'review', goal: '', claudeMdTemplate: 'You are a skeptical reviewer. Find real bugs, not style nits.' },
      { harness: 'claude', role: 'fix', goal: '' },
    ],
  },
  {
    name: 'claude-implement-codex-review',
    steps: [
      { harness: 'claude', role: 'implement', goal: '' },
      { harness: 'codex', role: 'review', goal: '' },
    ],
  },
]

export class StrategySelector {
  private traceStore: FilesystemTraceStore
  private memoryStore: FilesystemMemoryStore
  private strategies: OrchestrationStrategy[]

  constructor(options?: {
    traceRoot?: string
    memoryRoot?: string
    strategies?: OrchestrationStrategy[]
  }) {
    this.traceStore = new FilesystemTraceStore(
      options?.traceRoot ?? join(FOREMAN_HOME, 'traces', 'evals'),
    )
    this.memoryStore = new FilesystemMemoryStore(
      options?.memoryRoot ?? join(FOREMAN_HOME, 'memory'),
    )
    this.strategies = options?.strategies ?? DEFAULT_STRATEGIES
  }

  /**
   * Pick the best strategy for a task based on historical data.
   */
  async select(context: TaskContext): Promise<StrategySelection> {
    // Score all strategies from trace history
    const scores = await this.scoreStrategies(context.taskShape)

    // Find matching strategies with enough data
    const candidates = scores.filter((s) => s.runs >= 2)

    if (candidates.length > 0) {
      // Pick the best by composite score (completion rate * avg score, penalize cost)
      candidates.sort((a, b) => {
        const scoreA = a.completionRate * a.avgScore * (1 - Math.min(a.avgCost, 1) * 0.1)
        const scoreB = b.completionRate * b.avgScore * (1 - Math.min(b.avgCost, 1) * 0.1)
        return scoreB - scoreA
      })

      const best = candidates[0]
      const strategy = this.strategies.find((s) => s.name === best.strategy) ?? this.strategies[0]

      return {
        strategy,
        reason: `Best for ${context.taskShape}: ${best.avgScore.toFixed(2)} avg score, ${(best.completionRate * 100).toFixed(0)}% completion across ${best.runs} runs`,
        confidence: Math.min(best.runs / 10, 1),
        scores: best,
      }
    }

    // Heuristic fallback based on task shape
    if (context.isCI) {
      // CI fixes benefit from review
      const s = this.strategies.find((s) => s.name === 'claude-implement-review-fix') ?? this.strategies[0]
      return {
        strategy: s,
        reason: 'CI fix: using implement-review-fix loop (heuristic)',
        confidence: 0.3,
      }
    }

    if (context.isGreenfield) {
      // Greenfield: single agent is fine
      return {
        strategy: this.strategies[0],
        reason: 'Greenfield task: single agent (heuristic)',
        confidence: 0.3,
      }
    }

    // Default: single claude
    return {
      strategy: this.strategies[0],
      reason: 'No historical data — using default strategy',
      confidence: 0.1,
    }
  }

  /**
   * Score all strategies from trace history for a given task shape.
   */
  async scoreStrategies(taskShape: string, maxTraces = 200): Promise<StrategyScore[]> {
    const allRefs = await this.traceStore.list()
    const refs = allRefs.slice(-maxTraces)
    const strategyData = new Map<string, {
      runs: number
      totalScore: number
      totalCost: number
      totalDuration: number
      completions: number
    }>()

    for (const ref of refs) {
      const bundle = await this.traceStore.get(ref.traceId)
      if (!bundle) continue
      if (bundle.metadata?.taskShape !== taskShape && taskShape !== '*') continue

      const strategy = bundle.metadata?.strategy ?? 'default'
      const strategyName = bundle.metadata?.evalEnv
        ? `${bundle.metadata.evalEnv}:${strategy}`
        : strategy

      const existing = strategyData.get(strategyName) ?? {
        runs: 0, totalScore: 0, totalCost: 0, totalDuration: 0, completions: 0,
      }

      existing.runs++
      const rewards = bundle.evidence.filter((e) => e.kind === 'reward')
      const avgReward = rewards.length > 0
        ? rewards.reduce((s, r) => s + parseFloat(r.value || '0'), 0) / rewards.length
        : 0
      existing.totalScore += avgReward
      existing.totalCost += parseFloat(bundle.metadata?.costUsd ?? '0')
      existing.totalDuration += parseFloat(bundle.metadata?.durationMs ?? '0')
      if (bundle.outcome?.validated) existing.completions++

      strategyData.set(strategyName, existing)
    }

    return [...strategyData.entries()].map(([strategy, data]) => ({
      strategy,
      taskShape,
      runs: data.runs,
      avgScore: data.runs > 0 ? data.totalScore / data.runs : 0,
      avgCost: data.runs > 0 ? data.totalCost / data.runs : 0,
      avgDuration: data.runs > 0 ? data.totalDuration / data.runs : 0,
      completionRate: data.runs > 0 ? data.completions / data.runs : 0,
    })).sort((a, b) => b.avgScore - a.avgScore)
  }

  /**
   * Detect task context from a repo path and goal.
   */
  static async detectContext(repoPath: string, goal: string): Promise<TaskContext> {
    const repo = repoPath.split('/').pop() ?? ''
    let repoType: TaskContext['repoType'] = 'unknown'

    try {
      const { readFile } = await import('node:fs/promises')
      try { await readFile(join(repoPath, 'Cargo.toml'), 'utf8'); repoType = 'cargo' } catch {}
      if (repoType === 'unknown') {
        try {
          const pkg = JSON.parse(await readFile(join(repoPath, 'package.json'), 'utf8'))
          repoType = pkg.scripts?.build?.includes('pnpm') ? 'pnpm' : 'npm'
        } catch {}
      }
      if (repoType === 'unknown') {
        try { await readFile(join(repoPath, 'go.mod'), 'utf8'); repoType = 'go' } catch {}
      }
      if (repoType === 'unknown') {
        try { await readFile(join(repoPath, 'pyproject.toml'), 'utf8'); repoType = 'python' } catch {}
      }
    } catch {}

    const lower = goal.toLowerCase()
    const isCI = lower.includes('ci') || lower.includes('failing') || lower.includes('fix the build')
    const isFix = lower.includes('fix') || lower.includes('repair') || lower.includes('bug')
    const isGreenfield = lower.includes('create') || lower.includes('scaffold') || lower.includes('new project')

    return {
      repo,
      repoType,
      taskShape: isCI ? 'ci-repair' : isFix ? 'fix' : isGreenfield ? 'greenfield' : repoType,
      goal,
      isCI,
      isFix,
      isGreenfield,
    }
  }
}
