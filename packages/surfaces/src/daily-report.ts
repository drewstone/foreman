/**
 * Daily report generator.
 *
 * Reads heartbeat traces for a date range, aggregates them, and renders
 * a Markdown document for human review. The report shows:
 *
 * - Portfolio snapshot (all tracked sessions, grouped by repo)
 * - Actions Foreman would have taken (dry-run decisions)
 * - Discoveries from session scanning
 * - Blocked work and why
 * - Proposed next actions with confidence levels
 *
 * This is the validation artifact for the dry-run period. Drew reviews
 * this daily and checks whether Foreman's proposed actions match what
 * he would actually do.
 *
 * Usage:
 *   npx tsx packages/surfaces/src/daily-report-cli.ts [--date 2026-03-20] [--days 1]
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { extractDeepSessionInsights, type SessionInsightReport } from './session-insights.js'
import { indexAllSessions, type IndexedMessage } from '@drew/foreman-memory/session-index'
import { judgeDailyReport, renderJudgment } from '@drew/foreman-evals/foreman-judge'
import {
  createLLMJudge,
  renderLLMJudgment,
  FOREMAN_DAILY_REPORT_RUBRIC,
  FOREMAN_DAILY_REPORT_DIRECTIVE,
  type LLMJudgment,
} from '@drew/foreman-evals/llm-judge'
import { createClaudeProvider } from '@drew/foreman-providers'
import { VersionedStore } from '@drew/foreman-core'
import { loadSessionMetrics, aggregateMetrics, renderMetricsAggregate } from './session-metrics.js'
import { trackSkillPerformance, detectDegradation, renderSkillPerformance } from './skill-tracker.js'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
const TRACES_DIR = join(FOREMAN_HOME, 'traces', 'heartbeats')
const REPORTS_DIR = join(FOREMAN_HOME, 'reports')

interface HeartbeatTrace {
  kind: string
  at: string
  checked: number
  resumed: number
  discoveries: string[]
  actions: Array<{
    sessionId: string
    action: string
    result: string
  }>
  sessionInsights: string[]
  blockedSessions: Array<{
    id: string
    repo: string
    reason: string
    confidence: number
  }>
  sessions: Array<{
    id: string
    repo: string
    branch: string
    status: string
    ciStatus?: string
    priority: number
    prNumber?: number
    daysOld: string
    lastCommit: string
    hasClaudeSession: boolean
  }>
}

export async function loadTracesForDate(date: string): Promise<HeartbeatTrace[]> {
  const files = await readdir(TRACES_DIR)
  const matching = files.filter((f) => f.startsWith(date) && f.endsWith('.json'))
  matching.sort()

  const traces: HeartbeatTrace[] = []
  for (const file of matching) {
    try {
      const raw = await readFile(join(TRACES_DIR, file), 'utf8')
      traces.push(JSON.parse(raw))
    } catch { continue }
  }
  return traces
}

function groupByRepo(sessions: HeartbeatTrace['sessions']): Map<string, HeartbeatTrace['sessions']> {
  const map = new Map<string, HeartbeatTrace['sessions']>()
  for (const s of sessions) {
    const existing = map.get(s.repo) ?? []
    existing.push(s)
    map.set(s.repo, existing)
  }
  return map
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'blocked': return '🔴'
    case 'active': return '🟢'
    case 'waiting': return '🟡'
    case 'stale': return '⚪'
    case 'completed': return '✅'
    default: return '⚪'
  }
}

function ciEmoji(ci?: string): string {
  if (!ci) return ''
  switch (ci) {
    case 'pass': return ' ✅'
    case 'fail': return ' ❌'
    case 'pending': return ' ⏳'
    default: return ''
  }
}

export interface SessionIndexData {
  recentUserMessages: IndexedMessage[]
  topSearches: Array<{ query: string; count: number; repos: string[] }>
  staleRepos: Array<{ repo: string; lastActive: string; daysStale: number }>
}

export function renderDailyReport(date: string, traces: HeartbeatTrace[], sessionInsights?: SessionInsightReport, indexData?: SessionIndexData): string {
  if (traces.length === 0) return `# Foreman Daily Report — ${date}\n\nNo heartbeat traces found.\n`

  const latest = traces[traces.length - 1]
  const earliest = traces[0]

  // Aggregate unique actions across all heartbeats
  const allActions = new Map<string, { action: string; count: number; result: string }>()
  for (const t of traces) {
    for (const a of t.actions) {
      const key = `${a.sessionId}|${a.action}`
      const existing = allActions.get(key)
      if (existing) {
        existing.count++
      } else {
        allActions.set(key, { action: `${a.sessionId.split(':').pop()}: ${a.action}`, count: 1, result: a.result })
      }
    }
  }

  // Aggregate unique discoveries
  const allDiscoveries = new Set<string>()
  for (const t of traces) {
    for (const d of t.discoveries) allDiscoveries.add(d)
    for (const i of t.sessionInsights) allDiscoveries.add(i)
  }

  // Aggregate blocked sessions
  const blocked = new Map<string, { repo: string; reason: string; confidence: number }>()
  for (const t of traces) {
    for (const b of t.blockedSessions) {
      blocked.set(b.id, b)
    }
  }

  // Session changes: compare first and last trace of the day
  const firstSessions = new Map(earliest.sessions.map((s) => [s.id, s]))
  const lastSessions = new Map(latest.sessions.map((s) => [s.id, s]))
  const newSessions = latest.sessions.filter((s) => !firstSessions.has(s.id))
  const removedIds = [...firstSessions.keys()].filter((id) => !lastSessions.has(id))
  const statusChanges: string[] = []
  for (const [id, first] of firstSessions) {
    const last = lastSessions.get(id)
    if (last && (first.status !== last.status || first.ciStatus !== last.ciStatus)) {
      statusChanges.push(`**${first.repo}/${first.branch}**: ${first.status}${first.ciStatus ? `(CI:${first.ciStatus})` : ''} → ${last.status}${last.ciStatus ? `(CI:${last.ciStatus})` : ''}`)
    }
  }

  // Group latest sessions by repo
  const byRepo = groupByRepo(latest.sessions)
  const repos = [...byRepo.entries()].sort((a, b) => {
    const maxA = Math.max(...a[1].map((s) => s.priority))
    const maxB = Math.max(...b[1].map((s) => s.priority))
    return maxB - maxA
  })

  // Build the report
  const lines: string[] = []

  lines.push(`# Foreman Daily Report — ${date}`)
  lines.push('')
  lines.push(`**Heartbeats:** ${traces.length} (${earliest.at.slice(11, 16)} → ${latest.at.slice(11, 16)} UTC)`)
  lines.push(`**Sessions tracked:** ${latest.sessions.length}`)
  lines.push(`**Repos:** ${byRepo.size}`)
  lines.push(`**Blocked:** ${blocked.size}`)
  lines.push('')

  // Actions (what Foreman would have done)
  lines.push('## Proposed Actions')
  lines.push('')
  if (allActions.size === 0) {
    lines.push('No actions proposed today.')
  } else {
    lines.push('| Session | Action | Times | Result |')
    lines.push('|---|---|---|---|')
    for (const [, a] of allActions) {
      lines.push(`| ${a.action.split(': ')[0]} | ${a.action.split(': ').slice(1).join(': ')} | ${a.count}x | ${a.result} |`)
    }
    lines.push('')
    lines.push('> **Review question:** Would you have taken these actions? If not, what would you have done instead?')
  }
  lines.push('')

  // Discoveries
  lines.push('## Discoveries & Insights')
  lines.push('')
  if (allDiscoveries.size === 0) {
    lines.push('No new discoveries.')
  } else {
    for (const d of allDiscoveries) {
      lines.push(`- ${d}`)
    }
    lines.push('')
    lines.push('> **Review question:** Did Foreman notice the right things? What did it miss?')
  }
  lines.push('')

  // Status changes
  if (statusChanges.length > 0 || newSessions.length > 0 || removedIds.length > 0) {
    lines.push('## Changes Today')
    lines.push('')
    for (const c of statusChanges) lines.push(`- ${c}`)
    for (const s of newSessions) lines.push(`- **NEW** ${s.repo}/${s.branch} (${s.status})`)
    for (const id of removedIds) lines.push(`- **REMOVED** ${id}`)
    lines.push('')
  }

  // Blocked work
  if (blocked.size > 0) {
    lines.push('## Blocked Work')
    lines.push('')
    lines.push('| Repo | Branch | Reason | Confidence |')
    lines.push('|---|---|---|---|')
    for (const [id, b] of blocked) {
      const branch = id.split(':').pop() ?? ''
      lines.push(`| ${b.repo} | ${branch} | ${b.reason} | ${b.confidence === 0 ? 'no recipe' : `${(b.confidence * 100).toFixed(0)}%`} |`)
    }
    lines.push('')
    lines.push('> **Review question:** Should Foreman attempt to fix any of these? What recipe would you apply?')
    lines.push('')
  }

  // Session insights (what Drew is actually saying and doing)
  if (sessionInsights && sessionInsights.totalSessions > 0) {
    lines.push('## Session Activity')
    lines.push('')
    lines.push(`**${sessionInsights.totalSessions} sessions** analyzed (${sessionInsights.totalMessages} messages)`)
    lines.push('')

    if (sessionInsights.repoActivity.length > 0) {
      for (const repo of sessionInsights.repoActivity) {
        lines.push(`### ${repo.repo} (${repo.sessionCount} sessions, last active ${repo.lastActive.slice(0, 10)})`)
        lines.push('')
        if (repo.inferredGoals.length > 0) {
          lines.push('**What you said:**')
          for (const goal of repo.inferredGoals.slice(0, 5)) {
            lines.push(`- "${goal}"`)
          }
          lines.push('')
        }
        if (repo.commonCommands.length > 0) {
          lines.push(`**Common commands:** \`${repo.commonCommands.join('`, `')}\``)
          lines.push('')
        }
        if (repo.commonFiles.length > 0) {
          lines.push(`**Key files:** \`${repo.commonFiles.join('`, `')}\``)
          lines.push('')
        }
      }
    }

    if (sessionInsights.recurringPatterns.length > 0) {
      lines.push('**Cross-repo patterns:**')
      for (const p of sessionInsights.recurringPatterns.slice(0, 10)) {
        lines.push(`- ${p.pattern} (${p.frequency}x across ${p.repos.join(', ')})`)
      }
      lines.push('')
    }

    if (sessionInsights.suggestedClaudeMdRules.length > 0) {
      lines.push('**Suggested CLAUDE.md rules:**')
      for (const rule of sessionInsights.suggestedClaudeMdRules) {
        lines.push(`- ${rule}`)
      }
      lines.push('')
    }

    if (sessionInsights.crossRepoInsights.length > 0) {
      lines.push('**Cross-repo insights:**')
      for (const insight of sessionInsights.crossRepoInsights) {
        lines.push(`- ${insight}`)
      }
      lines.push('')
    }

    if (sessionInsights.abandonedWork.length > 0) {
      lines.push('**Potentially abandoned work:**')
      for (const w of sessionInsights.abandonedWork) {
        lines.push(`- ${w.repo}${w.branch ? `/${w.branch}` : ''}: "${w.lastPrompt}" (${w.daysStale}d stale)`)
      }
      lines.push('')
    }

    lines.push('> **Review question:** Does this match what you were actually working on? Is Foreman reading your sessions correctly?')
    lines.push('')
  }

  // What you've been saying (from FTS5 index — richer than session insights)
  if (indexData && indexData.recentUserMessages.length > 0) {
    lines.push('## What You Said (last 48h)')
    lines.push('')

    // Group by repo
    const byRepo = new Map<string, IndexedMessage[]>()
    for (const msg of indexData.recentUserMessages) {
      const repo = msg.repo || msg.project || 'unknown'
      const existing = byRepo.get(repo) ?? []
      existing.push(msg)
      byRepo.set(repo, existing)
    }

    for (const [repo, msgs] of byRepo) {
      lines.push(`### ${repo}`)
      lines.push('')
      for (const msg of msgs.slice(0, 8)) {
        const text = msg.content.replace(/\n/g, ' ').slice(0, 200)
        lines.push(`- \`${msg.timestamp.slice(0, 16)}\` "${text}"`)
      }
      lines.push('')
    }

    lines.push('> **Review question:** Is Foreman hearing what matters? Are the priorities reflected in what you\'re saying?')
    lines.push('')
  }

  // Stale repos (repos with no activity in 3+ days)
  if (indexData && indexData.staleRepos.length > 0) {
    lines.push('## Stale Repos')
    lines.push('')
    lines.push('Repos with open branches but no session activity:')
    lines.push('')
    for (const sr of indexData.staleRepos) {
      lines.push(`- **${sr.repo}**: last active ${sr.lastActive.slice(0, 10)} (${sr.daysStale}d ago)`)
    }
    lines.push('')
    lines.push('> **Review question:** Should any of these be resumed, closed, or deprioritized?')
    lines.push('')
  }

  // Portfolio snapshot
  lines.push('## Portfolio Snapshot')
  lines.push('')
  for (const [repo, sessions] of repos) {
    const sorted = [...sessions].sort((a, b) => b.priority - a.priority)
    lines.push(`### ${repo}`)
    lines.push('')
    for (const s of sorted) {
      const pr = s.prNumber ? ` PR#${s.prNumber}` : ''
      const ci = ciEmoji(s.ciStatus)
      const age = parseInt(s.daysOld, 10)
      const ageStr = age === 0 ? 'today' : `${age}d ago`
      lines.push(`- ${statusEmoji(s.status)} **${s.branch}**${pr}${ci} (p${s.priority}, ${ageStr})`)
      lines.push(`  ${s.lastCommit}`)
    }
    lines.push('')
  }

  // Footer
  lines.push('---')
  lines.push('')
  lines.push('## Daily Review Checklist')
  lines.push('')
  lines.push('- [ ] Are the proposed actions correct?')
  lines.push('- [ ] Did Foreman notice the right blocked work?')
  lines.push('- [ ] Are there sessions Foreman missed?')
  lines.push('- [ ] Are the priorities right?')
  lines.push('- [ ] What would you have done differently?')
  lines.push('- [ ] Ready to remove dry-run? (Y/N, and why)')
  lines.push('')

  return lines.join('\n')
}

export async function generateDailyReport(date: string): Promise<string> {
  const traces = await loadTracesForDate(date)

  // Extract session insights from all repos seen in traces
  const repoPaths = new Set<string>()
  for (const t of traces) {
    for (const s of t.sessions) {
      const id = s.id
      const repoPath = id.split(':')[0]
      if (repoPath) repoPaths.add(repoPath)
    }
  }

  let insights: SessionInsightReport | undefined
  if (repoPaths.size > 0) {
    try {
      insights = await extractDeepSessionInsights({
        repoPaths: [...repoPaths],
        hoursBack: 48,
        maxSessionsPerRepo: 5,
      })
    } catch { /* best effort */ }
  }

  // Pull rich data from session index
  let indexData: SessionIndexData | undefined
  try {
    // Update index first (incremental — only new sessions)
    const { index } = await indexAllSessions({ maxAge: 7 * 24 * 3600 * 1000 })

    // Recent user messages (48h)
    const recentUserMessages = index.recentUserMessages({ limit: 60, hoursBack: 48 })
      .filter((m) => {
        // Filter out system/XML noise
        if (m.content.startsWith('<')) return false
        if (m.content.length < 15) return false
        return true
      })

    // Find stale repos: repos with tracked sessions but no recent index activity
    const repoStats = index.stats().byRepo
    const activeRepos = new Set(
      recentUserMessages.map((m) => m.repo).filter(Boolean),
    )

    const staleRepos: SessionIndexData['staleRepos'] = []
    // Check each tracked repo from heartbeat
    const trackedRepos = new Set<string>()
    for (const t of traces) {
      for (const s of t.sessions) {
        const repo = s.id.split(':')[0]?.split('/').pop()
        if (repo) trackedRepos.add(repo)
      }
    }

    for (const repo of trackedRepos) {
      if (activeRepos.has(repo)) continue
      // Find last message timestamp for this repo
      const lastMsgs = index.recentUserMessages({ repo, limit: 1, hoursBack: 720 })
      if (lastMsgs.length > 0) {
        const lastTs = lastMsgs[0].timestamp
        const daysStale = Math.floor((Date.now() - new Date(lastTs).getTime()) / (24 * 3600 * 1000))
        if (daysStale >= 3) {
          staleRepos.push({ repo, lastActive: lastTs, daysStale })
        }
      }
    }

    staleRepos.sort((a, b) => b.daysStale - a.daysStale)

    indexData = {
      recentUserMessages,
      topSearches: [],
      staleRepos,
    }

    index.close()
  } catch { /* session index unavailable — report still works */ }

  let report = renderDailyReport(date, traces, insights, indexData)

  // Session metrics (cost, tokens, turns from spawned sessions)
  try {
    const metrics = await loadSessionMetrics({ hoursBack: 48 })
    if (metrics.length > 0) {
      const agg = aggregateMetrics(metrics)
      report += '\n' + renderMetricsAggregate(agg)
    }
  } catch { /* no metrics yet */ }

  // Skill performance tracking
  try {
    const performances = await trackSkillPerformance({ hoursBack: 168 })
    if (performances.length > 0) {
      const proposals = detectDegradation(performances)
      report += '\n' + renderSkillPerformance(performances, proposals)
    }
  } catch { /* no skill data */ }

  // Auto-score this report
  const knownRepos = [...new Set(traces.flatMap((t) => t.sessions.map((s) => s.repo)))]
  const judgment = judgeDailyReport(report, {
    knownRepos,
    recentUserMessages: indexData?.recentUserMessages.length ?? 0,
    blockedSessions: traces[traces.length - 1]?.sessions.filter((s) => s.status === 'blocked').length ?? 0,
    totalSessions: traces[traces.length - 1]?.sessions.length ?? 0,
    heartbeatCount: traces.length,
  })

  // Shared versioned store for all artifact operations
  const versionedStore = new VersionedStore()

  // LLM judge (optional — runs if provider is available)
  let llmJudgmentText = ''
  let llmJudgment: LLMJudgment | undefined
  let directiveVersionId: string | undefined
  try {
    // Use Opus for judge — best reasoning, no shortcuts
    const provider = createClaudeProvider('judge-claude', { model: 'claude-opus-4-6' })

    // Load directive from versioned store (or seed it)
    let directive = FOREMAN_DAILY_REPORT_DIRECTIVE
    const activeDirective = await versionedStore.getActive('judge-directive', 'daily-report')
    if (activeDirective) {
      directive = activeDirective.content
      directiveVersionId = activeDirective.version.id
    } else {
      // Seed the store with the default directive
      const result = await versionedStore.put('judge-directive', 'daily-report', FOREMAN_DAILY_REPORT_DIRECTIVE, {
        source: 'default',
        activate: true,
      })
      directiveVersionId = result.version.id
    }

    // Also version the rubric
    const rubricJson = JSON.stringify(FOREMAN_DAILY_REPORT_RUBRIC)
    await versionedStore.put('judge-rubric', 'daily-report', rubricJson, { source: 'default' })

    const judge = createLLMJudge({
      id: 'foreman-daily-report-judge',
      provider,
      directive,
      rubric: FOREMAN_DAILY_REPORT_RUBRIC,
      artifactType: 'daily-report',
      timeoutMs: 90_000,
    })

    // Build context from operator profile
    let context = ''
    try {
      const profilePath = join(FOREMAN_HOME, 'memory', 'user', 'operator.json')
      const profile = JSON.parse(await readFile(profilePath, 'utf8'))
      if (profile.operatorPatterns?.length) {
        context += `Operator patterns: ${profile.operatorPatterns.join('; ')}\n`
      }
    } catch { /* no profile */ }

    llmJudgment = await judge.evaluate(report, context || undefined)
    llmJudgmentText = '\n' + renderLLMJudgment(llmJudgment)

    // Score the directive version that produced this judgment
    if (directiveVersionId && llmJudgment) {
      await versionedStore.score('judge-directive', 'daily-report', directiveVersionId, {
        judgeId: llmJudgment.judgeId,
        score: llmJudgment.overallScore,
        maxScore: llmJudgment.maxScore,
      })
    }
  } catch { /* LLM judge unavailable — deterministic judge still works */ }

  const scored = report + '\n' + renderJudgment(judgment) + llmJudgmentText

  // Save judgments as traces
  try {
    const judgeDir = join(FOREMAN_HOME, 'traces', 'judgments')
    await mkdir(judgeDir, { recursive: true })
    const traceData = {
      deterministic: judgment,
      llm: llmJudgment ?? null,
    }
    await writeFile(join(judgeDir, `${date}.json`), JSON.stringify(traceData, null, 2) + '\n', 'utf8')
  } catch { /* best effort */ }

  // Version the report template (the generator output, not the content)
  try {
    const templateResult = await versionedStore.put('report-template', 'daily', report, { source: `generated-${date}` })
    if (llmJudgment && !templateResult.isDuplicate) {
      await versionedStore.score('report-template', 'daily', templateResult.version.id, {
        judgeId: llmJudgment.judgeId,
        score: llmJudgment.overallScore,
        maxScore: llmJudgment.maxScore,
      })
    }
  } catch { /* best effort */ }

  await mkdir(REPORTS_DIR, { recursive: true })
  const reportPath = join(REPORTS_DIR, `${date}.md`)
  await writeFile(reportPath, scored, 'utf8')

  return reportPath
}

