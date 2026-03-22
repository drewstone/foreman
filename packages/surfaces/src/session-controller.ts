/**
 * Session controller — NTM-inspired tmux orchestration for Foreman.
 *
 * Replaces the ad-hoc tmux management in policy.ts with a proper
 * session lifecycle controller. Inspired by NTM's robot mode.
 *
 * Capabilities:
 *   spawn(project, prompt)     — start interactive claude in tmux
 *   send(session, prompt)      — inject follow-up prompt into running session
 *   status()                   — JSON status of all sessions
 *   inspect(session, opts)     — read session output with pattern matching
 *   metrics(session)           — commits, lines, tests per session
 *   kill(session)              — stop a session
 *   detectContextExhaustion()  — check for "prompt too long" in output
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
const CLAUDE_BIN = process.env.CLAUDE_PATH ?? '/home/drew/.local/bin/claude'
const ENV = { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` }

// ─── Types ──────────────────────────────────────────────────────────

export interface SessionInfo {
  name: string
  project: string
  projectPath: string
  alive: boolean
  round: number
  totalCommits: number
  lastActivity: string | null
  logFile: string
  progressFile: string
}

export interface SessionMetrics {
  commits: number
  linesAdded: number
  linesRemoved: number
  filesChanged: number
  testsAdded: number
  rounds: number
}

export interface InspectOptions {
  lastN?: number
  pattern?: string
  codeOnly?: boolean
}

// ─── Helpers ────────────────────────────────────────────────────────

function sessionName(project: string): string {
  const name = project.split('/').pop() ?? project
  return `foreman-${name}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40)
}

function tmuxRun(args: string[], options?: { encoding?: 'utf8'; timeout?: number }): string {
  return execFileSync('tmux', args, {
    encoding: options?.encoding ?? 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options?.timeout ?? 5_000,
    env: ENV,
  }) as string
}

function tmuxRunQuiet(args: string[]): boolean {
  try {
    execFileSync('tmux', args, { stdio: 'ignore', timeout: 5_000, env: ENV })
    return true
  } catch {
    return false
  }
}

function gitStat(cwd: string): { commits: number; linesAdded: number; linesRemoved: number; filesChanged: number } {
  try {
    const log = execFileSync('git', ['log', '--oneline'], { cwd, encoding: 'utf8', timeout: 5_000 })
    const commits = log.trim().split('\n').filter(Boolean).length

    const diff = execFileSync('git', ['diff', '--shortstat', 'HEAD~1..HEAD'], { cwd, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const filesMatch = diff.match(/(\d+) file/)
    const addMatch = diff.match(/(\d+) insertion/)
    const delMatch = diff.match(/(\d+) deletion/)

    return {
      commits,
      linesAdded: addMatch ? parseInt(addMatch[1]) : 0,
      linesRemoved: delMatch ? parseInt(delMatch[1]) : 0,
      filesChanged: filesMatch ? parseInt(filesMatch[1]) : 0,
    }
  } catch {
    return { commits: 0, linesAdded: 0, linesRemoved: 0, filesChanged: 0 }
  }
}

// ─── Skill registry ─────────────────────────────────────────────────

function buildSkillRegistry(): string {
  const skillsDir = join(homedir(), '.claude', 'skills')
  const skills: Array<{ name: string; desc: string }> = []
  try {
    for (const dir of readdirSync(skillsDir)) {
      const skillFile = join(skillsDir, dir, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      const content = readFileSync(skillFile, 'utf8')
      // Extract description from first "description:" line
      const descMatch = content.match(/description:\s*"?([^"\n]+)/)
      const desc = descMatch ? descMatch[1].slice(0, 120) : ''
      if (desc) skills.push({ name: dir, desc })
    }
  } catch {}
  return skills.map((s) => `- /${s.name}: ${s.desc}`).join('\n')
}

// ─── Project context ────────────────────────────────────────────────

function findProjectContext(projectPath: string): string | null {
  const candidates = [
    join(projectPath, '..', '..'),  // ~/foreman-projects/<name>/
    join(projectPath, '..', '..', '..'),  // ~/foreman-projects/ (if nested deeper)
    join(projectPath, '..'),
    projectPath,
  ]
  for (const dir of candidates) {
    try {
      const files = readdirSync(dir)
      const contextFile = files.find((f: string) =>
        (f.endsWith('.txt') && f.length > 5) ||
        f.endsWith('_master.md') ||
        f === 'context.md' ||
        f === 'SPEC.md',
      )
      if (contextFile) return join(dir, contextFile)
    } catch {}
  }
  return null
}

function ensureClaudeMd(projectPath: string): void {
  const claudeMdPath = join(projectPath, 'CLAUDE.md')
  if (existsSync(claudeMdPath)) return

  const contextFile = findProjectContext(projectPath)
  if (!contextFile) return

  const raw = readFileSync(contextFile, 'utf8').slice(0, 2000)
  const skillRegistry = buildSkillRegistry()

  writeFileSync(claudeMdPath, `# Project Context (auto-generated by Foreman)

## What "production-ready" means for this project

Read the context below and figure out what SHIPPED looks like. Not just working code —
the full product. If it's an API, it should serve requests. If it's research, it should
have reproducible results. If it's a framework, it should have examples and docs.

## Standards

- L7/L8 staff engineer quality. Zero tolerance for slop or bloat.
- Succinctness: fewer lines is better. No over-engineering.
- No mocks: real integration tests only. Mock only external services if absolutely necessary.
- Complete everything fully. No TODOs, no stubs, no placeholders.
- Never ask for permission. Act.
- Conventional commits (feat:, fix:, chore:). Commit frequently.
- Fix every failure you find. Never dismiss anything as "pre-existing."

## Available Skills

You have access to these skills via slash commands. Use them when relevant:

${skillRegistry}

Key skills for production work:
- /bad — browser automation, testing, audits, screenshots, showcases
- /evolve — autonomous improvement toward a measurable goal
- /critical-audit — security and quality audit
- /converge — drive CI to green
- /research — autonomous experiment loop
- /marketing-skills-collection — marketing deliverables (copy, SEO, landing pages)
- /site-clone — clone/migrate websites
- /polish — relentless quality improvement

## Original Design Context

${raw}
`, 'utf8')
}

// ─── Core: spawn ────────────────────────────────────────────────────

export function spawn(projectPath: string, prompt?: string): SessionInfo {
  const name = sessionName(projectPath)

  if (isAlive(name)) {
    return getSessionInfo(name, projectPath)
  }

  mkdirSync(join(FOREMAN_HOME, 'tmp'), { recursive: true })
  mkdirSync(join(FOREMAN_HOME, 'logs'), { recursive: true })

  // Inject project context
  ensureClaudeMd(projectPath)

  // Create tmux session with interactive claude (full TUI, streaming, tool calls)
  tmuxRunQuiet(['new-session', '-d', '-s', name, '-c', projectPath])

  // Capture output to log
  const logFile = join(FOREMAN_HOME, 'logs', `session-${name}.log`)
  tmuxRunQuiet(['pipe-pane', '-t', name, `-o cat >> ${logFile}`])

  // Start interactive claude with --dangerously-skip-permissions
  tmuxRunQuiet(['send-keys', '-t', name, `${CLAUDE_BIN} --dangerously-skip-permissions`, 'Enter'])

  // Wait for claude to initialize (show the > prompt)
  let ready = false
  for (let i = 0; i < 10; i++) {
    try { const p = tmuxRun(['capture-pane', '-t', name, '-p', '-S', '-3']); if (p.includes('>') || p.includes('Claude')) { ready = true; break } } catch {}
    execFileSync('sleep', ['1'], { stdio: 'ignore' })
  }

  // Send the initial prompt by typing it into claude's input
  const actualPrompt = prompt ?? buildPrompt(projectPath, 1)
  sendPrompt(name, actualPrompt)

  return getSessionInfo(name, projectPath)
}

// ─── Core: send ─────────────────────────────────────────────────────

export function send(nameOrProject: string, prompt: string): boolean {
  const name = nameOrProject.startsWith('foreman-') ? nameOrProject : sessionName(nameOrProject)
  if (!isAlive(name)) return false
  return sendPrompt(name, prompt)
}

function sendPrompt(name: string, prompt: string): boolean {
  // Write prompt to temp file, then type it into the interactive claude session
  const promptFile = join(FOREMAN_HOME, 'tmp', `${name}-prompt.txt`)
  writeFileSync(promptFile, prompt, 'utf8')

  // Use tmux load-buffer + paste to send multi-line prompts cleanly
  // Then press Enter to submit to claude
  tmuxRunQuiet(['load-buffer', '-b', 'foreman-prompt', promptFile])
  tmuxRunQuiet(['paste-buffer', '-t', name, '-b', 'foreman-prompt', '-d'])
  return tmuxRunQuiet(['send-keys', '-t', name, '', 'Enter'])
}

function buildPrompt(projectPath: string, round: number): string {
  const stateFile = join(projectPath, '.foreman', 'session-state.md')
  let context = ''
  if (existsSync(stateFile)) {
    context = `Previous session state:\n${readFileSync(stateFile, 'utf8').slice(0, 1500)}\n\n`
  }

  return `${context}You are an autonomous agent. Round ${round}. Full permissions. Do NOT ask — act.

Read CLAUDE.md for what this project is and what "production-ready" means for it.
Read .foreman/session-state.md for what was done in previous rounds.

Your job: MAKE THIS PROJECT REAL. Not just code that compiles — a product someone can use.

Figure out what this project needs to be production-ready. That could be:
- Code: install deps, fix bugs, build features, write tests
- Docs: README with setup instructions, API docs, examples
- Infrastructure: Dockerfile, CI config, deploy scripts
- Quality: run tests, fix failures, add missing coverage
- Research: run experiments, produce results, verify claims
- Whatever else it takes — use bash for everything

After each piece of work, commit with a descriptive message.

Before finishing this round, write .foreman/session-state.md with:
- What you accomplished this round
- Current project state (what works, what doesn't)
- What's left to be production-ready (ordered by priority)
- What requires human action (API keys, DNS, payments, etc.)

Push toward SHIPPED. Not "good enough." SHIPPED.`
}

// ─── Core: status (robot mode) ──────────────────────────────────────

export function status(): SessionInfo[] {
  const sessions: SessionInfo[] = []
  try {
    const out = tmuxRun(['list-sessions', '-F', '#{session_name}:#{session_path}'])
    for (const line of out.trim().split('\n')) {
      if (!line.startsWith('foreman-')) continue
      const [name] = line.split(':')
      const info = getSessionInfo(name)
      sessions.push(info)
    }
  } catch {}
  return sessions
}

function getSessionInfo(name: string, projectPath?: string): SessionInfo {
  const path = projectPath ?? resolveProjectFromSession(name)
  const logFile = join(FOREMAN_HOME, 'logs', `session-${name}.log`)
  const progressFile = join(FOREMAN_HOME, 'logs', `progress-${name}.log`)

  let round = 0
  try {
    const log = readFileSync(logFile, 'utf8')
    const rounds = log.match(/=== Round (\d+)/g)
    if (rounds) round = rounds.length
  } catch {}

  const git = gitStat(path)

  return {
    name,
    project: path.split('/').pop() ?? name,
    projectPath: path,
    alive: isAlive(name),
    round,
    totalCommits: git.commits,
    lastActivity: new Date().toISOString(),
    logFile,
    progressFile,
  }
}

function resolveProjectFromSession(name: string): string {
  try {
    const out = tmuxRun(['display-message', '-t', name, '-p', '#{pane_current_path}'])
    return out.trim()
  } catch {
    return join(homedir(), 'code', name.replace('foreman-', ''))
  }
}

// ─── Core: inspect ──────────────────────────────────────────────────

export function inspect(nameOrProject: string, options?: InspectOptions): string {
  const name = nameOrProject.startsWith('foreman-') ? nameOrProject : sessionName(nameOrProject)
  const lastN = options?.lastN ?? 50

  // Try capture-pane first (live output)
  let output = ''
  try {
    output = tmuxRun(['capture-pane', '-t', name, '-p', '-S', `-${lastN}`])
  } catch {}

  // Fall back to log file
  if (!output.trim()) {
    const logFile = join(FOREMAN_HOME, 'logs', `session-${name}.log`)
    try {
      const log = readFileSync(logFile, 'utf8')
      const lines = log.split('\n')
      output = lines.slice(-lastN).join('\n')
    } catch {}
  }

  // Apply filters
  if (options?.pattern) {
    const regex = new RegExp(options.pattern, 'gi')
    output = output.split('\n').filter((l) => regex.test(l)).join('\n')
  }

  if (options?.codeOnly) {
    const codeBlocks: string[] = []
    const matches = output.matchAll(/```[\s\S]*?```/g)
    for (const m of matches) codeBlocks.push(m[0])
    output = codeBlocks.join('\n\n')
  }

  return output
}

// ─── Core: metrics ──────────────────────────────────────────────────

export function metrics(nameOrProject: string): SessionMetrics {
  const name = nameOrProject.startsWith('foreman-') ? nameOrProject : sessionName(nameOrProject)
  const info = getSessionInfo(name)
  const git = gitStat(info.projectPath)

  // Count test files
  let testsAdded = 0
  try {
    const testFiles = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', 'HEAD~5..HEAD'], {
      cwd: info.projectPath, encoding: 'utf8', timeout: 5_000,
    })
    testsAdded = testFiles.split('\n').filter((f) => f.includes('test') || f.includes('spec')).length
  } catch {}

  return {
    commits: git.commits,
    linesAdded: git.linesAdded,
    linesRemoved: git.linesRemoved,
    filesChanged: git.filesChanged,
    testsAdded,
    rounds: info.round,
  }
}

// ─── Core: detect context exhaustion ────────────────────────────────

export function detectContextExhaustion(nameOrProject: string): boolean {
  const output = inspect(nameOrProject, { lastN: 20, pattern: 'Prompt is too long|context.*limit|max.*token|conversation.*too.*long' })
  return output.trim().length > 0
}

// ─── Core: kill ─────────────────────────────────────────────────────

export function kill(nameOrProject: string): boolean {
  const name = nameOrProject.startsWith('foreman-') ? nameOrProject : sessionName(nameOrProject)
  return tmuxRunQuiet(['kill-session', '-t', name])
}

export function killAll(): number {
  const sessions = status()
  let killed = 0
  for (const s of sessions) {
    if (kill(s.name)) killed++
  }
  return killed
}

// ─── Core: is alive / is idle ───────────────────────────────────────

export function isAlive(nameOrProject: string): boolean {
  const name = nameOrProject.startsWith('foreman-') ? nameOrProject : sessionName(nameOrProject)
  return tmuxRunQuiet(['has-session', '-t', name])
}

/** Check if the session's claude is waiting for input (idle between rounds) */
export function isIdle(nameOrProject: string): boolean {
  const name = nameOrProject.startsWith('foreman-') ? nameOrProject : sessionName(nameOrProject)
  if (!tmuxRunQuiet(['has-session', '-t', name])) return false
  try {
    const output = tmuxRun(['capture-pane', '-t', name, '-p', '-S', '-3']).trim()
    const lastLine = output.split('\n').pop()?.trim() ?? ''
    // Claude interactive prompt ends with > or shows the input cursor
    // Shell prompt ends with $ or #
    // Also detect if claude exited (back to shell)
    return lastLine.endsWith('$') || lastLine.endsWith('#') ||
      lastLine === '>' || lastLine.startsWith('>') ||
      output.includes('Session complete')
  } catch {
    return false
  }
}

