import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { initState, getDb, getStmts, getConfidence, log } from './state.js'
import type { Stmts } from './state.js'
import type Database from 'better-sqlite3'
import type { ConfidenceStore } from '@drew/foreman-memory/confidence'

describe('initState / getters', () => {
  it('getDb returns the db passed to initState', () => {
    const db = { name: 'db' } as unknown as Database.Database
    const stmts = {} as unknown as Stmts
    const confidence = {} as unknown as ConfidenceStore
    initState(db, stmts, confidence)
    assert.strictEqual(getDb(), db)
  })

  it('getStmts returns the stmts passed to initState', () => {
    const db = {} as unknown as Database.Database
    const stmts = { insertGoal: {} } as unknown as Stmts
    const confidence = {} as unknown as ConfidenceStore
    initState(db, stmts, confidence)
    assert.strictEqual(getStmts(), stmts)
  })

  it('getConfidence returns the confidence passed to initState', () => {
    const db = {} as unknown as Database.Database
    const stmts = {} as unknown as Stmts
    const confidence = { record: () => {} } as unknown as ConfidenceStore
    initState(db, stmts, confidence)
    assert.strictEqual(getConfidence(), confidence)
  })

  it('overwrites previous values on repeated initState calls', () => {
    const db1 = { id: 1 } as unknown as Database.Database
    const db2 = { id: 2 } as unknown as Database.Database
    const stmts = {} as unknown as Stmts
    const confidence = {} as unknown as ConfidenceStore
    initState(db1, stmts, confidence)
    assert.strictEqual(getDb(), db1)
    initState(db2, stmts, confidence)
    assert.strictEqual(getDb(), db2)
  })
})

describe('log', () => {
  it('writes a single line to console.log', () => {
    const lines: unknown[] = []
    const original = console.log
    console.log = (...args: unknown[]) => { lines.push(args[0]) }
    try {
      log('hello')
      assert.equal(lines.length, 1)
    } finally {
      console.log = original
    }
  })

  it('prefixes output with an ISO 8601 timestamp in brackets', () => {
    const lines: string[] = []
    const original = console.log
    console.log = (line: string) => { lines.push(line) }
    try {
      log('test message')
      const line = lines[0]
      assert.match(line, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\] /)
    } finally {
      console.log = original
    }
  })

  it('includes the message verbatim after the timestamp', () => {
    const lines: string[] = []
    const original = console.log
    console.log = (line: string) => { lines.push(line) }
    try {
      log('foreman dispatch')
      assert.ok(lines[0].endsWith('foreman dispatch'), `line was: ${lines[0]}`)
    } finally {
      console.log = original
    }
  })

  it('uses a timestamp close to the current time', () => {
    const lines: string[] = []
    const original = console.log
    console.log = (line: string) => { lines.push(line) }
    try {
      const before = Date.now()
      log('timing check')
      const after = Date.now()
      const match = lines[0].match(/^\[(.+?)\]/)
      assert.ok(match, 'no timestamp bracket found')
      const ts = new Date(match![1]).getTime()
      assert.ok(ts >= before && ts <= after, `timestamp ${ts} outside [${before}, ${after}]`)
    } finally {
      console.log = original
    }
  })
})
