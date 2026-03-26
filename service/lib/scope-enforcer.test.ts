import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { installScopeHook, removeScopeHook } from './scope-enforcer.js'

function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir })
}

describe('installScopeHook — normal git repo', () => {
  let dir: string

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'foreman-scope-install-'))
    initGitRepo(dir)
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null when allowedPaths is empty', () => {
    const result = installScopeHook(dir, { allowedPaths: [] })
    assert.equal(result, null)
  })

  it('creates pre-commit hook at .git/hooks/pre-commit', () => {
    const hookPath = installScopeHook(dir, { allowedPaths: ['src/foo.ts'] })
    assert.ok(hookPath !== null)
    assert.equal(hookPath, join(dir, '.git', 'hooks', 'pre-commit'))
    assert.ok(existsSync(hookPath))
  })

  it('hook file starts with bash shebang', async () => {
    const hookPath = installScopeHook(dir, { allowedPaths: ['src/foo.ts'] })
    assert.ok(hookPath !== null)
    const content = await readFile(hookPath, 'utf8')
    assert.ok(content.startsWith('#!/usr/bin/env bash'))
  })

  it('hook file is executable', async () => {
    const hookPath = installScopeHook(dir, { allowedPaths: ['src/foo.ts'] })
    assert.ok(hookPath !== null)
    const s = await stat(hookPath)
    assert.ok((s.mode & 0o111) !== 0, 'hook file must be executable')
  })

  it('hook script contains allowed patterns', async () => {
    // allowedPaths globs: * → .* in the hook script
    const hookPath = installScopeHook(dir, { allowedPaths: ['src/foo.ts', 'lib/*.ts'] })
    assert.ok(hookPath !== null)
    const content = await readFile(hookPath, 'utf8')
    assert.ok(content.includes('"src/foo.ts"'), 'literal path should appear verbatim')
    assert.ok(content.includes('"lib/.*.ts"'), 'glob * should be converted to .* in hook script')
  })

  it('hook script contains forbidden patterns when provided', async () => {
    const hookPath = installScopeHook(dir, {
      allowedPaths: ['src/.*'],
      forbiddenPaths: ['src/secrets.ts'],
    })
    assert.ok(hookPath !== null)
    const content = await readFile(hookPath, 'utf8')
    assert.ok(content.includes('"src/secrets.ts"'))
    assert.ok(content.includes('FORBIDDEN'))
  })

  it('hook script has empty FORBIDDEN_PATTERNS when forbiddenPaths omitted', async () => {
    const hookPath = installScopeHook(dir, { allowedPaths: ['src/.*'] })
    assert.ok(hookPath !== null)
    const content = await readFile(hookPath, 'utf8')
    assert.ok(content.includes('FORBIDDEN_PATTERNS=()'))
  })

  it('returns a path on repeated calls (overwrites existing hook)', () => {
    const first = installScopeHook(dir, { allowedPaths: ['a.ts'] })
    const second = installScopeHook(dir, { allowedPaths: ['b.ts'] })
    assert.ok(first !== null)
    assert.ok(second !== null)
    assert.equal(first, second)
  })
})

describe('installScopeHook — git worktree', () => {
  let mainDir: string
  let worktreeDir: string

  before(async () => {
    mainDir = await mkdtemp(join(tmpdir(), 'foreman-scope-main-'))
    worktreeDir = await mkdtemp(join(tmpdir(), 'foreman-scope-wt-'))
    initGitRepo(mainDir)
    // Create a branch so we can add a worktree
    execFileSync('git', ['checkout', '-b', 'wt-branch'], { cwd: mainDir })
    execFileSync('git', ['worktree', 'add', worktreeDir, 'wt-branch'], { cwd: mainDir })
  })

  after(async () => {
    await rm(mainDir, { recursive: true, force: true })
    await rm(worktreeDir, { recursive: true, force: true })
  })

  it('.git in worktree is a file, not a directory', async () => {
    const gitEntry = join(worktreeDir, '.git')
    const s = await stat(gitEntry)
    assert.ok(s.isFile(), '.git should be a file in a worktree')
  })

  it('creates .foreman-hooks/ directory for worktree', async () => {
    installScopeHook(worktreeDir, { allowedPaths: ['src/.*'] })
    const hooksDir = join(worktreeDir, '.foreman-hooks')
    assert.ok(existsSync(hooksDir), '.foreman-hooks/ should be created')
  })

  it('places hook at .foreman-hooks/pre-commit', () => {
    const hookPath = installScopeHook(worktreeDir, { allowedPaths: ['src/.*'] })
    assert.ok(hookPath !== null)
    assert.equal(hookPath, join(worktreeDir, '.foreman-hooks', 'pre-commit'))
    assert.ok(existsSync(hookPath))
  })

  it('sets core.hooksPath to .foreman-hooks/ in worktree config', () => {
    installScopeHook(worktreeDir, { allowedPaths: ['src/.*'] })
    const result = execFileSync('git', ['config', '--local', 'core.hooksPath'], {
      cwd: worktreeDir,
      encoding: 'utf8',
    }).trim()
    assert.equal(result, join(worktreeDir, '.foreman-hooks'))
  })
})

