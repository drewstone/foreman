import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import telemetry from './telemetry.js'

const { ensureTelemetrySchema, recordTelemetryRun, summarizeTelemetry, getDailyTelemetryCost } = telemetry

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE goals (id INTEGER PRIMARY KEY);
    CREATE TABLE decisions (id INTEGER PRIMARY KEY);
  `)
  ensureTelemetrySchema(db)
  return db
}

test('telemetry summary aggregates by harness/provider/model/repo/skill', () => {
  const db = makeDb()

  recordTelemetryRun(db, {
    eventKey: 'run-1',
    harness: 'claude',
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    repo: 'foreman',
    skill: '/evolve',
    status: 'success',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 1.25,
    finishedAt: '2099-01-01T00:00:00Z',
  })
  recordTelemetryRun(db, {
    eventKey: 'run-2',
    harness: 'codex',
    provider: 'openai',
    model: 'gpt-5-codex',
    repo: 'foreman',
    skill: '/pursue',
    status: 'success',
    inputTokens: 200,
    outputTokens: 100,
    costUsd: 2.5,
    finishedAt: '2099-01-01T00:10:00Z',
  })

  const summary = summarizeTelemetry(db, 24 * 365 * 200)
  assert.equal(summary.runs, 2)
  assert.equal(summary.totalCostUsd, 3.75)
  assert.equal(summary.totalTokens, 450)
  assert.equal(summary.byHarness[0]?.key, 'codex')
  assert.equal(summary.byProvider[0]?.key, 'openai')
  assert.equal(summary.byRepo[0]?.key, 'foreman')
})

test('recordTelemetryRun upserts by event key', () => {
  const db = makeDb()

  recordTelemetryRun(db, {
    eventKey: 'dedupe',
    harness: 'claude',
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    costUsd: 1,
    finishedAt: '2099-01-01T00:00:00Z',
  })
  recordTelemetryRun(db, {
    eventKey: 'dedupe',
    harness: 'claude',
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    costUsd: 2,
    finishedAt: '2099-01-01T00:00:00Z',
  })

  const row = db.prepare(`SELECT COUNT(*) as count, SUM(cost_usd) as total FROM telemetry_runs`).get() as { count: number, total: number }
  assert.equal(row.count, 1)
  assert.equal(row.total, 2)
})

test('getDailyTelemetryCost sums only today rows', () => {
  const db = makeDb()

  recordTelemetryRun(db, {
    eventKey: 'today',
    harness: 'claude',
    costUsd: 3,
    finishedAt: new Date().toISOString(),
  })
  recordTelemetryRun(db, {
    eventKey: 'old',
    harness: 'claude',
    costUsd: 4,
    finishedAt: '2000-01-01T00:00:00Z',
  })

  assert.equal(getDailyTelemetryCost(db), 3)
})
