import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import telemetry from './telemetry.js'
import promptPolicyGovernor from './prompt-policy-governor.js'
import { serializePromptPolicy } from './prompt-policy.js'

const { ensureTelemetrySchema } = telemetry
const {
  ensurePromptPolicyGovernanceSchema,
  evaluatePromptPolicy,
  getActivePromptPolicy,
  getLatestPromptPolicyEvaluation,
  listPromptPolicyIds,
  promotePromptPolicy,
} = promptPolicyGovernor

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
      metrics TEXT,
      deliverable_status TEXT,
      prompt_policy_id TEXT,
      template_version INTEGER,
      worktree_path TEXT,
      cost_usd REAL,
      created_at TEXT NOT NULL
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
  ensurePromptPolicyGovernanceSchema(db)
  return db
}

test('evaluatePromptPolicy compares observed candidate and baseline outcomes', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO goals (id, intent, workspace_path) VALUES (1, 'Improve prompt policy', '/tmp/foreman')`).run()
  db.prepare(`INSERT INTO prompt_templates (version, template, active) VALUES (1, ?, 1)`)
    .run(serializePromptPolicy({
      id: 'balanced-default',
      standardsProfile: 'balanced',
      reasoningContextBudget: 8000,
      executionContextBudget: 4000,
      includeProjectHistory: true,
      includeGoalHistory: true,
      includeOperatorSignals: true,
      includeOperatorExemplars: true,
      includeDeadEnds: true,
      includeGitWorkflow: true,
      gitWorkflowDetail: 'full',
      skillGuideMode: 'auto',
    }).trim())

  const insert = db.prepare(`
    INSERT INTO decisions (
      id, goal_id, skill, task, status, metrics, deliverable_status, prompt_policy_id,
      template_version, worktree_path, cost_usd, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  insert.run(1, 1, '/evolve', 'Task 1', 'success', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'pass', 'strict-guarded', 1, '/tmp/foreman', 0.7, '2026-03-25T00:00:00Z')
  insert.run(2, 1, '/verify', 'Task 2', 'success', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'pass', 'strict-guarded', 1, '/tmp/foreman', 0.5, '2026-03-25T01:00:00Z')
  insert.run(3, 1, '/evolve', 'Task 3', 'success', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'pass', 'strict-guarded', 1, '/tmp/foreman', 0.6, '2026-03-25T02:00:00Z')
  insert.run(4, 1, '/evolve', 'Task 4', 'failure', JSON.stringify({ scopeStatus: 'violation', testsPassed: false }), 'fail', 'balanced-default', 1, '/tmp/foreman', 1.4, '2026-03-24T00:00:00Z')
  insert.run(5, 1, '/verify', 'Task 5', 'success', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'pass', 'balanced-default', 1, '/tmp/foreman', 1.1, '2026-03-24T01:00:00Z')
  insert.run(6, 1, '/evolve', 'Task 6', 'failure', JSON.stringify({ scopeStatus: 'violation', testsPassed: false }), 'fail', 'balanced-default', 1, '/tmp/foreman', 1.3, '2026-03-24T02:00:00Z')

  const evaluation = evaluatePromptPolicy(db, {
    policyId: 'strict-guarded',
    baselinePolicyId: 'balanced-default',
    project: 'foreman',
    promotionRule: {
      minCandidateExamples: 3,
      minBaselineExamples: 3,
    },
  })

  assert.equal(evaluation.candidate.examples, 3)
  assert.equal(evaluation.baseline?.examples, 3)
  assert.equal(evaluation.candidate.deliverablePassRate, 1)
  assert.equal(evaluation.baseline?.deliverablePassRate, 1 / 3)
  assert.equal(evaluation.comparison?.delta.scopeViolationRate, -2 / 3)
  assert.equal(evaluation.promotion?.status, 'promote')
})

test('promotePromptPolicy persists evaluation and activates candidate when forced or promoted', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO goals (id, intent, workspace_path) VALUES (1, 'Improve prompt policy', '/tmp/foreman')`).run()
  db.prepare(`INSERT INTO prompt_templates (version, template, active) VALUES (1, ?, 1)`)
    .run(serializePromptPolicy({
      id: 'balanced-default',
      standardsProfile: 'balanced',
      reasoningContextBudget: 8000,
      executionContextBudget: 4000,
      includeProjectHistory: true,
      includeGoalHistory: true,
      includeOperatorSignals: true,
      includeOperatorExemplars: true,
      includeDeadEnds: true,
      includeGitWorkflow: true,
      gitWorkflowDetail: 'full',
      skillGuideMode: 'auto',
    }).trim())

  const insert = db.prepare(`
    INSERT INTO decisions (
      id, goal_id, skill, task, status, metrics, deliverable_status, prompt_policy_id,
      template_version, worktree_path, cost_usd, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (let i = 0; i < 6; i++) {
    insert.run(i + 1, 1, '/verify', `Strict ${i}`, 'success', JSON.stringify({ scopeStatus: 'clean', testsPassed: true }), 'pass', 'strict-guarded', 1, '/tmp/foreman', 0.4, `2026-03-25T0${i}:00:00Z`)
    insert.run(i + 20, 1, '/verify', `Base ${i}`, i < 3 ? 'success' : 'failure', JSON.stringify({ scopeStatus: i < 3 ? 'clean' : 'violation', testsPassed: i < 3 }), i < 3 ? 'pass' : 'fail', 'balanced-default', 1, '/tmp/foreman', 1.0, `2026-03-24T0${i}:00:00Z`)
  }

  const result = promotePromptPolicy(db, {
    policyId: 'strict-guarded',
    baselinePolicyId: 'balanced-default',
    project: 'foreman',
    apply: true,
  })

  assert.equal(result.evaluation.promotion?.status, 'promote')
  assert.equal(result.persisted.applied, 1)
  assert.equal(result.activePolicy.id, 'strict-guarded')
  assert.equal(getActivePromptPolicy(db).id, 'strict-guarded')
  assert.equal(getLatestPromptPolicyEvaluation(db)?.candidatePolicyId, 'strict-guarded')
  assert.ok(listPromptPolicyIds(db).includes('strict-guarded'))
})
