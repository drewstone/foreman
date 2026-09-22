/**
 * Learned Dispatch Policy
 *
 * Uses AxGEPA to optimize staged dispatch selection from outcome data.
 * The learned policy chooses a constrained mode + skill pair. Task text is
 * synthesized deterministically from that action and current state.
 *
 * Pluggable: Identity (use post-completion recommendation or heuristic),
 * LLM (single Claude call to reason about next step), GEPA (optimized).
 */

import type Database from 'better-sqlite3'
import { callClaudeForJSON } from './claude-runner.js'
import { getDb } from './state.js'
import { getDispatchPolicyControl } from './policy-control.js'

export type DispatchMode = 'advance' | 'recover' | 'verify' | 'redesign' | 'stop'
export type DispatchBudgetStatus = 'ok' | 'blocked'
export type DispatchDeliverableStatus = 'pass' | 'fail' | 'unchecked' | 'unknown'
export type DispatchProjectPhase = 'fresh' | 'active' | 'recovery' | 'validated'

export interface DispatchDecision {
  skill: string
  task: string
  reasoning: string
  mode?: DispatchMode
}

export interface DispatchContext {
  goalIntent: string
  projectName: string
  recentDecisions: Array<{
    skill: string
    status: string
    outcome: string | null
  }>
  learnedFlows: string[]
  skillPreferences: string[]
  operatorSkillSignals: string[]
  confidenceLevel: string
  candidateSkills: string[]
  budgetStatus: DispatchBudgetStatus
  latestDeliverableStatus: DispatchDeliverableStatus
  projectPhase: DispatchProjectPhase
}

export interface DispatchPolicy {
  name: string
  decide(ctx: DispatchContext): Promise<DispatchDecision>
}

export interface DispatchTrainingExample {
  createdAt: string
  decisionId?: number
  sessionName?: string | null
  operatorSessionId?: string
  context: DispatchContext
  decision: DispatchDecision
  outcome: 'success' | 'failure'
  source: 'decision' | 'operator_session'
}

interface DispatchAction {
  mode: DispatchMode
  skill: string
  reasoning: string
}

interface OperatorSessionRow {
  id: string
  repo: string | null
  harness: string
  timestamp: string
  user_messages: string | null
  skills_used: string | null
  outcome_signals: string | null
}

const DISPATCH_MODES: DispatchMode[] = ['advance', 'recover', 'verify', 'redesign', 'stop']
export const DEFAULT_DISPATCH_SKILLS = [
  '/evolve',
  '/pursue',
  '/polish',
  '/verify',
  '/converge',
  '/critical-audit',
  '/research',
  '/diagnose',
] as const

const MODE_TO_SKILLS: Record<DispatchMode, readonly string[]> = {
  advance: ['/evolve', '/polish', '/research'],
  recover: ['/diagnose', '/converge', '/research'],
  verify: ['/verify', '/critical-audit'],
  redesign: ['/pursue', '/research', '/evolve'],
  stop: ['/verify', '/critical-audit'],
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out = new Set<string>()
  for (const value of values) {
    if (!value || typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) out.add(trimmed)
  }
  return [...out]
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit)
}

function normalizeProjectName(projectName: string): string {
  const trimmed = projectName.trim()
  if (!trimmed) return 'unknown'
  const parts = trimmed.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? trimmed
}

function normalizeDeliverableStatus(status: string | null | undefined): DispatchDeliverableStatus {
  if (status === 'pass' || status === 'fail' || status === 'unchecked') return status
  return 'unknown'
}

function normalizeBudgetStatus(status: string | null | undefined): DispatchBudgetStatus {
  return status === 'blocked' ? 'blocked' : 'ok'
}

function normalizeCandidateSkills(skills?: string[]): string[] {
  const requested = uniqueStrings(skills ?? [])
  if (requested.length === 0) return [...DEFAULT_DISPATCH_SKILLS]

  const allowed = requested.filter(skill => DEFAULT_DISPATCH_SKILLS.includes(skill as typeof DEFAULT_DISPATCH_SKILLS[number]))
  return allowed.length > 0 ? allowed : [...DEFAULT_DISPATCH_SKILLS]
}

