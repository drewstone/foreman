import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import telemetry from './telemetry.js'
import policyControl from './policy-control.js'
import replayGovernor from './replay-governor.js'

const { ensureTelemetrySchema, recordTelemetryRun } = telemetry
const { ensurePolicyControlSchema, getDispatchPolicyControl, getLatestReplayPolicyEvaluation } = policyControl
const { promoteReplayPolicy, getReplayGovernanceSnapshot } = replayGovernor

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY,
      intent TEXT,
      workspace_path TEXT
    );

    CREATE TABLE decisions (
      id INTEGER PRIMARY KEY,
      goal_id INTEGER,
      skill TEXT NOT NULL,
      task TEXT NOT NULL,
      reasoning TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'dispatched',
      origin TEXT DEFAULT 'operator',
      outcome TEXT,
      learnings TEXT,
      metrics TEXT,
      taste_signal TEXT,
      session_name TEXT,
      worktree_path TEXT,
      template_version INTEGER,
      cost_usd REAL,
      prompt_sections TEXT,
      deliverable_status TEXT DEFAULT 'unchecked',
      created_at TEXT NOT NULL
    );

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
  ensureTelemetrySchema(db)
  ensurePolicyControlSchema(db)
  return db
}

test('promoteReplayPolicy evaluates, persists, and applies a promoted dispatch policy', async () => {
  const db = makeDb()
  db.prepare(`INSERT INTO goals (id, intent, workspace_path) VALUES (1, 'Improve project', '/tmp/proj')`).run()
  db.prepare(`INSERT INTO decisions (
    id, goal_id, skill, task, reasoning, status, origin, metrics, taste_signal,
    worktree_path, cost_usd, deliverable_status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    0, 1, '/research', 'Seed context', '', 'success', 'operator',
    JSON.stringify({ scopeStatus: 'clean', testsPassed: true }),
    'approved', '/tmp/proj', 0.2, 'pass', '2026-03-23T00:00:00Z',
  )
  db.prepare(`INSERT INTO decisions (
    id, goal_id, skill, task, reasoning, status, origin, metrics, taste_signal,
    worktree_path, cost_usd, deliverable_status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    1, 1, '/evolve', 'Task A', '', 'success', 'operator',
    JSON.stringify({ scopeStatus: 'clean', testsPassed: true }),
    'approved', '/tmp/proj', 1.0, 'pass', '2026-03-24T00:00:00Z',
  )
  db.prepare(`INSERT INTO decisions (
    id, goal_id, skill, task, reasoning, status, origin, metrics, taste_signal,
    worktree_path, cost_usd, deliverable_status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    2, 1, '/evolve', 'Task B', '', 'failure', 'operator',
    JSON.stringify({ scopeStatus: 'violation', testsPassed: false }),
    'rejected', '/tmp/proj', 2.0, 'fail', '2026-03-25T00:00:00Z',
  )

  recordTelemetryRun(db, {
    eventKey: 'proj-verify',
    harness: 'claude',
    repo: 'proj',
    skill: '/verify',
    costUsd: 0.3,
    finishedAt: '2099-01-01T00:00:00Z',
  })
  recordTelemetryRun(db, {
    eventKey: 'proj-diagnose',
    harness: 'claude',
    repo: 'proj',
    skill: '/diagnose',
    costUsd: 0.5,
    finishedAt: '2099-01-01T00:00:00Z',
  })
  recordTelemetryRun(db, {
    eventKey: 'proj-evolve',
    harness: 'claude',
    repo: 'proj',
    skill: '/evolve',
    costUsd: 1.5,
    finishedAt: '2099-01-01T00:00:00Z',
  })

  const result = await promoteReplayPolicy(db, {
    policyName: 'heuristic',
    baselineName: 'identity',
    project: 'proj',
    apply: true,
    promotionRule: {
      minExamples: 2,
      minGoodExamples: 1,
      minBadExamples: 1,
    },
  })

  assert.equal(result.evaluation.promotion?.status, 'promote')
  assert.equal(result.activePolicy?.policyName, 'heuristic')
  assert.equal(result.persisted.applied, 1)
  assert.equal(getDispatchPolicyControl(db)?.policyName, 'heuristic')
  assert.equal(getLatestReplayPolicyEvaluation(db)?.candidatePolicyName, 'heuristic')

  const snapshot = getReplayGovernanceSnapshot(db)
  assert.equal(snapshot.activePolicy?.policyName, 'heuristic')
  assert.equal(snapshot.latest?.promotionStatus, 'promote')
})
