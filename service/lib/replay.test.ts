import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import replay from './replay.js'
import telemetry from './telemetry.js'
import type { DispatchContext, DispatchDecision } from './dispatch-policy.js'

const { listReplayExamples, summarizeReplayExamples, exportReplayDataset, evaluateReplayPolicy } = replay
const { ensureTelemetrySchema, recordTelemetryRun } = telemetry

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
  return db
}

function seedTelemetry(db: Database.Database, repo = 'proj'): void {
  recordTelemetryRun(db, {
    eventKey: `${repo}:verify`,
    harness: 'claude',
    repo,
    skill: '/verify',
    costUsd: 0.3,
    finishedAt: '2099-01-01T00:00:00Z',
  })
  recordTelemetryRun(db, {
    eventKey: `${repo}:diagnose`,
    harness: 'claude',
    repo,
    skill: '/diagnose',
    costUsd: 0.5,
    finishedAt: '2099-01-01T00:00:00Z',
  })
  recordTelemetryRun(db, {
    eventKey: `${repo}:evolve`,
    harness: 'claude',
    repo,
    skill: '/evolve',
    costUsd: 1.5,
    finishedAt: '2099-01-01T00:00:00Z',
  })
  recordTelemetryRun(db, {
    eventKey: `${repo}:research`,
    harness: 'claude',
    repo,
    skill: '/research',
    costUsd: 0.2,
    finishedAt: '2099-01-01T00:00:00Z',
  })
}