function deriveProjectPhase(
  recentDecisions: DispatchContext['recentDecisions'],
  latestDeliverableStatus: DispatchDeliverableStatus,
): DispatchProjectPhase {
  const last = recentDecisions[0]
  if (!last) return 'fresh'
  if (latestDeliverableStatus === 'pass' || last.skill === '/verify' || last.skill === '/critical-audit') {
    return 'validated'
  }
  if (latestDeliverableStatus === 'fail' || last.status === 'failure') return 'recovery'
  return 'active'
}

export function createDispatchContext(input: {
  goalIntent: string
  projectName: string
  recentDecisions: DispatchContext['recentDecisions']
  learnedFlows?: string[]
  skillPreferences?: string[]
  operatorSkillSignals?: string[]
  confidenceLevel?: string
  candidateSkills?: string[]
  budgetStatus?: DispatchBudgetStatus
  latestDeliverableStatus?: DispatchDeliverableStatus | string | null
  projectPhase?: DispatchProjectPhase
}): DispatchContext {
  const recentDecisions = (input.recentDecisions ?? []).slice(0, 5).map(item => ({
    skill: item.skill,
    status: item.status,
    outcome: item.outcome ?? null,
  }))
  const latestDeliverableStatus = normalizeDeliverableStatus(input.latestDeliverableStatus)

  return {
    goalIntent: truncate(input.goalIntent.trim() || 'Continue improving the project', 200),
    projectName: normalizeProjectName(input.projectName),
    recentDecisions,
    learnedFlows: uniqueStrings((input.learnedFlows ?? []).map(value => truncate(value, 200))).slice(0, 10),
    skillPreferences: uniqueStrings((input.skillPreferences ?? []).map(value => truncate(value, 200))).slice(0, 10),
    operatorSkillSignals: uniqueStrings((input.operatorSkillSignals ?? []).map(value => truncate(value, 200))).slice(0, 10),
    confidenceLevel: input.confidenceLevel?.trim() || 'dry-run',
    candidateSkills: normalizeCandidateSkills(input.candidateSkills),
    budgetStatus: normalizeBudgetStatus(input.budgetStatus),
    latestDeliverableStatus,
    projectPhase: input.projectPhase ?? deriveProjectPhase(recentDecisions, latestDeliverableStatus),
  }
}

function countRecent(recentDecisions: DispatchContext['recentDecisions'], status: 'success' | 'failure'): number {
  return recentDecisions.filter(item => item.status === status).length
}

function getModeSkills(mode: DispatchMode, ctx: DispatchContext): string[] {
  const allowed = MODE_TO_SKILLS[mode].filter(skill => ctx.candidateSkills.includes(skill))
  return allowed.length > 0 ? allowed : ctx.candidateSkills
}

function isSkillAllowedForMode(mode: DispatchMode, skill: string, ctx: DispatchContext): boolean {
  return getModeSkills(mode, ctx).includes(skill)
}

function preferSkill(mode: DispatchMode, ctx: DispatchContext, preferred?: string): string {
  if (preferred && isSkillAllowedForMode(mode, preferred, ctx)) return preferred
  const available = getModeSkills(mode, ctx)
  if (available.length === 0) return ctx.candidateSkills[0] ?? '/evolve'
  const last = ctx.recentDecisions[0]?.skill
  if (last && available.includes(last) && mode === 'advance') return last
  return available[0]
}

export function inferDispatchMode(
  skill: string,
  ctx?: Pick<DispatchContext, 'recentDecisions' | 'latestDeliverableStatus'>,
): DispatchMode {
  if (skill === '/verify' || skill === '/critical-audit') return 'verify'
  if (skill === '/pursue') return 'redesign'
  if (skill === '/diagnose' || skill === '/converge') return 'recover'
  if (ctx?.latestDeliverableStatus === 'fail') return 'recover'
  return 'advance'
}

