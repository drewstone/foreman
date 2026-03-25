/**
 * Optimization Surface — the general pattern for autonomous improvement.
 *
 * This is the abstraction that /evolve, /pursue, and the Prompt Lab
 * all implement in different ways:
 *
 *   RIVER: continuous data flow producing (input, outcome) pairs
 *   LAB: observe outcomes, generate variants via GEPA, A/B test
 *   PROMOTE: winners become the new default
 *
 * Any measurable configuration in Foreman can be wrapped as a Surface:
 *   - Prompt standards (what instructions do dispatched agents get?)
 *   - Dispatch policy (which skill for which task?)
 *   - Model routing (opus vs sonnet vs haiku for each skill?)
 *   - Context budgets (how much context per prompt tier?)
 *   - Scope strictness (how tight should file allowlists be?)
 *   - Post-completion strategy (identity vs digest vs full review?)
 *
 * The Surface interface is intentionally minimal. A surface knows:
 *   - How to read its current configuration
 *   - How to read outcome data relevant to it
 *   - How to describe itself to GEPA for optimization
 *   - How to apply a promoted variant
 *
 * The lab handles the experiment lifecycle (create, measure, promote/abandon).
 * GEPA handles the optimization (generate variants from data).
 * The surface just defines WHAT to optimize and HOW to measure it.
 */

import { getDb, log } from './state.js'

// ─── Core interface ──────────────────────────────────────────────────

export interface OptimizationSurface<TConfig = string, TSample = Record<string, unknown>> {
  /** Unique name for this surface */
  name: string

  /** Human description for GEPA's teacher model */
  description: string

  /** Read the current configuration value */
  getCurrent(): TConfig

  /** Apply a promoted configuration */
  apply(config: TConfig): void

  /** AxGEPA signature string: 'input:type -> output:type "description"' */
  gepaSignature: string

  /** Pull labeled samples relevant to this surface */
  pullSamples(limit: number): TSample[]

  /** Score a sample: returns 0-1 for each metric dimension */
  score(sample: TSample): Record<string, number>
}

// ─── Experiment lifecycle (generic, works for any surface) ───────────

export interface SurfaceExperiment {
  id: string
  surface: string
  variant: string       // JSON-serialized TConfig
  baseline: string      // JSON-serialized TConfig
  dispatches: number
  successes: number
  status: 'testing' | 'promoted' | 'abandoned'
  created: string
}

export function ensureSurfaceTable(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS optimization_surfaces (
      id TEXT PRIMARY KEY,
      surface TEXT NOT NULL,
      variant TEXT NOT NULL,
      baseline TEXT NOT NULL,
      dispatches INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'testing',
      scores TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      promoted_at TEXT
    )
  `)
}

export function createSurfaceExperiment(surface: string, variant: string, baseline: string): string {
  const db = getDb()
  ensureSurfaceTable()
  const id = `surf-${surface}-${Date.now().toString(36)}`
  db.prepare(`INSERT INTO optimization_surfaces (id, surface, variant, baseline) VALUES (?, ?, ?, ?)`)
    .run(id, surface, variant, baseline)
  log(`Surface[${surface}]: created experiment ${id}`)
  return id
}

export function recordSurfaceOutcome(surface: string, success: boolean, scores?: Record<string, number>): void {
  const db = getDb()
  ensureSurfaceTable()
  const exp = db.prepare(
    `SELECT id FROM optimization_surfaces WHERE surface = ? AND status = 'testing' ORDER BY created_at DESC LIMIT 1`
  ).get(surface) as { id: string } | undefined
  if (!exp) return
  db.prepare(`UPDATE optimization_surfaces SET dispatches = dispatches + 1, successes = successes + ? WHERE id = ?`)
    .run(success ? 1 : 0, exp.id)
}

export function getActiveSurfaceExperiment(surface: string): SurfaceExperiment | null {
  const db = getDb()
  ensureSurfaceTable()
  return db.prepare(
    `SELECT * FROM optimization_surfaces WHERE surface = ? AND status = 'testing' ORDER BY created_at DESC LIMIT 1`
  ).get(surface) as SurfaceExperiment | null
}

export function getPromotedSurfaceConfig(surface: string): string | null {
  const db = getDb()
  ensureSurfaceTable()
  const row = db.prepare(
    `SELECT variant FROM optimization_surfaces WHERE surface = ? AND status = 'promoted' ORDER BY promoted_at DESC LIMIT 1`
  ).get(surface) as { variant: string } | undefined
  return row?.variant ?? null
}

export function promoteSurface(expId: string): void {
  const db = getDb()
  db.prepare(`UPDATE optimization_surfaces SET status = 'promoted', promoted_at = datetime('now') WHERE id = ?`).run(expId)
}

export function abandonSurface(expId: string): void {
  const db = getDb()
  db.prepare(`UPDATE optimization_surfaces SET status = 'abandoned' WHERE id = ?`).run(expId)
}

/**
 * Evaluate: should we promote, abandon, or keep testing?
 * Generic significance check that works for any surface.
 */
export function evaluateSurfaceExperiment(
  exp: SurfaceExperiment,
  baselineRate: number,
  opts?: { minDispatches?: number, promotionThreshold?: number, maxDispatches?: number },
): 'promote' | 'abandon' | 'continue' {
  const min = opts?.minDispatches ?? 5
  const threshold = opts?.promotionThreshold ?? 0.10
  const max = opts?.maxDispatches ?? 10

  if (exp.dispatches < min) return 'continue'

  const variantRate = exp.dispatches > 0 ? exp.successes / exp.dispatches : 0
  const delta = variantRate - baselineRate

  if (delta >= threshold) return 'promote'
  if (delta <= -threshold) return 'abandon'
  if (exp.dispatches >= max) return delta >= 0 ? 'promote' : 'abandon'
  return 'continue'
}

// ─── Registry: all optimization surfaces in the system ───────────────

const surfaces = new Map<string, OptimizationSurface>()

export function registerSurface(surface: OptimizationSurface): void {
  surfaces.set(surface.name, surface)
  log(`Surface registered: ${surface.name}`)
}

export function getSurface(name: string): OptimizationSurface | undefined {
  return surfaces.get(name)
}

export function listSurfaces(): OptimizationSurface[] {
  return [...surfaces.values()]
}

/**
 * Run one optimization cycle across all registered surfaces.
 * Called periodically by the service.
 */
export async function runOptimizationCycle(): Promise<{
  surface: string
  action: string
} | null> {
  for (const surface of surfaces.values()) {
    const exp = getActiveSurfaceExperiment(surface.name)
    const samples = surface.pullSamples(100)
    const baselineRate = samples.length > 0
      ? samples.filter(s => surface.score(s).success >= 0.5).length / samples.length
      : 0

    if (exp) {
      const verdict = evaluateSurfaceExperiment(exp, baselineRate)
      if (verdict === 'promote') {
        promoteSurface(exp.id)
        surface.apply(JSON.parse(exp.variant))
        return { surface: surface.name, action: `promoted (${Math.round(exp.successes/exp.dispatches*100)}% vs ${Math.round(baselineRate*100)}% baseline)` }
      }
      if (verdict === 'abandon') {
        abandonSurface(exp.id)
        return { surface: surface.name, action: `abandoned (${Math.round(exp.successes/exp.dispatches*100)}% vs ${Math.round(baselineRate*100)}% baseline)` }
      }
      return { surface: surface.name, action: `testing (${exp.dispatches} dispatches)` }
    }
  }

  // No active experiments — could trigger GEPA here
  return null
}
