import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPromptPolicyCandidates,
  chooseHeuristicPromptPolicy,
  classifyPromptTaskShape,
  classifyTaskLengthBucket,
  DEFAULT_PROMPT_POLICY,
  inferRecommendedPromptPolicyId,
  parsePromptPolicy,
  shouldIncludeSkillGuide,
  type PromptPolicyTrainingExample,
} from './prompt-policy.js'

test('parsePromptPolicy preserves structured policies and falls back for legacy values', () => {
  const strict = parsePromptPolicy(JSON.stringify({
    id: 'strict-guarded',
    standardsProfile: 'strict',
    reasoningContextBudget: 7200,
    executionContextBudget: 3100,
    includeProjectHistory: true,
    includeGoalHistory: true,
    includeOperatorSignals: true,
    includeOperatorExemplars: false,
    includeDeadEnds: true,
    includeGitWorkflow: true,
    gitWorkflowDetail: 'full',
    skillGuideMode: 'auto',
  }))
  assert.equal(strict.id, 'strict-guarded')
  assert.equal(strict.standardsProfile, 'strict')
  assert.equal(strict.includeOperatorExemplars, false)

  const legacy = parsePromptPolicy('v1-default')
  assert.equal(legacy.id, DEFAULT_PROMPT_POLICY.id)
  assert.equal(legacy.executionContextBudget, DEFAULT_PROMPT_POLICY.executionContextBudget)
})

test('prompt policy helpers classify work and choose sensible variants', () => {
  assert.equal(classifyPromptTaskShape('/verify', 'Verify telemetry coverage'), 'verification')
  assert.equal(classifyPromptTaskShape('/pursue', 'Redesign dispatch flow'), 'redesign')
  assert.equal(classifyTaskLengthBucket('short task'), 'short')
  assert.equal(classifyTaskLengthBucket('x'.repeat(160)), 'medium')
  assert.equal(classifyTaskLengthBucket('x'.repeat(260)), 'long')

  const scopeFailure: PromptPolicyTrainingExample = {
    skill: '/evolve',
    task: 'Implement a risky change',
    taskShape: 'implementation',
    taskLengthBucket: 'medium',
    hasScope: true,
    hasDeliverable: false,
    success: false,
    scopeViolation: true,
    deliverableStatus: 'fail',
    variantId: DEFAULT_PROMPT_POLICY.id,
  }
  assert.equal(inferRecommendedPromptPolicyId(scopeFailure), 'strict-guarded')

  const verifyExample: PromptPolicyTrainingExample = {
    skill: '/verify',
    task: 'Verify regression fix',
    taskShape: 'verification',
    taskLengthBucket: 'short',
    hasScope: false,
    hasDeliverable: true,
    success: true,
    scopeViolation: false,
    deliverableStatus: 'pass',
    variantId: DEFAULT_PROMPT_POLICY.id,
  }
  assert.equal(inferRecommendedPromptPolicyId(verifyExample), 'lean-execution')

  const chosen = chooseHeuristicPromptPolicy(DEFAULT_PROMPT_POLICY, [scopeFailure, verifyExample])
  assert.equal(chosen.id, 'strict-guarded')
  assert.equal(shouldIncludeSkillGuide('/pursue', chosen), true)
})

test('buildPromptPolicyCandidates yields stable structured variants around the current policy', () => {
  const variants = buildPromptPolicyCandidates(DEFAULT_PROMPT_POLICY)
  const ids = variants.map(variant => variant.id)
  assert.ok(ids.includes(DEFAULT_PROMPT_POLICY.id))
  assert.ok(ids.includes('strict-guarded'))
  assert.ok(ids.includes('rich-reasoning'))
  assert.ok(ids.includes('lean-execution'))
  assert.ok(ids.some(id => id.endsWith('-strict')))
})
