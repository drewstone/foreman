/**
 * Cost monitoring and budget enforcement.
 *
 * Tracks spend per repo, harness, and day. Alerts when budgets
 * are approached or exceeded. Can pause auto-resume when over budget.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadSessionMetrics, aggregateMetrics, type SessionMetrics, type MetricsAggregate } from './session-metrics.js'
import { notify } from './notify.js'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export interface CostBudget {
  dailyUsd: number
  perRepoUsd?: number
  perHarnessUsd?: number
  alertThreshold: number // 0-1, e.g. 0.8 = alert at 80% of budget
}

export interface CostReport {
  period: string
  totalCostUsd: number
  budget: CostBudget
  utilizationPct: number
  overBudget: boolean
  alertSent: boolean
  byRepo: Record<string, number>
  byHarness: Record<string, number>
  byDay: Record<string, number>
  repoOverBudget: string[]
  harnessOverBudget: string[]
}

const DEFAULT_BUDGET: CostBudget = {
  dailyUsd: 10,
  perRepoUsd: 3,
  perHarnessUsd: 5,
  alertThreshold: 0.8,
}

export async function loadBudget(): Promise<CostBudget> {
  try {
    const raw = await readFile(join(FOREMAN_HOME, 'cost-budget.json'), 'utf8')
    return { ...DEFAULT_BUDGET, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_BUDGET
  }
}

export async function saveBudget(budget: CostBudget): Promise<void> {
  await mkdir(FOREMAN_HOME, { recursive: true })
  await writeFile(join(FOREMAN_HOME, 'cost-budget.json'), JSON.stringify(budget, null, 2) + '\n', 'utf8')
}

export async function checkCosts(options?: { hoursBack?: number }): Promise<CostReport> {
  const hoursBack = options?.hoursBack ?? 24
  const budget = await loadBudget()
  const metrics = await loadSessionMetrics({ hoursBack })
  const agg = aggregateMetrics(metrics)

  const repoOverBudget: string[] = []
  const harnessOverBudget: string[] = []

  if (budget.perRepoUsd) {
    for (const [repo, data] of Object.entries(agg.byRepo)) {
      if (data.cost > budget.perRepoUsd) repoOverBudget.push(repo)
    }
  }

  if (budget.perHarnessUsd) {
    for (const [harness, data] of Object.entries(agg.byHarness)) {
      if (data.cost > budget.perHarnessUsd) harnessOverBudget.push(harness)
    }
  }

  // By day breakdown
  const byDay: Record<string, number> = {}
  for (const m of metrics) {
    const day = m.timestamp.slice(0, 10)
    byDay[day] = (byDay[day] ?? 0) + (m.costUsd ?? 0)
  }

  const utilization = budget.dailyUsd > 0 ? agg.totalCostUsd / budget.dailyUsd : 0
  const overBudget = agg.totalCostUsd > budget.dailyUsd

  let alertSent = false
  if (utilization >= budget.alertThreshold || overBudget) {
    await notify({
      title: overBudget ? 'Cost Budget EXCEEDED' : 'Cost Budget Warning',
      body: [
        `24h spend: $${agg.totalCostUsd.toFixed(2)} / $${budget.dailyUsd.toFixed(2)} (${(utilization * 100).toFixed(0)}%)`,
        `Sessions: ${agg.totalSessions}`,
        repoOverBudget.length > 0 ? `Repos over budget: ${repoOverBudget.join(', ')}` : '',
        harnessOverBudget.length > 0 ? `Harnesses over budget: ${harnessOverBudget.join(', ')}` : '',
      ].filter(Boolean).join('\n'),
      severity: overBudget ? 'critical' : 'warning',
      source: 'cost-monitor',
    })
    alertSent = true
  }

  const report: CostReport = {
    period: `${hoursBack}h`,
    totalCostUsd: agg.totalCostUsd,
    budget,
    utilizationPct: utilization * 100,
    overBudget,
    alertSent,
    byRepo: Object.fromEntries(Object.entries(agg.byRepo).map(([k, v]) => [k, v.cost])),
    byHarness: Object.fromEntries(Object.entries(agg.byHarness).map(([k, v]) => [k, v.cost])),
    byDay,
    repoOverBudget,
    harnessOverBudget,
  }

  // Persist
  try {
    const dir = join(FOREMAN_HOME, 'traces', 'costs')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
      JSON.stringify(report, null, 2) + '\n',
      'utf8',
    )
  } catch { /* best effort */ }

  return report
}

export function renderCostReport(report: CostReport): string {
  const lines: string[] = []
  lines.push('## Cost Monitor')
  lines.push('')
  const bar = report.overBudget ? '🔴' : report.utilizationPct > 80 ? '🟡' : '🟢'
  lines.push(`${bar} **$${report.totalCostUsd.toFixed(2)}** / $${report.budget.dailyUsd} daily budget (${report.utilizationPct.toFixed(0)}%)`)
  lines.push('')

  if (Object.keys(report.byRepo).length > 0) {
    lines.push('| Repo | Cost |')
    lines.push('|---|---|')
    for (const [repo, cost] of Object.entries(report.byRepo).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      const flag = report.repoOverBudget.includes(repo) ? ' 🔴' : ''
      lines.push(`| ${repo}${flag} | $${cost.toFixed(2)} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
