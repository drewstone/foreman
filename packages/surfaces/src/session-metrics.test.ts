import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseClaudeMetrics, parseCodexMetrics, classifyTaskCompletion, aggregateMetrics, type SessionMetrics } from './session-metrics.js'

describe('parseClaudeMetrics', () => {
  it('extracts metrics from valid claude JSON output', () => {
    const stdout = JSON.stringify({
      session_id: 'ses-abc123',
      stop_reason: 'end_turn',
      total_cost_usd: 0.0865,
      num_turns: 5,
      result: 'All tests pass.',
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 50,
      },
      modelUsage: {
        'claude-opus-4-6': { costUSD: 0.0865 },
      },
    })

    const m = parseClaudeMetrics(stdout, { repo: 'test', goal: 'fix bug', durationMs: 5000, exitCode: 0 })
    assert.equal(m.sessionId, 'ses-abc123')
    assert.equal(m.costUsd, 0.0865)
    assert.equal(m.numTurns, 5)
    assert.equal(m.inputTokens, 1000)
    assert.equal(m.outputTokens, 500)
    assert.equal(m.cacheCreationTokens, 200)
    assert.equal(m.cacheReadTokens, 50)
    assert.equal(m.totalTokens, 1750)
    assert.deepEqual(m.modelIds, ['claude-opus-4-6'])
    assert.equal(m.stopReason, 'end_turn')
  })

  it('handles non-JSON stdout gracefully', () => {
    const m = parseClaudeMetrics('not json', { repo: 'test', goal: 'fix', durationMs: 1000, exitCode: 1 })
    assert.equal(m.sessionId, 'unknown')
    assert.equal(m.harness, 'claude')
    assert.equal(m.exitCode, 1)
  })

  it('handles empty stdout', () => {
    const m = parseClaudeMetrics('', { repo: 'test', goal: 'fix', durationMs: 0, exitCode: 0 })
    assert.equal(m.sessionId, 'unknown')
  })
})

describe('parseCodexMetrics', () => {
  it('extracts metrics from codex JSON', () => {
    const stdout = JSON.stringify({
      session_id: 'codex-123',
      usage: { input_tokens: 500, output_tokens: 200 },
    })
    const m = parseCodexMetrics(stdout, { repo: 'test', goal: 'fix', durationMs: 3000, exitCode: 0 })
    assert.equal(m.sessionId, 'codex-123')
    assert.equal(m.inputTokens, 500)
    assert.equal(m.outputTokens, 200)
  })
})

describe('classifyTaskCompletion', () => {
  const base: SessionMetrics = {
    sessionId: 'test', harness: 'claude', repo: 'test', goal: 'fix', timestamp: '',
    exitCode: 0, success: true, durationMs: 30000, numTurns: 5,
  }

  it('classifies non-zero exit as failed', () => {
    const r = classifyTaskCompletion({ ...base, exitCode: 1, success: false })
    assert.equal(r.completion, 'failed')
  })

  it('classifies max_tokens as abandoned', () => {
    const r = classifyTaskCompletion({ ...base, stopReason: 'max_tokens' })
    assert.equal(r.completion, 'abandoned')
  })

  it('classifies zero turns as failed', () => {
    const r = classifyTaskCompletion({ ...base, numTurns: 0 })
    assert.equal(r.completion, 'failed')
  })

  it('classifies "all tests pass" as completed', () => {
    const r = classifyTaskCompletion(base, 'Great, all tests pass and CI is green.')
    assert.equal(r.completion, 'completed')
  })

  it('classifies "unable to" as partial', () => {
    const r = classifyTaskCompletion(base, 'I was unable to fix the auth module.')
    assert.equal(r.completion, 'partial')
  })

  it('classifies clean exit with multiple turns as completed', () => {
    const r = classifyTaskCompletion(base)
    assert.equal(r.completion, 'completed')
  })
})

describe('aggregateMetrics', () => {
  it('returns zeroed aggregate for empty array', () => {
    const agg = aggregateMetrics([])
    assert.equal(agg.totalSessions, 0)
    assert.equal(agg.successRate, 0)
  })

  it('aggregates multiple sessions correctly', () => {
    const sessions: SessionMetrics[] = [
      { sessionId: '1', harness: 'claude', repo: 'a', goal: '', timestamp: '', exitCode: 0, success: true, durationMs: 10000, costUsd: 0.05, numTurns: 3, totalTokens: 1000, taskCompletion: 'completed' },
      { sessionId: '2', harness: 'codex', repo: 'b', goal: '', timestamp: '', exitCode: 1, success: false, durationMs: 20000, costUsd: 0.10, numTurns: 5, totalTokens: 2000, taskCompletion: 'failed' },
    ]
    const agg = aggregateMetrics(sessions)
    assert.equal(agg.totalSessions, 2)
    assert.equal(agg.successRate, 0.5)
    assert.ok(Math.abs(agg.totalCostUsd - 0.15) < 0.001)
    assert.equal(agg.totalTokens, 3000)
    assert.ok(agg.byHarness.claude)
    assert.ok(agg.byHarness.codex)
    assert.equal(agg.byRepo.a.sessions, 1)
    assert.equal(agg.completionRates.completed, 0.5)
    assert.equal(agg.completionRates.failed, 0.5)
  })
})
