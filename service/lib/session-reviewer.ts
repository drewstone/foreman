/**
 * Session reviewer — Foreman's brain for post-session decisions.
 *
 * When a CC session completes (via Stop hook), the reviewer:
 * 1. Reads the full session JSONL transcript
 * 2. Evaluates what was accomplished vs what was asked
 * 3. Checks deliverables (files exist, tests pass)
 * 4. Decides: what to dispatch next, with full Foreman context
 *
 * The dispatched agent doesn't need to know about Foreman.
 * The reviewer IS Foreman — it has goals, decisions, taste, confidence.
 */

import { readSessionTranscript, type SessionSummary } from './session-reader.js'
import { callClaudeForJSON } from './claude-runner.js'
import {
  getDb, getStmts, getConfidence,
  log, emitEvent, sendNotification,
} from './state.js'

export interface ReviewResult {
  status: 'success' | 'failure' | 'partial'
  summary: string
  qualityScore: number        // 1-10
  stepsCompleted: string[]
  deliverablesMet: boolean
  learnings: string[]
  nextDispatch: {
    skill: string
    task: string
    reasoning: string
  } | null
  shouldContinue: boolean     // should Foreman auto-dispatch next?
}

/**
 * Review a completed session and decide what happens next.
 */
export async function reviewSession(opts: {
  sessionId: string
  transcriptPath: string
  cwd: string
  lastAssistantMessage: string
  decisionId: number
  skill: string
  task: string
  goalIntent: string
  goalId: number | null
}): Promise<ReviewResult> {
  const db = getDb()
  const stmts = getStmts()
  const confidence = getConfidence()

  // 1. Read the full transcript
  const transcript = readSessionTranscript(opts.transcriptPath)

  // 2. Gather Foreman context for the reviewer
  const recentDecisions = stmts.goalDecisions
    ? (stmts.goalDecisions.all(opts.goalId ?? 0) as Array<{
        skill: string, task: string, status: string, outcome: string | null
      }>).slice(0, 8)
    : []

  const deadEnds = db.prepare(
    `SELECT content FROM learnings WHERE type = 'dead_end' ORDER BY created_at DESC LIMIT 5`
  ).all() as Array<{ content: string }>

  const sessionRecs = db.prepare(
    `SELECT content FROM learnings WHERE type = 'session_recommendation' ORDER BY created_at DESC LIMIT 5`
  ).all() as Array<{ content: string }>

  const tasteSignals = stmts.listTaste.all(5) as Array<{ pattern: string }>

  // 3. Build the tool call summary from transcript
  const toolSummary = transcript
    ? summarizeToolCalls(transcript)
    : 'No transcript available'

  // 4. Build reviewer prompt with full Foreman context
  const prompt = `You are Foreman's session reviewer. A Claude Code session just completed. Your job:
1. Assess what was accomplished vs what was asked
2. Rate quality honestly (1-10)
3. Decide what Foreman should dispatch next

## Session Details
- Skill: ${opts.skill || 'direct'}
- Task: ${opts.task}
- Goal: ${opts.goalIntent}
- Session: ${opts.sessionId}
- Turns: ${transcript?.turnCount ?? '?'}
- Tool calls: ${transcript?.toolCalls.length ?? '?'}
- Tokens: ${transcript ? `${transcript.totalInputTokens} in / ${transcript.totalOutputTokens} out` : '?'}

## What the session did (tool call summary)
${toolSummary}

## Last assistant message
${opts.lastAssistantMessage.slice(-3000)}

## Foreman Context
${recentDecisions.length > 0 ? `### Recent decisions on this goal\n${recentDecisions.map(d => `- [${d.status}] ${d.skill} — ${d.task.slice(0, 80)}${d.outcome ? ` → ${d.outcome.slice(0, 60)}` : ''}`).join('\n')}` : ''}

${deadEnds.length > 0 ? `### Dead ends (DO NOT retry)\n${deadEnds.map(d => `- ${d.content.slice(0, 120)}`).join('\n')}` : ''}

${sessionRecs.length > 0 ? `### Past session recommendations\n${sessionRecs.map(r => `- ${r.content.slice(0, 120)}`).join('\n')}` : ''}

${tasteSignals.length > 0 ? `### Operator taste\n${tasteSignals.map(t => `- ${t.pattern}`).join('\n')}` : ''}

## Available skills for next dispatch
- /evolve — iterative improvement toward a measurable target
- /pursue — architectural redesign, generational leaps
- /verify — check correctness, run tests
- /polish — relentless quality loop
- /converge — drive CI to green
- /critical-audit — parallel security/quality audit
- /diagnose — analyze failures
- /research — hypothesis-driven experimentation

Respond with JSON only:
{
  "status": "success" | "failure" | "partial",
  "summary": "2-3 sentences — what was accomplished",
  "qualityScore": 1-10,
  "stepsCompleted": ["step 1", "step 2"],
  "deliverablesMet": true/false,
  "learnings": ["insight 1", "insight 2"],
  "nextDispatch": {"skill": "/verify", "task": "specific task", "reasoning": "why"} or null,
  "shouldContinue": true/false
}`

  try {
    const parsed = await callClaudeForJSON(prompt) as any
    if (!parsed) {
      return fallbackReview(opts, transcript)
    }

    return {
      status: parsed.status ?? 'partial',
      summary: parsed.summary ?? '',
      qualityScore: typeof parsed.qualityScore === 'number' ? parsed.qualityScore : 5,
      stepsCompleted: Array.isArray(parsed.stepsCompleted) ? parsed.stepsCompleted : [],
      deliverablesMet: typeof parsed.deliverablesMet === 'boolean' ? parsed.deliverablesMet : false,
      learnings: Array.isArray(parsed.learnings) ? parsed.learnings.map(String) : [],
      nextDispatch: parsed.nextDispatch?.skill ? parsed.nextDispatch : null,
      shouldContinue: typeof parsed.shouldContinue === 'boolean' ? parsed.shouldContinue : false,
    }
  } catch (e) {
    log(`Session reviewer failed: ${e instanceof Error ? e.message : String(e)}`)
    return fallbackReview(opts, transcript)
  }
}

/**
 * Fallback when the LLM reviewer fails — use heuristics from transcript.
 */
function fallbackReview(
  opts: { task: string, skill: string },
  transcript: SessionSummary | null,
): ReviewResult {
  const hasToolCalls = (transcript?.toolCalls.length ?? 0) > 0
  const hasGitCommits = transcript?.toolCalls.some(t =>
    t.name === 'Bash' && JSON.stringify(t.input).includes('git commit')
  ) ?? false

  return {
    status: hasGitCommits ? 'success' : hasToolCalls ? 'partial' : 'failure',
    summary: `Session completed with ${transcript?.turnCount ?? 0} turns and ${transcript?.toolCalls.length ?? 0} tool calls.`,
    qualityScore: hasGitCommits ? 6 : 3,
    stepsCompleted: [],
    deliverablesMet: false,
    learnings: [],
    nextDispatch: null,
    shouldContinue: false,
  }
}

/**
 * Pairwise tournament ranking for multiple session outcomes.
 *
 * When Foreman has N completed sessions targeting the same goal (e.g., parallel
 * meta-harness proposers, or /evolve dispatches), rank them by pairwise comparison
 * instead of taking the last one or the highest single-shot score.
 *
 * Inspired by LLM-as-a-Verifier (llm-as-a-verifier/llm-as-a-verifier):
 * pairwise comparison is more calibrated than absolute rating.
 */
export async function rankSessionOutcomes(outcomes: Array<{
  sessionId: string
  summary: string
  qualityScore: number
  stepsCompleted: string[]
}>): Promise<Array<{ sessionId: string; tournamentScore: number; wins: number }>> {
  if (outcomes.length <= 1) {
    return outcomes.map(o => ({ sessionId: o.sessionId, tournamentScore: o.qualityScore * 10, wins: 0 }))
  }

  const criteria = [
    'completeness — which session accomplished more of the goal',
    'quality — which session produced cleaner, more correct output',
    'efficiency — which session wasted fewer steps on dead ends',
  ]

  const wins = new Map<string, number>()
  for (const o of outcomes) wins.set(o.sessionId, 0)

  // All pairs
  const pairs: [number, number][] = []
  for (let i = 0; i < outcomes.length; i++) {
    for (let j = i + 1; j < outcomes.length; j++) {
      pairs.push([i, j])
    }
  }

  // Run pairwise comparisons in parallel
  const comparisons = pairs.flatMap(([i, j]) =>
    criteria.map(crit => ({ i, j, crit }))
  )

  const results = await Promise.allSettled(comparisons.map(async ({ i, j, crit }) => {
    const flip = Math.random() > 0.5
    const [aIdx, bIdx] = flip ? [j, i] : [i, j]
    const a = outcomes[aIdx!]!
    const b = outcomes[bIdx!]!

    const prompt = `Compare two session outcomes on: "${crit}". Reply JSON only: {"winner": "A" or "B", "confidence": 0.0-1.0}

Session A (${a.sessionId}):
${a.summary}
Steps: ${a.stepsCompleted.join(', ')}
Score: ${a.qualityScore}/10

Session B (${b.sessionId}):
${b.summary}
Steps: ${b.stepsCompleted.join(', ')}
Score: ${b.qualityScore}/10`

    const result = await callClaudeForJSON(prompt, 'haiku')
    if (!result || !result.winner) return null

    const winnerIdx = result.winner === 'A' ? aIdx! : bIdx!
    const confidence = typeof result.confidence === 'number' ? result.confidence : 0.5
    return { winner: outcomes[winnerIdx]!.sessionId, confidence }
  }))

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      wins.set(r.value.winner, (wins.get(r.value.winner) ?? 0) + r.value.confidence)
    }
  }

  const maxWins = Math.max(...wins.values(), 1)
  return outcomes
    .map(o => ({
      sessionId: o.sessionId,
      tournamentScore: ((wins.get(o.sessionId) ?? 0) / maxWins) * 100,
      wins: wins.get(o.sessionId) ?? 0,
    }))
    .sort((a, b) => b.tournamentScore - a.tournamentScore)
}

/**
 * Summarize tool calls into a readable format for the reviewer.
 */
function summarizeToolCalls(transcript: SessionSummary): string {
  if (transcript.toolCalls.length === 0) return 'No tool calls recorded.'

  // Group by tool name and count
  const counts = new Map<string, number>()
  const examples = new Map<string, string[]>()

  for (const tc of transcript.toolCalls) {
    counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1)
    const existing = examples.get(tc.name) ?? []
    if (existing.length < 3) {
      // Extract a short description from input
      const input = tc.input
      let desc = ''
      if (tc.name === 'Bash' && input.command) desc = String(input.command).slice(0, 80)
      else if (tc.name === 'Read' && input.file_path) desc = String(input.file_path)
      else if (tc.name === 'Write' && input.file_path) desc = `→ ${String(input.file_path)}`
      else if (tc.name === 'Edit' && input.file_path) desc = `${String(input.file_path)}`
      else if (tc.name === 'Grep' && input.pattern) desc = `/${String(input.pattern).slice(0, 40)}/`
      else if (tc.name === 'Glob' && input.pattern) desc = String(input.pattern)
      else desc = JSON.stringify(input).slice(0, 60)

      if (desc) existing.push(desc)
      examples.set(tc.name, existing)
    }
  }

  const lines: string[] = [`${transcript.toolCalls.length} total tool calls:`]
  for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${name}: ${count}x`)
    const exs = examples.get(name) ?? []
    for (const ex of exs) lines.push(`    ${ex}`)
  }

  // Extract git commits specifically
  const gitCommits = transcript.toolCalls
    .filter(t => t.name === 'Bash' && JSON.stringify(t.input).includes('git commit'))
    .map(t => String((t.input as any).command ?? '').slice(0, 100))

  if (gitCommits.length > 0) {
    lines.push(`\nGit commits:`)
    for (const c of gitCommits) lines.push(`- ${c}`)
  }

  return lines.join('\n')
}
