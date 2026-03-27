import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import telemetry from './telemetry.js'
import { importTelemetryArtifacts } from './telemetry-import.js'

const { ensureTelemetrySchema } = telemetry

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE goals (id INTEGER PRIMARY KEY);
    CREATE TABLE decisions (id INTEGER PRIMARY KEY, status TEXT);
  `)
  ensureTelemetrySchema(db)
  return db
}

test('importTelemetryArtifacts imports trace bundles, session metrics, and raw Pi sessions without duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foreman-telemetry-import-'))
  const previousForemanHome = process.env.FOREMAN_HOME
  process.env.FOREMAN_HOME = root

  const traceRoot = join(root, 'traces')
  const sessionMetricsDir = join(traceRoot, 'sessions')
  const traceDir = join(traceRoot, 'trace-123')
  const piDir = join(root, '.pi', 'agent', 'sessions', 'proj-a')

  await mkdir(sessionMetricsDir, { recursive: true })
  await mkdir(traceDir, { recursive: true })
  await mkdir(piDir, { recursive: true })

  await writeFile(join(sessionMetricsDir, 'claude.json'), `${JSON.stringify({
    sessionId: 'claude-ses-1',
    harness: 'claude',
    repo: 'foreman',
    goal: 'Ship it',
    timestamp: '2026-03-27T00:10:00.000Z',
    exitCode: 0,
    success: true,
    durationMs: 60_000,
    costUsd: 0.2,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    modelIds: ['claude-sonnet-4-6'],
  }, null, 2)}\n`, 'utf8')

  await writeFile(join(traceDir, 'trace.json'), `${JSON.stringify({
    task: { id: 'task-1', goal: 'Fix bug' },
    events: [
      { at: '2026-03-27T01:00:00.000Z', kind: 'session.started', workerId: 'codex', summary: 'start' },
      { at: '2026-03-27T01:05:00.000Z', kind: 'session.completed', workerId: 'codex', summary: 'done' },
    ],
    evidence: [],
    outcome: { status: 'completed', summary: 'done', validated: true },
    metadata: {
      surface: 'session',
      provider: 'codex',
      action: 'start',
      sessionId: 'codex-ses-1',
      cwd: '/tmp/foreman',
      inputTokens: '250',
      outputTokens: '75',
      totalTokens: '325',
      model: 'gpt-5-codex',
    },
  }, null, 2)}\n`, 'utf8')

  await writeFile(join(piDir, 'pi-ses-1.jsonl'), [
    JSON.stringify({
      type: 'message',
      timestamp: '2026-03-27T02:00:00.000Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: {
          cost: { total: 0.33 },
          inputTokens: 300,
          outputTokens: 120,
        },
      },
    }),
  ].join('\n'), 'utf8')

  try {
    const db = makeDb()
    const first = await importTelemetryArtifacts(db, { traceRoot, maxAgeHours: 24 * 365, homeDir: root })
    assert.equal(first.imported, 3)

    const second = await importTelemetryArtifacts(db, { traceRoot, maxAgeHours: 24 * 365, homeDir: root })
    assert.equal(second.imported, 0)
    assert.ok(second.skipped >= 3)

    const rows = db.prepare(`
      SELECT event_key as eventKey, harness, provider, model, repo, status, total_tokens as totalTokens, cost_usd as costUsd
      FROM telemetry_runs
      ORDER BY event_key
    `).all() as Array<Record<string, unknown>>

    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map((row) => row.harness).sort(), ['claude', 'codex', 'pi'])
    const byHarness = new Map(rows.map((row) => [String(row.harness), row]))
    assert.equal(byHarness.get('claude')?.provider, 'anthropic')
    assert.equal(byHarness.get('codex')?.provider, 'openai')
    assert.equal(byHarness.get('pi')?.costUsd, 0.33)
  } finally {
    if (previousForemanHome == null) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = previousForemanHome
  }
})