export function synthesizeDispatchTask(
  action: Pick<DispatchAction, 'mode' | 'skill'>,
  ctx: DispatchContext,
): string {
  const goal = truncate(ctx.goalIntent, 200)
  const last = ctx.recentDecisions[0]
  const lastSummary = last ? `${last.skill} (${last.status})` : 'no prior dispatches'

  switch (action.mode) {
    case 'recover':
      if (action.skill === '/converge') {
        return `Repair the failing state for: ${goal}. Focus on broken tests, CI, or integration regressions from ${lastSummary}.`
      }
      if (action.skill === '/research') {
        return `Run a targeted failure investigation for: ${goal}. Reproduce the issue, isolate the cause, and identify the safest next move after ${lastSummary}.`
      }
      return `Diagnose the failure path for: ${goal}. Isolate root cause from ${lastSummary} and apply the next safe corrective step.`
    case 'verify':
      if (action.skill === '/critical-audit') {
        return `Audit the latest progress for: ${goal}. Check correctness, regressions, and risk before more implementation.`
      }
      return `Verify the latest progress for: ${goal}. Run the most relevant checks and confirm deliverable status.`
    case 'redesign':
      if (action.skill === '/research') {
        return `Research alternative approaches for: ${goal}. Compare options and identify a better design than the current path from ${lastSummary}.`
      }
      if (action.skill === '/evolve') {
        return `Push the project forward with a materially different implementation strategy for: ${goal}. Avoid repeating ${lastSummary}.`
      }
      return `Redesign the current approach for: ${goal}. Focus on architectural improvement instead of another local patch.`
    case 'stop':
      return `Pause new implementation work for: ${goal}. Summarize current state, constraints, and what must change before dispatching again.`
    case 'advance':
    default:
      if (action.skill === '/polish') {
        return `Polish the latest working state for: ${goal}. Improve quality, clarity, and finish details without changing scope.`
      }
      if (action.skill === '/research') {
        return `Run a targeted experiment to move ${goal} forward. Use current evidence from ${lastSummary} and keep the experiment bounded.`
      }
      return last?.status === 'success'
        ? `Continue improving: ${goal}. Build directly on the last successful move from ${lastSummary}.`
        : `Start improving: ${goal}. Make the next concrete implementation step and establish momentum.`
  }
}

function finalizeDecision(
  ctx: DispatchContext,
  action: DispatchAction,
): DispatchDecision {
  const skill = preferSkill(action.mode, ctx, action.skill)
  return {
    skill,
    task: synthesizeDispatchTask({ mode: action.mode, skill }, ctx),
    reasoning: action.reasoning,
    mode: action.mode,
  }
}

function serializeRecentHistory(ctx: DispatchContext): string {
  return ctx.recentDecisions.slice(0, 4)
    .map(item => `${item.skill}->${item.status}${item.outcome ? `:${truncate(item.outcome, 60)}` : ''}`)
    .join(', ')
}

function serializeSignals(values: string[], empty = 'none'): string {
  return values.slice(0, 4).join('; ') || empty
}

function validateMode(value: unknown): DispatchMode {
  return typeof value === 'string' && DISPATCH_MODES.includes(value as DispatchMode)
    ? value as DispatchMode
    : 'advance'
}

function parseActionResult(
  ctx: DispatchContext,
  input: { mode?: unknown, skill?: unknown, reasoning?: unknown },
  fallbackReasoning: string,
): DispatchDecision {
  const mode = validateMode(input.mode)
  const preferredSkill = typeof input.skill === 'string' ? input.skill : undefined
  return finalizeDecision(ctx, {
    mode,
    skill: preferSkill(mode, ctx, preferredSkill),
    reasoning: typeof input.reasoning === 'string' && input.reasoning.trim()
      ? input.reasoning.trim()
      : fallbackReasoning,
  })
}