test('listReplayExamples derives context history and objective vectors', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO goals (id, intent, workspace_path) VALUES (1, 'Ship replay harness', '/tmp/foreman')`).run()

  db.prepare(`
    INSERT INTO decisions (
      id, goal_id, skill, task, reasoning, status, origin, outcome, learnings, metrics,
      taste_signal, session_name, worktree_path, template_version, cost_usd, prompt_sections,
      deliverable_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1, 1, '/evolve', 'First pass', 'r1', 'failure', 'operator', 'missed target', 'learned a thing',
    JSON.stringify({ scopeStatus: 'violation', testsPassed: false }),
    'rejected', 's1', '/tmp/foreman', 1, 1.25, JSON.stringify(['goal', 'history']), 'fail', '2026-03-24T00:00:00Z',
  )
  db.prepare(`
    INSERT INTO decisions (
      id, goal_id, skill, task, reasoning, status, origin, outcome, learnings, metrics,
      taste_signal, session_name, worktree_path, template_version, cost_usd, prompt_sections,
      deliverable_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    2, 1, '/evolve', 'Second pass', 'r2', 'success', 'operator', 'shipped', 'better result',
    JSON.stringify({ scopeStatus: 'clean', testsPassed: true }),
    'approved', 's2', '/tmp/foreman', 2, 0.5, JSON.stringify(['goal', 'learnings']), 'pass', '2026-03-25T00:00:00Z',
  )

  const examples = listReplayExamples(db, { limit: 10 })
  assert.equal(examples.length, 2)

  const latest = examples[0]
  assert.equal(latest.decisionId, 2)
  assert.equal(latest.context.goalIntent, 'Ship replay harness')
  assert.equal(latest.context.project, 'foreman')
  assert.deepEqual(latest.context.promptSections, ['goal', 'learnings'])
  assert.equal(latest.context.previousProjectDecisions, 1)
  assert.equal(latest.context.previousProjectSkillDecisions, 1)
  assert.equal(latest.context.previousGoalDecisions, 1)
  assert.equal(latest.context.policyContext.goalIntent, 'Ship replay harness')
  assert.equal(latest.context.policyContext.projectName, 'foreman')
  assert.equal(latest.context.policyContext.recentDecisions.length, 1)
  assert.equal(latest.objectives.dispatchSucceeded, 1)
  assert.equal(latest.objectives.deliverablePassed, 1)
  assert.equal(latest.objectives.approvalSignal, 1)
  assert.equal(latest.objectives.rejectionSignal, 0)
  assert.equal(latest.objectives.scopeViolation, 0)
  assert.equal(latest.objectives.testsPassed, 1)
  assert.equal(latest.observed.trajectory, 'terminal')
})

test('summarizeReplayExamples reports objective coverage and group rates', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO goals (id, intent, workspace_path) VALUES (1, 'Goal', '/tmp/repo')`).run()
  db.prepare(`
    INSERT INTO decisions (
      id, goal_id, skill, task, reasoning, status, origin, metrics, taste_signal,
      worktree_path, cost_usd, deliverable_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1, 1, '/evolve', 'Task A', '', 'success', 'operator',
    JSON.stringify({ scopeStatus: 'clean', testsPassed: true }),
    'approved', '/tmp/repo', 1.0, 'pass', '2026-03-24T00:00:00Z',
  )
  db.prepare(`
    INSERT INTO decisions (
      id, goal_id, skill, task, reasoning, status, origin, metrics, taste_signal,
      worktree_path, cost_usd, deliverable_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    2, 1, '/verify', 'Task B', '', 'failure', 'operator',
    JSON.stringify({ scopeStatus: 'violation', testsPassed: false }),
    'rejected', '/tmp/repo', 2.0, 'fail', '2026-03-25T00:00:00Z',
  )
  db.prepare(`
    INSERT INTO decisions (
      id, goal_id, skill, task, reasoning, status, origin, worktree_path, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    3, 1, '/plan', 'Task C', '', 'dispatched', 'operator', '/tmp/repo', '2026-03-26T00:00:00Z',
  )

  const summary = summarizeReplayExamples(listReplayExamples(db, { limit: 10 }))
  assert.equal(summary.examples, 3)
  assert.equal(summary.objectiveCoverage.deliverableMeasured, 2)
  assert.equal(summary.objectiveCoverage.costMeasured, 2)
  assert.equal(summary.objectiveCoverage.scopeMeasured, 2)
  assert.equal(summary.objectiveCoverage.testsMeasured, 2)
  assert.equal(summary.objectiveCoverage.feedbackMeasured, 2)
  assert.equal(summary.successRate, 1 / 3)
  assert.equal(summary.deliverablePassRate, 1 / 2)
  assert.equal(summary.avgCostUsd, 1.5)
  assert.equal(summary.bySkill[0]?.key, '/evolve')
  assert.equal(summary.byProject[0]?.key, 'repo')
  assert.deepEqual(summary.byTrajectory.map(row => row.key).sort(), ['degraded', 'stalled', 'terminal'])
})

test('exportReplayDataset includes summary and filtered examples', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO decisions (id, skill, task, reasoning, status, worktree_path, created_at) VALUES (1, '/evolve', 'Task', '', 'success', '/tmp/foo', '2026-03-26T00:00:00Z')`).run()
  db.prepare(`INSERT INTO decisions (id, skill, task, reasoning, status, worktree_path, created_at) VALUES (2, '/verify', 'Task', '', 'success', '/tmp/bar', '2026-03-26T00:01:00Z')`).run()

  const dataset = exportReplayDataset(db, { project: 'bar' })
  assert.equal(dataset.examples.length, 1)
  assert.equal(dataset.examples[0]?.context.project, 'bar')
  assert.equal(dataset.summary.examples, 1)
  assert.ok(typeof dataset.generatedAt === 'string')
})

