import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConfidenceStore } from '@drew/foreman-memory/confidence'
import { decideAction, gateAndExecute, runPolicyCycle, type Action } from './policy.js'
import type { ForemanState } from './state-snapshot.js'

// ─── Helpers ────────────────────────────────────────────────────────

function mockProvider(response: string) {
  return { run: async (_prompt: string) => ({ stdout: response }) }
}

function makeState(overrides?: Partial<ForemanState>): ForemanState {
  return {
    timestamp: new Date().toISOString(),
    activeProjects: [],
    recentEvents: [],
    operatorPatterns: [],
    skillPerformance: [],
    confidenceScores: [],
    budget: { dailyBudgetUsd: 10, spentTodayUsd: 0, utilizationPct: 0, overBudget: false },
    profileName: null,
    totalActiveSessions: 0,
    totalManagedProjects: 0,
    sessionIndexStats: null,
    ...overrides,
  }
}

function makeAction(overrides?: Partial<Action>): Action {
  return {
    type: 'spawn-session',
    project: '/tmp/test-project',
    goal: 'fix tests',
    details: { harness: 'claude', prompt: 'fix the tests' },
    reasoning: 'CI is failing',
    ...overrides,
  }
}

let tmpDir: string

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'foreman-policy-test-'))
})

after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ─── decideAction / parseActionResponse ─────────────────────────────

describe('decideAction (parseActionResponse)', () => {
  const state = makeState()

  it('valid JSON response returns Action', async () => {
    const response = JSON.stringify({
      type: 'spawn-session',
      project: '/home/user/code/app',
      goal: 'fix CI',
      details: { harness: 'claude', prompt: 'fix the build' },
      reasoning: 'CI has been red for 2 hours',
    })
    const action = await decideAction(state, mockProvider(response))
    assert.ok(action)
    assert.equal(action.type, 'spawn-session')
    assert.equal(action.project, '/home/user/code/app')
    assert.equal(action.goal, 'fix CI')
    assert.equal(action.details.harness, 'claude')
    assert.equal(action.reasoning, 'CI has been red for 2 hours')
  })

  it('do-nothing type returns null', async () => {
    const response = JSON.stringify({
      type: 'do-nothing',
      project: '',
      goal: '',
      details: { reason: 'nothing to do' },
      reasoning: 'all projects are green',
    })
    const action = await decideAction(state, mockProvider(response))
    assert.equal(action, null)
  })

  it('garbage response returns null', async () => {
    const action = await decideAction(state, mockProvider('this is not json at all'))
    assert.equal(action, null)
  })

  it('JSON wrapped in markdown code blocks extracts correctly', async () => {
    const response = [
      'Here is my decision:',
      '',
      '```json',
      JSON.stringify({
        type: 'invoke-skill',
        project: 'my-app',
        goal: 'polish the codebase',
        details: { skill: '/polish', target: 'src/' },
        reasoning: 'code quality has drifted',
      }),
      '```',
      '',
      'That is the action I recommend.',
    ].join('\n')
    const action = await decideAction(state, mockProvider(response))
    assert.ok(action)
    assert.equal(action.type, 'invoke-skill')
    assert.equal(action.project, 'my-app')
    assert.equal(action.details.skill, '/polish')
  })

  it('response with no type field returns null', async () => {
    const response = JSON.stringify({ project: 'app', goal: 'stuff' })
    const action = await decideAction(state, mockProvider(response))
    assert.equal(action, null)
  })

  it('response with missing optional fields fills defaults', async () => {
    const response = JSON.stringify({ type: 'send-notification' })
    const action = await decideAction(state, mockProvider(response))
    assert.ok(action)
    assert.equal(action.project, '')
    assert.equal(action.goal, '')
    assert.deepEqual(action.details, {})
    assert.equal(action.reasoning, '')
  })
})

// ─── gateAndExecute confidence levels ───────────────────────────────