export function listOperatorSkillSignals(
  db: Database.Database,
  options?: { projectName?: string | null, before?: string, limit?: number },
): string[] {
  try {
    const limit = options?.limit ?? 5
    const params: unknown[] = []
    const filters = [`skills_used IS NOT NULL`, `skills_used != '[]'`]
    if (options?.before) {
      filters.push(`timestamp <= ?`)
      params.push(options.before)
    }
    if (options?.projectName) {
      filters.push(`repo LIKE ?`)
      params.push(`%${options.projectName}%`)
    }

    const rows = db.prepare(`
      SELECT repo, skills_used
      FROM operator_sessions
      WHERE ${filters.join(' AND ')}
      ORDER BY timestamp DESC
      LIMIT 50
    `).all(...params) as Array<{ repo: string | null, skills_used: string | null }>

    const counts = new Map<string, number>()
    for (const row of rows) {
      if (!row.skills_used) continue
      try {
        const skills = JSON.parse(row.skills_used) as unknown[]
        for (const skill of skills) {
          if (typeof skill !== 'string' || !DEFAULT_DISPATCH_SKILLS.includes(skill as typeof DEFAULT_DISPATCH_SKILLS[number])) continue
          counts.set(skill, (counts.get(skill) ?? 0) + 1)
        }
      } catch {}
    }

    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit)
      .map(([skill, count]) => `${skill}(${count}) from operator sessions`)
  } catch {
    return []
  }
}