describe('removeScopeHook', () => {
  let dir: string

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'foreman-scope-remove-'))
    initGitRepo(dir)
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('removes .foreman-hooks/pre-commit when it exists', async () => {
    const hooksDir = join(dir, '.foreman-hooks')
    await mkdir(hooksDir, { recursive: true })
    await writeFile(join(hooksDir, 'pre-commit'), '#!/bin/bash\nexit 0\n')

    assert.ok(existsSync(join(hooksDir, 'pre-commit')))
    removeScopeHook(dir)
    assert.equal(existsSync(join(hooksDir, 'pre-commit')), false)
  })

  it('does not throw when hook file is already gone', () => {
    assert.doesNotThrow(() => removeScopeHook(dir))
  })

  it('unsets core.hooksPath after removal', async () => {
    // Set hooksPath first so there is something to unset
    const hooksDir = join(dir, '.foreman-hooks')
    await mkdir(hooksDir, { recursive: true })
    await writeFile(join(hooksDir, 'pre-commit'), '#!/bin/bash\nexit 0\n')
    execFileSync('git', ['config', '--local', 'core.hooksPath', hooksDir], { cwd: dir })

    removeScopeHook(dir)

    // git config --local core.hooksPath should now exit non-zero (unset)
    const result = spawnSync('git', ['config', '--local', 'core.hooksPath'], { cwd: dir })
    assert.notEqual(result.status, 0, 'core.hooksPath should be unset after removeScopeHook')
  })
})

describe('pre-commit hook — enforcement', () => {
  let dir: string

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'foreman-hook-enforce-'))
    initGitRepo(dir)
    await writeFile(join(dir, 'allowed.ts'), 'export const x = 1\n')
    await writeFile(join(dir, 'forbidden.ts'), 'export const y = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'seed files'], { cwd: dir })
  })

  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('allows commit when only in-scope files are staged', async () => {
    installScopeHook(dir, { allowedPaths: ['allowed.ts'] })

    await writeFile(join(dir, 'allowed.ts'), 'export const x = 2\n')
    execFileSync('git', ['add', 'allowed.ts'], { cwd: dir })

    const result = spawnSync('git', ['commit', '-m', 'in-scope change'], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `commit should succeed; stderr: ${result.stderr}`)
  })

  it('rejects commit when out-of-scope file is staged', async () => {
    installScopeHook(dir, { allowedPaths: ['allowed.ts'] })

    await writeFile(join(dir, 'forbidden.ts'), 'export const y = 99\n')
    execFileSync('git', ['add', 'forbidden.ts'], { cwd: dir })

    const result = spawnSync('git', ['commit', '-m', 'out-of-scope change'], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0, 'commit should be rejected')
    const output = (result.stdout ?? '') + (result.stderr ?? '')
    assert.ok(
      output.includes('FOREMAN SCOPE VIOLATION') || output.includes('OUT OF SCOPE'),
      `expected scope violation message; got: ${output}`,
    )

    // Unstage so subsequent tests start clean
    execFileSync('git', ['reset', 'HEAD', 'forbidden.ts'], { cwd: dir })
  })

  it('rejects commit when file matches a forbidden pattern', async () => {
    // allowed + forbidden overlap — forbidden takes precedence
    installScopeHook(dir, {
      allowedPaths: ['allowed.ts', 'forbidden.ts'],
      forbiddenPaths: ['forbidden.ts'],
    })

    await writeFile(join(dir, 'forbidden.ts'), 'export const y = 100\n')
    execFileSync('git', ['add', 'forbidden.ts'], { cwd: dir })

    const result = spawnSync('git', ['commit', '-m', 'forbidden path'], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0, 'commit should be rejected due to forbidden pattern')
    const output = (result.stdout ?? '') + (result.stderr ?? '')
    assert.ok(
      output.includes('FORBIDDEN') || output.includes('FOREMAN SCOPE VIOLATION'),
      `expected forbidden message; got: ${output}`,
    )

    execFileSync('git', ['reset', 'HEAD', 'forbidden.ts'], { cwd: dir })
  })

  it('allows commit with no staged files (empty commit is a no-op)', async () => {
    installScopeHook(dir, { allowedPaths: ['allowed.ts'] })

    // Nothing staged — hook should exit 0 (empty $CHANGED_FILES branch)
    const result = spawnSync('git', ['commit', '--allow-empty', '-m', 'empty'], {
      cwd: dir,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `empty commit should succeed; stderr: ${result.stderr}`)
  })
})
