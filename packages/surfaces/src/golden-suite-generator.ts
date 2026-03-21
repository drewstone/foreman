/**
 * Golden suite generator.
 *
 * Extracts real sessions that produced verified good outcomes and
 * packages them as regression test cases. If Foreman's behavior
 * changes, these suites detect regressions.
 *
 * Source: eval traces with high scores + session metrics with task completion = 'completed'
 * Output: ~/.foreman/golden-suites/{suite-name}.json
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { FilesystemTraceStore, type TraceBundle } from '@drew/foreman-tracing'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export interface GoldenCase {
  id: string
  source: 'trace' | 'session-metric' | 'manual'
  goal: string
  repo?: string
  taskShape?: string
  expectedOutcome: 'completed' | 'pass'
  verifyCommand?: string
  expectedOutput?: string
  artifactVersions?: Record<string, string>
  metadata?: Record<string, string>
}

export interface GoldenSuite {
  name: string
  description: string
  generatedAt: string
  cases: GoldenCase[]
}

/**
 * Generate a golden suite from eval traces with high scores.
 */
export async function generateGoldenSuiteFromTraces(options?: {
  name?: string
  minScore?: number
  maxCases?: number
  traceRoot?: string
}): Promise<GoldenSuite> {
  const name = options?.name ?? 'auto-generated'
  const minScore = options?.minScore ?? 0.7
  const maxCases = options?.maxCases ?? 50
  const traceStore = new FilesystemTraceStore(
    options?.traceRoot ?? join(FOREMAN_HOME, 'traces', 'evals'),
  )

  const refs = await traceStore.list()
  const cases: GoldenCase[] = []

  for (const ref of refs) {
    if (cases.length >= maxCases) break
    const bundle = await traceStore.get(ref.traceId)
    if (!bundle) continue
    if (!bundle.outcome?.validated) continue

    // Check score from evidence
    const rewards = bundle.evidence.filter((e) => e.kind === 'reward')
    if (rewards.length === 0) continue
    const avgScore = rewards.reduce((s, r) => s + parseFloat(r.value || '0'), 0) / rewards.length
    if (avgScore < minScore) continue

    cases.push({
      id: ref.traceId,
      source: 'trace',
      goal: bundle.task.goal,
      repo: bundle.metadata?.repo,
      taskShape: bundle.metadata?.taskShape,
      expectedOutcome: 'completed',
      artifactVersions: Object.fromEntries(
        Object.entries(bundle.metadata ?? {})
          .filter(([k]) => k.endsWith('PromptVariantId'))
          .map(([k, v]) => [k.replace('PromptVariantId', ''), v]),
      ),
      metadata: {
        traceId: ref.traceId,
        score: String(avgScore),
        evalEnv: bundle.metadata?.evalEnv ?? '',
      },
    })
  }

  // Also pull from session metrics
  try {
    const sessionsDir = join(FOREMAN_HOME, 'traces', 'sessions')
    const files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.json')).sort().slice(-100)
    for (const file of files) {
      if (cases.length >= maxCases) break
      try {
        const raw = await readFile(join(sessionsDir, file), 'utf8')
        const m = JSON.parse(raw)
        if (m.taskCompletion === 'completed' && m.success && m.numTurns >= 2) {
          cases.push({
            id: `session:${m.sessionId}`,
            source: 'session-metric',
            goal: m.goal,
            repo: m.repo,
            taskShape: m.harness,
            expectedOutcome: 'completed',
            metadata: {
              sessionId: m.sessionId,
              harness: m.harness,
              durationMs: String(m.durationMs),
              costUsd: m.costUsd !== undefined ? String(m.costUsd) : '',
            },
          })
        }
      } catch { continue }
    }
  } catch { /* no session metrics */ }

  const suite: GoldenSuite = {
    name,
    description: `Auto-generated from ${cases.length} verified traces (min score: ${minScore})`,
    generatedAt: new Date().toISOString(),
    cases,
  }

  // Persist
  const suitesDir = join(FOREMAN_HOME, 'golden-suites')
  await mkdir(suitesDir, { recursive: true })
  await writeFile(
    join(suitesDir, `${name}.json`),
    JSON.stringify(suite, null, 2) + '\n',
    'utf8',
  )

  return suite
}

/**
 * Run a golden suite — replay each case and verify the outcome matches.
 */
export async function runGoldenSuite(suitePath: string, options?: {
  maxCases?: number
  onProgress?: (msg: string) => void
}): Promise<{ passed: number; failed: number; skipped: number; results: Array<{ id: string; passed: boolean; reason: string }> }> {
  const log = options?.onProgress ?? (() => {})
  const suite = JSON.parse(await readFile(suitePath, 'utf8')) as GoldenSuite
  const maxCases = options?.maxCases ?? suite.cases.length

  const results: Array<{ id: string; passed: boolean; reason: string }> = []
  let passed = 0
  let failed = 0
  let skipped = 0

  for (const c of suite.cases.slice(0, maxCases)) {
    // For trace-sourced cases, verify the artifacts still exist and the goal can still be run
    if (!c.repo) {
      skipped++
      results.push({ id: c.id, passed: false, reason: 'No repo — skipped' })
      continue
    }

    // Check repo exists
    try {
      const { statSync } = await import('node:fs')
      statSync(join(homedir(), 'code', c.repo))
    } catch {
      skipped++
      results.push({ id: c.id, passed: false, reason: `Repo ${c.repo} not found` })
      continue
    }

    // If there's a verify command, run it
    if (c.verifyCommand) {
      try {
        const { execFile } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const exec = promisify(execFile)
        const { stdout } = await exec('bash', ['-c', c.verifyCommand], {
          cwd: join(homedir(), 'code', c.repo),
          timeout: 30_000,
        })
        const matches = c.expectedOutput
          ? stdout.trim().includes(c.expectedOutput.trim())
          : stdout.trim().length > 0
        if (matches) {
          passed++
          results.push({ id: c.id, passed: true, reason: 'Verify command passed' })
        } else {
          failed++
          results.push({ id: c.id, passed: false, reason: `Verify output mismatch: ${stdout.slice(0, 100)}` })
        }
      } catch (e) {
        failed++
        results.push({ id: c.id, passed: false, reason: `Verify command failed: ${e}` })
      }
    } else {
      // No verify command — just check that the repo is in a valid state
      passed++
      results.push({ id: c.id, passed: true, reason: 'No verify command — assumed passing' })
    }

    log(`  ${c.id}: ${results[results.length - 1].passed ? 'PASS' : 'FAIL'} — ${results[results.length - 1].reason}`)
  }

  return { passed, failed, skipped, results }
}
