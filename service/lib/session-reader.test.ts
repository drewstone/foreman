import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readSessionTranscript } from './session-reader.js'

// Two-turn session: user → assistant → user → assistant
const VALID_JSONL = [
  JSON.stringify({
    sessionId: 'sess-abc123',
    cwd: '/home/user/project',
    gitBranch: 'main',
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'user',
    message: { content: [{ type: 'text', text: 'Please run the tests' }] },
  }),
  JSON.stringify({
    sessionId: 'sess-abc123',
    type: 'assistant',
    timestamp: '2026-01-01T00:00:01.000Z',
    message: {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 50 },
      content: [{ type: 'text', text: 'Running the tests now.' }],
    },
  }),
  JSON.stringify({
    sessionId: 'sess-abc123',
    type: 'user',
    timestamp: '2026-01-01T00:00:02.000Z',
    message: { content: [{ type: 'text', text: 'Great, anything else?' }] },
  }),
  JSON.stringify({
    sessionId: 'sess-abc123',
    type: 'assistant',
    timestamp: '2026-01-01T00:00:03.000Z',
    message: {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 300, output_tokens: 100, cache_read_input_tokens: 0 },
      content: [{ type: 'text', text: 'All tests passed.' }],
    },
  }),
].join('\n')

describe('readSessionTranscript', () => {
  let tempPath: string

  before(() => {
    tempPath = join(tmpdir(), `session-reader-test-${Date.now()}.jsonl`)
    writeFileSync(tempPath, VALID_JSONL, 'utf8')
  })

  after(() => {
    try { unlinkSync(tempPath) } catch {}
  })

  it('returns null when file does not exist', () => {
    const result = readSessionTranscript('/nonexistent/path/session-xyz.jsonl')
    assert.equal(result, null)
  })

  it('extracts sessionId, model, and turnCount from valid JSONL', () => {
    const result = readSessionTranscript(tempPath)
    assert.ok(result !== null, 'expected non-null result')
    assert.equal(result.sessionId, 'sess-abc123')
    assert.equal(result.model, 'claude-sonnet-4-6')
    // 2 user turns + 2 assistant turns = 4
    assert.equal(result.turnCount, 4)
    assert.equal(result.cwd, '/home/user/project')
    assert.equal(result.gitBranch, 'main')
    assert.equal(result.lastAssistantText, 'All tests passed.')
  })

  it('accumulates token counts across turns to enable estimatedCostUSD computation', () => {
    const result = readSessionTranscript(tempPath)
    assert.ok(result !== null, 'expected non-null result')

    // Totals across both assistant turns: 500+300=800 input, 200+100=300 output, 50+0=50 cache
    assert.equal(result.totalInputTokens, 800)
    assert.equal(result.totalOutputTokens, 300)
    assert.equal(result.totalCacheReadTokens, 50)

    // Verify cost can be derived (Claude Sonnet: $3/M input, $15/M output)
    const estimatedCostUSD =
      (result.totalInputTokens * 3 + result.totalOutputTokens * 15) / 1_000_000
    assert.ok(estimatedCostUSD > 0, 'cost must be positive')
    assert.ok(estimatedCostUSD < 0.01, 'cost sanity check for 1150 total tokens')
  })
})
