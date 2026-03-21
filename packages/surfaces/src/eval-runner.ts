/**
 * Unified eval runner.
 *
 * Discovers and runs all ForemanEvalEnv implementations, produces
 * combined reports, and optionally feeds the nightly optimizer.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ForemanEvalEnv, EvalReport } from '@drew/foreman-evals/eval-env'
import { TerminalTaskEnv, SWEBenchEnv, MultiHarnessEnv } from './benchmark-env.js'
import { CIRepairEnv } from './ci-repair-env.js'
import { ReportQualityEnv } from './report-quality-env.js'
import { getActiveProfile } from './user-profiles.js'
import { runNightlyOptimization } from './nightly-optimize.js'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

// ─── Registry ──────────────────────────────────────────────────────

export interface EnvEntry {
  name: string
  factory: (harness?: string) => ForemanEvalEnv
}

export const ENV_REGISTRY: EnvEntry[] = [
  { name: 'terminal-tasks', factory: (h) => new TerminalTaskEnv({ harness: h as 'claude' | 'codex' }) },
  { name: 'swe-bench', factory: () => new SWEBenchEnv() },
  { name: 'multi-harness', factory: () => new MultiHarnessEnv() },
  { name: 'ci-repair', factory: () => new CIRepairEnv() },
  { name: 'report-quality', factory: () => new ReportQualityEnv() },
]

export function listEnvNames(): string[] {
  return ENV_REGISTRY.map((e) => e.name)
}

// ─── Combined report ───────────────────────────────────────────────

export interface CombinedEvalReport {
  timestamp: string
  envReports: EvalReport[]
  totalTasks: number
  totalCompleted: number
  averageScore: number
  optimizerRan: boolean
}

// ─── Runner ────────────────────────────────────────────────────────

export async function runEvals(options?: {
  envNames?: string[]
  maxTasks?: number
  dryRun?: boolean
  optimize?: boolean
  onProgress?: (msg: string) => void
}): Promise<CombinedEvalReport> {
  const log = options?.onProgress ?? console.log

  // Load profile for config
  const profile = await getActiveProfile()
  const harness = profile?.preferredHarness ?? 'claude'
  const costBudget = profile?.costBudgetUsd ?? 10
  const shouldOptimize = options?.optimize ?? profile?.autoOptimize ?? false

  log(`Profile: ${profile?.name ?? 'default'} | Harness: ${harness} | Budget: $${costBudget}`)

  // Resolve envs
  const requestedNames = options?.envNames ?? listEnvNames()
  const entries = requestedNames.map((name) => {
    const entry = ENV_REGISTRY.find((e) => e.name === name)
    if (!entry) throw new Error(`Unknown eval env: ${name}. Available: ${listEnvNames().join(', ')}`)
    return entry
  })

  log(`\nRunning ${entries.length} eval env(s): ${entries.map((e) => e.name).join(', ')}`)
  if (options?.dryRun) log('[dry-run mode]')

  // Run sequentially
  const envReports: EvalReport[] = []
  for (const entry of entries) {
    log(`\n${'─'.repeat(60)}`)
    log(`ENV: ${entry.name}`)
    log('─'.repeat(60))

    const env = entry.factory(harness)
    const report = await env.evaluate({
      maxTasks: options?.maxTasks,
      dryRun: options?.dryRun,
      onProgress: log,
    })
    envReports.push(report)
  }

  // Aggregate
  const totalTasks = envReports.reduce((s, r) => s + r.tasks, 0)
  const totalCompleted = envReports.reduce((s, r) => s + r.completed, 0)
  const averageScore = totalTasks > 0
    ? envReports.reduce((s, r) => s + r.averageScore * r.tasks, 0) / totalTasks
    : 0

  log(`\n${'═'.repeat(60)}`)
  log(`COMBINED: ${totalCompleted}/${totalTasks} tasks completed (avg score ${averageScore.toFixed(3)})`)
  for (const r of envReports) {
    log(`  ${r.envName}: ${r.completed}/${r.tasks} (${r.averageScore.toFixed(3)})`)
  }

  // Optimize
  let optimizerRan = false
  if (shouldOptimize && !options?.dryRun) {
    log(`\nRunning nightly optimization (budget: $${costBudget})...`)
    try {
      const result = await runNightlyOptimization({
        costBudgetUsd: costBudget,
        onProgress: log,
      })
      optimizerRan = true
      log(`\nOptimizer: ${result.variantsGenerated} variants, ${result.promotions.length} promotions, GEPA: ${result.gepaRan}`)
    } catch (e) {
      log(`\nOptimizer failed: ${e}`)
    }
  }

  const combined: CombinedEvalReport = {
    timestamp: new Date().toISOString(),
    envReports,
    totalTasks,
    totalCompleted,
    averageScore,
    optimizerRan,
  }

  // Persist combined report
  try {
    const reportDir = join(FOREMAN_HOME, 'traces', 'eval-reports')
    await mkdir(reportDir, { recursive: true })
    await writeFile(
      join(reportDir, `combined-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
      JSON.stringify(combined, null, 2) + '\n',
      'utf8',
    )
  } catch { /* best effort */ }

  return combined
}
