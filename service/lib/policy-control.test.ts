import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import policyControl from './policy-control.js'

const {
  ensurePolicyControlSchema,
  getDispatchPolicyControl,
  setDispatchPolicyControl,
  recordReplayPolicyEvaluation,
  getLatestReplayPolicyEvaluation,
  listReplayPolicyEvaluations,
} = policyControl

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  ensurePolicyControlSchema(db)
  return db
}

test('setDispatchPolicyControl upserts the active dispatch policy override', () => {
  const db = makeDb()

  assert.equal(getDispatchPolicyControl(db), null)

  const created = setDispatchPolicyControl(db, {
    policyName: 'heuristic',
    source: 'replay_promotion',
    baselinePolicyName: 'identity',
  })
  assert.equal(created.policyName, 'heuristic')
  assert.equal(created.source, 'replay_promotion')

  const updated = setDispatchPolicyControl(db, {
    policyName: 'llm',
    source: 'manual_override',
  })
  assert.equal(updated.policyName, 'llm')
  assert.equal(updated.source, 'manual_override')
  assert.equal(updated.baselinePolicyName, null)
})

test('recordReplayPolicyEvaluation persists replay promotion history', () => {
  const db = makeDb()

  const record = recordReplayPolicyEvaluation(db, {
    candidatePolicyName: 'heuristic',
    baselinePolicyName: 'identity',
    scopeProject: 'foreman',
    scopeSkill: '/evolve',
    summary: {
      policyName: 'heuristic',
      examples: 12,
      coverage: { goodExamples: 5, badExamples: 4, mixedExamples: 3, predictedCostMeasured: 12 },
      exactSkillMatchRate: 0.2,
      preservedGoodDecisionRate: 0.8,
      safeGoodContinuationRate: 1,
      divergedFromBadDecisionRate: 0.75,
      repeatedBadDecisionRate: 0,
      avgScalarScore: 0.9,
      avgPredictedCostUsd: 0.4,
      contextSwitchRate: 0.7,
      objectiveVector: {
        constraints: { safeGoodContinuationRate: 1, repeatedBadDecisionRate: 0 },
        primary: { divergedFromBadDecisionRate: 0.75, avgPredictedCostUsd: 0.4 },
        diagnostics: {
          preservedGoodDecisionRate: 0.8,
          exactSkillMatchRate: 0.2,
          contextSwitchRate: 0.7,
          avgObservedCostUsd: 0.6,
          predictedCostCoverage: 12,
          predictedCostEvidenceSamples: 33,
          predictedCostSources: [{ key: 'repo_skill', count: 12 }],
        },
      },
      byCandidateSkill: [{ key: '/verify', count: 6 }],
      topTransitions: [{ fromSkill: '/evolve', toSkill: '/verify', count: 4 }],
    },
    comparison: {
      baselinePolicyName: 'identity',
      delta: {
        safeGoodContinuationRate: 0.1,
        divergedFromBadDecisionRate: 0.25,
        repeatedBadDecisionRate: -0.25,
        avgPredictedCostUsd: -0.3,
        preservedGoodDecisionRate: 0.05,
        exactSkillMatchRate: -0.3,
        contextSwitchRate: 0.4,
      },
    },
    promotion: {
      status: 'promote',
      reasons: ['Improved bad-decision divergence'],
      checks: [],
    },
    applied: true,
  })

  const latest = getLatestReplayPolicyEvaluation(db)
  assert.equal(record.id, latest?.id)
  assert.equal(latest?.candidatePolicyName, 'heuristic')
  assert.equal(latest?.promotionStatus, 'promote')
  assert.equal(latest?.applied, 1)

  const history = listReplayPolicyEvaluations(db, { limit: 5 })
  assert.equal(history.length, 1)
  assert.equal(history[0]?.summary.objectiveVector.diagnostics.predictedCostEvidenceSamples, 33)
})
