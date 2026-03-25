import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initState } from './state.js'
import { composePrompt } from './prompt-composer.js'
import type { Stmts } from './state.js'

// Minimal mock db — returns no rows for all prepared statement calls
function makeDb() {
  const stmt = { get: () => undefined, all: () => [] }
  return { prepare: () => stmt }
}

// Minimal mock stmts — only the fields composePrompt actually calls
function makeStmts(): Stmts {
  const empty = { all: () => [] }
  return {
    goalDecisions: empty,
    listTaste: empty,
    learningsByProject: empty,
    learningsByType: empty,
  } as unknown as Stmts
}

describe('composePrompt', () => {
  let workDir: string

  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'foreman-prompt-test-'))
    // Wire up state singletons with mocks before any composePrompt call
    initState(
      makeDb() as unknown as import('better-sqlite3').Database,
      makeStmts(),
      null as unknown as InstanceType<typeof import('@drew/foreman-memory/confidence').ConfidenceStore>,
    )
  })

  after(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it('produces slim tier for /verify', () => {
    const { tier } = composePrompt({
      skill: '/verify',
      task: 'check all tests pass',
      workDir,
    })
    assert.equal(tier, 'slim')
  })

  it('produces rich tier for /pursue', () => {
    const { tier } = composePrompt({
      skill: '/pursue',
      task: 'architectural redesign of the auth module',
      workDir,
    })
    assert.equal(tier, 'rich')
  })

  it('prepends skill prefix when skill starts with /', () => {
    const { text } = composePrompt({
      skill: '/verify',
      task: 'run the test suite',
      workDir,
    })
    assert.ok(
      text.startsWith('/verify '),
      `expected text to start with "/verify " but got: ${JSON.stringify(text.slice(0, 40))}`,
    )
  })
})
