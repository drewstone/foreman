/**
 * CodeSurface — optimize source code files, not just prompts.
 *
 * Extends OptimizationSurface for code-level evolution. The "configuration"
 * is the source code of a harness file. The proposer (CC) reads raw traces
 * and prior variants, then writes a structurally different version.
 *
 * This is the bridge between Foreman's optimization infrastructure and
 * the meta-harness pattern from the Stanford paper.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ParetoFrontier, ParetoEntry } from './pareto.js'
import { createFrontier, addToFrontier, serializeFrontier, deserializeFrontier } from './pareto.js'
import type { Hypothesis } from './hypothesis.js'

export interface CodeSurfaceConfig {
  /** Unique name for this surface */
  name: string
  /** Human description for the proposer */
  description: string
  /** Path to the harness file being evolved */
  harnessPath: string
  /** Directory where variants are written */
  variantsDir: string
  /** Directory where raw traces live (CC reads these directly) */
  tracesDir: string
  /** Path to frontier.json */
  frontierPath: string
  /** Path to evolution.jsonl */
  evolutionPath: string
  /** Command to validate a variant compiles (e.g., "tsc --noEmit") */
  validateCommand: string
  /** Command to benchmark a variant (e.g., "pnpm test:eval") */
  benchmarkCommand: string
  /** Dimensions to track on the Pareto frontier */
  dimensions: string[]
  /** CWD for validate/benchmark commands */
  cwd: string
}

export interface EvolutionEntry {
  iteration: number
  hypothesis: Hypothesis
  scores: Record<string, number> | null
  delta: Record<string, number> | null
  outcome: 'frontier' | 'dominated' | 'failed_validation' | 'failed_benchmark'
  timestamp: string
}

export class CodeSurface {
  readonly config: CodeSurfaceConfig
  private frontier: ParetoFrontier<string>

  constructor(config: CodeSurfaceConfig) {
    this.config = config
    mkdirSync(config.variantsDir, { recursive: true })
    mkdirSync(config.tracesDir, { recursive: true })
    mkdirSync(dirname(config.frontierPath), { recursive: true })
    mkdirSync(dirname(config.evolutionPath), { recursive: true })
    this.frontier = this.loadFrontier()
  }

  /** Read the current harness code */
  getCurrent(): string {
    return readFileSync(this.config.harnessPath, 'utf8')
  }

  /** Apply a variant as the current harness */
  apply(code: string): void {
    writeFileSync(this.config.harnessPath, code)
  }

  /** Load the Pareto frontier from disk */
  private loadFrontier(): ParetoFrontier<string> {
    if (existsSync(this.config.frontierPath)) {
      return deserializeFrontier(readFileSync(this.config.frontierPath, 'utf8'))
    }
    return createFrontier(this.config.dimensions)
  }

  /** Persist the frontier to disk */
  saveFrontier(): void {
    writeFileSync(this.config.frontierPath, serializeFrontier(this.frontier))
  }

  /** Get the frontier (read-only) */
  getFrontier(): ParetoFrontier<string> {
    return this.frontier
  }

  /** Register a baseline (the current harness) with its scores */
  seedBaseline(scores: Record<string, number>): void {
    const code = this.getCurrent()
    const entry: ParetoEntry<string> = {
      id: 'baseline',
      config: code,
      scores,
      hypothesis: 'baseline — current production harness',
      iteration: 0,
      timestamp: new Date().toISOString(),
    }
    addToFrontier(this.frontier, entry)
    this.saveFrontier()
  }

  /** Write a variant to the variants directory */
  writeVariant(name: string, code: string): string {
    const ext = this.config.harnessPath.split('.').pop() ?? 'ts'
    const path = join(this.config.variantsDir, `${name}.${ext}`)
    writeFileSync(path, code)
    return path
  }

  /** Read a variant from the variants directory */
  readVariant(name: string): string | null {
    const ext = this.config.harnessPath.split('.').pop() ?? 'ts'
    const path = join(this.config.variantsDir, `${name}.${ext}`)
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8')
  }

  /** Record an evolution entry (append to evolution.jsonl) */
  recordEvolution(entry: EvolutionEntry): void {
    const line = JSON.stringify(entry) + '\n'
    const { appendFileSync } = require('node:fs')
    appendFileSync(this.config.evolutionPath, line)
  }

  /** Try to add scored variant to frontier. Returns true if non-dominated. */
  addToFrontier(hypothesis: Hypothesis, code: string, scores: Record<string, number>): boolean {
    const entry: ParetoEntry<string> = {
      id: hypothesis.name,
      config: code,
      scores,
      hypothesis: hypothesis.hypothesis,
      iteration: hypothesis.iteration,
      timestamp: new Date().toISOString(),
    }
    const added = addToFrontier(this.frontier, entry)
    this.saveFrontier()
    return added
  }

  /** Get the state files a CC proposer needs to read */
  getProposerContext(): {
    frontierPath: string
    evolutionPath: string
    tracesDir: string
    variantsDir: string
    harnessPath: string
  } {
    return {
      frontierPath: this.config.frontierPath,
      evolutionPath: this.config.evolutionPath,
      tracesDir: this.config.tracesDir,
      variantsDir: this.config.variantsDir,
      harnessPath: this.config.harnessPath,
    }
  }
}
