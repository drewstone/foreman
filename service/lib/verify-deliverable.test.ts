import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { verifyDeliverable, runTestGate } from './verify-deliverable.js'

describe('verifyDeliverable', () => {
  let dir: string

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'foreman-verify-test-'))
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns unchecked when no spec provided', () => {
    const result = verifyDeliverable(dir, null, null)
    assert.equal(result.deliverableStatus, 'unchecked')
    assert.equal(result.scopeStatus, 'unchecked')
  })

  it('fails when deliverable file does not exist', () => {
    const result = verifyDeliverable(dir, { path: 'missing.txt' }, null)
    assert.equal(result.deliverableStatus, 'fail')
    assert.ok(result.details.some(d => d.includes('not found')))
  })

  it('passes when deliverable file exists', async () => {
    await writeFile(join(dir, 'output.md'), '# Hello\nWorld\nThird line\n')
    const result = verifyDeliverable(dir, { path: 'output.md', minLines: 2 }, null)
    assert.equal(result.deliverableStatus, 'pass')
  })

  it('fails when file is too short', async () => {
    await writeFile(join(dir, 'short.txt'), 'one line\n')
    const result = verifyDeliverable(dir, { path: 'short.txt', minLines: 10 }, null)
    assert.equal(result.deliverableStatus, 'fail')
    assert.ok(result.details.some(d => d.includes('too short')))
  })

  it('fails when mustContain is missing', async () => {
    await writeFile(join(dir, 'content.txt'), 'hello world\n')
    const result = verifyDeliverable(dir, {
      path: 'content.txt',
      mustContain: ['hello', 'MISSING_STRING'],
    }, null)
    assert.equal(result.deliverableStatus, 'fail')
    assert.ok(result.details.some(d => d.includes('missing required content')))
  })

  it('passes when all mustContain strings are present', async () => {
    await writeFile(join(dir, 'full.txt'), 'hello world foo bar\n')
    const result = verifyDeliverable(dir, {
      path: 'full.txt',
      mustContain: ['hello', 'foo'],
    }, null)
    assert.equal(result.deliverableStatus, 'pass')
  })

  it('fails when mustNotContain string is present', async () => {
    await writeFile(join(dir, 'forbidden.txt'), 'this has SECRET data\n')
    const result = verifyDeliverable(dir, {
      path: 'forbidden.txt',
      mustNotContain: ['SECRET'],
    }, null)
    assert.equal(result.deliverableStatus, 'fail')
    assert.ok(result.details.some(d => d.includes('forbidden content')))
  })

  it('passes testCommand when it exits 0', async () => {
    await writeFile(join(dir, 'tested.txt'), 'content\n')
    const result = verifyDeliverable(dir, {
      path: 'tested.txt',
      testCommand: 'true',
    }, null)
    assert.equal(result.deliverableStatus, 'pass')
    assert.ok(result.details.some(d => d.includes('test command passed')))
  })

  it('fails testCommand when it exits non-zero', async () => {
    await writeFile(join(dir, 'tested2.txt'), 'content\n')
    const result = verifyDeliverable(dir, {
      path: 'tested2.txt',
      testCommand: 'false',
    }, null)
    assert.equal(result.deliverableStatus, 'fail')
    assert.ok(result.details.some(d => d.includes('test command failed')))
  })
})

describe('verifyDeliverable scope checking', () => {
  let dir: string

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'foreman-scope-test-'))
    // Init a git repo with a commit
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    await writeFile(join(dir, 'allowed.ts'), 'export const x = 1\n')
    await writeFile(join(dir, 'forbidden.ts'), 'export const y = 2\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir })
    // Make a change
    await writeFile(join(dir, 'allowed.ts'), 'export const x = 2\n')
    await writeFile(join(dir, 'forbidden.ts'), 'export const y = 3\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'change both'], { cwd: dir })
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('detects scope violation when forbidden files are modified', () => {
    const result = verifyDeliverable(dir, null, {
      allowedPaths: ['allowed.ts'],
    })
    assert.equal(result.scopeStatus, 'violation')
    assert.ok(result.outOfScopeFiles.includes('forbidden.ts'))
  })

  it('reports clean when only allowed files are modified', () => {
    const result = verifyDeliverable(dir, null, {
      allowedPaths: ['allowed.ts', 'forbidden.ts'],
    })
    assert.equal(result.scopeStatus, 'clean')
  })
})

describe('runTestGate', () => {
  let dir: string

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'foreman-gate-test-'))
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('fails gracefully in empty directory (no tsconfig)', () => {
    const result = runTestGate(dir)
    // tsc --noEmit will fail in dir with no tsconfig — that's expected
    assert.equal(typeof result.passed, 'boolean')
    assert.equal(typeof result.output, 'string')
  })
})
