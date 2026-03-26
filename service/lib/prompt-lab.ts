/**
 * Prompt Lab — experimental testbed for dispatch prompt optimization.
 *
 * Architecture:
 *   River: dispatches flow continuously, producing (prompt, outcome) pairs
 *   Lab: reads the river, generates prompt variants, A/B tests them
 *   Promotion: winning variants become the default for future dispatches
 *
 * The lab doesn't interfere with the river. It observes, experiments,
 * and promotes — an explore/exploit loop over the prompt surface.
 *
 * What we optimize:
 *   NOT the full prompt. The prompt is composed from sections (task,
 *   standards, git workflow, context). We optimize the FRAMING of
 *   each section — the instruction that tells Claude how to behave.
 *
 * Optimization surfaces:
 *   1. Standards section — scope compliance, commit behavior
 *   2. Task framing — how the task description is presented
 *   3. Context budget — how much context per prompt tier
 *   4. Section selection — which sections to include/exclude
 *
 * Each surface has its own AxGen generator with a tunable instruction.
 * GEPA optimizes these instructions using dispatch outcomes as signal.
 */

import { getDb, getStmts, log } from './state.js'
import { callClaudeForJSON } from './claude-runner.js'

// ─── River: read dispatch outcomes ───────────────────────────────────

export interface DispatchSample {
  id: number
  skill: string
  task: string
  promptSections: string[]
  promptTier: string
  deliverableStatus: 'pass' | 'fail' | 'unchecked'
  scopeViolation: boolean
  success: boolean
  hasScope: boolean
  hasDeliverable: boolean
}

/**
 * Pull labeled samples from the decisions table.
 * This is the river — it only grows, never shrinks.
 */