describe('gateAndExecute confidence levels', () => {
  let store: ConfidenceStore

  before(() => {
    store = new ConfidenceStore(join(tmpDir, 'gate-test.db'))
  })

  after(() => {
    store.close()
  })

  it('score 0.0 -> dry-run, not executed', async () => {
    const action = makeAction({ type: 'run-eval', project: 'proj-zero' })
    const result = await gateAndExecute(action, store)
    assert.equal(result.level, 'dry-run')
    assert.equal(result.executed, false)
    assert.equal(result.outcome, null)
    assert.equal(result.score, 0.0)
  })

  it('score 0.35 -> propose, not executed (notification sent)', async () => {
    const action = makeAction({ type: 'spawn-session', project: 'proj-propose' })
    // 0.1 * 4 = 0.4 -> propose level (>= 0.3, < 0.6)
    for (let i = 0; i < 4; i++) {
      store.update('spawn-session', 'proj-propose', 'agree')
    }
    const score = store.getConfidence('spawn-session', 'proj-propose')
    assert.ok(score >= 0.3 && score < 0.6, `expected propose range, got ${score}`)

    const result = await gateAndExecute(action, store)
    assert.equal(result.level, 'propose')
    assert.equal(result.executed, false)
    assert.equal(result.outcome, null)
  })

  it('score 0.65 -> act-notify, executed', async () => {
    const action = makeAction({ type: 'send-notification', project: 'proj-act' })
    // 0.1 * 7 = 0.7 -> act-notify level (>= 0.6, < 0.8)
    for (let i = 0; i < 7; i++) {
      store.update('send-notification', 'proj-act', 'agree')
    }
    const score = store.getConfidence('send-notification', 'proj-act')
    assert.ok(score >= 0.6 && score < 0.8, `expected act-notify range, got ${score}`)

    const result = await gateAndExecute(action, store)
    assert.equal(result.level, 'act-notify')
    assert.equal(result.executed, true)
    assert.ok(result.outcome)
  })

  it('score 0.85 -> autonomous, executed', async () => {
    const action = makeAction({ type: 'invoke-skill', project: 'proj-auto' })
    // 0.1 * 9 = 0.9 -> autonomous level (>= 0.8)
    for (let i = 0; i < 9; i++) {
      store.update('invoke-skill', 'proj-auto', 'agree')
    }
    const score = store.getConfidence('invoke-skill', 'proj-auto')
    assert.ok(score >= 0.8, `expected autonomous range, got ${score}`)

    const result = await gateAndExecute(action, store)
    assert.equal(result.level, 'autonomous')
    assert.equal(result.executed, true)
    assert.ok(result.outcome)
  })

  it('dryRun flag overrides everything to dry-run', async () => {
    const action = makeAction({ type: 'run-eval', project: 'proj-dryrun-override' })
    // Seed to autonomous level
    for (let i = 0; i < 9; i++) {
      store.update('run-eval', 'proj-dryrun-override', 'agree')
    }
    const score = store.getConfidence('run-eval', 'proj-dryrun-override')
    assert.ok(score >= 0.8, `expected autonomous range, got ${score}`)

    const result = await gateAndExecute(action, store, { dryRun: true })
    assert.equal(result.level, 'dry-run')
    assert.equal(result.executed, false)
    assert.equal(result.outcome, null)
  })
})

// ─── Confidence updates from outcomes ───────────────────────────────

describe('confidence updates from outcomes', () => {
  let store: ConfidenceStore

  before(() => {
    store = new ConfidenceStore(join(tmpDir, 'outcome-test.db'))
  })

  after(() => {
    store.close()
  })

  it('successful action increases confidence', async () => {
    const action = makeAction({ type: 'cross-pollinate', project: 'proj-success' })
    // Seed to autonomous level so it executes
    for (let i = 0; i < 9; i++) {
      store.update('cross-pollinate', 'proj-success', 'agree')
    }
    const before = store.getConfidence('cross-pollinate', 'proj-success')

    // cross-pollinate always succeeds (returns { success: true, ... })
    const result = await gateAndExecute(action, store)
    assert.equal(result.executed, true)
    assert.ok(result.outcome?.success)

    const after = store.getConfidence('cross-pollinate', 'proj-success')
    assert.ok(after > before, `expected ${after} > ${before}`)
  })

  it('failed action decreases confidence', async () => {
    const action = makeAction({ type: 'spawn-session', project: 'proj-fail' })
    // Seed to autonomous level so it executes
    for (let i = 0; i < 9; i++) {
      store.update('spawn-session', 'proj-fail', 'agree')
    }
    const before = store.getConfidence('spawn-session', 'proj-fail')

    // spawn-session will fail (dynamic import of session-run.js will throw in test)
    const result = await gateAndExecute(action, store)
    assert.equal(result.executed, true)
    assert.ok(result.outcome)
    assert.equal(result.outcome.success, false)

    const after = store.getConfidence('spawn-session', 'proj-fail')
    assert.ok(after < before, `expected ${after} < ${before}`)
  })
})

// ─── runPolicyCycle integration ─────────────────────────────────────

describe('runPolicyCycle', () => {
  let store: ConfidenceStore

  before(() => {
    store = new ConfidenceStore(join(tmpDir, 'cycle-test.db'))
  })

  after(() => {
    store.close()
  })

  it('with mock provider returning valid action -> decision logged', async () => {
    const response = JSON.stringify({
      type: 'send-notification',
      project: 'cycle-proj',
      goal: 'alert operator',
      details: { channel: 'telegram', message: 'heads up' },
      reasoning: 'CI went red',
    })

    const progress: string[] = []
    const decision = await runPolicyCycle({
      dryRun: true,
      confidenceStore: store,
      provider: mockProvider(response),
      onProgress: (msg) => progress.push(msg),
    })

    assert.ok(decision)
    assert.ok(decision.action)
    assert.equal(decision.action.type, 'send-notification')
    assert.equal(decision.action.project, 'cycle-proj')
    assert.equal(decision.executed, false) // dryRun
    assert.ok(decision.timestamp)
    assert.ok(progress.length > 0)
  })

  it('with mock provider returning do-nothing -> null action decision', async () => {
    const response = JSON.stringify({
      type: 'do-nothing',
      project: '',
      goal: '',
      details: { reason: 'all clear' },
      reasoning: 'nothing to do',
    })

    const decision = await runPolicyCycle({
      confidenceStore: store,
      provider: mockProvider(response),
    })

    assert.ok(decision)
    assert.equal(decision.action, null)
    assert.equal(decision.executed, false)
    assert.equal(decision.confidenceLevel, 'dry-run')
    assert.equal(decision.confidenceScore, 0)
  })

  it('with mock provider returning null (garbage) -> null action decision', async () => {
    const decision = await runPolicyCycle({
      confidenceStore: store,
      provider: mockProvider('absolutely not json'),
    })

    assert.ok(decision)
    assert.equal(decision.action, null)
    assert.equal(decision.executed, false)
  })
})
