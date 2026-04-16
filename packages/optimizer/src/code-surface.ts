/**
 * CodeSurface — optimize source code files via meta-harness evolution.
 *
 * Implements OptimizationSurface so it participates in Foreman's existing
 * optimization cycle. Extends with Pareto frontier for multi-dimensional
 * tracking. Uses TraceStore for trace access (no custom injector).
 *
 * The "configuration" being optimized is the source code of a harness file.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ParetoFrontier, ParetoEntry } from './pareto.js'
import { createFrontier, addToFrontier, serializeFrontier, deserializeFrontier, frontierSummary } from './pareto.js'
import type { Hypothesis } from './hypothesis.js'

/**
 * Implements the same shape as OptimizationSurface from
 * service/lib/optimization-surface.ts but adds Pareto frontier.
 * Registered via registerSurface() in the service.
 */
export interface CodeSurfaceConfig {
  /** Unique name for this surface */
  name: string
  /** Human description for the proposer */
  description: string
  /** Path to the harness file being evolved */
  harnessPath: string
  /** Dimensions to track on the Pareto frontier */
  dimensions: string[]
  /** Root directory for .evolve/meta-harness state (frontier, evolution, variants) */
  stateDir: string
  /** AxGEPA signature (for compatibility with prompt lab) */
  gepaSignature?: string
}

export interface EvolutionEntry {
  iteration: number
  name: string
  hypothesis: string
  baseSystem: string
  changes: string[]
  scores: Record<string, number> | null
  delta: Record<string, number> | null
  outcome: 'frontier' | 'dominated' | 'rejected' | 'failed'
  timestamp: string
}

export class CodeSurface {
  readonly config: CodeSurfaceConfig
  private frontier: ParetoFrontier<string>

  constructor(config: CodeSurfaceConfig) {
    this.config = config
    mkdirSync(join(config.stateDir, 'variants'), { recursive: true })
    mkdirSync(dirname(this.frontierPath), { recursive: true })
    this.frontier = this.loadFrontier()
  }

  // ─── OptimizationSurface interface ──────────────────────────────────

  get name(): string { return this.config.name }
  get description(): string { return this.config.description }
  get gepaSignature(): string { return this.config.gepaSignature ?? `traces -> harness:code "${this.config.description}"` }

  /** Current harness source code */
  getCurrent(): string {
    return readFileSync(this.config.harnessPath, 'utf8')
  }

  /** Apply a variant as the active harness */
  apply(code: string): void {
    writeFileSync(this.config.harnessPath, code)
  }

  /**
   * Pull labeled samples — returns evolution entries as the "samples"
   * the optimization cycle scores. For code surfaces, the real signal
   * is in the Pareto frontier, not binary promote/abandon.
   */
  pullSamples(limit: number): EvolutionEntry[] {
    return this.readEvolution().slice(-limit)
  }

  /** Score an evolution entry for compatibility with the surface registry */
  score(sample: EvolutionEntry): Record<string, number> {
    if (!sample.scores) return { success: 0 }
    return { success: sample.outcome === 'frontier' ? 1 : 0, ...sample.scores }
  }

  // ─── Pareto frontier ────────────────────────────────────────────────

  private get frontierPath(): string {
    return join(this.config.stateDir, 'frontier.json')
  }

  private get evolutionPath(): string {
    return join(this.config.stateDir, 'evolution.jsonl')
  }

  get variantsDir(): string {
    return join(this.config.stateDir, 'variants')
  }

  private loadFrontier(): ParetoFrontier<string> {
    if (existsSync(this.frontierPath)) {
      try {
        return deserializeFrontier(readFileSync(this.frontierPath, 'utf8'))
      } catch {}
    }
    return createFrontier(this.config.dimensions)
  }

  saveFrontier(): void {
    writeFileSync(this.frontierPath, serializeFrontier(this.frontier))
  }

  getFrontier(): ParetoFrontier<string> {
    return this.frontier
  }

  getFrontierSummary(): string {
    return frontierSummary(this.frontier)
  }

  seedBaseline(scores: Record<string, number>): void {
    const entry: ParetoEntry<string> = {
      id: 'baseline',
      config: this.getCurrent(),
      scores,
      hypothesis: 'baseline — current production harness',
      iteration: 0,
      timestamp: new Date().toISOString(),
    }
    addToFrontier(this.frontier, entry)
    this.saveFrontier()
  }

  tryAddToFrontier(hyp: Hypothesis, code: string, scores: Record<string, number>): boolean {
    const entry: ParetoEntry<string> = {
      id: hyp.name,
      config: code,
      scores,
      hypothesis: hyp.hypothesis,
      iteration: hyp.iteration,
      timestamp: new Date().toISOString(),
    }
    const added = addToFrontier(this.frontier, entry)
    this.saveFrontier()
    return added
  }

  // ─── Variants ───────────────────────────────────────────────────────

  writeVariant(name: string, code: string): string {
    const ext = this.config.harnessPath.split('.').pop() ?? 'ts'
    const path = join(this.variantsDir, `${name}.${ext}`)
    writeFileSync(path, code)
    return path
  }

  readVariant(name: string): string | null {
    const ext = this.config.harnessPath.split('.').pop() ?? 'ts'
    const path = join(this.variantsDir, `${name}.${ext}`)
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8')
  }

  // ─── Evolution log ──────────────────────────────────────────────────

  recordEvolution(entry: EvolutionEntry): void {
    appendFileSync(this.evolutionPath, JSON.stringify(entry) + '\n')
  }

  readEvolution(): EvolutionEntry[] {
    if (!existsSync(this.evolutionPath)) return []
    return readFileSync(this.evolutionPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) }
        catch { return null }
      })
      .filter((e): e is EvolutionEntry => e !== null)
  }
}
