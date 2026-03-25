import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { initState, getDb, getStmts, getConfidence, log } from './state.js'
import type { Stmts } from './state.js'

// Minimal mock that satisfies Database.Database shape for our purposes
const mockDb = {} as unknown as import('better-sqlite3').Database

// Minimal mock satisfying Stmts — every key is a no-op Statement stub
const noop = { run: () => {}, get: () => undefined, all: () => [] } as unknown as import('better-sqlite3').Statement

const mockStmts: Stmts = {
  insertGoal: noop,
  updateGoal: noop,
  getGoal: noop,
  listGoals: noop,

  insertDecision: noop,
  updateDecision: noop,
  getDecision: noop,
  listDecisions: noop,
  searchDecisions: noop,
  goalDecisions: noop,

  insertSession: noop,
  updateSession: noop,
  getSession: noop,
  listSessions: noop,
  activeSessions: noop,
  deleteSession: noop,

  insertTaste: noop,
  listTaste: noop,

  insertEvent: noop,
  recentEvents: noop,

  upsertMcp: noop,
  deleteMcp: noop,
  listMcp: noop,
  getMcp: noop,
  mcpByScope: noop,

  upsertOperatorSession: noop,
  operatorSessionCount: noop,
  recentOperatorSessions: noop,
  latestScanTimestamp: noop,

  insertLearning: noop,
  learningsByType: noop,
  learningsByProject: noop,
  allLearnings: noop,

  insertTemplate: noop,
  activeTemplate: noop,
  updateTemplateScore: noop,
  promoteTemplate: noop,
  listTemplates: noop,
}

const mockConfidence = {} as unknown as import('@drew/foreman-memory/confidence').ConfidenceStore

describe('initState / getDb / getStmts / getConfidence round-trip', () => {
  it('getDb returns the db passed to initState', () => {
    initState(mockDb, mockStmts, mockConfidence)
    assert.strictEqual(getDb(), mockDb)
  })

  it('getStmts returns the stmts passed to initState', () => {
    initState(mockDb, mockStmts, mockConfidence)
    assert.strictEqual(getStmts(), mockStmts)
  })

  it('getConfidence returns the confidence store passed to initState', () => {
    initState(mockDb, mockStmts, mockConfidence)
    assert.strictEqual(getConfidence(), mockConfidence)
  })

  it('re-initialising with different objects updates all accessors', () => {
    const db2 = { tag: 'db2' } as unknown as import('better-sqlite3').Database
    const stmts2 = { ...mockStmts }
    const conf2 = { tag: 'conf2' } as unknown as import('@drew/foreman-memory/confidence').ConfidenceStore

    initState(db2, stmts2, conf2)

    assert.strictEqual(getDb(), db2)
    assert.strictEqual(getStmts(), stmts2)
    assert.strictEqual(getConfidence(), conf2)
  })
})

describe('log', () => {
  let captured: string[]
  let original: typeof console.log

  before(() => {
    captured = []
    original = console.log
    console.log = (...args: unknown[]) => { captured.push(args.join(' ')) }
  })

  after(() => {
    console.log = original
  })

  it('prefixes the message with an ISO 8601 timestamp in brackets', () => {
    const before = Date.now()
    log('hello world')
    const after = Date.now()

    assert.equal(captured.length, 1)
    const line = captured[0]

    // Format: [<ISO>] <msg>
    const match = line.match(/^\[(.+?)\] (.+)$/)
    assert.ok(match, `unexpected format: ${line}`)

    const ts = new Date(match[1]).getTime()
    assert.ok(!isNaN(ts), 'timestamp must be a valid date')
    assert.ok(ts >= before && ts <= after, 'timestamp must fall within test window')
    assert.equal(match[2], 'hello world')
  })

  it('passes the message through unchanged', () => {
    captured = []
    log('some message with spaces and 123 numbers')
    assert.ok(captured[0].endsWith('some message with spaces and 123 numbers'))
  })

  it('emits exactly one console.log call per log() call', () => {
    captured = []
    log('first')
    log('second')
    assert.equal(captured.length, 2)
  })
})
