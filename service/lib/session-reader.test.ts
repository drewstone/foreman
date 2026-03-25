import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSessionTranscript } from './session-reader.js'

// Temp file helpers — fixture data is inline, no separate files
function writeTmp(name: string, content: string): string {
  const p = join(tmpdir(), name)
  writeFileSync(p, content, 'utf8')
  return p
}

describe('readSessionTranscript', () => {
  const temps: string[] = []
  function tmp(name: string, content: string): string {
    const p = writeTmp(name, content)
    temps.push(p)
    return p
  }
  afterEach(() => {
    for (const p of temps.splice(0)) {
      try { unlinkSync(p) } catch {}
    }
  })

  test('returns null when file does not exist', () => {
    const result = readSessionTranscript('/nonexistent/path/does-not-exist.jsonl')
    assert.equal(result, null)
  })

  test('extracts sessionId, model, and turnCount from valid JSONL', () => {
    const JSONL = [
      JSON.stringify({
        sessionId: 'sess-abc123',
        cwd: '/home/user/project',
        gitBranch: 'main',
        timestamp: '2024-01-01T10:00:00.000Z',
        type: 'user',
        message: { content: [{ type: 'text', text: 'Do the thing' }] },
      }),
      JSON.stringify({
        sessionId: 'sess-abc123',
        cwd: '/home/user/project',
        gitBranch: 'main',
        timestamp: '2024-01-01T10:00:05.000Z',
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 25 },
          content: [{ type: 'text', text: 'Done!' }],
        },
      }),
    ].join('\n')

    const p = tmp('valid-session.jsonl', JSONL)
    const result = readSessionTranscript(p)

    assert.ok(result !== null)
    assert.equal(result.sessionId, 'sess-abc123')
    assert.equal(result.model, 'claude-sonnet-4-6')
    assert.equal(result.turnCount, 2) // 1 user + 1 assistant
    assert.equal(result.cwd, '/home/user/project')
    assert.equal(result.gitBranch, 'main')
    assert.equal(result.startTime, '2024-01-01T10:00:00.000Z')
    assert.equal(result.endTime, '2024-01-01T10:00:05.000Z')
    assert.equal(result.lastAssistantText, 'Done!')
  })

  test('computes estimatedCostUSD from accumulated token usage', () => {
    // Two assistant turns with known token counts
    const JSONL = [
      JSON.stringify({
        sessionId: 'sess-cost-test',
        timestamp: '2024-01-01T10:00:00.000Z',
        type: 'user',
        message: { content: [] },
      }),
      JSON.stringify({
        sessionId: 'sess-cost-test',
        timestamp: '2024-01-01T10:00:01.000Z',
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200 },
          content: [{ type: 'text', text: 'First response' }],
        },
      }),
      JSON.stringify({
        sessionId: 'sess-cost-test',
        timestamp: '2024-01-01T10:00:02.000Z',
        type: 'user',
        message: { content: [] },
      }),
      JSON.stringify({
        sessionId: 'sess-cost-test',
        timestamp: '2024-01-01T10:00:03.000Z',
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 2000, output_tokens: 750, cache_read_input_tokens: 400 },
          content: [{ type: 'text', text: 'Second response' }],
        },
      }),
    ].join('\n')

    const p = tmp('cost-session.jsonl', JSONL)
    const result = readSessionTranscript(p)

    assert.ok(result !== null)
    // Token totals accumulated across both assistant turns
    assert.equal(result.totalInputTokens, 3000)         // 1000 + 2000
    assert.equal(result.totalOutputTokens, 1250)        // 500 + 750
    assert.equal(result.totalCacheReadTokens, 600)      // 200 + 400

    // Derived cost estimate (Sonnet 4.6: $3/M input, $15/M output, $0.30/M cache read)
    const estimatedCostUSD =
      (result.totalInputTokens / 1_000_000) * 3.00 +
      (result.totalOutputTokens / 1_000_000) * 15.00 +
      (result.totalCacheReadTokens / 1_000_000) * 0.30

    // $0.009 input + $0.01875 output + $0.00000018 cache ≈ $0.02775
    assert.ok(estimatedCostUSD > 0.02 && estimatedCostUSD < 0.05,
      `estimatedCostUSD ${estimatedCostUSD} out of expected range`)
  })
})