function listHistoricalLearnings(
  db: Database.Database,
  type: string,
  createdAt: string,
  limit: number,
): string[] {
  try {
    const rows = db.prepare(`
      SELECT content
      FROM learnings
      WHERE type = ? AND created_at <= ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(type, createdAt, limit) as Array<{ content: string }>
    return rows.map(row => row.content)
  } catch {
    return []
  }
}

function listHistoricalDecisions(
  db: Database.Database,
  input: { decisionId: number, goalId: number | null, projectPath: string | null, limit: number },
): DispatchContext['recentDecisions'] {
  try {
    if (input.goalId != null) {
      return db.prepare(`
        SELECT skill, status, outcome
        FROM decisions
        WHERE id < ? AND goal_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(input.decisionId, input.goalId, input.limit) as DispatchContext['recentDecisions']
    }
    if (input.projectPath) {
      return db.prepare(`
        SELECT skill, status, outcome
        FROM decisions
        WHERE id < ? AND worktree_path LIKE ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(input.decisionId, `%${input.projectPath}%`, input.limit) as DispatchContext['recentDecisions']
    }
  } catch {}
  return []
}

function getHistoricalDeliverableStatus(
  db: Database.Database,
  input: { decisionId: number, goalId: number | null, projectPath: string | null },
): DispatchDeliverableStatus {
  try {
    if (input.goalId != null) {
      const row = db.prepare(`
        SELECT deliverable_status
        FROM decisions
        WHERE id < ? AND goal_id = ? AND deliverable_status IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(input.decisionId, input.goalId) as { deliverable_status?: string | null } | undefined
      return normalizeDeliverableStatus(row?.deliverable_status)
    }
    if (input.projectPath) {
      const row = db.prepare(`
        SELECT deliverable_status
        FROM decisions
        WHERE id < ? AND worktree_path LIKE ? AND deliverable_status IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(input.decisionId, `%${input.projectPath}%`) as { deliverable_status?: string | null } | undefined
      return normalizeDeliverableStatus(row?.deliverable_status)
    }
  } catch {}
  return 'unknown'
}

function classifyOperatorOutcome(outcomeSignals: string[]): 'success' | 'failure' | null {
  const sawSuccess = outcomeSignals.includes('success')
  const sawFailure = outcomeSignals.includes('failure')
  if (sawSuccess && !sawFailure) return 'success'
  if (sawFailure && !sawSuccess) return 'failure'
  return null
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function inferGoalIntentFromMessages(messages: string[]): string | null {
  for (const message of messages) {
    const trimmed = message.trim()
    if (!trimmed) continue
    if (!trimmed.startsWith('/')) return truncate(trimmed.replace(/\s+/g, ' '), 200)
  }
  const fallback = messages.find(message => message.trim())
  return fallback ? truncate(fallback.replace(/\s+/g, ' '), 200) : null
}

function buildOperatorSessionExamples(
  db: Database.Database,
  rows: OperatorSessionRow[],
): DispatchTrainingExample[] {
  const examples: DispatchTrainingExample[] = []

  for (const row of rows) {
    const skills = parseStringArray(row.skills_used)
      .filter(skill => DEFAULT_DISPATCH_SKILLS.includes(skill as typeof DEFAULT_DISPATCH_SKILLS[number]))
    const outcomeSignals = parseStringArray(row.outcome_signals)
    const outcome = classifyOperatorOutcome(outcomeSignals)
    if (skills.length === 0 || !outcome) continue

    const messages = parseStringArray(row.user_messages)
    const goalIntent = inferGoalIntentFromMessages(messages)
    if (!goalIntent) continue

    const projectName = normalizeProjectName(row.repo ?? row.harness)
    const learnedFlows = listHistoricalLearnings(db, 'flow', row.timestamp, 5)
    const skillPreferences = listHistoricalLearnings(db, 'skill_preference', row.timestamp, 5)
    const operatorSkillSignals = listOperatorSkillSignals(db, { projectName, before: row.timestamp, limit: 5 })

    for (let index = 0; index < Math.min(skills.length, 3); index++) {
      const skill = skills[index]
      const recentDecisions = skills
        .slice(0, index)
        .reverse()
        .map(previous => ({ skill: previous, status: 'seen', outcome: null }))

      const ctx = createDispatchContext({
        goalIntent,
        projectName,
        recentDecisions,
        learnedFlows,
        skillPreferences,
        operatorSkillSignals,
        confidenceLevel: 'operator',
        latestDeliverableStatus: 'unknown',
      })
      const mode = inferDispatchMode(skill, ctx)
      examples.push({
        createdAt: row.timestamp,
        operatorSessionId: row.id,
        context: ctx,
        decision: {
          skill,
          task: synthesizeDispatchTask({ mode, skill }, ctx),
          reasoning: 'operator session prior',
          mode,
        },
        outcome,
        source: 'operator_session',
      })
    }
  }

  return examples
}

export function buildDispatchTrainingData(
  db: Database.Database,
  options?: { decisionLimit?: number, operatorSessionLimit?: number },
): DispatchTrainingExample[] {
  const decisionLimit = options?.decisionLimit ?? 60
  const operatorSessionLimit = options?.operatorSessionLimit ?? 40

  const decisions = db.prepare(`
    SELECT d.id, d.skill, d.task, d.status, d.outcome, d.goal_id, d.created_at, d.session_name,
           d.deliverable_status, g.intent as goal_intent, COALESCE(g.workspace_path, d.worktree_path) as project_path
    FROM decisions d
    LEFT JOIN goals g ON g.id = d.goal_id
    WHERE d.status IN ('success', 'failure') AND d.skill != ''
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT ?
  `).all(decisionLimit) as Array<{
    id: number
    skill: string
    task: string
    status: 'success' | 'failure'
    outcome: string | null
    goal_id: number | null
    created_at: string
    session_name: string | null
    deliverable_status: string | null
    goal_intent: string | null
    project_path: string | null
  }>

  const decisionExamples = decisions.map(row => {
    const recentDecisions = listHistoricalDecisions(db, {
      decisionId: row.id,
      goalId: row.goal_id,
      projectPath: row.project_path,
      limit: 5,
    })
    const projectName = normalizeProjectName(row.project_path ?? 'unknown')
    const ctx = createDispatchContext({
      goalIntent: row.goal_intent ?? row.task,
      projectName,
      recentDecisions,
      learnedFlows: listHistoricalLearnings(db, 'flow', row.created_at, 8),
      skillPreferences: listHistoricalLearnings(db, 'skill_preference', row.created_at, 8),
      operatorSkillSignals: listOperatorSkillSignals(db, {
        projectName,
        before: row.created_at,
        limit: 5,
      }),
      confidenceLevel: 'dry-run',
      latestDeliverableStatus: getHistoricalDeliverableStatus(db, {
        decisionId: row.id,
        goalId: row.goal_id,
        projectPath: row.project_path,
      }),
    })
    const mode = inferDispatchMode(row.skill, ctx)

    return {
      createdAt: row.created_at,
      decisionId: row.id,
      sessionName: row.session_name,
      context: ctx,
      decision: {
        skill: row.skill,
        task: truncate(row.task, 200),
        reasoning: '',
        mode,
      },
      outcome: row.status,
      source: 'decision' as const,
    }
  })

  const operatorSessions = db.prepare(`
    SELECT id, repo, harness, timestamp, user_messages, skills_used, outcome_signals
    FROM operator_sessions
    WHERE skills_used IS NOT NULL AND skills_used != '[]'
      AND user_messages IS NOT NULL AND user_messages != '[]'
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(operatorSessionLimit) as OperatorSessionRow[]

  return [
    ...decisionExamples,
    ...buildOperatorSessionExamples(db, operatorSessions),
  ]
}

// ─── Identity policy: use heuristic ──────────────────────────────────

export const identityPolicy: DispatchPolicy = {
  name: 'identity',
  async decide(ctx) {
    const last = ctx.recentDecisions[0]
    const skill = preferSkill(last ? inferDispatchMode(last.skill, ctx) : 'advance', ctx, last?.skill)
    return finalizeDecision(ctx, {
      mode: last ? inferDispatchMode(skill, ctx) : 'advance',
      skill,
      reasoning: 'identity policy — repeat last skill',
    })
  },
}

export const heuristicPolicy: DispatchPolicy = {
  name: 'heuristic',
  async decide(ctx) {
    if (ctx.budgetStatus === 'blocked') {
      return finalizeDecision(ctx, {
        mode: 'stop',
        skill: '/verify',
        reasoning: 'heuristic policy — budget is blocked, pause implementation and summarize state',
      })
    }

    const last = ctx.recentDecisions[0]
    const repeatedFailure = ctx.recentDecisions.length >= 2
      && ctx.recentDecisions[0]?.status === 'failure'
      && ctx.recentDecisions[1]?.status === 'failure'
      && ctx.recentDecisions[0]?.skill === ctx.recentDecisions[1]?.skill

    if (!last) {
      return finalizeDecision(ctx, {
        mode: 'advance',
        skill: '/evolve',
        reasoning: 'heuristic policy — no prior decisions, start with evolve',
      })
    }

    if (last.status === 'failure') {
      if (repeatedFailure) {
        return finalizeDecision(ctx, {
          mode: 'redesign',
          skill: '/pursue',
          reasoning: 'heuristic policy — repeated failure suggests architectural change',
        })
      }
      return finalizeDecision(ctx, {
        mode: 'recover',
        skill: ctx.latestDeliverableStatus === 'fail' ? '/converge' : '/diagnose',
        reasoning: 'heuristic policy — analyze the failure before continuing',
      })
    }

    if (last.status === 'success') {
      if (last.skill === '/verify' || last.skill === '/critical-audit') {
        return finalizeDecision(ctx, {
          mode: 'advance',
          skill: '/evolve',
          reasoning: 'heuristic policy — verification passed, continue forward progress',
        })
      }
      return finalizeDecision(ctx, {
        mode: 'verify',
        skill: '/verify',
        reasoning: 'heuristic policy — successful changes should be validated explicitly',
      })
    }

    return identityPolicy.decide(ctx)
  },
}

// ─── LLM policy: Claude reasons about next step ─────────────────────

export const llmPolicy: DispatchPolicy = {
  name: 'llm',
  async decide(ctx) {
    const history = ctx.recentDecisions.slice(0, 5)
      .map(d => `${d.skill} → ${d.status}${d.outcome ? ': ' + d.outcome.slice(0, 80) : ''}`)
      .join('\n')

    const flows = ctx.learnedFlows.slice(0, 3).join('\n')
    const prefs = ctx.skillPreferences.slice(0, 3).join('\n')
    const operatorSignals = ctx.operatorSkillSignals.slice(0, 3).join('\n')
    const availableSkills = ctx.candidateSkills.join(', ')

    const prompt = `You are Foreman's staged dispatch policy. Decide the next action mode and skill.

Goal: ${ctx.goalIntent}
Project: ${ctx.projectName}
Confidence: ${ctx.confidenceLevel}
Project phase: ${ctx.projectPhase}
Budget: ${ctx.budgetStatus}
Latest deliverable status: ${ctx.latestDeliverableStatus}

Recent dispatches:
${history || 'None yet'}

Learned operator patterns:
${flows || 'No flows learned yet'}

Operator skill preferences:
${prefs || 'No preferences learned yet'}

Observed operator session signals:
${operatorSignals || 'No operator session signals yet'}

Available modes:
- advance — push implementation forward
- recover — repair or diagnose a failing path
- verify — validate current work
- redesign — change approach materially
- stop — pause implementation due to constraints

Available skills:
${availableSkills}

Return JSON only:
{"mode":"advance","skill":"/evolve","reasoning":"why this action is best now"}`

    try {
      const parsed = await callClaudeForJSON(prompt, 'claude-haiku-4-5-20251001') as any
      if (parsed) {
        return parseActionResult(ctx, parsed, 'llm policy — no reasoning')
      }
    } catch {}

    // Fallback
    return heuristicPolicy.decide(ctx)
  },
}

// ─── GEPA policy: optimized from outcome data ───────────────────────

let gepaPolicy: DispatchPolicy | null = null

export async function initGepaPolicy(
  trainingData: DispatchTrainingExample[],
): Promise<DispatchPolicy> {
  if (trainingData.length < 5) {
    console.log('GEPA dispatch policy: not enough data (need 5+, have', trainingData.length, ')')
    return heuristicPolicy
  }

  try {
    const axLib: any = await import('@ax-llm/ax')
    const { ai, ax, AxGEPA } = axLib

    const studentAI = ai({ name: 'anthropic', config: { model: 'claude-haiku-4-5-20251001' as any } })
    const teacherAI = ai({ name: 'anthropic', config: { model: 'claude-sonnet-4-6' as any } })

    const decider = ax(
      `goalIntent:string, projectName:string, recentHistory:string, learnedFlows:string, skillPreferences:string, operatorSignals:string, confidenceLevel:string, budgetStatus:string, latestDeliverableStatus:string, projectPhase:string, recentSuccessCount:string, recentFailureCount:string -> mode:class "${DISPATCH_MODES.join(', ')}", skill:class "${DEFAULT_DISPATCH_SKILLS.join(', ')}"`
    )
    decider.setInstruction(
      'You are a staged dispatch policy for an autonomous portfolio operator. First choose the right mode, then choose the best skill inside that mode. Prefer bounded, sensible transitions over noisy skill rotation. Use recover for failures, verify after meaningful progress, redesign after repeated failure, and advance when the current path is working.'
    )

    const train = trainingData.slice(0, Math.floor(trainingData.length * 0.7)).map(d => ({
      goalIntent: d.context.goalIntent.slice(0, 200),
      projectName: d.context.projectName,
      recentHistory: serializeRecentHistory(d.context),
      learnedFlows: serializeSignals(d.context.learnedFlows),
      skillPreferences: serializeSignals(d.context.skillPreferences),
      operatorSignals: serializeSignals(d.context.operatorSkillSignals),
      confidenceLevel: d.context.confidenceLevel,
      budgetStatus: d.context.budgetStatus,
      latestDeliverableStatus: d.context.latestDeliverableStatus,
      projectPhase: d.context.projectPhase,
      recentSuccessCount: String(countRecent(d.context.recentDecisions, 'success')),
      recentFailureCount: String(countRecent(d.context.recentDecisions, 'failure')),
      mode: d.decision.mode ?? inferDispatchMode(d.decision.skill, d.context),
      skill: d.decision.skill,
    }))

    const validation = trainingData.slice(Math.floor(trainingData.length * 0.7)).map(d => ({
      goalIntent: d.context.goalIntent.slice(0, 200),
      projectName: d.context.projectName,
      recentHistory: serializeRecentHistory(d.context),
      learnedFlows: serializeSignals(d.context.learnedFlows),
      skillPreferences: serializeSignals(d.context.skillPreferences),
      operatorSignals: serializeSignals(d.context.operatorSkillSignals),
      confidenceLevel: d.context.confidenceLevel,
      budgetStatus: d.context.budgetStatus,
      latestDeliverableStatus: d.context.latestDeliverableStatus,
      projectPhase: d.context.projectPhase,
      recentSuccessCount: String(countRecent(d.context.recentDecisions, 'success')),
      recentFailureCount: String(countRecent(d.context.recentDecisions, 'failure')),
      mode: d.decision.mode ?? inferDispatchMode(d.decision.skill, d.context),
      skill: d.decision.skill,
    }))

    const metric = ({ prediction, example }: { prediction: any, example: any }) => {
      const modeMatch = prediction?.mode === example?.mode ? 1 : 0
      const skillMatch = prediction?.skill === example?.skill ? 1 : 0
      const actionValidity = DISPATCH_MODES.includes(prediction?.mode as DispatchMode)
        && typeof prediction?.skill === 'string'
        ? 1
        : 0
      return { modeMatch, skillMatch, actionValidity }
    }

    const optimizer = new AxGEPA({
      studentAI,
      teacherAI,
      numTrials: 8,
      minibatch: true,
      minibatchSize: 4,
      earlyStoppingTrials: 3,
      sampleCount: 1,
    })

    const result = await optimizer.compile(decider, train, metric, {
      validationExamples: validation,
      maxMetricCalls: 80,
    })

    if (result.optimizedProgram) {
      decider.applyOptimization(result.optimizedProgram)
      console.log(`GEPA dispatch policy: optimized (score: ${result.bestScore})`)
    }

    gepaPolicy = {
      name: 'gepa',
      async decide(ctx) {
        try {
          const result = await decider.forward(studentAI, {
            goalIntent: ctx.goalIntent.slice(0, 200),
            projectName: ctx.projectName,
            recentHistory: serializeRecentHistory(ctx),
            learnedFlows: serializeSignals(ctx.learnedFlows),
            skillPreferences: serializeSignals(ctx.skillPreferences),
            operatorSignals: serializeSignals(ctx.operatorSkillSignals),
            confidenceLevel: ctx.confidenceLevel,
            budgetStatus: ctx.budgetStatus,
            latestDeliverableStatus: ctx.latestDeliverableStatus,
            projectPhase: ctx.projectPhase,
            recentSuccessCount: String(countRecent(ctx.recentDecisions, 'success')),
            recentFailureCount: String(countRecent(ctx.recentDecisions, 'failure')),
          })
          return parseActionResult(ctx, result ?? {}, 'gepa-optimized dispatch policy')
        } catch {
          return heuristicPolicy.decide(ctx)
        }
      },
    }

    return gepaPolicy
  } catch (e) {
    console.log(`GEPA dispatch policy init failed: ${e}`)
    return heuristicPolicy
  }
}

// ─── Policy registry ─────────────────────────────────────────────────

const DISPATCH_POLICY = process.env.FOREMAN_DISPATCH_POLICY ?? 'llm'

const policies: Record<string, DispatchPolicy> = {
  identity: identityPolicy,
  heuristic: heuristicPolicy,
  llm: llmPolicy,
}

export function getDispatchPolicy(): DispatchPolicy {
  const selected = getSelectedDispatchPolicyName()
  if (selected === 'gepa' && gepaPolicy) return gepaPolicy
  return policies[selected] ?? llmPolicy
}

export function getDispatchPolicyByName(name: string): DispatchPolicy | null {
  if (name === 'gepa') return gepaPolicy
  return policies[name] ?? null
}

export function getSelectedDispatchPolicyName(): string {
  try {
    const override = getDispatchPolicyControl(getDb())
    if (override?.policyName) return override.policyName
  } catch {}
  return DISPATCH_POLICY
}

export function listDispatchPolicies(): Array<{ name: string, live: boolean, available: boolean, active: boolean }> {
  const active = getSelectedDispatchPolicyName()
  return [
    { name: 'identity', live: false, available: true, active: active === 'identity' },
    { name: 'heuristic', live: false, available: true, active: active === 'heuristic' },
    { name: 'llm', live: true, available: true, active: active === 'llm' },
    { name: 'gepa', live: true, available: gepaPolicy != null, active: active === 'gepa' },
  ]
}

export function policyRequiresLiveCalls(name: string): boolean {
  return name === 'llm' || name === 'gepa'
}
