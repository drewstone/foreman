/**
 * Foreman policy function.
 *
 * THE PRODUCT. Given state, decide what to do.
 *
 * This is an LLM call — the agent reasons about what action
 * to take across all projects. No pre-decided workflows.
 * No keyword matching. The LLM reads the state and decides.
 */

import { mkdir, writeFile, stat } from 'node:fs/promises'
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

const POLICY_SYSTEM = `You are Foreman, an autonomous operator agent. You manage a portfolio of projects by spawning coding sessions, invoking skills, and driving work to completion.

You observe project state — active sessions, CI status, budget, confidence, operator patterns — and decide the single highest-value action.

IMPORTANT: "project" must be the FULL ABSOLUTE PATH to the project directory (shown in the state snapshot), not just the name.

Respond with EXACTLY one JSON object (no markdown, no explanation):
{
  "type": "spawn-session" | "resume-session" | "create-pr" | "invoke-skill" | "run-experiment" | "cross-pollinate" | "send-notification" | "run-eval" | "continue-work" | "do-nothing",
  "project": "<FULL ABSOLUTE PATH to project>",
  "goal": "<what this action achieves>",
  "details": { "<key>": "<value>" },
  "reasoning": "<1-2 sentences why this is highest-value>"
}

For details:
- spawn-session: { "harness": "claude", "prompt": "<detailed task for the session>" }
- invoke-skill: { "skill": "/evolve|/polish|/verify|/pursue|/critical-audit", "target": "<what to improve>" }
- do-nothing: { "reason": "..." }

When spawning a session on a NEW project (0 sessions, no history):
1. First session should: read all existing code/docs, understand the architecture, set up deps, run tests
2. Create .foreman/experiments/MANIFEST.md with: hypothesis, methodology, success criteria, metrics to track
3. Then start building/improving the highest-ROI gap

When spawning on an EXISTING project:
1. Continue from where the last session left off
2. Run /evolve or /pursue to push quality forward
3. Check CI, fix failures, ship improvements

Prioritize:
1. New active projects with 0 sessions (need initial exploration)
2. Failing CI that can be fixed
3. Stalled work with clear next steps
4. Skill invocations that compound value (/evolve, /pursue)
5. Nothing — if nothing needs doing, that's fine`

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

  // Tell the LLM what was recently acted on so it picks different projects
  const recentlyActed = recentDecisionKeys.length > 0
    ? `\n\nRECENTLY ACTED ON (pick a DIFFERENT project/action):\n${recentDecisionKeys.map((k) => `- ${k}`).join('\n')}`
    : ''

  const prompt = `${systemPrompt}\n\n---\n\n${stateText}${recentlyActed}`

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
      const claudePath = process.env.CLAUDE_PATH ?? '/home/drew/.local/bin/claude'
      const { stdout } = await execFileAsync(claudePath, [
        '-p', prompt,
        '--output-format', 'text',
      ], { timeout: 60_000, env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } })
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

async function resolveProjectPath(project: string): Promise<string> {
  if (project.startsWith('/')) return project
  const home = homedir()
  const candidates = [
    join(home, 'foreman-projects', 'avalanche-intelligence', 'repo', project),
    join(home, 'foreman-projects', 'belief-state-agents', 'repo', project),
    join(home, 'foreman-projects', 'PiGraph', 'repo', project),
    join(home, 'foreman-projects', project),
    join(home, 'code', project),
  ]
  for (const p of candidates) {
    try {
      const s = await stat(p)
      if (s.isDirectory()) return p
    } catch {}
  }
  return join(home, 'code', project)
}

