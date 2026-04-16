/**
 * Trace Injector — expose raw traces as filesystem for CC proposers.
 *
 * The paper's key finding: raw traces (10M tokens) >> summaries (34.9 acc)
 * >> scores-only (34.6 acc). The proposer reads 82 files per iteration,
 * 41% source code and 40% execution traces.
 *
 * This module dumps raw trace data into a directory structure CC can
 * navigate with Read/Grep/Glob. No summarization — let CC do its own diagnosis.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface TraceInjectionSource {
  /** Variant name this trace belongs to */
  variant: string
  /** Scenario/task identifier */
  scenario: string
  /** Raw execution output (stdout, logs, etc.) */
  output: string
  /** Scores achieved */
  scores?: Record<string, number>
  /** Duration in ms */
  durationMs?: number
  /** Whether this was a pass or fail */
  passed?: boolean
  /** Full request/response if available */
  request?: string
  response?: string
  /** Error message if failed */
  error?: string
}

/**
 * Write raw traces into a directory structure CC can navigate:
 *
 * tracesDir/
 *   {variant}/
 *     {scenario}.json     — full trace data
 *     {scenario}.log      — raw output text
 *     summary.json        — per-variant aggregate (scores, pass rate)
 */
export function injectTraces(tracesDir: string, traces: TraceInjectionSource[]): void {
  mkdirSync(tracesDir, { recursive: true })

  // Group by variant
  const byVariant = new Map<string, TraceInjectionSource[]>()
  for (const trace of traces) {
    const list = byVariant.get(trace.variant) ?? []
    list.push(trace)
    byVariant.set(trace.variant, list)
  }

  for (const [variant, variantTraces] of byVariant) {
    const variantDir = join(tracesDir, variant)
    mkdirSync(variantDir, { recursive: true })

    let passCount = 0
    let totalCount = 0
    const allScores: Record<string, number[]> = {}

    for (const trace of variantTraces) {
      totalCount++
      if (trace.passed) passCount++

      // Full structured trace
      writeFileSync(
        join(variantDir, `${trace.scenario}.json`),
        JSON.stringify({
          variant: trace.variant,
          scenario: trace.scenario,
          passed: trace.passed,
          scores: trace.scores,
          durationMs: trace.durationMs,
          error: trace.error,
          request: trace.request,
          response: trace.response,
        }, null, 2),
      )

      // Raw output log (CC reads this for diagnosis)
      if (trace.output) {
        writeFileSync(join(variantDir, `${trace.scenario}.log`), trace.output)
      }

      // Accumulate scores for summary
      for (const [key, val] of Object.entries(trace.scores ?? {})) {
        if (!allScores[key]) allScores[key] = []
        allScores[key].push(val)
      }
    }

    // Per-variant summary
    const avgScores: Record<string, number> = {}
    for (const [key, vals] of Object.entries(allScores)) {
      avgScores[key] = vals.reduce((a, b) => a + b, 0) / vals.length
    }

    writeFileSync(
      join(variantDir, 'summary.json'),
      JSON.stringify({
        variant,
        passRate: totalCount > 0 ? passCount / totalCount : 0,
        totalScenarios: totalCount,
        passed: passCount,
        failed: totalCount - passCount,
        averageScores: avgScores,
      }, null, 2),
    )
  }
}

/**
 * Write the evolution summary as a single JSONL file CC can grep through.
 */
export function writeEvolutionSummary(
  evolutionPath: string,
  entries: Array<{
    iteration: number
    name: string
    hypothesis: string
    baseSystem: string
    scores: Record<string, number> | null
    outcome: string
  }>,
): void {
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  writeFileSync(evolutionPath, lines)
}
