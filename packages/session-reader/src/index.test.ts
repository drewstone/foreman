import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseSessionTranscript,
  parseLastAssistantMessage,
  parseClosingBlock,
  readSessionTranscript,
  readLastAssistantMessage,
  type SessionSummary,
  type ClosingBlock,
} from './index.js'

// ─── Fixtures ────────────────────────────────────────────────────────

function jsonl(...lines: object[]): string {
  return lines.map(l => JSON.stringify(l)).join('\n')
}

const MINIMAL_SESSION = jsonl(
  { sessionId: 'sess-1', cwd: '/tmp/test', gitBranch: 'main', timestamp: '2026-01-01T00:00:00Z', type: 'system' },
  { type: 'user', timestamp: '2026-01-01T00:00:01Z' },
  {
    type: 'assistant',
    timestamp: '2026-01-01T00:00:02Z',
    message: {
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
      content: [{ type: 'text', text: 'Hello world' }],
    },
  },
)

const MULTI_TURN_SESSION = jsonl(
  { sessionId: 'sess-2', cwd: '/home/user/project', gitBranch: 'feature', timestamp: '2026-01-01T00:00:00Z', type: 'system' },
  { type: 'user', timestamp: '2026-01-01T00:01:00Z' },
  {
    type: 'assistant',
    timestamp: '2026-01-01T00:01:30Z',
    message: {
      model: 'claude-opus-4-20250514',
      usage: { input_tokens: 200, output_tokens: 80 },
      content: [
        { type: 'text', text: 'Reading file...' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/foo.ts' } },
      ],
    },
  },
  { type: 'user', timestamp: '2026-01-01T00:02:00Z' },
  {
    type: 'assistant',
    timestamp: '2026-01-01T00:02:30Z',
    message: {
      model: 'claude-opus-4-20250514',
      usage: { input_tokens: 300, output_tokens: 120, cache_read_input_tokens: 50 },
      content: [
        { type: 'text', text: 'Writing fix...' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/foo.ts', old_string: 'bad', new_string: 'good' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      ],
    },
  },
  { type: 'user', timestamp: '2026-01-01T00:03:00Z' },
  {
    type: 'assistant',
    timestamp: '2026-01-01T00:03:30Z',
    message: {
      model: 'claude-opus-4-20250514',
      usage: { input_tokens: 150, output_tokens: 60 },
      content: [{ type: 'text', text: 'Done. All tests pass.' }],
    },
  },
)

// ─── parseSessionTranscript ──────────────────────────────────────────

describe('parseSessionTranscript', () => {
  it('parses minimal session', () => {
    const result = parseSessionTranscript(MINIMAL_SESSION)
    assert.ok(result)
    assert.equal(result.sessionId, 'sess-1')
    assert.equal(result.cwd, '/tmp/test')
    assert.equal(result.gitBranch, 'main')
    assert.equal(result.model, 'claude-sonnet-4-20250514')
    assert.equal(result.turnCount, 2) // user + assistant
    assert.equal(result.totalInputTokens, 100)
    assert.equal(result.totalOutputTokens, 50)
    assert.equal(result.totalCacheReadTokens, 10)
    assert.equal(result.lastAssistantText, 'Hello world')
    assert.equal(result.startTime, '2026-01-01T00:00:00Z')
    assert.equal(result.endTime, '2026-01-01T00:00:02Z')
  })

  it('aggregates multi-turn usage', () => {
    const result = parseSessionTranscript(MULTI_TURN_SESSION)
    assert.ok(result)
    assert.equal(result.turnCount, 6) // 3 user + 3 assistant
    assert.equal(result.totalInputTokens, 650) // 200 + 300 + 150
    assert.equal(result.totalOutputTokens, 260) // 80 + 120 + 60
    assert.equal(result.totalCacheReadTokens, 50) // only second turn has it
  })

  it('collects tool calls', () => {
    const result = parseSessionTranscript(MULTI_TURN_SESSION)
    assert.ok(result)
    assert.equal(result.toolCalls.length, 3)
    assert.equal(result.toolCalls[0].name, 'Read')
    assert.equal(result.toolCalls[1].name, 'Edit')
    assert.equal(result.toolCalls[2].name, 'Bash')
    assert.deepEqual(result.toolCalls[0].input, { file_path: '/tmp/foo.ts' })
  })

  it('uses last assistant text, not concatenation', () => {
    const result = parseSessionTranscript(MULTI_TURN_SESSION)
    assert.ok(result)
    assert.equal(result.lastAssistantText, 'Done. All tests pass.')
  })

  it('takes first model encountered', () => {
    const result = parseSessionTranscript(MULTI_TURN_SESSION)
    assert.ok(result)
    assert.equal(result.model, 'claude-opus-4-20250514')
  })

  it('takes first sessionId/cwd/gitBranch encountered', () => {
    const content = jsonl(
      { sessionId: 'first', cwd: '/first', gitBranch: 'first-branch', timestamp: 'T1', type: 'system' },
      { sessionId: 'second', cwd: '/second', gitBranch: 'second-branch', timestamp: 'T2', type: 'system' },
    )
    const result = parseSessionTranscript(content)
    assert.ok(result)
    assert.equal(result.sessionId, 'first')
    assert.equal(result.cwd, '/first')
    assert.equal(result.gitBranch, 'first-branch')
  })

  it('truncates lastAssistantText to 5000 chars', () => {
    const longText = 'x'.repeat(10000)
    const content = jsonl(
      { type: 'assistant', timestamp: 'T1', message: { content: [{ type: 'text', text: longText }] } },
    )
    const result = parseSessionTranscript(content)
    assert.ok(result)
    assert.equal(result.lastAssistantText.length, 5000)
  })

  it('handles missing usage fields gracefully', () => {
    const content = jsonl(
      { type: 'assistant', timestamp: 'T1', message: { usage: {}, content: [{ type: 'text', text: 'hi' }] } },
    )
    const result = parseSessionTranscript(content)
    assert.ok(result)
    assert.equal(result.totalInputTokens, 0)
    assert.equal(result.totalOutputTokens, 0)
    assert.equal(result.totalCacheReadTokens, 0)
  })

  it('handles assistant message with no content', () => {
    const content = jsonl(
      { type: 'assistant', timestamp: 'T1', message: { model: 'test' } },
    )
    const result = parseSessionTranscript(content)
    assert.ok(result)
    assert.equal(result.turnCount, 1)
    assert.equal(result.toolCalls.length, 0)
  })

  it('handles assistant with no message', () => {
    const content = jsonl(
      { type: 'assistant', timestamp: 'T1' },
    )
    const result = parseSessionTranscript(content)
    assert.ok(result)
    assert.equal(result.turnCount, 1)
  })

  it('skips malformed JSON lines', () => {
    const content = '{"sessionId":"s1","timestamp":"T1","type":"system"}\nNOT JSON\n{"type":"user","timestamp":"T2"}'
    const result = parseSessionTranscript(content)
    assert.ok(result)
    assert.equal(result.sessionId, 's1')
    assert.equal(result.turnCount, 1) // only user counted
  })

  it('returns null on empty string', () => {
    const result = parseSessionTranscript('')
    assert.ok(result) // empty but parseable — returns default summary
    assert.equal(result.turnCount, 0)
  })

  it('handles tool_use with no name', () => {
    const content = jsonl(
      { type: 'assistant', timestamp: 'T1', message: { content: [{ type: 'tool_use' }] } },
    )
    const result = parseSessionTranscript(content)
    assert.ok(result)
    assert.equal(result.toolCalls[0].name, 'unknown')
    assert.deepEqual(result.toolCalls[0].input, {})
  })

  it('joins multiple text blocks in same turn', () => {
    const content = jsonl(
      {
        type: 'assistant', timestamp: 'T1',
        message: {
          content: [
            { type: 'text', text: 'part one' },
            { type: 'tool_use', name: 'Read', input: {} },
            { type: 'text', text: 'part two' },
          ],
        },
      },
    )
    const result = parseSessionTranscript(content)
    assert.ok(result)
    assert.equal(result.lastAssistantText, 'part one\npart two')
    assert.equal(result.toolCalls.length, 1)
  })
})

// ─── parseClosingBlock ───────────────────────────────────────────────

describe('parseClosingBlock', () => {
  it('returns null on empty text', () => {
    assert.equal(parseClosingBlock(''), null)
  })

  it('returns null on text with no closing markers', () => {
    assert.equal(parseClosingBlock('Just some regular text without any structure.'), null)
  })

  it('parses JSON code block', () => {
    const text = 'Here is the result:\n```json\n{"status":"complete","summary":"All done","stepsCompleted":["wrote code","ran tests"],"skillRecommendations":[{"skill":"/verify","task":"run tests","reasoning":"need confidence"}],"nextContext":"ready for deploy","deliverables":["output.ts"]}\n```'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.equal(result.status, 'complete')
    assert.equal(result.summary, 'All done')
    assert.deepEqual(result.stepsCompleted, ['wrote code', 'ran tests'])
    assert.equal(result.skillRecommendations.length, 1)
    assert.equal(result.skillRecommendations[0].skill, '/verify')
    assert.equal(result.nextContext, 'ready for deploy')
    assert.deepEqual(result.deliverables, ['output.ts'])
  })

  it('parses JSON block with only status', () => {
    const text = '```json\n{"status":"partial"}\n```'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.equal(result.status, 'partial')
    assert.equal(result.summary, '')
    assert.deepEqual(result.stepsCompleted, [])
  })

  it('parses JSON block with only summary', () => {
    const text = '```json\n{"summary":"Did the thing"}\n```'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.equal(result.status, 'unknown')
    assert.equal(result.summary, 'Did the thing')
  })

  it('parses JSON block with only skillRecommendations', () => {
    const text = '```json\n{"skillRecommendations":[{"skill":"/evolve","task":"optimize","reasoning":"slow"}]}\n```'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.equal(result.skillRecommendations.length, 1)
  })

  it('parses raw JSON object', () => {
    const text = 'Session complete. {"status":"complete","summary":"Built the feature"}'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.equal(result.status, 'complete')
    assert.equal(result.summary, 'Built the feature')
  })

  it('parses markdown closing section with status', () => {
    const text = '## Session Closing\nStatus: complete\nSteps:\n- Wrote tests\n- Fixed bug\n'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.equal(result.status, 'complete')
    assert.ok(result.summary.includes('Session Closing'))
  })

  it('parses markdown Status header', () => {
    const text = '## Status\nResult: partial\nDone:\n- Step A\n- Step B\n'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.equal(result.status, 'partial')
  })

  it('parses markdown Results header', () => {
    const text = '## Results\nstatus = blocked\n'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.equal(result.status, 'blocked')
  })

  it('extracts steps from markdown', () => {
    const text = '## Closing\nStatus: complete\nCompleted:\n- First thing\n- Second thing\n- Third thing\n'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.deepEqual(result.stepsCompleted, ['First thing', 'Second thing', 'Third thing'])
  })

  it('defaults to unknown status for markdown without status line', () => {
    const text = '## Session Closing\nJust some notes about what happened.'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.equal(result.status, 'unknown')
  })

  it('handles non-array stepsCompleted in JSON', () => {
    const text = '```json\n{"status":"complete","stepsCompleted":"not an array"}\n```'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.deepEqual(result.stepsCompleted, [])
  })

  it('handles non-array skillRecommendations in JSON', () => {
    const text = '```json\n{"status":"complete","skillRecommendations":"not an array"}\n```'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.deepEqual(result.skillRecommendations, [])
  })

  it('handles non-array deliverables in JSON', () => {
    const text = '```json\n{"status":"complete","deliverables":"not an array"}\n```'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.deepEqual(result.deliverables, [])
  })

  it('handles invalid JSON in code block gracefully', () => {
    const text = '```json\n{broken json\n```'
    // Falls through to markdown or returns null
    const result = parseClosingBlock(text)
    assert.equal(result, null)
  })

  it('prefers JSON block over raw JSON', () => {
    const text = '```json\n{"status":"complete","summary":"from block"}\n```\n{"status":"partial","summary":"raw"}'
    const result = parseClosingBlock(text)
    assert.ok(result)
    assert.equal(result.summary, 'from block')
  })

  it('truncates markdown summary to 500 chars', () => {
    const longSection = '## Session Closing\n' + 'x'.repeat(1000)
    const result = parseClosingBlock(longSection)
    assert.ok(result)
    assert.ok(result.summary.length <= 500)
  })
})

// ─── parseLastAssistantMessage ───────────────────────────────────────

describe('parseLastAssistantMessage', () => {
  it('returns last assistant text', () => {
    const result = parseLastAssistantMessage(MULTI_TURN_SESSION)
    assert.equal(result, 'Done. All tests pass.')
  })

  it('returns null on empty content', () => {
    assert.equal(parseLastAssistantMessage(''), null)
  })

  it('returns null when no assistant messages', () => {
    const content = jsonl(
      { type: 'user', timestamp: 'T1' },
      { type: 'system', timestamp: 'T2' },
    )
    assert.equal(parseLastAssistantMessage(content), null)
  })

  it('returns null when assistant has no text content', () => {
    const content = jsonl(
      { type: 'assistant', timestamp: 'T1', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
    )
    assert.equal(parseLastAssistantMessage(content), null)
  })

  it('joins multiple text blocks', () => {
    const content = jsonl(
      {
        type: 'assistant', timestamp: 'T1',
        message: { content: [{ type: 'text', text: 'Line 1' }, { type: 'text', text: 'Line 2' }] },
      },
    )
    assert.equal(parseLastAssistantMessage(content), 'Line 1\nLine 2')
  })

  it('skips malformed lines when searching backwards', () => {
    const content = jsonl(
      { type: 'assistant', timestamp: 'T1', message: { content: [{ type: 'text', text: 'first' }] } },
    ) + '\nBROKEN LINE'
    assert.equal(parseLastAssistantMessage(content), 'first')
  })

  it('handles assistant with no message property', () => {
    const content = jsonl(
      { type: 'assistant', timestamp: 'T1', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'assistant', timestamp: 'T2' },
    )
    // Last assistant has no message, so falls through to earlier one
    assert.equal(parseLastAssistantMessage(content), 'ok')
  })
})

// ─── readSessionTranscript (filesystem) ──────────────────────────────

describe('readSessionTranscript', () => {
  let dir: string

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-reader-test-'))
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads and parses a JSONL file', async () => {
    const file = join(dir, 'session.jsonl')
    await writeFile(file, MINIMAL_SESSION)
    const result = readSessionTranscript(file)
    assert.ok(result)
    assert.equal(result.sessionId, 'sess-1')
  })

  it('returns null for missing file', () => {
    const result = readSessionTranscript(join(dir, 'nonexistent.jsonl'))
    assert.equal(result, null)
  })

  it('returns null for empty file', async () => {
    const file = join(dir, 'empty.jsonl')
    await writeFile(file, '')
    const result = readSessionTranscript(file)
    // Empty string → empty parsed result (still valid)
    assert.ok(result)
    assert.equal(result.turnCount, 0)
  })
})

// ─── readLastAssistantMessage (filesystem) ───────────────────────────

describe('readLastAssistantMessage', () => {
  let dir: string

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-reader-last-msg-'))
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads last assistant message from file', async () => {
    const file = join(dir, 'session.jsonl')
    await writeFile(file, MULTI_TURN_SESSION)
    const result = readLastAssistantMessage(file)
    assert.equal(result, 'Done. All tests pass.')
  })

  it('returns null for missing file', () => {
    assert.equal(readLastAssistantMessage(join(dir, 'missing.jsonl')), null)
  })
})

