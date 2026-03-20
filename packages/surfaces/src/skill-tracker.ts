/**
 * Skill invocation tracker and degrade→patch loop.
 *
 * Monitors skill invocations (/evolve, /polish, /verify, /critical-audit)
 * across sessions, tracks success/failure rates, detects degradation,
 * and proposes patches when quality drops.
 *
 * Data source: session index (FTS5) — searches for skill invocations.
 * Persistence: ~/.foreman/memory/skills/ — per-skill performance data.
 * Output: degradation alerts + patch proposals in daily report.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { SessionIndex } from '@drew/foreman-memory/session-index'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
const SKILLS_DIR = join(FOREMAN_HOME, 'memory', 'skills')

export interface SkillInvocation {
  skillName: string
  timestamp: string
  repo: string
  sessionId: string
  succeeded: boolean
  context: string
}

export interface SkillPerformance {
  skillName: string
  totalInvocations: number
  recentInvocations: number
  overallSuccessRate: number
  recentSuccessRate: number
  trend: 'improving' | 'stable' | 'degrading' | 'unknown'
  lastInvocation: string
  commonRepos: string[]
  recentFailures: Array<{ timestamp: string; repo: string; context: string }>
}

export interface SkillPatchProposal {
  skillName: string
  reason: string
  severity: 'low' | 'medium' | 'high'
  suggestedChange: string
}

const TRACKED_SKILLS = [
  'evolve', 'polish', 'verify', 'critical-audit', 'diagnose',
  'research', 'improve', 'code-review', 'converge', 'pursue',
]

/**
 * Scan session index for skill invocations and compute performance.
 */
