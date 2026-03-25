/**
 * Experiment runner — creates, runs, and promotes optimization experiments.
 *
 * Each experiment is an isolated directory under experiments/ containing:
 *   generator.ts  — the AxLLM setup (signature, instruction)
 *   metric.ts     — the scoring function
 *   config.json   — hyperparams (numTrials, model, etc.)
 *   results.json  — outcomes after testing
 *
 * On promotion, generator.ts content replaces current/<surface>.ts
 */

import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs'
import { getDb, log } from '../state.js'

const OPTIMIZATION_DIR = join(import.meta.dirname ?? __dirname, 'optimization')
const EXPERIMENTS_DIR = join(OPTIMIZATION_DIR, 'experiments')
const CURRENT_DIR = join(OPTIMIZATION_DIR, 'current')

export interface ExperimentConfig {
  surface: string
  approach: 'axgen_simple' | 'axgen_failure_analysis' | 'axflow_pipeline'
  gepaSignature: string
  instruction: string
  numTrials: number
  studentModel: string
  teacherModel: string
  minibatchSize: number
  earlyStoppingTrials: number
}

export interface ExperimentResult {
  expId: string
  surface: string
  variant: string
  dispatches: number
  successes: number
  rate: number
  baselineRate: number
  delta: number
  verdict: 'promoted' | 'abandoned' | 'testing'
  scores: Record<string, number>[]
}

/**
 * Create a new experiment directory with generator, metric, and config.
 */
export function createExperiment(
  surface: string,
  approach: ExperimentConfig['approach'],
  instruction: string,
  config?: Partial<ExperimentConfig>,
): string {
  const expId = `exp-${surface}-${Date.now().toString(36)}`
  const expDir = join(EXPERIMENTS_DIR, expId)
  mkdirSync(expDir, { recursive: true })

  const fullConfig: ExperimentConfig = {
    surface,
    approach,
    gepaSignature: config?.gepaSignature ?? `task:string, skill:string -> ${surface}Instruction:string`,
    instruction,
    numTrials: config?.numTrials ?? 4,
    studentModel: config?.studentModel ?? 'claude-sonnet-4-6',
    teacherModel: config?.teacherModel ?? 'claude-opus-4-6',
    minibatchSize: config?.minibatchSize ?? 3,
    earlyStoppingTrials: config?.earlyStoppingTrials ?? 2,
  }

  // Write config
  writeFileSync(join(expDir, 'config.json'), JSON.stringify(fullConfig, null, 2))

  // Write the generator (the instruction that GEPA will optimize)
  writeFileSync(join(expDir, 'generator.ts'), `/**
 * Experiment: ${expId}
 * Surface: ${surface}
 * Approach: ${approach}
 * Created: ${new Date().toISOString()}
 */

export const INSTRUCTION = ${JSON.stringify(instruction)}

export const SIGNATURE = ${JSON.stringify(fullConfig.gepaSignature)}
`)

  // Write the metric stub
  writeFileSync(join(expDir, 'metric.ts'), `/**
 * Metric for ${expId}
 * Returns 0-1 scores per dimension.
 */

export function score(sample: { success: boolean, scopeViolation: boolean }): Record<string, number> {
  return {
    success: sample.success ? 1 : 0,
    scopeCompliance: sample.scopeViolation ? 0 : 1,
  }
}
`)

  // Init empty results
  writeFileSync(join(expDir, 'results.json'), JSON.stringify({
    expId,
    surface,
    dispatches: 0,
    successes: 0,
    scores: [],
    verdict: 'testing',
    created: new Date().toISOString(),
  }, null, 2))

  log(`Experiment created: ${expId} in ${expDir}`)
  return expId
}

/**
 * Record an outcome for an experiment.
 */
export function recordOutcome(expId: string, success: boolean, scores?: Record<string, number>): void {
  const resultsPath = join(EXPERIMENTS_DIR, expId, 'results.json')
  if (!existsSync(resultsPath)) return

  const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as ExperimentResult
  results.dispatches++
  if (success) results.successes++
  results.rate = results.dispatches > 0 ? results.successes / results.dispatches : 0
  if (scores) results.scores.push(scores)

  writeFileSync(resultsPath, JSON.stringify(results, null, 2))
}

/**
 * Read experiment results.
 */
export function getResults(expId: string): ExperimentResult | null {
  const resultsPath = join(EXPERIMENTS_DIR, expId, 'results.json')
  if (!existsSync(resultsPath)) return null
  return JSON.parse(readFileSync(resultsPath, 'utf8'))
}

/**
 * Read experiment config.
 */
export function getConfig(expId: string): ExperimentConfig | null {
  const configPath = join(EXPERIMENTS_DIR, expId, 'config.json')
  if (!existsSync(configPath)) return null
  return JSON.parse(readFileSync(configPath, 'utf8'))
}

/**
 * Promote an experiment: copy its generator to current/<surface>.ts
 */
export function promote(expId: string): void {
  const config = getConfig(expId)
  if (!config) return

  const genPath = join(EXPERIMENTS_DIR, expId, 'generator.ts')
  const targetPath = join(CURRENT_DIR, `${config.surface}.ts`)

  if (!existsSync(genPath)) return

  // Read the instruction from the experiment
  const genContent = readFileSync(genPath, 'utf8')

  // Write to current with promotion metadata
  const promoted = `/**
 * ${config.surface} surface — PROMOTED from ${expId}
 * Promoted: ${new Date().toISOString()}
 * Approach: ${config.approach}
 */

${genContent}
`
  writeFileSync(targetPath, promoted)

  // Update results
  const results = getResults(expId)
  if (results) {
    results.verdict = 'promoted'
    writeFileSync(join(EXPERIMENTS_DIR, expId, 'results.json'), JSON.stringify(results, null, 2))
  }

  log(`Experiment promoted: ${expId} → current/${config.surface}.ts`)
}

/**
 * Read the current live instruction for a surface.
 */
export function getCurrentInstruction(surface: string): string | null {
  const currentPath = join(CURRENT_DIR, `${surface}.ts`)
  if (!existsSync(currentPath)) return null

  const content = readFileSync(currentPath, 'utf8')
  // Extract the INSTRUCTION or STANDARDS_INSTRUCTION export
  const match = content.match(/export const (?:INSTRUCTION|STANDARDS_INSTRUCTION|[\w_]+INSTRUCTION)\s*=\s*(['"`])([\s\S]*?)\1/m)
    ?? content.match(/export const (?:INSTRUCTION|STANDARDS_INSTRUCTION|[\w_]+INSTRUCTION)\s*=\s*\[([\s\S]*?)\]\.join/m)
  if (match) return match[2] ?? match[1] ?? null

  // Try JSON.parse approach
  const jsonMatch = content.match(/export const INSTRUCTION = (["'][\s\S]*?["'])/)
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]) } catch {}
  }

  return null
}

/**
 * List all experiments for a surface.
 */
export function listExperiments(surface?: string): Array<{ id: string, surface: string, verdict: string, rate: number, dispatches: number }> {
  if (!existsSync(EXPERIMENTS_DIR)) return []

  const { readdirSync } = require('node:fs')
  const dirs = readdirSync(EXPERIMENTS_DIR).filter((d: string) => d.startsWith('exp-'))

  const results: Array<{ id: string, surface: string, verdict: string, rate: number, dispatches: number }> = []
  for (const dir of dirs) {
    if (surface && !dir.includes(surface)) continue
    const r = getResults(dir)
    if (r) results.push({ id: r.expId, surface: r.surface, verdict: r.verdict, rate: r.rate, dispatches: r.dispatches })
  }
  return results
}
