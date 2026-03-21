/**
 * Policy self-improvement.
 *
 * Reads decision log, computes meta-metrics, proposes prompt variants.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { VersionedStore } from '@drew/foreman-core'
import type { ConfidenceStore } from '@drew/foreman-memory/confidence'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export interface PolicyMetrics {
  totalDecisions: number
  decisionsPerHour: number
  actionDistribution: Record<string, number>
  doNothingRate: number
  uniqueProjects: number
  hoursSpanned: number
}

export async function computePolicyMetrics(options?: {
  hoursBack?: number
}): Promise<PolicyMetrics> {
  const hoursBack = options?.hoursBack ?? 24
  const cutoff = Date.now() - hoursBack * 3600_000
  const dir = join(FOREMAN_HOME, 'traces', 'policy')

  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return {
      totalDecisions: 0,
      decisionsPerHour: 0,
      actionDistribution: {},
      doNothingRate: 0,
      uniqueProjects: 0,
      hoursSpanned: hoursBack,
    }
  }

  const decisions: Array<{ action: { type: string; project: string } | null; timestamp: string }> = []
  for (const file of files) {
    try {
      const raw = await readFile(join(dir, file), 'utf8')
      const dec = JSON.parse(raw)
      const ts = new Date(dec.timestamp).getTime()
      if (ts >= cutoff) decisions.push(dec)
    } catch {
      // skip malformed
    }
  }

  const distribution: Record<string, number> = {}
  const projects = new Set<string>()
  let doNothingCount = 0

  for (const dec of decisions) {
    if (!dec.action) {
      doNothingCount++
      distribution['do-nothing'] = (distribution['do-nothing'] ?? 0) + 1
    } else {
      const t = dec.action.type
      distribution[t] = (distribution[t] ?? 0) + 1
      if (dec.action.project) projects.add(dec.action.project)
    }
  }

  return {
    totalDecisions: decisions.length,
    decisionsPerHour: decisions.length / hoursBack,
    actionDistribution: distribution,
    doNothingRate: decisions.length > 0 ? doNothingCount / decisions.length : 0,
    uniqueProjects: projects.size,
    hoursSpanned: hoursBack,
  }
}

export async function generatePolicyVariant(
  metrics: PolicyMetrics,
): Promise<string | null> {
  const store = new VersionedStore()
  const active = await store.getActive('policy', 'main')
  if (!active) return null

  const metricsText = [
    `Decisions: ${metrics.totalDecisions} over ${metrics.hoursSpanned}h (${metrics.decisionsPerHour.toFixed(1)}/h)`,
    `Do-nothing rate: ${(metrics.doNothingRate * 100).toFixed(0)}%`,
    `Action distribution: ${JSON.stringify(metrics.actionDistribution)}`,
    `Unique projects: ${metrics.uniqueProjects}`,
  ].join('\n')

  const prompt = [
    'You are improving Foreman\'s policy prompt. Given the current prompt and its observed metrics, propose an improved version.',
    '',
    '## Current prompt',
    active.content,
    '',
    '## Observed metrics',
    metricsText,
    '',
    '## Instructions',
    'Output ONLY the improved prompt text. No explanation, no markdown fences.',
    'Keep the JSON response format section exactly as-is.',
    'Focus on improving prioritization rules and decision quality.',
  ].join('\n')

  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const { stdout } = await execFileAsync('claude', [
      '-p', prompt,
      '--output-format', 'text',
    ], { timeout: 120_000 })

    const variant = stdout.trim()
    if (!variant || variant.length < 100) return null

    const result = await store.put('policy', 'main', variant, { source: 'policy-optimizer' })
    if (result.isDuplicate) return null
    return result.version.id
  } catch {
    return null
  }
}

export function crossPollinate(confidenceStore: ConfidenceStore): void {
  const entries = confidenceStore.list()

  // Group by actionType
  const byAction = new Map<string, Array<{ project: string; score: number }>>()
  for (const entry of entries) {
    let list = byAction.get(entry.actionType)
    if (!list) {
      list = []
      byAction.set(entry.actionType, list)
    }
    list.push({ project: entry.project, score: entry.score })
  }

  // For each actionType with a high-confidence project, transfer to low/zero projects
  const allProjects = new Set(entries.map((e) => e.project))
  for (const [actionType, projectScores] of byAction) {
    const highConf = projectScores.filter((p) => p.score > 0.6)
    if (highConf.length === 0) continue

    for (const project of allProjects) {
      const existing = projectScores.find((p) => p.project === project)
      if (!existing || existing.score < 0.1) {
        confidenceStore.update(actionType, project, 'transfer')
      }
    }
  }
}