export async function generateMultiDayReport(startDate: string, days: number): Promise<string> {
  // Collect all repo paths across all days first
  const allRepoPaths = new Set<string>()
  const dayTraces: Array<{ date: string; traces: HeartbeatTrace[] }> = []
  const start = new Date(startDate)

  for (let i = 0; i < days; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().slice(0, 10)
    const traces = await loadTracesForDate(dateStr)
    if (traces.length > 0) {
      dayTraces.push({ date: dateStr, traces })
      for (const t of traces) {
        for (const s of t.sessions) {
          const repoPath = s.id.split(':')[0]
          if (repoPath) allRepoPaths.add(repoPath)
        }
      }
    }
  }

  if (dayTraces.length === 0) return 'No heartbeat traces found for the given date range.\n'

  // Get session insights once for all repos
  let insights: SessionInsightReport | undefined
  if (allRepoPaths.size > 0) {
    try {
      insights = await extractDeepSessionInsights({
        repoPaths: [...allRepoPaths],
        hoursBack: days * 24 + 24,
        maxSessionsPerRepo: 5,
      })
    } catch { /* best effort */ }
  }

  // Render each day (only include insights on the most recent day)
  const parts: string[] = []
  for (let i = 0; i < dayTraces.length; i++) {
    const { date, traces } = dayTraces[i]
    parts.push(renderDailyReport(date, traces, i === 0 ? insights : undefined))
  }

  return parts.join('\n\n---\n\n')
}