export async function trackSkillPerformance(options?: {
  hoursBack?: number
  onProgress?: (msg: string) => void
}): Promise<SkillPerformance[]> {
  const hoursBack = options?.hoursBack ?? 168 // 7 days
  const log = options?.onProgress ?? (() => {})
  const performances: SkillPerformance[] = []

  let index: SessionIndex
  try {
    index = new SessionIndex()
  } catch { return [] }

  try {
    for (const skill of TRACKED_SKILLS) {
      // Search for skill invocations in user messages
      const invocations = index.search({
        query: `/${skill}`,
        role: 'user',
        hoursBack,
        limit: 50,
      })

      if (invocations.length === 0) continue

      // Also search assistant responses for completion signals
      const responses = index.search({
        query: skill,
        role: 'assistant',
        hoursBack,
        limit: 50,
      })

      // Classify each invocation as success/failure based on nearby responses
      const classified: SkillInvocation[] = []
      for (const inv of invocations) {
        const nearbyResponses = responses.filter((r) =>
          r.message.sessionId === inv.message.sessionId &&
          Math.abs(new Date(r.message.timestamp).getTime() - new Date(inv.message.timestamp).getTime()) < 30 * 60 * 1000,
        )

        const responseText = nearbyResponses.map((r) => r.message.content).join(' ').toLowerCase()

        // Positive signals (skill completed successfully)
        const positiveSignals = [
          'all tests pass', 'all checks pass', 'ci is green', 'ci green',
          'pr created', 'pushed to', 'merged', 'committed',
          '9/10', '10/10', '9.', '10.', 'score: 9', 'score: 10',
          'complete', 'converged', 'promoted', 'verified',
          'pass rate: 100', 'pass rate: 1.0',
          'round complete', 'iteration complete', 'loop complete',
        ]
        // Negative signals (skill failed or was abandoned)
        const negativeSignals = [
          'failed', 'error:', 'panic', 'compilation error',
          'giving up', 'cannot', 'unable to', 'stuck',
          'max iterations', 'max rounds', 'timed out',
          'abort', 'cancelled', 'score: 0', 'score: 1', 'score: 2',
          '0/10', '1/10', '2/10', '3/10',
        ]

        const posCount = positiveSignals.filter((s) => responseText.includes(s)).length
        const negCount = negativeSignals.filter((s) => responseText.includes(s)).length

        // Classify: if more positive than negative signals, or no signals but agent ran long enough
        const succeeded = posCount > negCount ||
          (posCount === 0 && negCount === 0 && nearbyResponses.length >= 3)

        classified.push({
          skillName: skill,
          timestamp: inv.message.timestamp,
          repo: inv.message.repo || inv.message.project,
          sessionId: inv.message.sessionId,
          succeeded,
          context: inv.snippet.slice(0, 200),
        })
      }

      // Compute performance
      const total = classified.length
      const recent = classified.filter((i) =>
        Date.now() - new Date(i.timestamp).getTime() < 48 * 3600 * 1000,
      )
      const overallSuccess = classified.filter((i) => i.succeeded).length / Math.max(total, 1)
      const recentSuccess = recent.length > 0
        ? recent.filter((i) => i.succeeded).length / recent.length
        : overallSuccess

      // Detect trend
      let trend: SkillPerformance['trend'] = 'unknown'
      if (total >= 5 && recent.length >= 2) {
        const diff = recentSuccess - overallSuccess
        if (diff > 0.1) trend = 'improving'
        else if (diff < -0.1) trend = 'degrading'
        else trend = 'stable'
      }

      const recentFailures = classified
        .filter((i) => !i.succeeded)
        .slice(0, 5)
        .map((i) => ({ timestamp: i.timestamp, repo: i.repo, context: i.context }))

      const repos = [...new Set(classified.map((i) => i.repo).filter(Boolean))]

      performances.push({
        skillName: skill,
        totalInvocations: total,
        recentInvocations: recent.length,
        overallSuccessRate: overallSuccess,
        recentSuccessRate: recentSuccess,
        trend,
        lastInvocation: classified[0]?.timestamp ?? '',
        commonRepos: repos.slice(0, 5),
        recentFailures,
      })

      log(`  ${skill}: ${total} invocations, ${(overallSuccess * 100).toFixed(0)}% success, trend: ${trend}`)
    }
  } finally {
    index.close()
  }

  // Persist
  try {
    await mkdir(SKILLS_DIR, { recursive: true })
    await writeFile(
      join(SKILLS_DIR, 'performance.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), skills: performances }, null, 2) + '\n',
      'utf8',
    )
  } catch { /* best effort */ }

  return performances
}

/**
 * Detect degrading skills and propose patches.
 */
export function detectDegradation(performances: SkillPerformance[]): SkillPatchProposal[] {
  const proposals: SkillPatchProposal[] = []

  for (const perf of performances) {
    if (perf.trend === 'degrading') {
      const failContexts = perf.recentFailures.map((f) => f.context).join('; ')
      proposals.push({
        skillName: perf.skillName,
        reason: `${perf.skillName} degrading: overall ${(perf.overallSuccessRate * 100).toFixed(0)}% → recent ${(perf.recentSuccessRate * 100).toFixed(0)}%`,
        severity: perf.recentSuccessRate < 0.3 ? 'high' : perf.recentSuccessRate < 0.5 ? 'medium' : 'low',
        suggestedChange: `Review recent failures in ${perf.commonRepos.join(', ')}: ${failContexts.slice(0, 200)}. Consider tightening the skill's verification step or adding guardrails for the failing patterns.`,
      })
    }

    // Also flag skills with consistently low success
    if (perf.totalInvocations >= 5 && perf.overallSuccessRate < 0.4 && perf.trend !== 'improving') {
      proposals.push({
        skillName: perf.skillName,
        reason: `${perf.skillName} has ${(perf.overallSuccessRate * 100).toFixed(0)}% success across ${perf.totalInvocations} invocations`,
        severity: 'high',
        suggestedChange: `Skill may be fundamentally broken or misconfigured. Review SKILL.md and recent failure contexts.`,
      })
    }
  }

  return proposals
}

/**
 * Render skill performance for daily report.
 */
export function renderSkillPerformance(performances: SkillPerformance[], proposals: SkillPatchProposal[]): string {
  if (performances.length === 0) return ''

  const lines: string[] = []
  lines.push('## Skill Performance')
  lines.push('')
  lines.push('| Skill | Invocations | Success | Recent | Trend |')
  lines.push('|---|---|---|---|---|')

  for (const p of performances.sort((a, b) => b.totalInvocations - a.totalInvocations)) {
    const trendIcon = p.trend === 'improving' ? '📈' : p.trend === 'degrading' ? '📉' : p.trend === 'stable' ? '➡️' : '❓'
    lines.push(`| /${p.skillName} | ${p.totalInvocations} | ${(p.overallSuccessRate * 100).toFixed(0)}% | ${(p.recentSuccessRate * 100).toFixed(0)}% | ${trendIcon} ${p.trend} |`)
  }
  lines.push('')

  if (proposals.length > 0) {
    lines.push('### Degradation Alerts')
    lines.push('')
    for (const p of proposals) {
      const icon = p.severity === 'high' ? '🔴' : p.severity === 'medium' ? '🟡' : '🟢'
      lines.push(`${icon} **/${p.skillName}**: ${p.reason}`)
      lines.push(`  → ${p.suggestedChange}`)
      lines.push('')
    }
  }

  return lines.join('\n')
}