/** Send the next round to idle sessions — call from daemon poll cycle */
export function nudgeIdleSessions(): Array<{ name: string; round: number }> {
  const nudged: Array<{ name: string; round: number }> = []
  for (const session of status()) {
    if (!session.alive) continue
    if (!isIdle(session.name)) continue

    const round = session.round + 1
    const prompt = buildPrompt(session.projectPath, round)

    // Check if claude is running (> prompt) or exited ($ prompt)
    let claudeRunning = false
    try {
      const output = tmuxRun(['capture-pane', '-t', session.name, '-p', '-S', '-3']).trim()
      const lastLine = output.split('\n').pop()?.trim() ?? ''
      claudeRunning = !(lastLine.endsWith('$') || lastLine.endsWith('#'))
    } catch {}

    if (!claudeRunning) {
      // Claude exited — restart it first
      tmuxRunQuiet(['send-keys', '-t', session.name, `${CLAUDE_BIN} --dangerously-skip-permissions`, 'Enter'])
      // Wait for claude to initialize
      for (let i = 0; i < 10; i++) {
        try {
          const p = tmuxRun(['capture-pane', '-t', session.name, '-p', '-S', '-3'])
          if (p.includes('>') || p.includes('Claude')) break
        } catch {}
        execFileSync('sleep', ['1'], { stdio: 'ignore' })
      }
    }

    if (sendPrompt(session.name, prompt)) {
      nudged.push({ name: session.name, round })
    }
  }
  return nudged
}