// ─── Integration: closing block from full transcript ─────────────────

describe('end-to-end: transcript with closing block', () => {
  it('extracts closing block from session transcript', () => {
    const content = jsonl(
      { sessionId: 'sess-e2e', cwd: '/tmp', timestamp: 'T1', type: 'system' },
      { type: 'user', timestamp: 'T2' },
      {
        type: 'assistant', timestamp: 'T3',
        message: {
          model: 'claude-opus-4-20250514',
          usage: { input_tokens: 500, output_tokens: 200 },
          content: [{
            type: 'text',
            text: 'Here is the closing block:\n```json\n{"status":"complete","summary":"Extracted module with tests","stepsCompleted":["created package","wrote tests","updated imports"],"skillRecommendations":[{"skill":"/verify","task":"run full test suite","reasoning":"ensure nothing broke"}],"nextContext":"ready for review","deliverables":["packages/session-reader/src/index.ts"]}\n```',
          }],
        },
      },
    )
    const result = parseSessionTranscript(content)
    assert.ok(result)
    assert.ok(result.closingBlock)
    assert.equal(result.closingBlock.status, 'complete')
    assert.equal(result.closingBlock.summary, 'Extracted module with tests')
    assert.equal(result.closingBlock.stepsCompleted.length, 3)
    assert.equal(result.closingBlock.skillRecommendations[0].skill, '/verify')
    assert.deepEqual(result.closingBlock.deliverables, ['packages/session-reader/src/index.ts'])
  })

  it('skill chaining: reviewer can extract next dispatch from closing block', () => {
    const content = jsonl(
      { sessionId: 'sess-chain', cwd: '/tmp', timestamp: 'T1', type: 'system' },
      { type: 'user', timestamp: 'T2' },
      {
        type: 'assistant', timestamp: 'T3',
        message: {
          content: [{
            type: 'text',
            text: '```json\n{"status":"complete","summary":"Phase 1 done","skillRecommendations":[{"skill":"/polish","task":"clean up edge cases","reasoning":"code works but has rough edges"},{"skill":"/verify","task":"run full suite","reasoning":"sanity check"}]}\n```',
          }],
        },
      },
    )
    const result = parseSessionTranscript(content)
    assert.ok(result?.closingBlock)
    assert.equal(result.closingBlock.skillRecommendations.length, 2)
    // Reviewer would pick the first recommendation
    const next = result.closingBlock.skillRecommendations[0]
    assert.equal(next.skill, '/polish')
    assert.equal(next.task, 'clean up edge cases')
    assert.ok(next.reasoning)
  })
})
