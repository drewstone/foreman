import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { initState, getDb, getStmts, getConfidence, log, emitEvent, sseClients } from './state.js'
import type { Stmts } from './state.js'
import type Database from 'better-sqlite3'
import type { ConfidenceStore } from '@drew/foreman-memory/confidence'

// ─── Minimal mocks ───────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  return {} as Database.Database
}

function makeStmts(overrides: Partial<Stmts> = {}): Stmts {
  const noop = { run: () => ({}) } as unknown as Database.Statement
  const full: Record<string, Database.Statement> = {}
  const keys: (keyof Stmts)[] = [
    'insertGoal', 'updateGoal', 'getGoal', 'listGoals',
    'insertDecision', 'updateDecision', 'getDecision', 'listDecisions',
    'searchDecisions', 'goalDecisions',
    'insertSession', 'updateSession', 'getSession', 'listSessions',
    'activeSessions', 'deleteSession',
    'insertTaste', 'listTaste',
    'insertEvent', 'recentEvents',
    'upsertMcp', 'deleteMcp', 'listMcp', 'getMcp', 'mcpByScope',
    'upsertOperatorSession', 'operatorSessionCount', 'recentOperatorSessions',
    'latestScanTimestamp',
    'insertLearning', 'learningsByType', 'learningsByProject', 'allLearnings',
    'insertTemplate', 'activeTemplate', 'updateTemplateScore', 'promoteTemplate',
    'listTemplates',
  ]
  for (const k of keys) full[k] = noop
  return { ...full, ...overrides } as Stmts
}

function makeConfidence(): ConfidenceStore {
  return {} as ConfidenceStore
}

function makeSseClient(): { written: string[], res: ServerResponse } {
  const written: string[] = []
  const res = { write: (chunk: string) => { written.push(chunk); return true } } as unknown as ServerResponse
  return { written, res }
}

// ─── initState / getters ─────────────────────────────────────────────────────

describe('initState and getters', () => {
  const db = makeDb()
  const stmts = makeStmts()
  const confidence = makeConfidence()

  before(() => {
    initState(db, stmts, confidence)
  })

  it('getDb returns the db passed to initState', () => {
    assert.strictEqual(getDb(), db)
  })

  it('getStmts returns the stmts passed to initState', () => {
    assert.strictEqual(getStmts(), stmts)
  })

  it('getConfidence returns the confidence passed to initState', () => {
    assert.strictEqual(getConfidence(), confidence)
  })

  it('reinitializing replaces all three values', () => {
    const db2 = makeDb()
    const stmts2 = makeStmts()
    const confidence2 = makeConfidence()
    initState(db2, stmts2, confidence2)
    assert.strictEqual(getDb(), db2)
    assert.strictEqual(getStmts(), stmts2)
    assert.strictEqual(getConfidence(), confidence2)
    // restore
    initState(db, stmts, confidence)
  })
})

// ─── log ─────────────────────────────────────────────────────────────────────

describe('log', () => {
  it('writes an ISO-timestamped line to stdout', () => {
    const lines: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')) }
    try {
      const before = Date.now()
      log('hello world')
      const after = Date.now()
      assert.equal(lines.length, 1)
      const line = lines[0]
      assert.ok(line.includes('hello world'), `line should contain message: ${line}`)
      // extract timestamp from brackets
      const match = line.match(/^\[(.+?)\]/)
      assert.ok(match, `line should start with bracketed timestamp: ${line}`)
      const ts = new Date(match![1]).getTime()
      assert.ok(ts >= before && ts <= after, `timestamp ${match![1]} not within test window`)
    } finally {
      console.log = original
    }
  })

  it('format is [ISO] message', () => {
    const lines: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')) }
    try {
      log('test msg')
      assert.ok(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] test msg$/.test(lines[0]),
        `unexpected format: ${lines[0]}`)
    } finally {
      console.log = original
    }
  })
})

// ─── emitEvent ───────────────────────────────────────────────────────────────

describe('emitEvent', () => {
  let insertEventArgs: unknown[][]
  let stmts: Stmts
  const db = makeDb()
  const confidence = makeConfidence()

  before(() => {
    insertEventArgs = []
    stmts = makeStmts({
      insertEvent: {
        run: (...args: unknown[]) => { insertEventArgs.push(args); return {} as Database.RunResult },
      } as unknown as Database.Statement,
    })
    initState(db, stmts, confidence)
  })

  after(() => {
    sseClients.clear()
  })

  it('calls insertEvent.run with type, sessionName, goalId, and serialized data', () => {
    insertEventArgs.length = 0
    emitEvent('session-start', 'my-session', 42, { key: 'val' })
    assert.equal(insertEventArgs.length, 1)
    const [type, sessionName, goalId, data] = insertEventArgs[0]
    assert.equal(type, 'session-start')
    assert.equal(sessionName, 'my-session')
    assert.equal(goalId, 42)
    assert.equal(data, JSON.stringify({ key: 'val' }))
  })

  it('calls insertEvent.run with null data when data is omitted', () => {
    insertEventArgs.length = 0
    emitEvent('heartbeat', null, null)
    assert.equal(insertEventArgs.length, 1)
    const [type, sessionName, goalId, data] = insertEventArgs[0]
    assert.equal(type, 'heartbeat')
    assert.equal(sessionName, null)
    assert.equal(goalId, null)
    assert.equal(data, null)
  })

  it('broadcasts SSE payload to all connected clients', () => {
    sseClients.clear()
    const c1 = makeSseClient()
    const c2 = makeSseClient()
    sseClients.add(c1.res)
    sseClients.add(c2.res)

    emitEvent('test-event', 'sess', 1, { x: 1 })

    assert.equal(c1.written.length, 1)
    assert.equal(c2.written.length, 1)
    // SSE framing: starts with "data: " and ends with double newline
    assert.ok(c1.written[0].startsWith('data: '), `c1 payload: ${c1.written[0]}`)
    assert.ok(c1.written[0].endsWith('\n\n'), `c1 payload missing trailing newlines`)
  })

  it('SSE payload is valid JSON containing event fields', () => {
    sseClients.clear()
    const c = makeSseClient()
    sseClients.add(c.res)

    emitEvent('goal-done', 'sess2', 7, { score: 0.9 })

    const raw = c.written[0].replace(/^data: /, '').trimEnd()
    const parsed = JSON.parse(raw)
    assert.equal(parsed.type, 'goal-done')
    assert.equal(parsed.sessionName, 'sess2')
    assert.equal(parsed.goalId, 7)
    assert.deepEqual(parsed.data, { score: 0.9 })
    assert.ok(typeof parsed.timestamp === 'string', 'should include timestamp')
    // timestamp should be a valid ISO date
    assert.ok(!isNaN(new Date(parsed.timestamp).getTime()), `invalid timestamp: ${parsed.timestamp}`)
  })

  it('removes a client that throws on write and continues broadcasting', () => {
    sseClients.clear()
    const good = makeSseClient()
    const bad = {
      write: () => { throw new Error('broken pipe') },
    } as unknown as ServerResponse
    sseClients.add(bad)
    sseClients.add(good.res)

    // should not throw
    emitEvent('probe', null, null)

    // bad client removed, good client received payload
    assert.ok(!sseClients.has(bad), 'bad client should be removed from sseClients')
    assert.equal(good.written.length, 1)
  })
})
