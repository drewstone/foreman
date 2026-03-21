/**
 * Foreman policy function.
 *
 * THE PRODUCT. Given state, decide what to do.
 *
 * This is an LLM call — the agent reasons about what action
 * to take across all projects. No pre-decided workflows.
 * No keyword matching. The LLM reads the state and decides.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ForemanState, ForemanEvent } from './state-snapshot.js'
import { buildStateSnapshot, formatStateForLLM } from './state-snapshot.js'
import { ConfidenceStore, type ConfidenceLevel, type ConfidenceSignal, type ActionType } from '@drew/foreman-memory/confidence'
import { VersionedStore } from '@drew/foreman-core'
import { notify } from './notify.js'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

// ─── Types ──────────────────────────────────────────────────────────

export type { ActionType }

export interface Action {
  type: ActionType | string
  project: string
  goal: string
  details: Record<string, string>
  reasoning: string
}

export interface ActionOutcome {
  success: boolean
  summary: string
  evidence: string[]
}

export interface PolicyDecision {
  timestamp: string
  state: ForemanState
  action: Action | null
  confidenceLevel: ConfidenceLevel
  confidenceScore: number
  executed: boolean
  outcome: ActionOutcome | null
}

// ─── Policy prompt ──────────────────────────────────────────────────

const POLICY_SYSTEM = `You are Foreman, an autonomous agent that manages an operator's projects.

You observe the current state across all projects — active sessions, CI status, budget, confidence scores, operator patterns — and decide the single highest-value action to take right now.

You are conservative. If nothing needs doing, say so. If your confidence for an action type on a project is low, you should still recommend the action — the confidence gating happens after your decision.

Respond with EXACTLY one JSON object (no markdown, no explanation):
{
  "type": "spawn-session" | "resume-session" | "create-pr" | "invoke-skill" | "run-experiment" | "cross-pollinate" | "send-notification" | "run-eval" | "continue-work" | "do-nothing",
  "project": "<project path or name>",
  "goal": "<what this action achieves>",
  "details": { "<key>": "<value>" },
  "reasoning": "<1-2 sentences explaining why this is the highest-value action>"
}

For details, include relevant fields:
- spawn-session: { "harness": "claude|codex|pi|foreman", "prompt": "..." }
- resume-session: { "sessionId": "...", "harness": "..." }
- invoke-skill: { "skill": "/evolve|/polish|/verify|...", "target": "..." }
- run-experiment: { "metric": "...", "command": "..." }
- send-notification: { "channel": "telegram|slack", "message": "..." }
- create-pr: { "title": "...", "branch": "..." }
- do-nothing: { "reason": "..." }

Prioritize:
1. Failing CI that can be fixed
2. Stalled work with clear next steps
3. Active experiments that need attention
4. Skill invocations that would compound value
5. Notifications about state changes
6. Nothing — if nothing needs doing, that's fine`

// ─── Versioned policy loading ────────────────────────────────────────

async function loadPolicyPrompt(): Promise<string> {
  try {
    const store = new VersionedStore()
    const active = await store.getActive('policy', 'main')
    if (active) return active.content
    // Bootstrap: save the default prompt as v001
    await store.put('policy', 'main', POLICY_SYSTEM, { source: 'bootstrap' })
    return POLICY_SYSTEM
  } catch {
    return POLICY_SYSTEM
  }
}

// ─── Core policy call ───────────────────────────────────────────────

export async function decideAction(
  state: ForemanState,
  provider?: { run(prompt: string): Promise<{ stdout: string }> },
): Promise<Action | null> {
  const stateText = formatStateForLLM(state)
  const systemPrompt = await loadPolicyPrompt()
  const prompt = `${systemPrompt}\n\n---\n\n${stateText}`

  let responseText: string

  if (provider) {
    const result = await provider.run(prompt)
    responseText = result.stdout
  } else {
    // Default: use claude CLI for now
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)

    try {
      const { stdout } = await execFileAsync('claude', [
        '-p', prompt,
        '--output-format', 'text',
      ], { timeout: 60_000 })
      responseText = stdout
    } catch (e) {
      return null
    }
  }

  return parseActionResponse(responseText)
}

function parseActionResponse(text: string): Action | null {
  // Extract JSON from response (may be wrapped in markdown)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null

  try {
    const parsed = JSON.parse(jsonMatch[0])

    if (!parsed.type || typeof parsed.type !== 'string') return null
    if (parsed.type === 'do-nothing') return null

    return {
      type: parsed.type as ActionType,
      project: String(parsed.project ?? ''),
      goal: String(parsed.goal ?? ''),
      details: parsed.details && typeof parsed.details === 'object' ? parsed.details : {},
      reasoning: String(parsed.reasoning ?? ''),
    }
  } catch {
    return null
  }
}

// ─── Action execution ───────────────────────────────────────────────

export async function executeAction(action: Action): Promise<ActionOutcome> {
  try {
    switch (action.type) {
      case 'spawn-session':
        return await executeSpawnSession(action)
      case 'resume-session':
        return await executeResumeSession(action)
      case 'invoke-skill':
        return await executeInvokeSkill(action)
      case 'send-notification':
        return await executeSendNotification(action)
      case 'run-eval':
        return await executeRunEval(action)
      case 'create-pr':
        return await executeCreatePR(action)
      case 'run-experiment':
        return await executeRunExperiment(action)
      case 'continue-work':
        return await executeContinueWork(action)
      case 'cross-pollinate':
        return { success: true, summary: 'Cross-pollination logged for review', evidence: [] }
      default:
        return { success: false, summary: `Unknown action type: ${action.type}`, evidence: [] }
    }
  } catch (e) {
    return { success: false, summary: `Action failed: ${e}`, evidence: [] }
  }
}

async function executeSpawnSession(action: Action): Promise<ActionOutcome> {
  if (action.details.harness === 'foreman') {
    const { spawnChild } = await import('./foreman-provider.js')
    const child = await spawnChild({
      project: action.project,
      dryRun: true, // children always start in dry-run
    })
    return {
      success: child.status === 'running',
      summary: `Foreman child spawned for ${action.project} (PID ${child.pid})`,
      evidence: [`foreman-child:${action.project}:${child.pid}`],
    }
  }

  const { runSessionSurface } = await import('./session-run.js')
  const result = await runSessionSurface({
    provider: (action.details.harness as 'claude' | 'codex') ?? 'claude',
    action: 'start',
    prompt: action.details.prompt ?? action.goal,
    cwd: action.project,
    approve: true,
  })
  return {
    success: result.status === 'completed',
    summary: `Session ${result.sessionId ?? 'unknown'}: ${result.status}`,
    evidence: result.sessionId ? [`session:${result.sessionId}`] : [],
  }
}

async function executeResumeSession(action: Action): Promise<ActionOutcome> {
  const { runSessionSurface } = await import('./session-run.js')
  const result = await runSessionSurface({
    provider: (action.details.harness as 'claude' | 'codex') ?? 'claude',
    action: 'continue-last',
    prompt: action.details.prompt ?? action.goal,
    cwd: action.project,
    approve: true,
  })
  return {
    success: result.status === 'completed',
    summary: `Resume ${result.sessionId ?? 'last'}: ${result.status}`,
    evidence: result.sessionId ? [`session:${result.sessionId}`] : [],
  }
}

async function executeInvokeSkill(action: Action): Promise<ActionOutcome> {
  const { runSessionSurface } = await import('./session-run.js')
  const skill = action.details.skill ?? '/evolve'
  const result = await runSessionSurface({
    provider: 'claude',
    action: 'start',
    prompt: `${skill} ${action.details.target ?? action.goal}`,
    cwd: action.project,
    approve: true,
  })
  return {
    success: result.status === 'completed',
    summary: `Skill ${skill}: ${result.status}`,
    evidence: [`skill:${skill}`],
  }
}

async function executeSendNotification(action: Action): Promise<ActionOutcome> {
  await notify({
    title: `Foreman — ${action.project}`,
    body: action.details.message ?? action.goal,
    severity: 'info',
    source: 'policy',
  })
  return { success: true, summary: 'Notification sent', evidence: ['notify:sent'] }
}

async function executeRunEval(action: Action): Promise<ActionOutcome> {
  const { runEvals } = await import('./eval-runner.js')
  const result = await runEvals({
    envNames: action.details.env ? [action.details.env] : undefined,
    dryRun: action.details.dryRun === 'true',
  })
  return {
    success: result.totalCompleted > 0,
    summary: `Eval: ${result.totalCompleted}/${result.totalTasks} completed (avg ${result.averageScore.toFixed(3)})`,
    evidence: [`eval:${result.totalTasks}`],
  }
}

async function executeCreatePR(action: Action): Promise<ActionOutcome> {
  const { createPR } = await import('./ci-tools.js')
  const result = await createPR({
    repoPath: action.project,
    title: action.details.title ?? action.goal,
    body: action.details.body ?? action.reasoning,
  })
  if (result.error) {
    return { success: false, summary: `PR failed: ${result.error}`, evidence: [] }
  }
  return { success: true, summary: `PR #${result.number}: ${result.url}`, evidence: [`pr:${result.url}`] }
}

async function executeRunExperiment(action: Action): Promise<ActionOutcome> {
  // Experiments are run as sessions with the experiment goal as prompt
  // The worktree-experiment infrastructure requires a scorer function,
  // so for policy-driven experiments we use a session instead
  return executeSpawnSession({
    ...action,
    details: {
      ...action.details,
      prompt: action.details.command
        ? `Run experiment: ${action.details.command}\nMetric: ${action.details.metric ?? 'success'}\nGoal: ${action.goal}`
        : action.goal,
    },
  })
}

async function executeContinueWork(action: Action): Promise<ActionOutcome> {
  return executeResumeSession(action)
}

// ─── Confidence gating ──────────────────────────────────────────────

export interface GatedResult {
  action: Action
  level: ConfidenceLevel
  score: number
  executed: boolean
  outcome: ActionOutcome | null
}

export async function gateAndExecute(
  action: Action,
  confidenceStore: ConfidenceStore,
  options?: { dryRun?: boolean },
): Promise<GatedResult> {
  const score = confidenceStore.getConfidence(action.type, action.project)
  const level = confidenceStore.getLevel(action.type, action.project)

  // Force dry-run if flag set
  if (options?.dryRun || level === 'dry-run') {
    return { action, level: 'dry-run', score, executed: false, outcome: null }
  }

  if (level === 'propose') {
    // Queue for operator approval — don't execute yet
    await notify({
      title: `Foreman proposal (${action.type})`,
      body: `Project: ${action.project}\nGoal: ${action.goal}\nReasoning: ${action.reasoning}\n\nReply to approve or reject.`,
      severity: 'info',
      source: 'policy',
    })
    return { action, level, score, executed: false, outcome: null }
  }

  // act-notify or autonomous — execute
  const outcome = await executeAction(action)

  // Update confidence from outcome
  const signal: ConfidenceSignal = outcome.success ? 'success' : 'failure'
  confidenceStore.update(action.type, action.project, signal)

  // Notify if act-notify level
  if (level === 'act-notify') {
    await notify({
      title: `Foreman acted (${action.type})`,
      body: `Project: ${action.project}\nGoal: ${action.goal}\nOutcome: ${outcome.summary}`,
      severity: outcome.success ? 'info' : 'warning',
      source: 'policy',
    })
  }

  return { action, level, score, executed: true, outcome }
}

// ─── Decision logging ───────────────────────────────────────────────

export async function logDecision(decision: PolicyDecision): Promise<void> {
  const dir = join(FOREMAN_HOME, 'traces', 'policy')
  await mkdir(dir, { recursive: true })

  const filename = `${decision.timestamp.replace(/[:.]/g, '-')}.json`
  await writeFile(
    join(dir, filename),
    JSON.stringify(decision, null, 2) + '\n',
    'utf8',
  )
}

// ─── Full policy cycle ──────────────────────────────────────────────

export async function runPolicyCycle(options?: {
  dryRun?: boolean
  confidenceStore?: ConfidenceStore
  recentEvents?: ForemanEvent[]
  provider?: { run(prompt: string): Promise<{ stdout: string }> }
  onProgress?: (msg: string) => void
}): Promise<PolicyDecision> {
  const log = options?.onProgress ?? (() => {})
  const store = options?.confidenceStore ?? new ConfidenceStore()
  const ownStore = !options?.confidenceStore

  try {
    // Build state
    log('Building state snapshot...')
    const confidenceScores = store.list().map((c) => ({
      actionType: c.actionType,
      project: c.project,
      score: c.score,
      level: c.level,
    }))

    const state = await buildStateSnapshot({
      confidenceScores,
      recentEvents: options?.recentEvents,
    })

    log(`State: ${state.totalManagedProjects} projects, ${state.totalActiveSessions} sessions`)

    // Decide
    log('Calling policy...')
    const action = await decideAction(state, options?.provider)

    if (!action) {
      log('Policy: do nothing')
      const decision: PolicyDecision = {
        timestamp: new Date().toISOString(),
        state,
        action: null,
        confidenceLevel: 'dry-run',
        confidenceScore: 0,
        executed: false,
        outcome: null,
      }
      await logDecision(decision)
      return decision
    }

    log(`Policy: ${action.type} on ${action.project} — ${action.reasoning}`)

    // Gate and execute
    const result = await gateAndExecute(action, store, { dryRun: options?.dryRun })

    log(`Confidence: ${result.score.toFixed(2)} (${result.level}) → ${result.executed ? 'executed' : 'not executed'}`)
    if (result.outcome) {
      log(`Outcome: ${result.outcome.success ? 'success' : 'failure'} — ${result.outcome.summary}`)
    }

    const decision: PolicyDecision = {
      timestamp: new Date().toISOString(),
      state,
      action,
      confidenceLevel: result.level,
      confidenceScore: result.score,
      executed: result.executed,
      outcome: result.outcome,
    }

    await logDecision(decision)
    return decision
  } finally {
    if (ownStore) store.close()
  }
}
