import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installScopeHook, removeScopeHook } from './scope-enforcer.js'

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-scope-test-'))
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  return dir
}

function gitConfigGet(dir: string, key: string): string {
  try {
    return execFileSync('git', ['config', key], { cwd: dir }).toString().trim()
  } catch {
    return ''
  }
}

describe('installScopeHook', () => {
  let tmpDir: string

  before(() => {
    tmpDir = makeTempRepo()
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when allowedPaths is empty', () => {
    const dir = makeTempRepo()
    try {
      const result = installScopeHook(dir, { allowedPaths: [] })
      assert.equal(result, null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates .foreman-hooks/pre-commit', () => {
    const result = installScopeHook(tmpDir, { allowedPaths: ['src/.*'] })
    const hookPath = join(tmpDir, '.foreman-hooks', 'pre-commit')
    assert.ok(existsSync(hookPath), 'pre-commit hook file should exist')
    assert.equal(result, hookPath)
  })

  it('hook file is executable', () => {
    const hookPath = join(tmpDir, '.foreman-hooks', 'pre-commit')
    const mode = statSync(hookPath).mode
    assert.ok(mode & 0o111, 'hook should be executable')
  })

  it('sets core.hooksPath pointing at .foreman-hooks', () => {
    const hooksPath = gitConfigGet(tmpDir, 'core.hooksPath')
    assert.ok(
      hooksPath.includes('.foreman-hooks'),
      `expected core.hooksPath to contain .foreman-hooks, got: "${hooksPath}"`,
    )
  })

  it('hook script contains allowed patterns', () => {
    const dir = makeTempRepo()
    try {
      installScopeHook(dir, { allowedPaths: ['src/foo.ts', 'lib/bar.ts'] })
      const content = readFileSync(join(dir, '.foreman-hooks', 'pre-commit'), 'utf8')
      assert.ok(content.includes('src/foo.ts'), 'hook should include src/foo.ts')
      assert.ok(content.includes('lib/bar.ts'), 'hook should include lib/bar.ts')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('hook script contains forbidden patterns when provided', () => {
    const dir = makeTempRepo()
    try {
      installScopeHook(dir, { allowedPaths: ['src/.*'], forbiddenPaths: ['src/secrets.ts'] })
      const content = readFileSync(join(dir, '.foreman-hooks', 'pre-commit'), 'utf8')
      assert.ok(content.includes('src/secrets.ts'), 'hook should include forbidden pattern')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('glob wildcards in allowedPaths are converted to .* in hook', () => {
    const dir = makeTempRepo()
    try {
      installScopeHook(dir, { allowedPaths: ['src/*.ts'] })
      const content = readFileSync(join(dir, '.foreman-hooks', 'pre-commit'), 'utf8')
      assert.ok(content.includes('src/.*.ts'), 'glob * should be converted to .*')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns the absolute path to the pre-commit hook', () => {
    const dir = makeTempRepo()
    try {
      const result = installScopeHook(dir, { allowedPaths: ['src/.*'] })
      assert.equal(result, join(dir, '.foreman-hooks', 'pre-commit'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('removeScopeHook', () => {
  let tmpDir: string

  before(() => {
    tmpDir = makeTempRepo()
    installScopeHook(tmpDir, { allowedPaths: ['src/.*'] })
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removes the pre-commit hook file', () => {
    const hookPath = join(tmpDir, '.foreman-hooks', 'pre-commit')
    assert.ok(existsSync(hookPath), 'hook should exist before removal')
    removeScopeHook(tmpDir)
    assert.ok(!existsSync(hookPath), 'hook should not exist after removal')
  })

  it('unsets core.hooksPath from git config', () => {
    // reinstall so we have a hooksPath to unset
    installScopeHook(tmpDir, { allowedPaths: ['src/.*'] })
    assert.ok(
      gitConfigGet(tmpDir, 'core.hooksPath').includes('.foreman-hooks'),
      'hooksPath should be set before remove',
    )
    removeScopeHook(tmpDir)
    assert.equal(gitConfigGet(tmpDir, 'core.hooksPath'), '', 'core.hooksPath should be unset after removal')
  })

  it('does not throw when hook does not exist', () => {
    const dir = makeTempRepo()
    try {
      assert.doesNotThrow(() => removeScopeHook(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