async function executeSpawnSession(action: Action): Promise<ActionOutcome> {
  const projectPath = await resolveProjectPath(action.project)

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

  // Spawn claude directly — simpler and more reliable than runSessionSurface
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const claudePath = process.env.CLAUDE_PATH ?? '/home/drew/.local/bin/claude'
  const prompt = action.details.prompt ?? action.goal

  try {
    const { stdout } = await exec(claudePath, [
      '-p', prompt,
      '--output-format', 'text',
    ], {
      cwd: projectPath,
      timeout: 300_000, // 5 min
      env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
    })
    return {
      success: true,
      summary: `Session completed in ${action.project}: ${stdout.slice(0, 200)}`,
      evidence: [`session:${action.project}`],
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      success: false,
      summary: `Session failed in ${action.project}: ${msg.slice(0, 200)}`,
      evidence: [],
    }
  }
}

async function executeResumeSession(action: Action): Promise<ActionOutcome> {
  return executeSpawnSession({
    ...action,
    details: { ...action.details, prompt: action.details.prompt ?? `Continue working on: ${action.goal}` },
  })
}

async function executeInvokeSkill(action: Action): Promise<ActionOutcome> {
  const skill = action.details.skill ?? '/evolve'
  return executeSpawnSession({
    ...action,
    details: { ...action.details, prompt: `${skill} ${action.details.target ?? action.goal}` },
  })
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

// ─── Decision deduplication ─────────────────────────────────────────

const recentDecisionKeys: string[] = []
const MAX_DEDUP_HISTORY = 10

function actionKey(action: Action): string {
  return `${action.type}:${action.project}`
}

function isDuplicate(action: Action): boolean {
  return recentDecisionKeys.includes(actionKey(action))
}

function recordDecision(action: Action | null): void {
  if (!action) return
  const key = actionKey(action)
  // Remove if already tracked (will re-add at end)
  const idx = recentDecisionKeys.indexOf(key)
  if (idx !== -1) recentDecisionKeys.splice(idx, 1)
  recentDecisionKeys.push(key)
  if (recentDecisionKeys.length > MAX_DEDUP_HISTORY) {
    recentDecisionKeys.shift()
  }
}

/** Clear dedup history — call when new events arrive so the policy can re-evaluate */
export function clearDedup(): void {
  recentDecisionKeys.length = 0
}

// ─── Full policy cycle ──────────────────────────────────────────────

export async function runPolicyCycle(options?: {
  dryRun?: boolean
  confidenceStore?: ConfidenceStore
  recentEvents?: ForemanEvent[]
  watchedDirs?: string[]
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
      watchedDirs: options?.watchedDirs,
    })

    log(`State: ${state.totalManagedProjects} projects, ${state.totalActiveSessions} sessions`)

    // Decide
    log('Calling policy...')
    const action = await decideAction(state, options?.provider)

    if (!action) {
      log('Policy: do nothing')
      recordDecision(null)
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

    // Dedup: if we already proposed this exact (type, project) recently, skip
    if (isDuplicate(action)) {
      log(`Policy: ${action.type} on ${action.project} — DEDUP (already proposed recently)`)
      const decision: PolicyDecision = {
        timestamp: new Date().toISOString(),
        state,
        action: null,
        confidenceLevel: 'dry-run',
        confidenceScore: 0,
        executed: false,
        outcome: null,
      }
      // Don't log dedup'd decisions — they're noise
      return decision
    }

    recordDecision(action)
    log(`Policy: ${action.type} on ${action.project} — ${action.reasoning}`)

    // Gate and execute
    const result = await gateAndExecute(action, store, { dryRun: options?.dryRun })

    log(`Confidence: ${result.score.toFixed(2)} (${result.level}) → ${result.executed ? 'executed' : 'not executed'}`)
    if (result.outcome) {
      log(`Outcome: ${result.outcome.success ? 'success' : 'failure'} — ${result.outcome.summary}`)
      // If action failed, clear it from dedup so it can be retried
      if (!result.outcome.success) {
        const key = actionKey(action)
        const idx = recentDecisionKeys.indexOf(key)
        if (idx !== -1) recentDecisionKeys.splice(idx, 1)
      }
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
