/**
 * Parallel Dispatch — spawn N CC sessions for optimization.
 *
 * Each session gets its own worktree (isolation) and reads the shared
 * frontier + traces. Sessions run in parallel, all proposing variants
 * against the same frontier. Results collected and frontier updated.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { callClaude, type ClaudeRunResult } from './claude-runner.js'

const CLAUDE_BIN = process.env.CLAUDE_PATH ?? join(homedir(), '.local/bin/claude')
const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export interface ParallelProposal {
  worktreePath: string
  branch: string
  result: ClaudeRunResult
  pendingEvalPath: string | null
}

/**
 * Create N git worktrees for parallel CC sessions.
 */
export function createWorktrees(
  repoPath: string,
  count: number,
  label: string,
): string[] {
  const paths: string[] = []
  const wtBase = join(FOREMAN_HOME, 'meta-harness-worktrees')
  mkdirSync(wtBase, { recursive: true })

  for (let i = 0; i < count; i++) {
    const branch = `meta-harness/${label}-${i}`
    const wtPath = join(wtBase, `${basename(repoPath)}-${label}-${i}`)

    // Clean up stale worktree if exists
    try {
      execFileSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', wtPath], { stdio: 'ignore' })
    } catch {}
    try {
      execFileSync('git', ['-C', repoPath, 'branch', '-D', branch], { stdio: 'ignore' })
    } catch {}

    execFileSync('git', ['-C', repoPath, 'worktree', 'add', '-b', branch, wtPath], {
      stdio: 'ignore',
      timeout: 30_000,
    })

    paths.push(wtPath)
  }

  return paths
}

/**
 * Clean up worktrees after an iteration.
 */
export function cleanupWorktrees(repoPath: string, paths: string[]): void {
  for (const p of paths) {
    try {
      execFileSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', p], { stdio: 'ignore' })
    } catch {}
  }
  try {
    execFileSync('git', ['-C', repoPath, 'worktree', 'prune'], { stdio: 'ignore' })
  } catch {}
}

/**
 * Copy shared meta-harness state into a worktree so CC can read it.
 */
export function injectStateIntoWorktree(
  worktreePath: string,
  metaHarnessDir: string,
): void {
  const targetDir = join(worktreePath, '.meta-harness')
  mkdirSync(targetDir, { recursive: true })

  // Copy frontier, evolution log, traces — CC reads these
  for (const file of ['frontier.json', 'evolution.jsonl']) {
    const src = join(metaHarnessDir, file)
    if (existsSync(src)) {
      cpSync(src, join(targetDir, file))
    }
  }

  // Copy traces dir
  const tracesDir = join(metaHarnessDir, 'traces')
  if (existsSync(tracesDir)) {
    cpSync(tracesDir, join(targetDir, 'traces'), { recursive: true })
  }

  // Copy variants dir
  const variantsDir = join(metaHarnessDir, 'variants')
  if (existsSync(variantsDir)) {
    cpSync(variantsDir, join(targetDir, 'variants'), { recursive: true })
  }
}

/**
 * Run N parallel CC proposer sessions.
 * Each reads the shared state, writes a pending_eval.json with its proposal.
 */
export async function runParallelProposers(opts: {
  worktrees: string[]
  skillPath: string
  model?: string
  timeoutMs?: number
}): Promise<ParallelProposal[]> {
  const { worktrees, skillPath, model = 'opus', timeoutMs = 300_000 } = opts

  const skillContent = readFileSync(skillPath, 'utf8')

  const promises = worktrees.map(async (wt, i) => {
    const prompt = [
      skillContent,
      '',
      `You are proposer #${i}. Read .meta-harness/frontier.json, .meta-harness/evolution.jsonl, and .meta-harness/traces/ to understand what has been tried.`,
      'Write your proposed variant and pending_eval.json per the SKILL.md instructions.',
    ].join('\n')

    const result = await callClaude({
      prompt,
      model,
      timeoutMs,
      cwd: wt,
    })

    const pendingPath = join(wt, '.meta-harness', 'pending_eval.json')
    return {
      worktreePath: wt,
      branch: `meta-harness-${i}`,
      result,
      pendingEvalPath: existsSync(pendingPath) ? pendingPath : null,
    }
  })

  return Promise.all(promises)
}
