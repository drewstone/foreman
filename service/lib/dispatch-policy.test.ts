import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  buildDispatchTrainingData,
  createDispatchContext,
  heuristicPolicy,
  inferDispatchMode,
  synthesizeDispatchTask,
} from './dispatch-policy.js'

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
      status TEXT NOT NULL,
      outcome TEXT,
      deliverable_status TEXT,
      worktree_path TEXT,
      session_name TEXT,
      created_at TEXT NOT NULL
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
  `)
  return db
}

test('heuristicPolicy uses staged modes and deterministic task synthesis', async () => {
  const verifyCtx = createDispatchContext({
    goalIntent: 'Ship the telemetry dashboard',
    projectName: 'foreman',
    recentDecisions: [{ skill: '/evolve', status: 'success', outcome: 'made progress' }],
    latestDeliverableStatus: 'unchecked',
  })
  const verifyDecision = await heuristicPolicy.decide(verifyCtx)
  assert.equal(verifyDecision.mode, 'verify')
  assert.equal(verifyDecision.skill, '/verify')
  assert.match(verifyDecision.task, /Verify the latest progress/)

  const redesignCtx = createDispatchContext({
    goalIntent: 'Stabilize auto-dispatch',
    projectName: 'foreman',
    recentDecisions: [
      { skill: '/evolve', status: 'failure', outcome: 'still flaky' },
      { skill: '/evolve', status: 'failure', outcome: 'regressed again' },
    ],
    latestDeliverableStatus: 'fail',
  })
  const redesignDecision = await heuristicPolicy.decide(redesignCtx)
  assert.equal(redesignDecision.mode, 'redesign')
  assert.equal(redesignDecision.skill, '/pursue')
  assert.match(redesignDecision.task, /Redesign the current approach/)

  assert.equal(inferDispatchMode('/diagnose', redesignCtx), 'recover')
  assert.match(
    synthesizeDispatchTask({ mode: 'recover', skill: '/diagnose' }, redesignCtx),
    /Diagnose the failure path/,
  )
})

test('buildDispatchTrainingData mixes foreman decisions with operator-session priors', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO goals (id, intent, workspace_path) VALUES (1, 'Improve dispatch policy', '/tmp/foreman')`).run()
  db.prepare(`INSERT INTO learnings (id, type, content, created_at) VALUES (1, 'flow', 'Verify after good implementation progress', '2026-03-24T00:00:00Z')`).run()
  db.prepare(`INSERT INTO learnings (id, type, content, created_at) VALUES (2, 'skill_preference', 'Use /pursue after repeated failure', '2026-03-24T00:00:00Z')`).run()

  db.prepare(`
    INSERT INTO decisions (id, goal_id, skill, task, status, outcome, deliverable_status, worktree_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 1, '/evolve', 'Initial implementation', 'failure', 'missed edge cases', 'fail', '/tmp/foreman', '2026-03-24T01:00:00Z')
  db.prepare(`
    INSERT INTO decisions (id, goal_id, skill, task, status, outcome, deliverable_status, worktree_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 1, '/verify', 'Check latest fix', 'success', 'tests passed', 'pass', '/tmp/foreman', '2026-03-24T02:00:00Z')

  db.prepare(`
    INSERT INTO operator_sessions (id, harness, repo, timestamp, message_count, user_messages, skills_used, outcome_signals)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'sess-1',
    'claude',
    '/home/drew/code/foreman',
    '2026-03-24T03:00:00Z',
    3,
    JSON.stringify([
      'Improve the dispatch policy so it learns from real sessions.',
      '/evolve iterate on the policy',
      '/verify confirm the results',
    ]),
    JSON.stringify(['/evolve', '/verify']),
    JSON.stringify(['success']),
  )

  const training = buildDispatchTrainingData(db, { decisionLimit: 10, operatorSessionLimit: 10 })
  assert.equal(training.length, 4)

  const operatorExamples = training.filter(example => example.source === 'operator_session')
  assert.equal(operatorExamples.length, 2)
  assert.equal(operatorExamples[0]?.decision.skill, '/evolve')
  assert.equal(operatorExamples[1]?.decision.skill, '/verify')
  assert.ok(operatorExamples.every(example => example.outcome === 'success'))
  assert.ok(operatorExamples.some(example =>
    example.context.operatorSkillSignals.some(signal => signal.startsWith('/evolve('))
  ))

  const decisionExample = training.find(example => example.source === 'decision' && example.decision.skill === '/verify')
  assert.equal(decisionExample?.context.latestDeliverableStatus, 'fail')
  assert.equal(decisionExample?.decision.mode, 'verify')
  assert.ok(decisionExample?.context.learnedFlows.some(flow => flow.includes('Verify after good implementation progress')))
})
