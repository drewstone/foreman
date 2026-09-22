import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import telemetry from './telemetry.js'
import { answerProjectQuestion, getProjectDrilldown, listProjectRecommendations } from './dashboard-model.js'

const { ensureTelemetrySchema, recordTelemetryRun } = telemetry

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE goals (
      id INTEGER PRIMARY KEY,
      intent TEXT,
      workspace_path TEXT,
      status TEXT DEFAULT 'active',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE decisions (
      id INTEGER PRIMARY KEY,
      goal_id INTEGER,
      skill TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      outcome TEXT,
      deliverable_status TEXT,
      worktree_path TEXT,
      created_at TEXT NOT NULL,
      metrics TEXT,
      taste_signal TEXT,
      session_name TEXT,
      reasoning TEXT DEFAULT '',
      origin TEXT DEFAULT 'operator',
      learnings TEXT,
      template_version INTEGER,
      cost_usd REAL,
      prompt_sections TEXT,
      scope_spec TEXT,
      deliverable_spec TEXT,
      prompt_policy_id TEXT
    );

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE operator_sessions (
      id TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      repo TEXT,
      timestamp TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      user_messages TEXT,
      skills_used TEXT,
      outcome_signals TEXT,
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE prompt_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL,
      template TEXT NOT NULL,
      score REAL,
      dispatches INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  ensureTelemetrySchema(db)
  return db
}

test('listProjectRecommendations ranks scoped projects by observed need and readiness', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO goals (id, intent, workspace_path, status) VALUES (1, 'Loop foreman', '/tmp/foreman', 'active')`).run()
  db.prepare(`INSERT INTO goals (id, intent, workspace_path, status) VALUES (2, 'Fix pigraph', '/tmp/pigraph', 'active')`).run()

  const insertDecision = db.prepare(`
    INSERT INTO decisions (
      id, goal_id, skill, task, status, outcome, deliverable_status, worktree_path,
      created_at, metrics, taste_signal, cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  insertDecision.run(1, 1, '/evolve', 'Task A', 'success', 'good', 'pass', '/tmp/foreman', '2026-03-25T00:00:00Z', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'approved', 0.4)
  insertDecision.run(2, 1, '/verify', 'Task B', 'success', 'good', 'pass', '/tmp/foreman', '2026-03-25T01:00:00Z', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'approved', 0.3)
  insertDecision.run(3, 1, '/evolve', 'Task C', 'success', 'good', 'pass', '/tmp/foreman', '2026-03-25T02:00:00Z', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'approved', 0.5)
  insertDecision.run(4, 1, '/verify', 'Task D', 'success', 'good', 'pass', '/tmp/foreman', '2026-03-25T03:00:00Z', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'approved', 0.2)

  insertDecision.run(10, 2, '/evolve', 'Broken A', 'failure', 'bad', 'fail', '/tmp/pigraph', '2026-03-25T00:00:00Z', JSON.stringify({ scopeStatus: 'violation', testsPassed: false }), 'rejected', 1.2)
  insertDecision.run(11, 2, '/diagnose', 'Broken B', 'failure', 'bad', 'fail', '/tmp/pigraph', '2026-03-25T01:00:00Z', JSON.stringify({ scopeStatus: 'violation', testsPassed: false }), 'rejected', 1.1)
  insertDecision.run(12, 2, '/verify', 'Broken C', 'success', 'mixed', 'pass', '/tmp/pigraph', '2026-03-25T02:00:00Z', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'approved', 0.9)
  insertDecision.run(13, 2, '/evolve', 'Broken D', 'failure', 'bad', 'fail', '/tmp/pigraph', '2026-03-25T03:00:00Z', JSON.stringify({ scopeStatus: 'violation', testsPassed: false }), 'rejected', 1.3)

  db.prepare(`
    INSERT INTO operator_sessions (id, harness, repo, timestamp, user_messages, skills_used, outcome_signals)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('sess-1', 'claude', '/home/drew/code/foreman', '2026-03-26T00:00:00Z', JSON.stringify(['Loop foreman harder']), JSON.stringify(['/evolve', '/verify']), JSON.stringify(['success']))
  db.prepare(`
    INSERT INTO operator_sessions (id, harness, repo, timestamp, user_messages, skills_used, outcome_signals)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('sess-2', 'claude', '/home/drew/code/pigraph', '2026-03-26T00:00:00Z', JSON.stringify(['Fix pigraph first']), JSON.stringify(['/diagnose', '/verify']), JSON.stringify(['failure']))

  recordTelemetryRun(db, { eventKey: 'foreman-1', harness: 'claude', repo: 'foreman', skill: '/evolve', costUsd: 0.5, finishedAt: '2099-01-01T00:00:00Z' })
  recordTelemetryRun(db, { eventKey: 'foreman-2', harness: 'claude', repo: 'foreman', skill: '/verify', costUsd: 0.4, finishedAt: '2099-01-01T00:00:00Z' })
  recordTelemetryRun(db, { eventKey: 'foreman-3', harness: 'claude', repo: 'foreman', skill: '/evolve', costUsd: 0.5, finishedAt: '2099-01-01T00:00:00Z' })
  recordTelemetryRun(db, { eventKey: 'pigraph-1', harness: 'claude', repo: 'pigraph', skill: '/diagnose', costUsd: 1.1, finishedAt: '2099-01-01T00:00:00Z' })

  const recommendations = listProjectRecommendations(db, {
    projects: ['foreman', 'pigraph'],
    limit: 2,
  })

  assert.equal(recommendations.length, 2)
  assert.equal(recommendations[0]?.project, 'foreman')
  assert.equal(recommendations[0]?.recommendation, 'loop')
  assert.equal(recommendations[0]?.nextActions.length > 0, true)
  assert.equal(recommendations[0]?.evidence.topSkills.length > 0, true)
  assert.equal(recommendations[0]?.scores.loop > recommendations[0]?.scores.optimize, true)
  assert.equal(recommendations[1]?.project, 'pigraph')
  assert.equal(recommendations[1]?.recommendation, 'optimize')
  assert.equal(recommendations[1]?.warnings.some(item => item.key === 'scope_risk'), true)
})

test('answerProjectQuestion respects window filters and degrades thin-signal projects', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO goals (id, intent, workspace_path, status) VALUES (1, 'Loop foreman', '/tmp/foreman', 'active')`).run()
  db.prepare(`INSERT INTO goals (id, intent, workspace_path, status) VALUES (2, 'Study dotfiles', '/tmp/dotfiles', 'active')`).run()

  const insertDecision = db.prepare(`
    INSERT INTO decisions (
      id, goal_id, skill, task, status, outcome, deliverable_status, worktree_path,
      created_at, metrics, taste_signal, cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  insertDecision.run(1, 1, '/evolve', 'Fresh foreman', 'success', 'good', 'pass', '/tmp/foreman', '2099-01-05T00:00:00Z', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'approved', 0.4)
  insertDecision.run(2, 1, '/verify', 'Fresh foreman verify', 'success', 'good', 'pass', '/tmp/foreman', '2099-01-06T00:00:00Z', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'approved', 0.3)
  insertDecision.run(3, 1, '/evolve', 'Fresh foreman again', 'success', 'good', 'pass', '/tmp/foreman', '2099-01-07T00:00:00Z', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'approved', 0.3)
  insertDecision.run(4, 1, '/verify', 'Fresh foreman closeout', 'success', 'good', 'pass', '/tmp/foreman', '2099-01-08T00:00:00Z', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'approved', 0.2)

  insertDecision.run(10, 2, '/research', 'Old dotfiles research', 'success', 'mixed', 'unchecked', '/tmp/dotfiles', '2020-01-01T00:00:00Z', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'approved', 0.5)
  insertDecision.run(11, 2, '/research', 'Old dotfiles research 2', 'success', 'mixed', 'unchecked', '/tmp/dotfiles', '2020-01-02T00:00:00Z', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'approved', 0.5)

  db.prepare(`
    INSERT INTO operator_sessions (id, harness, repo, timestamp, user_messages, skills_used, outcome_signals)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('sess-1', 'claude', '/home/drew/code/foreman', '2099-01-06T00:00:00Z', JSON.stringify(['Keep looping foreman']), JSON.stringify(['/evolve', '/verify']), JSON.stringify(['success']))

  const question = answerProjectQuestion(db, {
    projects: ['foreman', 'dotfiles'],
    focus: 'all',
    windowDays: 30,
    limit: 3,
  })

  assert.equal(question.focus, 'all')
  assert.equal(question.recommendations.length, 2)
  assert.equal(question.recommendations.some(item => item.project === 'foreman'), true)
  assert.equal(question.recommendations.some(item => item.project === 'dotfiles' && item.recommendation === 'autoresearch'), true)
  assert.match(question.answer, /foreman|dotfiles/i)
  assert.equal(question.alternatives.length >= 1, true)
})

test('getProjectDrilldown returns scoped evidence slices for one project', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO goals (id, intent, workspace_path, status) VALUES (1, 'Loop foreman', '/tmp/foreman', 'active')`).run()

  const insertDecision = db.prepare(`
    INSERT INTO decisions (
      id, goal_id, skill, task, status, outcome, deliverable_status, worktree_path,
      created_at, metrics, taste_signal, cost_usd, prompt_policy_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  insertDecision.run(1, 1, '/evolve', 'Fresh foreman', 'success', 'good', 'pass', '/tmp/foreman', '2099-01-05T00:00:00Z', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'approved', 0.4, 'balanced-default')
  insertDecision.run(2, 1, '/verify', 'Fresh foreman verify', 'success', 'good', 'pass', '/tmp/foreman', '2099-01-06T00:00:00Z', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'approved', 0.3, 'strict-guarded')

  db.prepare(`
    INSERT INTO operator_sessions (id, harness, repo, timestamp, user_messages, skills_used, outcome_signals)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('sess-1', 'claude', '/home/drew/code/foreman', '2099-01-06T00:00:00Z', JSON.stringify(['Keep looping foreman']), JSON.stringify(['/evolve', '/verify']), JSON.stringify(['success']))

  recordTelemetryRun(db, { eventKey: 'foreman-1', harness: 'claude', repo: 'foreman', skill: '/evolve', model: 'sonnet', costUsd: 0.5, source: 'session-run', finishedAt: '2099-01-06T00:00:00Z' })

  const drilldown = getProjectDrilldown(db, 'foreman', {
    windowDays: 30,
    limit: 8,
  })

  assert.ok(drilldown)
  assert.equal(drilldown?.project, 'foreman')
  assert.equal(drilldown?.activeGoals.length, 1)
  assert.equal(drilldown?.operatorSessions.length, 1)
  assert.equal(drilldown?.replayExamples.length >= 1, true)
  assert.equal(drilldown?.trainingExamples.length >= 1, true)
  assert.equal(drilldown?.promptSamples.length >= 1, true)
  assert.equal(drilldown?.telemetryRuns.length, 1)
  assert.match(drilldown?.replayExamples[0]?.refs.decision ?? '', /\/api\/decisions\//)
  assert.match(drilldown?.trainingExamples[0]?.refs.decision ?? '', /\/api\/decisions\//)
  assert.match(drilldown?.telemetryRuns[0]?.refs.telemetry ?? '', /\/api\/telemetry\/runs\//)
})