export function pullSamples(limit = 100): DispatchSample[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT id, skill, task, prompt_sections, deliverable_status,
           scope_spec, deliverable_spec, status,
           CASE WHEN outcome LIKE '%SCOPE VIOLATION%' THEN 1 ELSE 0 END as scope_violation
    FROM decisions
    WHERE status IN ('success', 'failure')
    ORDER BY created_at DESC LIMIT ?
  `).all(limit) as Array<{
    id: number, skill: string, task: string, prompt_sections: string | null,
    deliverable_status: string | null, scope_spec: string | null,
    deliverable_spec: string | null, status: string, scope_violation: number
  }>

  return rows.map(r => ({
    id: r.id,
    skill: r.skill || 'direct',
    task: r.task,
    promptSections: r.prompt_sections ? JSON.parse(r.prompt_sections) : [],
    promptTier: r.prompt_sections ? 'unknown' : 'unknown',
    deliverableStatus: (r.deliverable_status as any) ?? 'unchecked',
    scopeViolation: r.scope_violation === 1,
    success: r.status === 'success',
    hasScope: !!r.scope_spec,
    hasDeliverable: !!r.deliverable_spec,
  }))
}

// ─── Prompt surfaces (what we optimize) ──────────────────────────────

export interface PromptSurface {
  name: string
  currentInstruction: string
  // Each surface is a tunable instruction string
}

/**
 * The surfaces we optimize. Each one controls a section of the composed prompt.
 */
export function getDefaultSurfaces(): PromptSurface[] {
  return [
    {
      name: 'standards',
      currentInstruction: [
        'L7/L8 staff engineer quality. Zero tolerance for slop.',
        'Complete everything fully. No TODOs, no stubs.',
        'ONLY create or modify the files specified in your task.',
        'Do NOT use "git add -A" or "git add .". Add files by name.',
        'If your commit is rejected by a scope hook, run: git reset HEAD . && git add <your-allowed-file> && git commit.',
        'If tests exist, run them. Fix failures before moving on.',
        'Never ask for permission. Act.',
      ].join('\n'),
    },
    {
      name: 'task_framing',
      currentInstruction: 'Present the task as a direct imperative. Include the exact file path to create/modify. Emphasize the ONLY constraint.',
    },
    {
      name: 'context_budget',
      currentInstruction: 'slim=1500 chars for /verify /converge /polish. medium=3000 for /evolve /critical-audit. rich=6000 for /pursue /plan /research /reflect.',
    },
  ]
}

// ─── Lab: experiment runner ──────────────────────────────────────────

export interface Experiment {
  id: string
  surface: string           // which surface we're testing
  variant: string           // the new instruction
  baseline: string          // the old instruction
  dispatches: number        // how many dispatches used this variant
  successes: number         // how many succeeded
  created: string
}

export interface LabState {
  experiments: Experiment[]
  activeSurface: string | null  // which surface we're currently optimizing
  lastOptimization: string | null
}

/**
 * Run an optimization cycle on one surface.
 *
 * Strategy: analyze failure patterns in the data, then ask Claude
 * to generate a better instruction that addresses those patterns.
 * Uses callClaudeForJSON (Claude Code pipe mode with OAuth auth)
 * instead of raw AxGEPA (which needs ANTHROPIC_API_KEY).
 *
 * When ANTHROPIC_API_KEY is available, this can be upgraded to use
 * AxGEPA for proper Pareto optimization. The interface stays the same.
 */
export async function optimizeSurface(
  surface: PromptSurface,
  samples: DispatchSample[],
): Promise<string | null> {
  if (samples.length < 10) {
    log(`PromptLab: need 10+ samples for ${surface.name} (have ${samples.length})`)
    return null
  }

  // Analyze failure patterns from the data
  const failures = samples.filter(s => !s.success)
  const successes = samples.filter(s => s.success)
  const scopeViolations = samples.filter(s => s.scopeViolation)

  const failuresBySkill: Record<string, number> = {}
  const successesBySkill: Record<string, number> = {}
  for (const s of failures) failuresBySkill[s.skill] = (failuresBySkill[s.skill] ?? 0) + 1
  for (const s of successes) successesBySkill[s.skill] = (successesBySkill[s.skill] ?? 0) + 1

  const failureTasks = failures.slice(0, 8).map(f => `- [${f.skill}] ${f.task.slice(0, 100)}`)
  const successTasks = successes.slice(0, 5).map(s => `- [${s.skill}] ${s.task.slice(0, 100)}`)

  const prompt = `You are optimizing the "standards" instruction for an autonomous coding dispatch system.

## Current instruction (baseline: ${Math.round(successes.length / samples.length * 100)}% success rate)
${surface.currentInstruction}

## Failure analysis (${failures.length}/${samples.length} failed)
Scope violations: ${scopeViolations.length}
Failures by skill: ${JSON.stringify(failuresBySkill)}
Successes by skill: ${JSON.stringify(successesBySkill)}

Failed tasks:
${failureTasks.join('\n')}

Successful tasks:
${successTasks.join('\n')}

## Key pattern
The #1 failure mode is SCOPE VIOLATION — agents create 8-9 files when asked to create 1.
They ignore "ONLY modify specified files" and build dashboards, CLIs, hooks regardless of task.
When scope hooks block their commit, they don't recover.

## Your job
Write an IMPROVED standards instruction that:
1. More forcefully prevents scope creep
2. Gives clearer recovery instructions when commits are rejected
3. Keeps what works (the successes above show the current instruction works for some tasks)
4. Is concise — every word must earn its place

Respond with JSON only:
{"instruction": "the new standards instruction text (newline-separated bullet points)"}

Do NOT include anything except the JSON object.`

  try {
    const result = await callClaudeForJSON(prompt) as any
    if (!result?.instruction) return null

    const variant = String(result.instruction)
    if (variant === surface.currentInstruction) return null
    if (variant.length < 50 || variant.length > 2000) return null

    log(`PromptLab: ${surface.name} variant generated (${variant.length} chars)`)
    return variant
  } catch (e) {
    log(`PromptLab: optimization failed for ${surface.name}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

// ─── Experiment store (SQLite) ───────────────────────────────────────

export function ensureLabTable(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_lab (
      id TEXT PRIMARY KEY,
      surface TEXT NOT NULL,
      variant TEXT NOT NULL,
      baseline TEXT NOT NULL,
      dispatches INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'testing',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      promoted_at TEXT
    )
  `)
}

export function createExperiment(surface: string, variant: string, baseline: string): string {
  const db = getDb()
  ensureLabTable()
  const id = `exp-${surface}-${Date.now().toString(36)}`
  db.prepare(`INSERT INTO prompt_lab (id, surface, variant, baseline) VALUES (?, ?, ?, ?)`)
    .run(id, surface, variant, baseline)
  log(`PromptLab: created experiment ${id} for ${surface}`)
  return id
}

export function recordExperimentOutcome(expId: string, success: boolean): void {
  const db = getDb()
  ensureLabTable()
  db.prepare(`UPDATE prompt_lab SET dispatches = dispatches + 1, successes = successes + ? WHERE id = ?`)
    .run(success ? 1 : 0, expId)
}

export function getActiveExperiment(surface: string): Experiment | null {
  const db = getDb()
  ensureLabTable()
  const row = db.prepare(`SELECT * FROM prompt_lab WHERE surface = ? AND status = 'testing' ORDER BY created_at DESC LIMIT 1`)
    .get(surface) as any
  if (!row) return null
  return {
    id: row.id,
    surface: row.surface,
    variant: row.variant,
    baseline: row.baseline,
    dispatches: row.dispatches,
    successes: row.successes,
    created: row.created_at,
  }
}

export function promoteExperiment(expId: string): void {
  const db = getDb()
  db.prepare(`UPDATE prompt_lab SET status = 'promoted', promoted_at = datetime('now') WHERE id = ?`)
    .run(expId)
  log(`PromptLab: promoted experiment ${expId}`)
}

export function abandonExperiment(expId: string): void {
  const db = getDb()
  db.prepare(`UPDATE prompt_lab SET status = 'abandoned' WHERE id = ?`)
    .run(expId)
  log(`PromptLab: abandoned experiment ${expId}`)
}

/**
 * Evaluate whether an active experiment should be promoted or abandoned.
 * Uses a simple significance test: need 5+ dispatches, and variant must
 * beat baseline by 10+ percentage points.
 */
export function evaluateExperiment(exp: Experiment, baselineRate: number): 'promote' | 'abandon' | 'continue' {
  if (exp.dispatches < 5) return 'continue'

  const variantRate = exp.dispatches > 0 ? exp.successes / exp.dispatches : 0
  const delta = variantRate - baselineRate

  if (delta >= 0.10) return 'promote'    // 10pp improvement
  if (delta <= -0.10) return 'abandon'   // 10pp regression
  if (exp.dispatches >= 10) {
    // After 10 dispatches, if no clear signal, abandon
    return delta >= 0 ? 'promote' : 'abandon'
  }
  return 'continue'
}

// ─── Main loop: called periodically by the service ───────────────────

/**
 * Run one cycle of the prompt lab.
 * 1. Pull samples from the river
 * 2. Check if an active experiment needs evaluation
 * 3. If no active experiment, generate a new variant
 * 4. Report state
 */
export async function runPromptLabCycle(): Promise<{
  samples: number
  activeExperiment: string | null
  action: string
}> {
  const samples = pullSamples(100)
  const surfaces = getDefaultSurfaces()
  const baselineRate = samples.length > 0
    ? samples.filter(s => s.success).length / samples.length
    : 0

  // Check each surface for active experiments
  for (const surface of surfaces) {
    const exp = getActiveExperiment(surface.name)

    if (exp) {
      const verdict = evaluateExperiment(exp, baselineRate)
      if (verdict === 'promote') {
        promoteExperiment(exp.id)
        return { samples: samples.length, activeExperiment: exp.id, action: `promoted ${surface.name} variant (${Math.round(exp.successes/exp.dispatches*100)}% vs ${Math.round(baselineRate*100)}% baseline)` }
      }
      if (verdict === 'abandon') {
        abandonExperiment(exp.id)
        return { samples: samples.length, activeExperiment: exp.id, action: `abandoned ${surface.name} variant (${Math.round(exp.successes/exp.dispatches*100)}% vs ${Math.round(baselineRate*100)}% baseline)` }
      }
      // Still testing
      return { samples: samples.length, activeExperiment: exp.id, action: `testing ${surface.name} (${exp.dispatches} dispatches, ${Math.round(exp.successes/exp.dispatches*100)}%)` }
    }
  }

  // No active experiments — generate a variant for the lowest-performing surface
  // For now, always optimize 'standards' since that's where scope compliance lives
  const targetSurface = surfaces[0] // standards
  const variant = await optimizeSurface(targetSurface, samples)

  if (variant) {
    const expId = createExperiment(targetSurface.name, variant, targetSurface.currentInstruction)
    return { samples: samples.length, activeExperiment: expId, action: `generated new ${targetSurface.name} variant` }
  }

  return { samples: samples.length, activeExperiment: null, action: 'no variant generated' }
}
