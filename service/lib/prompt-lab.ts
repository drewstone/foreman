/**
 * Prompt Lab — manual experiment loop for structured prompt policies.
 *
 * This is intentionally narrower now:
 * - The runtime path uses structured prompt policies
 * - The lab proposes/testing/promotes full prompt-policy variants
 * - It no longer optimizes stale per-section instruction fragments
 */

import { getDb, getStmts, log } from './state.js'
import {
  buildPromptPolicyCandidates,
  chooseHeuristicPromptPolicy,
  classifyPromptTaskShape,
  classifyTaskLengthBucket,
  parsePromptPolicy,
  serializePromptPolicy,
  type PromptPolicy,
  type PromptPolicyTrainingExample,
} from './prompt-policy.js'

export interface DispatchSample {
  id: number
  createdAt: string
  worktreePath: string | null
  skill: string
  task: string
  promptSections: string[]
  promptTier: string
  promptPolicyId: string
  deliverableStatus: 'pass' | 'fail' | 'unchecked'
  scopeViolation: boolean
  success: boolean
  hasScope: boolean
  hasDeliverable: boolean
}

export function pullSamples(limit = 100): DispatchSample[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT d.id, d.skill, d.task, d.prompt_sections, d.prompt_policy_id, d.deliverable_status,
           d.scope_spec, d.deliverable_spec, d.status, d.metrics, d.created_at, d.worktree_path, pt.template
    FROM decisions d
    LEFT JOIN prompt_templates pt ON pt.version = d.template_version
    WHERE d.status IN ('success', 'failure')
    ORDER BY d.created_at DESC LIMIT ?
  `).all(limit) as Array<{
    id: number
    skill: string
    task: string
    prompt_sections: string | null
    prompt_policy_id: string | null
    deliverable_status: string | null
    scope_spec: string | null
    deliverable_spec: string | null
    status: string
    metrics: string | null
    created_at: string
    worktree_path: string | null
    template: string | null
  }>

  return rows.map(row => {
    let scopeViolation = false
    try {
      const metrics = row.metrics ? JSON.parse(row.metrics) as Record<string, unknown> : {}
      scopeViolation = metrics.scopeStatus === 'violation' || false
    } catch {}

    const templatePolicy = parsePromptPolicy(row.template)
    return {
      id: row.id,
      createdAt: row.created_at,
      worktreePath: row.worktree_path,
      skill: row.skill || 'direct',
      task: row.task,
      promptSections: row.prompt_sections ? JSON.parse(row.prompt_sections) : [],
      promptTier: row.prompt_sections ? 'known' : 'unknown',
      promptPolicyId: row.prompt_policy_id || templatePolicy.id,
      deliverableStatus: row.deliverable_status === 'pass' || row.deliverable_status === 'fail'
        ? row.deliverable_status
        : 'unchecked',
      scopeViolation,
      success: row.status === 'success',
      hasScope: !!row.scope_spec,
      hasDeliverable: !!row.deliverable_spec,
    }
  })
}

export interface PromptSurface {
  name: string
  currentPolicy: PromptPolicy
}

function getCurrentPromptPolicy(): PromptPolicy {
  try {
    const stmts = getStmts()
    const activeTemplate = stmts.activeTemplate.get() as { template?: string | null } | undefined
    return parsePromptPolicy(activeTemplate?.template)
  } catch {
    return parsePromptPolicy(null)
  }
}

export function getDefaultSurfaces(): PromptSurface[] {
  return [{ name: 'prompt_policy', currentPolicy: getCurrentPromptPolicy() }]
}

export interface Experiment {
  id: string
  surface: string
  variant: string
  baseline: string
  dispatches: number
  successes: number
  created: string
}

function buildTrainingExamples(samples: DispatchSample[]): PromptPolicyTrainingExample[] {
  return samples.map(sample => ({
    skill: sample.skill,
    task: sample.task,
    taskShape: classifyPromptTaskShape(sample.skill, sample.task),
    taskLengthBucket: classifyTaskLengthBucket(sample.task),
    hasScope: sample.hasScope,
    hasDeliverable: sample.hasDeliverable,
    success: sample.success,
    scopeViolation: sample.scopeViolation,
    deliverableStatus: sample.deliverableStatus,
    variantId: sample.promptPolicyId,
  }))
}

export async function optimizeSurface(
  surface: PromptSurface,
  samples: DispatchSample[],
): Promise<string | null> {
  if (samples.length < 10) {
    log(`PromptLab: need 10+ samples for ${surface.name} (have ${samples.length})`)
    return null
  }

  const current = surface.currentPolicy
  const examples = buildTrainingExamples(samples)
  const heuristic = chooseHeuristicPromptPolicy(current, examples)
  if (heuristic.id !== current.id) {
    log(`PromptLab: selected heuristic prompt policy ${heuristic.id}`)
    return serializePromptPolicy(heuristic).trim()
  }

  const candidates = buildPromptPolicyCandidates(current).filter(candidate => candidate.id !== current.id)
  const scored = candidates.map(candidate => {
    const matchCount = examples.filter(example => example.variantId === candidate.id).length
    const penalty = examples.filter(example => example.scopeViolation && candidate.id !== 'strict-guarded').length
    return { candidate, score: matchCount - penalty * 0.5 }
  }).sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))

  const best = scored[0]?.candidate
  if (!best) return null
  log(`PromptLab: selected fallback prompt policy ${best.id}`)
  return serializePromptPolicy(best).trim()
}

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

export function evaluateExperiment(exp: Experiment, baselineRate: number): 'promote' | 'abandon' | 'continue' {
  if (exp.dispatches < 5) return 'continue'

  const variantRate = exp.dispatches > 0 ? exp.successes / exp.dispatches : 0
  const delta = variantRate - baselineRate

  if (delta >= 0.10) return 'promote'
  if (delta <= -0.10) return 'abandon'
  if (exp.dispatches >= 10) return delta >= 0 ? 'promote' : 'abandon'
  return 'continue'
}

export async function runPromptLabCycle(): Promise<{
  samples: number
  activeExperiment: string | null
  action: string
}> {
  const samples = pullSamples(100)
  const surfaces = getDefaultSurfaces()
  const baselineRate = samples.length > 0
    ? samples.filter(sample => sample.success).length / samples.length
    : 0

  for (const surface of surfaces) {
    const exp = getActiveExperiment(surface.name)
    if (exp) {
      const verdict = evaluateExperiment(exp, baselineRate)
      if (verdict === 'promote') {
        promoteExperiment(exp.id)
        return {
          samples: samples.length,
          activeExperiment: exp.id,
          action: `promoted ${surface.name} variant (${Math.round(exp.successes / exp.dispatches * 100)}% vs ${Math.round(baselineRate * 100)}% baseline)`,
        }
      }
      if (verdict === 'abandon') {
        abandonExperiment(exp.id)
        return {
          samples: samples.length,
          activeExperiment: exp.id,
          action: `abandoned ${surface.name} variant (${Math.round(exp.successes / exp.dispatches * 100)}% vs ${Math.round(baselineRate * 100)}% baseline)`,
        }
      }
      return {
        samples: samples.length,
        activeExperiment: exp.id,
        action: `testing ${surface.name} (${exp.dispatches} dispatches, ${Math.round(exp.successes / Math.max(exp.dispatches, 1) * 100)}%)`,
      }
    }
  }

  const targetSurface = surfaces[0]
  const variant = await optimizeSurface(targetSurface, samples)
  const baseline = serializePromptPolicy(targetSurface.currentPolicy).trim()
  if (variant && variant !== baseline) {
    const expId = createExperiment(targetSurface.name, variant, baseline)
    const variantId = parsePromptPolicy(variant).id
    return {
      samples: samples.length,
      activeExperiment: expId,
      action: `generated new ${targetSurface.name} variant (${variantId})`,
    }
  }

  return { samples: samples.length, activeExperiment: null, action: 'no variant generated' }
}
