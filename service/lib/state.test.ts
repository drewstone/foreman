import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initState, getDb, getStmts, getConfidence, log } from './state.js'
import type { Stmts } from './state.js'
import type { ConfidenceStore } from '@drew/foreman-memory/confidence'

// Minimal mock for Database.Database
function makeDb() {
  return {} as import('better-sqlite3').Database
}

// Minimal mock for Stmts — only needs to satisfy the interface shape
function makeStmts(): Stmts {
  const stmt = {} as import('better-sqlite3').Statement
  return {
    insertGoal: stmt,
    updateGoal: stmt,
    getGoal: stmt,
    listGoals: stmt,
    insertDecision: stmt,
    updateDecision: stmt,
    getDecision: stmt,
    listDecisions: stmt,
    searchDecisions: stmt,
    goalDecisions: stmt,
    insertSession: stmt,
    updateSession: stmt,
    getSession: stmt,
    listSessions: stmt,
    activeSessions: stmt,
    deleteSession: stmt,
    insertTaste: stmt,
    listTaste: stmt,
    insertEvent: stmt,
    recentEvents: stmt,
    upsertMcp: stmt,
    deleteMcp: stmt,
    listMcp: stmt,
    getMcp: stmt,
    mcpByScope: stmt,
    upsertOperatorSession: stmt,
    operatorSessionCount: stmt,
    recentOperatorSessions: stmt,
    latestScanTimestamp: stmt,
    insertLearning: stmt,
    learningsByType: stmt,
    learningsByProject: stmt,
    allLearnings: stmt,
    insertTemplate: stmt,
    activeTemplate: stmt,
    updateTemplateScore: stmt,
    promoteTemplate: stmt,
    listTemplates: stmt,
  }
}

// Minimal mock for ConfidenceStore
function makeConfidence(): ConfidenceStore {
  return {
    getConfidence: () => 0.5,
    getLevel: () => 'propose',
    getLevelForScore: (s: number) => s >= 0.8 ? 'autonomous' : 'propose',
    update: () => {},
    getOverride: () => null,
    setOverride: () => {},
    clearOverride: () => {},
    getEntry: () => null,
    listEntries: () => [],
  } as unknown as ConfidenceStore
}

describe('initState + getDb/getStmts/getConfidence round-trip', () => {
  let db: import('better-sqlite3').Database
  let stmts: Stmts
  let confidence: ConfidenceStore

  beforeEach(() => {
    db = makeDb()
    stmts = makeStmts()
    confidence = makeConfidence()
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

  it('reinitializing replaces all three references', () => {
    const db2 = makeDb()
    const stmts2 = makeStmts()
    const confidence2 = makeConfidence()
    initState(db2, stmts2, confidence2)
    assert.strictEqual(getDb(), db2)
    assert.strictEqual(getStmts(), stmts2)
    assert.strictEqual(getConfidence(), confidence2)
  })

  it('getDb/getStmts/getConfidence are independent — each returns its own object', () => {
    assert.notStrictEqual(getDb(), getStmts())
    assert.notStrictEqual(getDb(), getConfidence())
    assert.notStrictEqual(getStmts(), getConfidence())
  })
})

describe('log outputs timestamped text', () => {
  it('writes an ISO timestamp prefix followed by the message', () => {
    const lines: string[] = []
    const orig = console.log
    console.log = (s: string) => { lines.push(s) }
    try {
      const before = Date.now()
      log('hello world')
      const after = Date.now()

      assert.equal(lines.length, 1)
      const line = lines[0]

      // Format: [<ISO>] <msg>
      assert.match(line, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] hello world$/)

      // Timestamp is within the test window
      const ts = new Date(line.slice(1, line.indexOf(']'))).getTime()
      assert.ok(ts >= before, `timestamp ${ts} should be >= ${before}`)
      assert.ok(ts <= after, `timestamp ${ts} should be <= ${after}`)
    } finally {
      console.log = orig
    }
  })

  it('preserves the full message including special characters', () => {
    const lines: string[] = []
    const orig = console.log
    console.log = (s: string) => { lines.push(s) }
    try {
      log('session=abc status=done cost=$1.23')
      assert.ok(lines[0].endsWith('session=abc status=done cost=$1.23'))
    } finally {
      console.log = orig
    }
  })

  it('each call produces exactly one line', () => {
    const lines: string[] = []
    const orig = console.log
    console.log = (s: string) => { lines.push(s) }
    try {
      log('first')
      log('second')
      log('third')
      assert.equal(lines.length, 3)
    } finally {
      console.log = orig
    }
  })
})