test('listReplayExamples derives downstream trajectory labels from later decisions', () => {
  const db = makeDb()
  db.prepare(`INSERT INTO goals (id, intent, workspace_path) VALUES (1, 'Recover failure', '/tmp/proj')`).run()
  db.prepare(`INSERT INTO decisions (
    id, goal_id, skill, task, reasoning, status, origin, metrics, taste_signal,
    worktree_path, cost_usd, deliverable_status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    1, 1, '/evolve', 'Bad step', '', 'failure', 'operator',
    JSON.stringify({ scopeStatus: 'violation', testsPassed: false }),
    'rejected', '/tmp/proj', 1.5, 'fail', '2026-03-24T00:00:00Z',
  )
  db.prepare(`INSERT INTO decisions (
    id, goal_id, skill, task, reasoning, status, origin, metrics, taste_signal,
    worktree_path, cost_usd, deliverable_status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    2, 1, '/diagnose', 'Recover', '', 'success', 'operator',
    JSON.stringify({ scopeStatus: 'clean', testsPassed: true }),
    'approved', '/tmp/proj', 0.5, 'pass', '2026-03-25T00:00:00Z',
  )

  const examples = listReplayExamples(db, { limit: 10 })
  assert.equal(examples[1]?.decisionId, 1)
  assert.equal(examples[1]?.observed.trajectory, 'recovered')
  assert.equal(examples[1]?.observed.futureDecisionCount, 1)
  assert.equal(examples[1]?.observed.nextDecisionStatus, 'success')
})

test('evaluateReplayPolicy scores safe continuation and bad-decision divergence', async () => {
  const db = makeDb()
  seedTelemetry(db)
  db.prepare(`INSERT INTO goals (id, intent, workspace_path) VALUES (1, 'Improve project', '/tmp/proj')`).run()
  db.prepare(`INSERT INTO learnings (id, type, content, created_at) VALUES (1, 'flow', 'Use verify after success', '2026-03-24T00:00:00Z')`).run()
  db.prepare(`INSERT INTO learnings (id, type, content, created_at) VALUES (2, 'skill_preference', 'Prefer /diagnose after failure', '2026-03-24T00:00:00Z')`).run()

  db.prepare(`
    INSERT INTO decisions (
      id, goal_id, skill, task, reasoning, status, origin, metrics, taste_signal,
      worktree_path, cost_usd, deliverable_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    0, 1, '/research', 'Seed context', '', 'success', 'operator',
    JSON.stringify({ scopeStatus: 'clean', testsPassed: true }),
    'approved', '/tmp/proj', 0.25, 'pass', '2026-03-23T00:00:00Z',
  )
  db.prepare(`
    INSERT INTO decisions (
      id, goal_id, skill, task, reasoning, status, origin, metrics, taste_signal,
      worktree_path, cost_usd, deliverable_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1, 1, '/evolve', 'Task A', '', 'success', 'operator',
    JSON.stringify({ scopeStatus: 'clean', testsPassed: true }),
    'approved', '/tmp/proj', 1.0, 'pass', '2026-03-24T00:00:00Z',
  )
  db.prepare(`
    INSERT INTO decisions (
      id, goal_id, skill, task, reasoning, status, origin, metrics, taste_signal,
      worktree_path, cost_usd, deliverable_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    2, 1, '/evolve', 'Task B', '', 'failure', 'operator',
    JSON.stringify({ scopeStatus: 'violation', testsPassed: false }),
    'rejected', '/tmp/proj', 2.0, 'fail', '2026-03-25T00:00:00Z',
  )

  const examples = listReplayExamples(db, { limit: 10 })
    .filter(example => example.decisionId !== 0)
    .reverse()
  const decide = async (ctx: DispatchContext): Promise<DispatchDecision> => {
    const last = ctx.recentDecisions[0]
    if (last?.status === 'success') {
      return { skill: '/verify', task: 'Verify success', reasoning: 'test policy' }
    }
    return { skill: '/diagnose', task: 'Diagnose failure', reasoning: 'test policy' }
  }

  const evaluation = await evaluateReplayPolicy(examples, {
    policyName: 'test-policy',
    decide,
    telemetryDb: db,
  })
  assert.equal(evaluation.summary.examples, 2)
  assert.equal(evaluation.summary.coverage.goodExamples, 1)
  assert.equal(evaluation.summary.coverage.badExamples, 1)
  assert.equal(evaluation.summary.avgPredictedCostUsd, 0.3)
  assert.equal(evaluation.summary.safeGoodContinuationRate, 1)
  assert.equal(evaluation.summary.divergedFromBadDecisionRate, 1)
  assert.equal(evaluation.summary.avgScalarScore, 1)
  assert.equal(evaluation.summary.objectiveVector.constraints.safeGoodContinuationRate, 1)
  assert.equal(evaluation.summary.objectiveVector.diagnostics.predictedCostSources[0]?.key, 'repo_skill')
  assert.equal(evaluation.examples[0]?.candidate.predictedCostSource, 'repo_skill')
  assert.equal(evaluation.examples[0]?.candidate.policyName, 'test-policy')
})

test('evaluateReplayPolicy compares against a baseline and emits a promotion decision', async () => {
  const db = makeDb()
  seedTelemetry(db)
  db.prepare(`INSERT INTO goals (id, intent, workspace_path) VALUES (1, 'Improve project', '/tmp/proj')`).run()
  db.prepare(`INSERT INTO learnings (id, type, content, created_at) VALUES (1, 'flow', 'Use verify after success', '2026-03-24T00:00:00Z')`).run()
  db.prepare(`INSERT INTO decisions (
    id, goal_id, skill, task, reasoning, status, origin, metrics, taste_signal,
    worktree_path, cost_usd, deliverable_status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    0, 1, '/research', 'Seed context', '', 'success', 'operator',
    JSON.stringify({ scopeStatus: 'clean', testsPassed: true }),
    'approved', '/tmp/proj', 0.25, 'pass', '2026-03-23T00:00:00Z',
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

  const examples = listReplayExamples(db, { limit: 10 })
    .filter(example => example.decisionId !== 0)
    .reverse()

  const candidate = await evaluateReplayPolicy(examples, {
    policyName: 'candidate',
    decide: async (ctx: DispatchContext): Promise<DispatchDecision> => {
      const last = ctx.recentDecisions[0]
      if (last?.status === 'success') {
        return { skill: '/verify', task: 'Verify success', reasoning: 'candidate policy' }
      }
      return { skill: '/diagnose', task: 'Diagnose failure', reasoning: 'candidate policy' }
    },
    baseline: {
      policyName: 'identity-ish',
      decide: async (ctx: DispatchContext): Promise<DispatchDecision> => {
        const last = ctx.recentDecisions[0]
        return {
          skill: last?.skill ?? '/evolve',
          task: 'Repeat the prior move',
          reasoning: 'baseline policy',
        }
      },
    },
    promotionRule: {
      minExamples: 2,
      minGoodExamples: 1,
      minBadExamples: 1,
      minBadDivergenceImprovement: 0.25,
    },
    telemetryDb: db,
  })

  assert.equal(candidate.baselineSummary?.policyName, 'identity-ish')
  assert.equal(candidate.summary.avgPredictedCostUsd, 0.3)
  assert.equal(candidate.baselineSummary?.avgPredictedCostUsd, 0.85)
  assert.equal(candidate.comparison?.delta.safeGoodContinuationRate, 1)
  assert.equal(candidate.comparison?.delta.divergedFromBadDecisionRate, 1)
  assert.ok(Math.abs((candidate.comparison?.delta.avgPredictedCostUsd ?? 0) + 0.55) < 1e-9)
  assert.equal(candidate.comparison?.delta.repeatedBadDecisionRate, -1)
  assert.equal(candidate.promotion?.status, 'promote')
  assert.equal(candidate.examples[0]?.baseline?.predictedCostSource, 'repo_skill')
  assert.equal(candidate.examples[0]?.baseline?.policyName, 'identity-ish')
  assert.equal(candidate.examples[0]?.comparison?.changedFromBaseline, 1)
})