// ─── Multi-round driver ─────────────────────────────────────────────

/**
 * Start a multi-round work session. Spawns claude, waits for it to
 * finish, checks progress, sends follow-up prompt, repeats.
 *
 * Unlike the bash driver script, this runs from Node and can inspect
 * output between rounds to make intelligent decisions.
 */
export async function driveProject(projectPath: string, options?: {
  maxRounds?: number
  onRound?: (round: number, metrics: SessionMetrics) => void
  onComplete?: (metrics: SessionMetrics) => void
}): Promise<SessionMetrics> {
  const maxRounds = options?.maxRounds ?? 20
  const name = sessionName(projectPath)

  // Spawn initial session
  spawn(projectPath)

  for (let round = 1; round <= maxRounds; round++) {
    // Wait for claude to finish (poll tmux pane for shell prompt)
    await waitForCompletion(name, 600_000) // 10 min max per round

    const m = metrics(name)
    options?.onRound?.(round, m)

    // Check for context exhaustion
    if (detectContextExhaustion(name)) {
      // Kill and respawn with fresh context
      kill(name)
      await sleep(2000)
      spawn(projectPath, buildPrompt(projectPath, round + 1))
      continue
    }

    // Check if done
    const stateFile = join(projectPath, '.foreman', 'session-state.md')
    if (existsSync(stateFile)) {
      const state = readFileSync(stateFile, 'utf8').toLowerCase()
      if (state.includes('done') || state.includes('production-ready') || state.includes('complete')) {
        break
      }
    }

    // Send next round
    const nextPrompt = buildPrompt(projectPath, round + 1)
    send(name, nextPrompt)
  }

  const finalMetrics = metrics(name)
  options?.onComplete?.(finalMetrics)
  return finalMetrics
}

async function waitForCompletion(name: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await sleep(10_000) // check every 10s

    if (!isAlive(name)) return // session died

    // Check if the shell prompt is showing (claude finished)
    try {
      const lastLine = tmuxRun(['capture-pane', '-t', name, '-p', '-S', '-1']).trim()
      if (lastLine.endsWith('$') || lastLine.endsWith('#') || lastLine.includes('Session complete')) {
        return
      }
    } catch {}
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Robot mode: JSON status ────────────────────────────────────────

export function robotStatus(): string {
  const sessions = status()
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    sessions: sessions.map((s) => ({
      ...s,
      metrics: metrics(s.name),
      contextExhausted: s.alive ? detectContextExhaustion(s.name) : false,
    })),
    totalSessions: sessions.length,
    aliveSessions: sessions.filter((s) => s.alive).length,
  }, null, 2)
}
