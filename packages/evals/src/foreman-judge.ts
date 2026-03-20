/**
 * Foreman self-evaluation judge.
 *
 * Scores Foreman's artifacts (daily reports, heartbeat decisions, proposed
 * actions) against the SOUL.md and VISION.md standards. Produces structured
 * scores + reasons that feed into optimization loops.
 *
 * Rubric dimensions:
 *   1. Awareness    — Did Foreman notice what matters?
 *   2. Prioritization — Are priorities correct?
 *   3. Action quality — Would the proposed actions be correct?
 *   4. Completeness — What did it miss?
 *   5. Judgment     — Does it match operator-level thinking?
 *
 * Each dimension scored 0-10 with reasons.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface JudgeDimension {
  name: string
  score: number
  maxScore: number
  reasons: string[]
}

export interface ForemanJudgment {
  timestamp: string
  artifact: string
  artifactType: 'daily-report' | 'heartbeat' | 'proposed-action' | 'session-insight'
  dimensions: JudgeDimension[]
  overallScore: number
  maxScore: number
  summary: string
  recommendations: string[]
}

export interface JudgeRubric {
  awareness: string[]
  prioritization: string[]
  actionQuality: string[]
  completeness: string[]
  judgment: string[]
}

const DEFAULT_RUBRIC: JudgeRubric = {
  awareness: [
    'Notices all repos with active work',
    'Detects CI failures within one heartbeat cycle',
    'Surfaces user messages and goals from recent sessions',
    'Identifies stale branches with no activity',
    'Catches cross-repo patterns (same commands, shared themes)',
  ],
  prioritization: [
    'Blocked work (CI failures) gets highest priority',
    'Active work with PRs ranks above idle branches',
    'Stale branches without PRs get deprioritized',
    'Repos the user is actively talking about rank higher',
    'Priority matches what the user would actually work on next',
  ],
  actionQuality: [
    'Proposed actions are specific and actionable',
    'Dry-run decisions correctly identify when to act vs skip',
    'CI failure actions include reading logs, not just retrying',
    'Resume decisions match the actual blocker, not generic "fix it"',
    'Actions respect the "never trust self-report" principle',
  ],
  completeness: [
    'All managed repos appear in the report',
    'Session activity covers all harnesses (Claude, Codex, Pi)',
    'User messages are surfaced, not just branch metadata',
    'Cross-repo insights are identified',
    'Abandoned or forgotten work is flagged',
  ],
  judgment: [
    'Decisions match what a senior operator would do',
    'Skepticism is applied (not just "everything is fine")',
    'Report surfaces non-obvious insights, not just status',
    'Recommendations are concrete, not vague',
    'The report would actually change what the user does today',
  ],
}

// ─── Deterministic judge (no LLM needed) ───────────────────────────

export function judgeDailyReport(reportContent: string, context: {
  knownRepos: string[]
  recentUserMessages: number
  blockedSessions: number
  totalSessions: number
  heartbeatCount: number
}): ForemanJudgment {
  const dimensions: JudgeDimension[] = []

  // 1. Awareness
  const awareness: JudgeDimension = { name: 'awareness', score: 0, maxScore: 10, reasons: [] }

  // Check if report mentions session activity
  if (reportContent.includes('## Session Activity') || reportContent.includes('## What You Said')) {
    awareness.score += 3
    awareness.reasons.push('Session activity section present')
  } else {
    awareness.reasons.push('MISSING: No session activity — not reading user sessions')
  }

  // Check if user messages are surfaced
  if (reportContent.includes('**What you said:**') || reportContent.includes('What You Said')) {
    awareness.score += 2
    awareness.reasons.push('User messages surfaced')
  } else {
    awareness.reasons.push('MISSING: User messages not shown — Foreman can\'t hear the operator')
  }

  // Check if all known repos appear
  const reportLower = reportContent.toLowerCase()
  let reposFound = 0
  for (const repo of context.knownRepos) {
    if (reportLower.includes(repo.toLowerCase())) reposFound++
  }
  const repoCoverage = context.knownRepos.length > 0
    ? reposFound / context.knownRepos.length
    : 0
  awareness.score += Math.round(repoCoverage * 3)
  if (repoCoverage < 1) {
    const missing = context.knownRepos.filter((r) => !reportLower.includes(r.toLowerCase()))
    awareness.reasons.push(`MISSING repos: ${missing.join(', ')}`)
  } else {
    awareness.reasons.push(`All ${context.knownRepos.length} repos represented`)
  }

  // Check blocked work detection
  if (context.blockedSessions > 0) {
    if (reportContent.includes('## Blocked Work')) {
      awareness.score += 2
      awareness.reasons.push('Blocked work section present')
    } else {
      awareness.reasons.push('MISSING: Blocked work exists but not reported')
    }
  } else {
    awareness.score += 2
    awareness.reasons.push('No blocked work (correct)')
  }

  dimensions.push(awareness)

  // 2. Prioritization
  const prioritization: JudgeDimension = { name: 'prioritization', score: 0, maxScore: 10, reasons: [] }

  // Check if priorities are assigned
  const priorityMatches = reportContent.match(/\(p\d+/g) ?? []
  if (priorityMatches.length > 0) {
    prioritization.score += 3
    prioritization.reasons.push(`${priorityMatches.length} sessions have priorities`)
  } else {
    prioritization.reasons.push('No priority assignments visible')
  }

  // Check if blocked work has highest priority
  if (context.blockedSessions > 0 && reportContent.includes('p9')) {
    prioritization.score += 3
    prioritization.reasons.push('Blocked sessions correctly at p9')
  } else if (context.blockedSessions > 0) {
    prioritization.reasons.push('Blocked sessions not at highest priority')
  } else {
    prioritization.score += 3
  }

  // Check if stale repos are flagged
  if (reportContent.includes('## Stale Repos') || reportContent.includes('stale')) {
    prioritization.score += 2
    prioritization.reasons.push('Stale repos identified')
  } else {
    prioritization.reasons.push('No staleness detection')
  }

  // Changes section exists
  if (reportContent.includes('## Changes Today')) {
    prioritization.score += 2
    prioritization.reasons.push('Changes tracked')
  }

  dimensions.push(prioritization)

  // 3. Action Quality
  const actionQuality: JudgeDimension = { name: 'action_quality', score: 0, maxScore: 10, reasons: [] }

  if (reportContent.includes('## Proposed Actions')) {
    actionQuality.score += 2
    actionQuality.reasons.push('Proposed actions section present')
  }

  // Check if actions are specific
  if (reportContent.includes('no known recipe') && context.blockedSessions > 0) {
    actionQuality.score += 2
    actionQuality.reasons.push('Correctly identifies lack of recipe (honest about capability gap)')
  }

  // Deduct if no actions proposed when there should be
  if (context.blockedSessions > 0 && reportContent.includes('No actions proposed')) {
    actionQuality.reasons.push('PROBLEM: Blocked sessions exist but no actions proposed')
  } else if (context.blockedSessions === 0 && reportContent.includes('No actions proposed')) {
    actionQuality.score += 3
    actionQuality.reasons.push('Correctly no actions when nothing blocked')
  }

  // Check for review questions (meta-awareness)
  const reviewQuestions = (reportContent.match(/Review question/g) ?? []).length
  if (reviewQuestions >= 3) {
    actionQuality.score += 3
    actionQuality.reasons.push(`${reviewQuestions} review prompts for human judgment`)
  } else if (reviewQuestions > 0) {
    actionQuality.score += 1
    actionQuality.reasons.push(`Only ${reviewQuestions} review prompts`)
  }

  dimensions.push(actionQuality)

  // 4. Completeness
  const completeness: JudgeDimension = { name: 'completeness', score: 0, maxScore: 10, reasons: [] }

  const sections = [
    'Proposed Actions', 'Discoveries', 'Changes Today',
    'Portfolio Snapshot', 'Review Checklist',
  ]
  let sectionsFound = 0
  for (const section of sections) {
    if (reportContent.includes(`## ${section}`)) sectionsFound++
  }
  completeness.score += Math.round((sectionsFound / sections.length) * 4)
  completeness.reasons.push(`${sectionsFound}/${sections.length} expected sections present`)

  // Bonus sections
  if (reportContent.includes('Session Activity') || reportContent.includes('What You Said')) {
    completeness.score += 2
    completeness.reasons.push('Session activity data included')
  }
  if (reportContent.includes('Stale Repos')) {
    completeness.score += 2
    completeness.reasons.push('Staleness analysis included')
  }
  if (reportContent.includes('Cross-repo')) {
    completeness.score += 2
    completeness.reasons.push('Cross-repo insights included')
  }

  dimensions.push(completeness)

  // 5. Judgment
  const judgment: JudgeDimension = { name: 'judgment', score: 0, maxScore: 10, reasons: [] }

  // Does it have enough data to be useful?
  if (context.recentUserMessages > 10) {
    judgment.score += 2
    judgment.reasons.push(`${context.recentUserMessages} recent user messages analyzed`)
  } else if (context.recentUserMessages > 0) {
    judgment.score += 1
    judgment.reasons.push(`Only ${context.recentUserMessages} user messages — thin data`)
  } else {
    judgment.reasons.push('MISSING: No user messages analyzed — can\'t model operator intent')
  }

  // Non-obvious insights?
  if (reportContent.includes('Suggested CLAUDE.md rules')) {
    judgment.score += 3
    judgment.reasons.push('Generating actionable suggestions from patterns')
  }

  // Would this change what the user does today?
  const hasActionableContent = reportContent.includes('FAIL') ||
    reportContent.includes('Blocked') ||
    reportContent.includes('Stale') ||
    reportContent.includes('recipe')
  if (hasActionableContent) {
    judgment.score += 3
    judgment.reasons.push('Report contains actionable findings')
  } else {
    judgment.reasons.push('Report is informational only — wouldn\'t change today\'s plan')
  }

  if (reportContent.includes('Review Checklist')) {
    judgment.score += 2
    judgment.reasons.push('Review checklist present for human feedback')
  }

  dimensions.push(judgment)

  // Compute overall
  const totalScore = dimensions.reduce((sum, d) => sum + d.score, 0)
  const totalMax = dimensions.reduce((sum, d) => sum + d.maxScore, 0)

  const recommendations: string[] = []
  for (const d of dimensions) {
    if (d.score < d.maxScore * 0.5) {
      recommendations.push(`Improve ${d.name}: ${d.reasons.filter((r) => r.startsWith('MISSING') || r.startsWith('PROBLEM')).join('; ')}`)
    }
  }

  return {
    timestamp: new Date().toISOString(),
    artifact: `daily-report-${new Date().toISOString().slice(0, 10)}`,
    artifactType: 'daily-report',
    dimensions,
    overallScore: totalScore,
    maxScore: totalMax,
    summary: `${totalScore}/${totalMax} (${((totalScore / totalMax) * 100).toFixed(0)}%)`,
    recommendations,
  }
}

export function renderJudgment(j: ForemanJudgment): string {
  const lines: string[] = []
  lines.push(`## Judge Score: ${j.summary}`)
  lines.push('')

  for (const d of j.dimensions) {
    const bar = '█'.repeat(d.score) + '░'.repeat(d.maxScore - d.score)
    lines.push(`**${d.name}** ${bar} ${d.score}/${d.maxScore}`)
    for (const r of d.reasons) {
      lines.push(`  - ${r}`)
    }
    lines.push('')
  }

  if (j.recommendations.length > 0) {
    lines.push('### Recommendations')
    for (const r of j.recommendations) {
      lines.push(`- ${r}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
