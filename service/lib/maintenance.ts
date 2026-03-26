/**
 * Maintenance — worktree cleanup, zombie session reaping, auto-commit.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import {
  FOREMAN_HOME,
  getDb, getStmts, log,
} from './state.js'
import { tmux, getBackend } from './session-manager.js'

const execFileAsync = promisify(execFile)

export async function autoCommitWorktree(workDir: string): Promise<boolean> {
  try {
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: workDir, timeout: 5_000 })
    if (!status.trim()) return false

    await execFileAsync('git', ['add', '-A'], { cwd: workDir, timeout: 5_000 })
    await execFileAsync('git', ['commit', '-m', 'chore: auto-commit uncommitted work from foreman session'], { cwd: workDir, timeout: 10_000 })

    try {
      await execFileAsync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: workDir, timeout: 15_000 })
    } catch {}

    log(`Auto-committed uncommitted work in ${workDir.split('/').pop()}`)
    return true
  } catch {
    return false
  }
}

export async function cleanupWorktrees(): Promise<number> {
  const wtDir = join(FOREMAN_HOME, 'worktrees')
  if (!existsSync(wtDir)) return 0
  const db = getDb()

  let cleaned = 0
  const cutoff = Date.now() - 24 * 60 * 60 * 1000

  try {
    for (const entry of readdirSync(wtDir)) {
      const wtPath = join(wtDir, entry)
      try {
        const mtime = statSync(wtPath).mtimeMs
        if (mtime > cutoff) continue

        const sessionRow = db.prepare(`SELECT name, status FROM sessions WHERE work_dir = ?`).get(wtPath) as { name: string, status: string } | undefined
        if (sessionRow && (sessionRow.status === 'running' || sessionRow.status === 'starting')) continue

        await autoCommitWorktree(wtPath)

        try {
          const { stdout } = await execFileAsync('git', ['-C', wtPath, 'rev-parse', '--git-common-dir'], { timeout: 5_000 })
          const repoGitDir = stdout.trim()
          const repoDir = join(repoGitDir, '..')
          await execFileAsync('git', ['-C', repoDir, 'worktree', 'remove', '--force', wtPath], { timeout: 10_000 })
          cleaned++
          log(`Cleaned worktree: ${entry}`)
        } catch {
          try {
            await execFileAsync('rm', ['-rf', wtPath], { timeout: 5_000 })
            cleaned++
          } catch {}
        }
      } catch {}
    }
  } catch {}

  return cleaned
}

export async function reapZombieSessions(): Promise<number> {
  let reaped = 0
  const backend = getBackend()
  const stmts = getStmts()

  const sessions = stmts.activeSessions.all() as Array<{ name: string, status: string, goal_id: number, work_dir: string, last_checked_at: string | null }>
  for (const s of sessions) {
    if (!backend.isAlive(s.name)) continue
    if (s.status === 'starting') continue

    const hasClaude = tmux(['list-panes', '-t', s.name, '-F', '#{pane_current_command}']).trim()
    const isClaudeRunning = hasClaude.includes('node') || hasClaude.includes('claude') || hasClaude.includes('tsx')

    if (isClaudeRunning) continue

    if (s.status === 'idle') {
      await autoCommitWorktree(s.work_dir)
      backend.kill(s.name)
      stmts.updateSession.run('dead', 'reaped (zombie)', s.name)
      reaped++
      log(`Reaped zombie session: ${s.name}`)
    } else {
      stmts.updateSession.run('idle', '', s.name)
    }
  }

  return reaped
}
