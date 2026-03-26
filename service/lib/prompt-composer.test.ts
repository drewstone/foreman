import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initState } from './state.js'
import { composePrompt } from './prompt-composer.js'
import type { Stmts } from './state.js'
import type Database from 'better-sqlite3'

// Minimal mock statement — ignores all args, returns empty rows
function makeStmt(): Database.Statement {
  return {
    all: () => [],
    run: () => ({ changes: 0, lastInsertRowid: 0n }),
    get: () => undefined,
  } as unknown as Database.Statement
}

// Mock db — prepare() always returns a stmt that returns []
function makeMockDb(): Database.Database {
  return {
    prepare: (_sql: string) => makeStmt(),
  } as unknown as Database.Database
}

// Full mock stmts satisfying the Stmts interface
function makeMockStmts(): Stmts {
  const s = makeStmt()
  return {
    insertGoal: s, updateGoal: s, getGoal: s, listGoals: s,
    insertDecision: s, updateDecision: s, getDecision: s,
    listDecisions: s, searchDecisions: s, goalDecisions: s,
    insertSession: s, updateSession: s, getSession: s,
    listSessions: s, activeSessions: s, deleteSession: s,
    insertTaste: s, listTaste: s,
    insertEvent: s, recentEvents: s,
    upsertMcp: s, deleteMcp: s, listMcp: s, getMcp: s, mcpByScope: s,
    upsertOperatorSession: s, operatorSessionCount: s,
    recentOperatorSessions: s, latestScanTimestamp: s,
    insertLearning: s, learningsByType: s, learningsByProject: s,
    allLearnings: s,
    insertTemplate: s, activeTemplate: s, updateTemplateScore: s,
    promoteTemplate: s, listTemplates: s,
  }
}

describe('composePrompt', () => {
  let workDir: string

  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'foreman-compose-test-'))
    // composePrompt uses getDb/getStmts singletons — init with mocks
    // confidence is not accessed by composePrompt so null is safe
    initState(makeMockDb(), makeMockStmts(), null as any)
  })

  after(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it('returns text, sections, and tier', () => {
    const result = composePrompt({ skill: '/verify', task: 'run the tests', workDir })
    assert.equal(typeof result.text, 'string')
    assert.ok(Array.isArray(result.sections))
    assert.equal(typeof result.tier, 'string')
  })

  it('execution skills get slim tier (1500 budget)', () => {
    for (const skill of ['/verify', '/converge', '/polish']) {
      const { tier } = composePrompt({ skill, task: 'do something', workDir })
      assert.equal(tier, 'slim', `expected slim tier for ${skill}`)
    }
  })

  it('reasoning skills get rich tier (6000 budget)', () => {
    for (const skill of ['/pursue', '/plan', '/research', '/reflect']) {
      const { tier } = composePrompt({ skill, task: 'think deeply', workDir })
      assert.equal(tier, 'rich', `expected rich tier for ${skill}`)
    }
  })

  it('skill prefix is prepended when skill starts with /', () => {
    const skill = '/verify'
    const { text } = composePrompt({ skill, task: 'run tests', workDir })
    assert.ok(
      text.startsWith(`${skill} `),
      `text should start with "${skill} " but got: ${JSON.stringify(text.slice(0, 60))}`
    )
  })

  it('no slash prefix when skill does not start with /', () => {
    const { text } = composePrompt({ skill: 'verify', task: 'run tests', workDir })
    assert.ok(
      !text.startsWith('/'),
      `text should not start with "/" when skill has no slash, got: ${JSON.stringify(text.slice(0, 60))}`
    )
  })
})
