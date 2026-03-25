import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { verifyDeliverable, runTestGate } from './verify-deliverable.ts'

describe('verifyDeliverable', () => {
  let workDir: string

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'verify-deliv-'))
  })

  after(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('passes when file exists and meets all checks', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    writeFileSync(join(workDir, 'output.ts'), content)

    const result = verifyDeliverable(workDir, {
      path: 'output.ts',
      minLines: 10,
      mustContain: ['line 5', 'line 10'],
      mustNotContain: ['TODO', 'FIXME'],
    }, null)

    assert.equal(result.deliverableStatus, 'pass')
    assert.equal(result.scopeStatus, 'unchecked')
    assert.ok(result.details.some(d => d.includes('deliverable verified')))
  })

  it('fails when file is missing', () => {
    const result = verifyDeliverable(workDir, {
      path: 'does-not-exist.ts',
    }, null)

    assert.equal(result.deliverableStatus, 'fail')
    assert.ok(result.details.some(d => d.includes('deliverable not found')))
  })

  it('fails when file is too short', () => {
    writeFileSync(join(workDir, 'short.ts'), 'one line')

    const result = verifyDeliverable(workDir, {
      path: 'short.ts',
      minLines: 50,
    }, null)

    assert.equal(result.deliverableStatus, 'fail')
    assert.ok(result.details.some(d => d.includes('too short')))
  })

  it('fails when mustContain strings are absent', () => {
    writeFileSync(join(workDir, 'missing-content.ts'), 'export function hello() {}')

    const result = verifyDeliverable(workDir, {
      path: 'missing-content.ts',
      mustContain: ['import React', 'describe('],
    }, null)

    assert.equal(result.deliverableStatus, 'fail')
    assert.ok(result.details.some(d => d.includes('missing required content')))
    // Both missing strings should be reported
    const missingDetails = result.details.filter(d => d.includes('missing required content'))
    assert.equal(missingDetails.length, 2)
  })
})

describe('runTestGate', () => {
  let workDir: string

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'test-gate-'))
    // Create a minimal tsconfig that tsc --noEmit can check
    writeFileSync(join(workDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'es2022',
      },
      include: ['*.ts'],
    }))
    // Create a valid TS file so tsc has something to check
    writeFileSync(join(workDir, 'index.ts'), 'export const x: number = 1\n')
    // Symlink node_modules so npx tsc resolves typescript
    symlinkSync(join(process.cwd(), 'node_modules'), join(workDir, 'node_modules'))
  })

  after(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('passes on a directory with valid TypeScript', () => {
    const result = runTestGate(workDir)
    assert.equal(result.passed, true)
  })
})
