/**
 * Foreman Service
 *
 * Standalone daemon. Manages state, sessions, and events.
 * Never makes policy decisions — only executes them.
 *
 * Start: tsx service/index.ts
 * Default: http://localhost:7374
 */

import http from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'

const execFileAsync = promisify(execFile)

// ─── Skill proposals ─────────────────────────────────────────────────
import { createProposal, listProposals, updateProposalStatus, openProposalPR as openSkillPR } from './lib/skill-proposals.js'

// ─── Dispatch policy ─────────────────────────────────────────────────
import { getDispatchPolicy, initGepaPolicy, type DispatchContext } from './lib/dispatch-policy.js'

// ─── Plan generator ──────────────────────────────────────────────────
import { buildIdeationDispatch, buildFullPlanDispatch, parseIdeationOutput, listPlans, updatePlanStatus, getPlan, openProposalPR as openPlanPR, type PlanGeneratorContext } from './lib/plan-generator.js'

// ─── Claude runner (for digest/analysis until migrated to dispatches) ─
import { callClaudeForJSON } from './lib/claude-runner.js'

// ─── Confidence store (from packages/memory) ─────────────────────────
// Tracks per-(skill, project) confidence that earns autonomy through evidence.
import { ConfidenceStore } from '@drew/foreman-memory/confidence'

// ─── Config ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.FOREMAN_PORT ?? '7374', 10)
const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
const DB_PATH = join(FOREMAN_HOME, 'foreman.db')
const CLAUDE_BIN = process.env.CLAUDE_PATH ?? join(homedir(), '.local/bin/claude')
const ENV = { ...process.env, PATH: `${homedir()}/.local/bin:${process.env.PATH}` }
const WATCHER_INTERVAL_MS = 10_000
const CLAUDE_BOOT_POLL_MS = 3_000
const MAX_DAILY_COST_USD = parseFloat(process.env.FOREMAN_MAX_DAILY_COST ?? '20')
const MAX_CONCURRENT_SESSIONS = parseInt(process.env.FOREMAN_MAX_SESSIONS ?? '5', 10)
const AUTO_MERGE = process.env.FOREMAN_AUTO_MERGE === 'true' // default: false — operator reviews PRs
const CLAUDE_BOOT_TIMEOUT_MS = 60_000

mkdirSync(join(FOREMAN_HOME, 'logs'), { recursive: true })
mkdirSync(join(FOREMAN_HOME, 'worktrees'), { recursive: true })

// ─── Confidence (per-skill, per-project autonomy) ────────────────────

const confidence = new ConfidenceStore(join(FOREMAN_HOME, 'confidence.db'))

// ─── Database ────────────────────────────────────────────────────────

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    workspace_path TEXT,
    workspace_type TEXT NOT NULL DEFAULT 'repo',
    context TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER REFERENCES goals(id),
    skill TEXT NOT NULL,
    task TEXT NOT NULL,
    reasoning TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'dispatched',
    origin TEXT NOT NULL DEFAULT 'operator',
    outcome TEXT,
    learnings TEXT,
    metrics TEXT,
    taste_signal TEXT,
    session_name TEXT,
    worktree_path TEXT,
    worktree_branch TEXT,
    base_branch TEXT,
    template_version INTEGER,
    cost_usd REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    name TEXT PRIMARY KEY,
    goal_id INTEGER REFERENCES goals(id),
    decision_id INTEGER REFERENCES decisions(id),
    work_dir TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting',
    prompt TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_checked_at TEXT,
    last_output TEXT
  );

  CREATE TABLE IF NOT EXISTS taste (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,
    source TEXT,
    weight REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    session_name TEXT,
    goal_id INTEGER,
    data TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS operator_sessions (
    id TEXT PRIMARY KEY,
    harness TEXT NOT NULL,
    repo TEXT,
    timestamp TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    user_messages TEXT,
    skills_used TEXT,
    outcome_signals TEXT,
    scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL,
    template TEXT NOT NULL,
    score REAL,
    dispatches INTEGER NOT NULL DEFAULT 0,
    successes INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT,
    project TEXT,
    weight REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_decisions_goal ON decisions(goal_id);
  CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
`)

// Migrations for existing databases
try { db.exec(`ALTER TABLE decisions ADD COLUMN origin TEXT NOT NULL DEFAULT 'operator'`) } catch {}
try { db.exec(`ALTER TABLE decisions ADD COLUMN base_branch TEXT`) } catch {}
try { db.exec(`ALTER TABLE decisions ADD COLUMN template_version INTEGER`) } catch {}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_operator_sessions_repo ON operator_sessions(repo);
  CREATE INDEX IF NOT EXISTS idx_learnings_type ON learnings(type);
  CREATE INDEX IF NOT EXISTS idx_prompt_templates_active ON prompt_templates(active);

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '[]',
    env TEXT,
    scope TEXT NOT NULL DEFAULT 'global',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// ─── Prepared statements ─────────────────────────────────────────────

const stmts = {
  insertGoal: db.prepare(`INSERT INTO goals (intent, workspace_path, workspace_type, context, priority) VALUES (?, ?, ?, ?, ?)`),
  updateGoal: db.prepare(`UPDATE goals SET status = ?, updated_at = datetime('now') WHERE id = ?`),
  getGoal: db.prepare(`SELECT * FROM goals WHERE id = ?`),
  listGoals: db.prepare(`SELECT * FROM goals WHERE status = 'active' ORDER BY priority DESC, created_at DESC`),

  insertDecision: db.prepare(`INSERT INTO decisions (goal_id, skill, task, reasoning, session_name, worktree_path, worktree_branch, base_branch, template_version, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateDecision: db.prepare(`UPDATE decisions SET status = ?, outcome = ?, learnings = ?, metrics = ?, taste_signal = ?, cost_usd = ?, updated_at = datetime('now') WHERE id = ?`),
  getDecision: db.prepare(`SELECT * FROM decisions WHERE id = ?`),
  listDecisions: db.prepare(`SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?`),
  searchDecisions: db.prepare(`SELECT * FROM decisions WHERE task LIKE ? OR outcome LIKE ? OR learnings LIKE ? OR skill LIKE ? OR session_name LIKE ? OR reasoning LIKE ? ORDER BY created_at DESC LIMIT ?`),
  goalDecisions: db.prepare(`SELECT * FROM decisions WHERE goal_id = ? ORDER BY created_at DESC`),

  insertSession: db.prepare(`INSERT OR REPLACE INTO sessions (name, goal_id, decision_id, work_dir, status, prompt) VALUES (?, ?, ?, ?, 'starting', ?)`),
  updateSession: db.prepare(`UPDATE sessions SET status = ?, last_checked_at = datetime('now'), last_output = ? WHERE name = ?`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE name = ?`),
  listSessions: db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC`),
  activeSessions: db.prepare(`SELECT * FROM sessions WHERE status IN ('starting', 'running', 'idle')`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE name = ?`),

  insertTaste: db.prepare(`INSERT INTO taste (pattern, source, weight) VALUES (?, ?, ?)`),
  listTaste: db.prepare(`SELECT * FROM taste ORDER BY weight DESC, created_at DESC LIMIT ?`),

  insertEvent: db.prepare(`INSERT INTO events (type, session_name, goal_id, data) VALUES (?, ?, ?, ?)`),
  recentEvents: db.prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT ?`),

  // MCP servers
  upsertMcp: db.prepare(`INSERT OR REPLACE INTO mcp_servers (id, name, command, args, env, scope) VALUES (?, ?, ?, ?, ?, ?)`),
  deleteMcp: db.prepare(`DELETE FROM mcp_servers WHERE id = ?`),
  listMcp: db.prepare(`SELECT * FROM mcp_servers ORDER BY name`),
  getMcp: db.prepare(`SELECT * FROM mcp_servers WHERE id = ?`),
  mcpByScope: db.prepare(`SELECT * FROM mcp_servers WHERE scope = ? OR scope = 'global'`),

  // Operator sessions
  upsertOperatorSession: db.prepare(`INSERT OR REPLACE INTO operator_sessions (id, harness, repo, timestamp, message_count, user_messages, skills_used, outcome_signals) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  operatorSessionCount: db.prepare(`SELECT COUNT(*) as count FROM operator_sessions`),
  recentOperatorSessions: db.prepare(`SELECT * FROM operator_sessions WHERE repo = ? ORDER BY timestamp DESC LIMIT ?`),
  latestScanTimestamp: db.prepare(`SELECT MAX(scanned_at) as latest FROM operator_sessions`),

  // Learnings
  insertLearning: db.prepare(`INSERT INTO learnings (type, content, source, project, weight) VALUES (?, ?, ?, ?, ?)`),
  learningsByType: db.prepare(`SELECT * FROM learnings WHERE type = ? ORDER BY weight DESC, created_at DESC LIMIT ?`),
  learningsByProject: db.prepare(`SELECT * FROM learnings WHERE project = ? ORDER BY weight DESC LIMIT ?`),
  allLearnings: db.prepare(`SELECT * FROM learnings ORDER BY weight DESC, created_at DESC LIMIT ?`),

  // Prompt templates
  insertTemplate: db.prepare(`INSERT INTO prompt_templates (version, template, active) VALUES (?, ?, ?)`),
  activeTemplate: db.prepare(`SELECT * FROM prompt_templates WHERE active = 1 ORDER BY version DESC LIMIT 1`),
  updateTemplateScore: db.prepare(`UPDATE prompt_templates SET score = ?, dispatches = ?, successes = ? WHERE id = ?`),
  promoteTemplate: db.prepare(`UPDATE prompt_templates SET active = CASE WHEN id = ? THEN 1 ELSE 0 END`),
  listTemplates: db.prepare(`SELECT * FROM prompt_templates ORDER BY version DESC LIMIT ?`),
}

// ─── Tmux helpers ────────────────────────────────────────────────────

function tmux(args: string[]): string {
  try {
    return execFileSync('tmux', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      env: ENV,
    }) as string
  } catch { return '' }
}

function tmuxQuiet(args: string[]): boolean {
  try {
    execFileSync('tmux', args, { stdio: 'ignore', timeout: 5_000, env: ENV })
    return true
  } catch { return false }
}

function isTmuxAlive(name: string): boolean {
  return tmuxQuiet(['has-session', '-t', name])
}

function captureTmux(name: string, lines: number = 30): string {
  return tmux(['capture-pane', '-t', name, '-p', '-S', `-${lines}`])
}

function detectIdle(name: string): boolean {
  if (!isTmuxAlive(name)) return false
  try {
    const output = captureTmux(name, 3).trim()
    const last = output.split('\n').pop()?.trim() ?? ''
    return last.endsWith('$') || last.endsWith('#') ||
      last === '>' || last.startsWith('>') ||
      output.includes('Session complete')
  } catch { return false }
}

function detectClaudeReady(name: string): boolean {
  try {
    const p = captureTmux(name, 5)
    return p.includes('❯') || p.includes('▐▛')
  } catch { return false }
}

function sessionName(label: string): string {
  return `foreman-${label}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50)
}

// ─── Execution backend interface ─────────────────────────────────────
// Abstraction over where/how sessions run. tmux is the default.
// Cloud backends (Modal, SSH, Docker) plug in here.

interface SpawnRequest {
  name: string
  workDir: string
  prompt: string
  goalId: number
  decisionId: number
  backend?: string    // 'tmux' (default), 'modal', 'ssh', 'docker'
  model?: string      // claude model override: 'opus', 'sonnet', 'haiku'
}

interface ExecutionBackend {
  spawn(req: SpawnRequest): void
  isAlive(name: string): boolean
  isIdle(name: string): boolean
  capture(name: string, lines: number): string
  kill(name: string): void
}

// ─── tmux backend (default) ──────────────────────────────────────────

const pendingPrompts = new Map<string, SpawnRequest>()

const tmuxBackend: ExecutionBackend = {
  spawn(req: SpawnRequest): void {
    const { name, workDir, prompt } = req
    const model = req.model ?? ''
    const modelFlag = model ? ` --model ${model}` : ''

    if (isTmuxAlive(name)) {
      tmuxQuiet(['kill-session', '-t', name])
    }

    // No HOME isolation — it breaks Claude's OAuth keychain auth every time.
    // Worktree provides git isolation. Side effects are acceptable tradeoff
    // vs sessions that can't authenticate.
    tmuxQuiet(['new-session', '-d', '-s', name, '-c', workDir])

    const logFile = join(FOREMAN_HOME, 'logs', `session-${name}.log`)
    mkdirSync(join(FOREMAN_HOME, 'logs'), { recursive: true })
    // pipe-pane captures all tmux pane output to a log file
    tmuxQuiet(['pipe-pane', '-t', name, `-o`, `cat >> "${logFile}"`])

    // Generate MCP config for this session (if any MCP servers are registered)
    const mcpFlag = generateMcpConfig(name)

    tmuxQuiet(['send-keys', '-t', name, `${CLAUDE_BIN} --dangerously-skip-permissions${modelFlag}${mcpFlag}`, 'Enter'])

    pendingPrompts.set(name, req)
    stmts.insertSession.run(name, req.goalId, req.decisionId, workDir, prompt)
    log(`Spawned session ${name} in ${workDir}${model ? ` (model: ${model})` : ''}${mcpFlag ? ' +mcp' : ''}`)
  },

  isAlive: isTmuxAlive,
  isIdle: detectIdle,
  capture: captureTmux,

  kill(name: string): void {
    tmuxQuiet(['kill-session', '-t', name])
  },
}

// ─── MCP config generation ───────────────────────────────────────────
// Generates a temporary MCP config file for a session from registered servers.
// Claude Code loads it via --mcp-config flag.

import { writeFileSync } from 'node:fs'

function generateMcpConfig(sessionName: string): string {
  const servers = stmts.listMcp.all() as Array<{
    id: string, name: string, command: string, args: string, env: string | null
  }>
  if (servers.length === 0) return ''

  const mcpConfig: Record<string, { command: string, args: string[], env?: Record<string, string> }> = {}
  for (const s of servers) {
    mcpConfig[s.id] = {
      command: s.command,
      args: JSON.parse(s.args),
      ...(s.env ? { env: JSON.parse(s.env) } : {}),
    }
  }

  const configPath = join(FOREMAN_HOME, 'mcp', `${sessionName}.json`)
  mkdirSync(join(FOREMAN_HOME, 'mcp'), { recursive: true })
  writeFileSync(configPath, JSON.stringify({ mcpServers: mcpConfig }, null, 2))

  return ` --mcp-config ${configPath}`
}

// ─── Tangle Sandbox backend ──────────────────────────────────────────
// Uses @tangle-network/sandbox SDK for remote container execution.
// Full isolation — each dispatch runs in its own container.
// Sandboxes persist between dispatches (hibernate when idle, wake on demand).

import type {
  SandboxClientConfig,
  CreateSandboxOptions,
  TaskOptions,
  TaskResult,
  BackendConfig,
} from '@tangle-network/sandbox'

// Use import() for the class since it may not be installed
type SandboxClientType = import('@tangle-network/sandbox').SandboxClient
type SandboxInstanceType = import('@tangle-network/sandbox').SandboxInstance

interface TangleSandboxState {
  sandboxId: string
  sessionId?: string
  status: 'creating' | 'running' | 'idle' | 'dead'
}

const tangleSandboxes = new Map<string, TangleSandboxState>()

function getTangleConfig(): SandboxClientConfig {
  const apiKey = process.env.TANGLE_API_KEY
  if (!apiKey) throw new Error('TANGLE_API_KEY required for sandbox backend')
  return { apiKey }
}

async function createTangleClient(): Promise<SandboxClientType> {
  const { Sandbox } = await import('@tangle-network/sandbox')
  return new Sandbox(getTangleConfig())
}

const tangleBackend: ExecutionBackend = {
  spawn(req: SpawnRequest): void {
    tangleSandboxes.set(req.name, { sandboxId: '', status: 'creating' })
    stmts.insertSession.run(req.name, req.goalId, req.decisionId, req.workDir, req.prompt)

    spawnTangleSandbox(req).catch(e => {
      const msg = e instanceof Error ? e.message : String(e)
      log(`Tangle spawn failed for ${req.name}: ${msg}`)
      tangleSandboxes.set(req.name, { sandboxId: '', status: 'dead' })
      stmts.updateSession.run('dead', `spawn failed: ${msg}`, req.name)
      emitEvent('session_died', req.name, req.goalId)
    })

    log(`Tangle sandbox queued for ${req.name}`)
  },

  isAlive(name: string): boolean {
    const state = tangleSandboxes.get(name)
    return !!state && state.status !== 'dead'
  },

  isIdle(name: string): boolean {
    return tangleSandboxes.get(name)?.status === 'idle'
  },

  capture(name: string, _lines: number): string {
    const state = tangleSandboxes.get(name)
    if (!state) return ''
    return `[tangle:${state.sandboxId || 'creating'}] status: ${state.status}`
  },

  kill(name: string): void {
    const state = tangleSandboxes.get(name)
    if (state?.sandboxId) {
      stopTangleSandbox(state.sandboxId).catch(() => {})
    }
    tangleSandboxes.set(name, { ...state!, status: 'dead' })
  },
}

async function spawnTangleSandbox(req: SpawnRequest): Promise<void> {
  const client = await createTangleClient()

  const backendType: BackendConfig['type'] = req.model === 'codex' ? 'codex' : 'claude-code'

  const createOpts: CreateSandboxOptions = {
    name: `foreman-${req.name}`,
    backend: { type: backendType },
    metadata: {
      foremanSession: req.name,
      foremanDecision: String(req.decisionId),
    },
  }

  // If workDir is a URL (git repo), clone it. If local path, skip (sandbox can't access local fs).
  if (req.workDir.startsWith('http') || req.workDir.startsWith('git@')) {
    createOpts.git = { url: req.workDir }
  }

  const sandbox = await client.create(createOpts)
  const sandboxId = sandbox.id

  tangleSandboxes.set(req.name, { sandboxId, status: 'running' })
  stmts.updateSession.run('running', `sandbox:${sandboxId}`, req.name)
  emitEvent('session_started', req.name, req.goalId, { sandboxId })

  // Send the task to the sandbox agent
  const taskOpts: TaskOptions = {
    backend: { type: backendType },
  }
  const result: TaskResult = await sandbox.task(req.prompt, taskOpts)

  const finalStatus: TangleSandboxState['status'] = result.success ? 'idle' : 'dead'
  tangleSandboxes.set(req.name, {
    sandboxId,
    sessionId: result.sessionId,
    status: finalStatus,
  })
  stmts.updateSession.run(
    finalStatus,
    result.response?.slice(0, 500) ?? '',
    req.name,
  )
  emitEvent(result.success ? 'session_idle' : 'session_died', req.name, req.goalId, {
    sandboxId,
    success: result.success,
    sessionId: result.sessionId,
  })

  log(`Tangle sandbox ${sandboxId} ${result.success ? 'completed' : 'failed'} for ${req.name}`)
}

async function stopTangleSandbox(sandboxId: string): Promise<void> {
  try {
    const client = await createTangleClient()
    const sandbox = await client.get(sandboxId)
    if (sandbox) await sandbox.stop()
  } catch (e) {
    log(`Failed to stop sandbox ${sandboxId}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ─── Backend registry ────────────────────────────────────────────────

const backends: Record<string, ExecutionBackend> = {
  tmux: tmuxBackend,
  tangle: tangleBackend,
}

function getBackend(name?: string): ExecutionBackend {
  return backends[name ?? 'tmux'] ?? tmuxBackend
}

function spawnSession(req: SpawnRequest): void {
  getBackend(req.backend).spawn(req)
}

// ─── Model routing ───────────────────────────────────────────────────
// Select the right model for the task. Reduces cost without sacrificing quality.

function selectModel(skill: string, _task: string): string | undefined {
  // Learned patterns (populated from taste/decisions data over time)
  const prefs = stmts.learningsByType.all('skill_preference', 10) as Array<{ content: string }>
  for (const p of prefs) {
    // Check if a preference specifies a model for this skill
    if (p.content.includes(skill) && p.content.includes('opus')) return 'opus'
    if (p.content.includes(skill) && p.content.includes('haiku')) return 'haiku'
    if (p.content.includes(skill) && p.content.includes('sonnet')) return 'sonnet'
  }

  // Default heuristics (can be overridden by learned preferences)
  switch (skill) {
    case '/converge': return 'sonnet'       // CI repair is mechanical
    case '/verify': return 'sonnet'         // validation is straightforward
    case '/polish': return 'sonnet'         // quality iteration
    case '/pursue': return undefined        // generational design — use default (highest available)
    case '/evolve': return undefined        // optimization needs reasoning
    case '/critical-audit': return undefined // security needs depth
    default: return undefined               // use default
  }
}

function sendPrompt(name: string, prompt: string): void {
  const lines = prompt.slice(0, 500).split('\n')
  for (const line of lines) {
    tmuxQuiet(['send-keys', '-t', name, '-l', line])
    tmuxQuiet(['send-keys', '-t', name, 'Enter'])
  }
}

// ─── Session watcher ─────────────────────────────────────────────────

function watcherTick(): void {
  const backend = getBackend() // default backend for now; per-session backend tracking is future work

  // 1. Check pending prompts — send when claude is ready
  for (const [name, req] of pendingPrompts) {
    if (!backend.isAlive(name)) {
      pendingPrompts.delete(name)
      stmts.updateSession.run('dead', '', name)
      emitEvent('session_died', name, req.goalId)
      continue
    }
    if (detectClaudeReady(name)) {
      setTimeout(() => {
        sendPrompt(name, req.prompt)
        stmts.updateSession.run('running', '', name)
        emitEvent('session_started', name, req.goalId)
        log(`Sent prompt to ${name}`)
      }, 2000)
      pendingPrompts.delete(name)
    }
  }

  // 2. Check running sessions for completion
  const active = stmts.activeSessions.all() as Array<{ name: string, status: string, goal_id: number }>
  for (const s of active) {
    if (pendingPrompts.has(s.name)) continue

    if (!backend.isAlive(s.name)) {
      if (s.status !== 'dead') {
        stmts.updateSession.run('dead', '', s.name)
        emitEvent('session_died', s.name, s.goal_id)
        log(`Session ${s.name} died`)
        // Harvest outcome from dead session
        harvestOutcome(s.name, s.goal_id, backend).catch(e => log(`Harvest failed for ${s.name}: ${e}`))
      }
      continue
    }

    const idle = backend.isIdle(s.name)
    const output = backend.capture(s.name, 3).trim().split('\n').pop() ?? ''
    stmts.updateSession.run(idle ? 'idle' : 'running', output, s.name)

    if (idle && s.status === 'running') {
      emitEvent('session_idle', s.name, s.goal_id)
      log(`Session ${s.name} is now idle`)
      // Harvest outcome from completed session
      harvestOutcome(s.name, s.goal_id, backend).catch(e => log(`Harvest failed for ${s.name}: ${e}`))
    }
  }
}

// ─── Auto-outcome harvester ──────────────────────────────────────────
// When a session finishes (idle or dead), read what happened and auto-generate
// an outcome record. This is the critical link that closes the learning loop.

async function harvestOutcome(sessionName: string, goalId: number, backend: ExecutionBackend): Promise<void> {
  // Find the decision for this session
  const decision = db.prepare(`SELECT * FROM decisions WHERE session_name = ? AND status = 'dispatched' ORDER BY created_at DESC LIMIT 1`)
    .get(sessionName) as { id: number, skill: string, task: string, worktree_branch: string | null, base_branch: string | null } | undefined
  if (!decision) return

  const session = stmts.getSession.get(sessionName) as { work_dir: string, status: string } | undefined
  if (!session) return

  const workDir = session.work_dir

  // ── Read session output from LOG FILE (complete) instead of tmux capture (limited)
  const logFile = join(FOREMAN_HOME, 'logs', `session-${sessionName}.log`)
  let output = ''
  try {
    if (existsSync(logFile)) {
      const full = readFileSync(logFile, 'utf8')
      // Take last 5000 chars — enough for cost, test results, commit messages
      output = full.slice(-5000)
    }
  } catch {}
  // Fallback to tmux capture if log file empty
  if (!output && backend.isAlive(sessionName)) {
    output = backend.capture(sessionName, 80)
  }

  // ── Count ONLY the session's commits (diff from base branch, not all history)
  let commits = 0
  let gitLog = ''
  let hasPR = false
  let testsPassed: boolean | null = null

  const baseBranch = decision.base_branch
  const worktreeBranch = decision.worktree_branch

  try {
    // Use merge-base to find the exact branch point, then count from there
    if (baseBranch) {
      const { stdout: mergeBase } = await execFileAsync('git', ['merge-base', baseBranch, 'HEAD'], { cwd: workDir, timeout: 5_000 })
      const { stdout } = await execFileAsync('git', ['log', '--oneline', `${mergeBase.trim()}..HEAD`], { cwd: workDir, timeout: 5_000 })
      const lines = stdout.trim().split('\n').filter(Boolean)
      commits = lines.length
      gitLog = lines.slice(0, 5).join('\n')
    } else {
      // No base branch — count commits on HEAD not on any remote
      const { stdout } = await execFileAsync('git', ['log', '--oneline', '-10'], { cwd: workDir, timeout: 5_000 })
      const lines = stdout.trim().split('\n').filter(Boolean)
      commits = lines.length
      gitLog = lines.slice(0, 5).join('\n')
    }
  } catch {}

  // ── Check if THIS session's branch has a PR (not any PR in the repo)
  if (worktreeBranch) {
    try {
      const { stdout } = await execFileAsync('gh', ['pr', 'list', '--head', worktreeBranch, '--json', 'title,url', '--limit', '1'], { cwd: workDir, timeout: 10_000 })
      const prs = JSON.parse(stdout)
      if (prs.length > 0) hasPR = true
    } catch {}
  }

  // Detect test results from output
  if (output.includes('tests pass') || output.includes('✅') || output.includes('All tests passed') || output.includes('✓ pass')) {
    testsPassed = true
  } else if (output.includes('FAIL') || output.includes('❌') || output.includes('tests fail') || output.includes('✗ fail')) {
    testsPassed = false
  }

  // ── Parse cost from session log (Claude Code prints "Total cost: $X.XX" or similar)
  let costUsd: number | null = null
  // Try multiple patterns Claude Code uses
  const costPatterns = [
    /Total cost:\s*\$(\d+\.?\d*)/i,
    /Cost:\s*\$(\d+\.?\d*)/i,
    /\$(\d+\.\d{2,})\s*total/i,
    /(\d+\.\d{2,})\s*USD/i,
    // Claude Code API mode: "Input: X tokens, Output: Y tokens, Cost: $Z"
    /(?:cost|spent|billed)[:\s]*\$?(\d+\.?\d*)/i,
  ]
  for (const pattern of costPatterns) {
    const match = output.match(pattern)
    if (match) { costUsd = parseFloat(match[1]); break }
  }

  // Determine success — sessions with 0 commits but no errors are "completed" not "failed"
  const hasErrors = output.includes('Error:') || output.includes('FAIL') || output.includes('fatal:')
  const status = commits > 0 && !hasErrors ? 'success'
    : commits > 0 && hasErrors ? 'success' // commits + errors = partial success (still made progress)
    : hasErrors ? 'failure'
    : 'success' // no commits, no errors = completed successfully (e.g. verification task)

  // Generate outcome text
  const outcomeParts: string[] = []
  if (commits > 0) outcomeParts.push(`${commits} commits`)
  if (hasPR) outcomeParts.push('PR created')
  if (testsPassed === true) outcomeParts.push('tests passing')
  if (testsPassed === false) outcomeParts.push('tests failing')
  if (hasErrors) outcomeParts.push('errors detected')
  if (costUsd) outcomeParts.push(`$${costUsd.toFixed(2)}`)
  const outcomeText = outcomeParts.length > 0 ? outcomeParts.join(', ') : 'session completed'

  // Extract learnings from output (commit messages, key results)
  const learnings: string[] = []
  const outputLines = output.split('\n').slice(-40)
  for (const line of outputLines) {
    const clean = line.replace(/[\x00-\x1f\x7f]/g, '').trim()
    if (clean.length < 15 || clean.length > 200) continue
    if (clean.match(/^(feat|fix|chore|refactor|test|docs)(\(.*?\))?:/) ||
        clean.includes('✅') || clean.includes('improved') || clean.includes('fixed')) {
      learnings.push(clean)
    }
  }

  // Snapshot evolve state BEFORE it gets overwritten by the next dispatch.
  // Extract scores, trajectory, and experiment learnings from files that
  // will be replaced. Save to the learnings table so the knowledge persists.
  try {
    const evolveFile = join(workDir, 'evolve-progress.md')
    if (existsSync(evolveFile)) {
      const evolveContent = readFileSync(evolveFile, 'utf8')
      // Extract score from "Score: X.XX → target Y.YY"
      const scoreMatch = evolveContent.match(/Score:\s*([\d.]+)\s*→\s*target\s*([\d.]+)/i)
      if (scoreMatch) {
        learnings.push(`evolve-snapshot: score ${scoreMatch[1]} (target ${scoreMatch[2]})`)
      }
      // Extract round info
      const roundMatch = evolveContent.match(/Round\s*(\d+)/i)
      if (roundMatch) {
        learnings.push(`evolve-snapshot: round ${roundMatch[1]}`)
      }
    }

    const expFile = join(workDir, '.evolve', 'experiments.jsonl')
    if (existsSync(expFile)) {
      const expLines = readFileSync(expFile, 'utf8').trim().split('\n').filter(Boolean)
      // Extract the latest experiment's learnings
      for (const line of expLines.slice(-3)) {
        try {
          const exp = JSON.parse(line)
          if (exp.learnings) {
            for (const l of exp.learnings.slice(0, 2)) {
              const key = `exp-learning: ${String(l).slice(0, 150)}`
              if (!learnings.includes(key)) learnings.push(key)
            }
          }
          if (exp.verdict && exp.hypothesis) {
            learnings.push(`exp-result: ${exp.verdict} — ${exp.hypothesis.slice(0, 100)}`)
          }
        } catch {}
      }
    }
  } catch {}

  // Store the outcome
  stmts.updateDecision.run(
    status,
    outcomeText,
    learnings.length > 0 ? JSON.stringify(learnings) : null,
    JSON.stringify({ commits, hasPR, testsPassed, gitLog }),
    null, // taste_signal — operator sets this
    costUsd,
    decision.id,
  )

  log(`Auto-harvested outcome for ${sessionName}: ${outcomeText}`)
  emitEvent('outcome_harvested', sessionName, goalId, { decisionId: decision.id, status, commits })

  // Ensure work is pushed and a PR exists — the operator reviews via PR, not worktree diffs.
  if (commits > 0 && worktreeBranch && baseBranch) {
    const prUrl = await ensurePushAndPR(workDir, worktreeBranch, baseBranch, decision.skill, decision.task)
    if (prUrl) log(`PR created/found: ${prUrl}`)
  }

  // Run post-completion pipeline (sub-agents that analyze the session)
  const digest = await runPostCompletionPipeline(decision.id, sessionName, decision.skill, decision.task, workDir, output, status, outcomeText)

  // If pipeline produced a richer outcome, update the decision
  if (digest.summary) {
    db.prepare(`UPDATE decisions SET outcome = ?, learnings = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(digest.summary.slice(0, 2000), digest.learnings ? JSON.stringify(digest.learnings) : null, decision.id)
  }

  // Send notification with enriched summary
  const notifyText = digest.summary ?? outcomeText
  sendNotification(`Foreman: ${sessionName}`, `${decision.skill} → ${notifyText.slice(0, 200)}`)

  // Update confidence for this (skill, project)
  // Use the GOAL's workspace path (the real repo), not the worktree path.
  // This way all dispatches on the same project accumulate confidence together.
  let projectName = workDir.split('/').pop() ?? workDir
  if (goalId) {
    const goal = stmts.getGoal.get(goalId) as { workspace_path?: string } | undefined
    if (goal?.workspace_path) projectName = goal.workspace_path.split('/').pop() ?? projectName
  }
  // Use pipeline's quality score if available, otherwise fall back to binary
  const confSignal = (digest.qualityScore ?? 0) >= 7 ? 'success' as const
    : status === 'success' ? 'success' as const : 'failure' as const
  confidence.update(decision.skill || 'direct', projectName, confSignal)
  const newLevel = confidence.getLevel(decision.skill || 'direct', projectName)
  log(`Confidence: ${decision.skill || 'direct'}@${projectName} → ${newLevel} (${confSignal})`)

  // Trigger immediate learning from this outcome
  const enrichedLearnings = digest.learnings ?? learnings
  updateLearningsFromOutcome(decision.id, decision.skill, decision.task, status, digest.summary ?? outcomeText, enrichedLearnings)

  // Auto-dispatch next work — use pipeline's recommended next action if available
  if (digest.nextAction) {
    log(`Pipeline recommends: ${digest.nextAction.skill} — ${digest.nextAction.task.slice(0, 80)}`)
  }
  maybeAutoDispatch(decision.skill, projectName, goalId).catch(e => log(`Auto-dispatch failed: ${e}`))
}

// ─── Ensure push + PR ────────────────────────────────────────────────
// After a session with commits, guarantee the branch is pushed and a PR exists.
// The operator reviews all Foreman work via PRs — this is the safety gate.

async function ensurePushAndPR(workDir: string, branch: string, baseBranch: string, skill: string, task: string): Promise<string | null> {
  // Push the branch
  try {
    await execFileAsync('git', ['push', '-u', 'origin', branch], { cwd: workDir, timeout: 30_000 })
  } catch (e) {
    // Push might fail if remote doesn't exist or branch already pushed
    log(`Push failed for ${branch}: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Check if a PR already exists for this branch
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'list', '--head', branch, '--json', 'url', '--limit', '1'], { cwd: workDir, timeout: 10_000 })
    const prs = JSON.parse(stdout)
    if (prs.length > 0) return prs[0].url // PR already exists
  } catch {}

  // Create PR
  try {
    const title = `foreman: ${skill || 'work'} — ${task.slice(0, 60)}`
    const body = `Automated Foreman dispatch.\n\nSkill: ${skill || 'direct'}\nTask: ${task.slice(0, 200)}\n\n---\n*This PR was created by Foreman. Review the changes before merging.*`

    const { stdout } = await execFileAsync('gh', [
      'pr', 'create',
      '--base', baseBranch,
      '--head', branch,
      '--title', title.slice(0, 100),
      '--body', body,
    ], { cwd: workDir, timeout: 15_000 })

    const url = stdout.trim()
    log(`Created PR: ${url}`)

    // Auto-merge if flag is set AND confidence is autonomous (0.8+)
    if (AUTO_MERGE) {
      const projectName = workDir.split('/').pop() ?? ''
      const confLevel = confidence.getLevel(skill || 'direct', projectName)
      if (confLevel === 'autonomous') {
        try {
          await execFileAsync('gh', ['pr', 'merge', url, '--squash', '--auto'], { cwd: workDir, timeout: 15_000 })
          log(`Auto-merged PR: ${url} (confidence: autonomous)`)
        } catch (e) {
          log(`Auto-merge failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      } else {
        log(`Auto-merge skipped: confidence is ${confLevel}, need autonomous (0.8+)`)
      }
    }

    return url
  } catch (e) {
    log(`PR creation failed for ${branch}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

// ─── Post-completion pipeline ─────────────────────────────────────────
// After a session completes, run sub-agents to analyze what happened.
// Each agent in the pipeline produces structured output that enriches
// the outcome record. Foreman gets a rich digest instead of raw git stats.
//
// Pluggable: Identity (passthrough), Digest (LLM summary), Full (audit + plan).
// Controlled by FOREMAN_POST_COMPLETION env var: 'identity' | 'digest' | 'full'
//
// The digest is stored on the decision. If Foreman needs more detail,
// it can read the full session log at ~/.foreman/logs/session-*.log

const POST_COMPLETION_STRATEGY = process.env.FOREMAN_POST_COMPLETION ?? 'digest'

interface PostCompletionDigest {
  summary: string | null          // human-readable summary of what the session did
  qualityScore: number | null     // 1-10 quality assessment
  goalAchieved: boolean | null    // did the session achieve its stated goal?
  learnings: string[] | null      // extracted learnings for future dispatches
  nextAction: { skill: string, task: string } | null  // recommended next dispatch
  fullLogPath: string | null      // path to full session log if Foreman needs more
}

interface PostCompletionAgent {
  name: string
  run(ctx: {
    decisionId: number
    sessionName: string
    skill: string
    task: string
    workDir: string
    output: string           // last ~5000 chars of session output
    status: string
    outcomeText: string
  }): Promise<Partial<PostCompletionDigest>>
}

// Identity: returns nothing, passthrough
const identityPostAgent: PostCompletionAgent = {
  name: 'identity',
  async run() { return {} },
}

// Digest: dispatches Claude to summarize the session, assess quality, recommend next steps
const digestPostAgent: PostCompletionAgent = {
  name: 'digest',
  async run(ctx) {
    // Read git diff from worktree for richer context
    let gitDiff = ''
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD~5..HEAD'], { cwd: ctx.workDir, timeout: 5_000 })
      gitDiff = stdout.trim().slice(0, 1000)
    } catch {}

    const prompt = `You are a post-completion reviewer for an autonomous coding agent session.

Session: ${ctx.sessionName}
Skill: ${ctx.skill}
Task: ${ctx.task}
Status: ${ctx.status}
Outcome: ${ctx.outcomeText}

${gitDiff ? `Git diff stat:\n${gitDiff}\n` : ''}
Session output (last portion):
${ctx.output.slice(-3000)}

Analyze this session and respond with JSON only:
{
  "summary": "2-3 sentence summary of what was accomplished",
  "qualityScore": 1-10,
  "goalAchieved": true/false,
  "learnings": ["specific reusable insight 1", "insight 2"],
  "nextAction": {"skill": "/skill-name", "task": "specific next task"} or null
}`

    try {
      const parsed = await callClaudeForJSON(prompt) as any
      if (!parsed) return {}
      return {
        summary: parsed.summary ?? null,
        qualityScore: typeof parsed.qualityScore === 'number' ? parsed.qualityScore : null,
        goalAchieved: typeof parsed.goalAchieved === 'boolean' ? parsed.goalAchieved : null,
        learnings: Array.isArray(parsed.learnings) ? parsed.learnings.map(String) : null,
        nextAction: parsed.nextAction?.skill ? parsed.nextAction : null,
      }
    } catch (e) {
      log(`Digest agent failed: ${e instanceof Error ? e.message : String(e)}`)
      return {}
    }
  },
}

// Full: runs digest + audit + plan as separate sub-agents, merges results
const fullPostAgent: PostCompletionAgent = {
  name: 'full',
  async run(ctx) {
    // Run digest first
    const digest = await digestPostAgent.run(ctx)

    // Then run an audit sub-agent that checks for issues
    let auditFindings: string[] = []
    try {
      const auditPrompt = `Review this completed coding session for quality issues.

Task: ${ctx.task}
Output (last portion):
${ctx.output.slice(-2000)}

List specific issues found (security, correctness, style). Respond with JSON:
{"issues": ["issue 1", "issue 2"]}
If no issues, return {"issues": []}`

      const auditResult = await callClaudeForJSON(auditPrompt) as any
      if (auditResult?.issues) {
        auditFindings = Array.isArray(auditResult.issues) ? auditResult.issues.map(String) : []
      }
    } catch {}

    // Merge: lower quality score if audit found issues
    const adjustedScore = auditFindings.length > 0
      ? Math.max(1, (digest.qualityScore ?? 7) - auditFindings.length)
      : digest.qualityScore

    const enrichedLearnings = [
      ...(digest.learnings ?? []),
      ...auditFindings.map(f => `AUDIT: ${f}`),
    ]

    return {
      ...digest,
      qualityScore: adjustedScore,
      learnings: enrichedLearnings.length > 0 ? enrichedLearnings : null,
      summary: digest.summary
        ? `${digest.summary}${auditFindings.length > 0 ? ` (${auditFindings.length} audit findings)` : ''}`
        : null,
    }
  },
}

const postCompletionAgents: Record<string, PostCompletionAgent> = {
  identity: identityPostAgent,
  digest: digestPostAgent,
  full: fullPostAgent,
}

async function runPostCompletionPipeline(
  decisionId: number, sessionName: string, skill: string, task: string,
  workDir: string, output: string, status: string, outcomeText: string,
): Promise<PostCompletionDigest> {
  const agent = postCompletionAgents[POST_COMPLETION_STRATEGY] ?? identityPostAgent
  const logPath = join(FOREMAN_HOME, 'logs', `session-${sessionName}.log`)

  if (agent.name === 'identity') {
    return {
      summary: null, qualityScore: null, goalAchieved: null,
      learnings: null, nextAction: null, fullLogPath: existsSync(logPath) ? logPath : null,
    }
  }

  log(`Post-completion: running ${agent.name} agent on ${sessionName}`)
  const startMs = Date.now()

  const result = await agent.run({ decisionId, sessionName, skill, task, workDir, output, status, outcomeText })
  const elapsed = Date.now() - startMs

  log(`Post-completion: ${agent.name} completed in ${(elapsed / 1000).toFixed(1)}s` +
    (result.qualityScore ? ` quality=${result.qualityScore}/10` : '') +
    (result.goalAchieved !== null ? ` goal=${result.goalAchieved}` : ''))

  return {
    summary: result.summary ?? null,
    qualityScore: result.qualityScore ?? null,
    goalAchieved: result.goalAchieved ?? null,
    learnings: result.learnings ?? null,
    nextAction: result.nextAction ?? null,
    fullLogPath: existsSync(logPath) ? logPath : null,
  }
}

// ─── Outcome-driven learning ─────────────────────────────────────────

function updateLearningsFromOutcome(
  decisionId: number, skill: string, task: string,
  status: string, outcome: string, learnings: string[],
): void {
  // Record successful patterns
  if (status === 'success' && learnings.length > 0) {
    for (const l of learnings.slice(0, 3)) {
      const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'dispatch_success'`).get(l.slice(0, 200))
      if (!exists) {
        stmts.insertLearning.run('dispatch_success', l.slice(0, 500), `decision:${decisionId}`, null, 1.5)
      }
    }
  }

  // Record failures as dead ends
  if (status === 'failure') {
    const key = `FAIL: ${skill} "${task.slice(0, 80)}" → ${outcome.slice(0, 100)}`
    const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'dead_end'`).get(key.slice(0, 200))
    if (!exists) {
      stmts.insertLearning.run('dead_end', key.slice(0, 500), `decision:${decisionId}`, null, -1.0)
    }
  }

  // Update prompt template score — per-template, not global
  // Each decision tracks which template_version it used
  const templates = stmts.listTemplates.all(10) as Array<{ id: number, version: number }>
  for (const t of templates) {
    const total = (db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE template_version = ? AND status IN ('success','failure')`).get(t.version) as { c: number }).c
    const success = (db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE template_version = ? AND status = 'success'`).get(t.version) as { c: number }).c
    if (total > 0) {
      stmts.updateTemplateScore.run(success / total, total, success, t.id)
    }
  }

  // Check if we have enough data to consider generating a GEPA variant
  const activeTemplate = stmts.activeTemplate.get() as { id: number, version: number, dispatches: number, score: number | null } | undefined
  if (activeTemplate && activeTemplate.dispatches >= 5 && !gepaRunning) {
    const untestedVariant = db.prepare(`SELECT id FROM prompt_templates WHERE active = 0 AND dispatches < 3`).get()
    if (!untestedVariant) {
      triggerGepaVariant(activeTemplate.version, activeTemplate.score ?? 0).catch(e => log(`GEPA variant failed: ${e}`))
    }
  }

  // Cross-project confidence transfer (Hyperagents-inspired)
  // When a skill succeeds on project A, give a small boost to the same skill
  // on all other known projects. This is how meta-level improvements transfer.
  if (status === 'success' && skill) {
    const allEntries = confidence.list()
    const otherProjects = new Set(allEntries.map(e => e.project))
    // Find the project this decision was on
    const thisDecision = db.prepare(`SELECT base_branch, worktree_path FROM decisions WHERE id = ?`).get(decisionId) as { base_branch?: string, worktree_path?: string } | undefined
    const thisProject = thisDecision?.worktree_path?.split('/').pop() ?? ''
    for (const otherProject of otherProjects) {
      if (otherProject === thisProject) continue
      // Only transfer if the same skill exists on the other project
      const existing = confidence.getConfidence(skill, otherProject)
      if (existing > 0) {
        confidence.update(skill, otherProject, 'transfer')
      }
    }
  }
}

// ─── Confidence-gated auto-dispatch ──────────────────────────────────
// When a session completes successfully and confidence is high enough,
// automatically dispatch the next highest-value work on that project.
// Safety rails: cost cap + concurrent session limit.

async function maybeAutoDispatch(skill: string, project: string, goalId: number): Promise<void> {
  const level = confidence.getLevel(skill || 'direct', project)

  // Only auto-dispatch at act-notify (0.6+) or autonomous (0.8+)
  if (level === 'dry-run' || level === 'propose') return

  // Safety rail: check daily cost
  const today = new Date().toISOString().slice(0, 10)
  const dailyCost = (db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) as total FROM decisions WHERE date(created_at) = ?`).get(today) as { total: number }).total
  if (dailyCost >= MAX_DAILY_COST_USD) {
    log(`Auto-dispatch blocked: daily cost $${dailyCost.toFixed(2)} >= $${MAX_DAILY_COST_USD} cap`)
    return
  }

  // Safety rail: check concurrent sessions
  const activeSessions = stmts.activeSessions.all() as Array<{ name: string }>
  if (activeSessions.length >= MAX_CONCURRENT_SESSIONS) {
    log(`Auto-dispatch blocked: ${activeSessions.length} sessions >= ${MAX_CONCURRENT_SESSIONS} cap`)
    return
  }

  // Find the goal to continue working on
  const goal = goalId ? stmts.getGoal.get(goalId) as { id: number, intent: string, workspace_path: string | null } | undefined : undefined
  if (!goal?.workspace_path) return

  // Use the learned dispatch policy to decide what to do next
  const lastDecisions = stmts.goalDecisions.all(goal.id) as Array<{ skill: string, status: string, outcome: string | null }>
  if (!lastDecisions.some(d => d.status === 'success')) return

  const flows = stmts.learningsByType.all('flow', 10) as Array<{ content: string }>
  const skillPrefs = stmts.learningsByType.all('skill_preference', 10) as Array<{ content: string }>

  const ctx: DispatchContext = {
    goalIntent: goal.intent,
    projectName: project,
    recentDecisions: lastDecisions.slice(0, 5).map(d => ({
      skill: d.skill, status: d.status, outcome: d.outcome,
    })),
    learnedFlows: flows.map(f => f.content),
    skillPreferences: skillPrefs.map(p => p.content),
    confidenceLevel: level,
  }

  const policy = getDispatchPolicy()
  const decision = await policy.decide(ctx)
  const nextSkill = decision.skill
  const nextTask = decision.task

  log(`Dispatch policy (${policy.name}): ${nextSkill} — ${decision.reasoning.slice(0, 80)}`)

  log(`Auto-dispatching: ${nextSkill} on ${project} (confidence: ${level})`)
  sendNotification('Foreman: Auto-dispatch', `${nextSkill} on ${project} (${level})`)

  // Dispatch through the internal function (not the API — avoid HTTP overhead)
  const repoDir = goal.workspace_path
  const autoLabel = `auto-${nextSkill.replace(/^\//, '')}-${Date.now().toString(36)}`
  const wt = await createWorktree(repoDir, autoLabel)
  if (!wt) return

  const sName = sessionName(autoLabel)
  const activeTpl = stmts.activeTemplate.get() as { version: number } | undefined
  const result = stmts.insertDecision.run(
    goal.id, nextSkill, nextTask, `auto-dispatch: confidence ${level}`,
    sName, wt.path, wt.branch, wt.baseBranch, activeTpl?.version ?? 1, 'auto',
  )
  const decisionId = Number(result.lastInsertRowid)

  const prompt = composePrompt({
    skill: nextSkill,
    task: nextTask,
    workDir: wt.path,
    goalIntent: goal.intent,
    goalId: goal.id,
    worktreeBranch: wt.branch,
    baseBranch: wt.baseBranch,
    repoDir,
  })

  const model = selectModel(nextSkill, nextTask)
  spawnSession({ name: sName, workDir: wt.path, prompt, goalId: goal.id, decisionId, model: model ?? undefined })

  emitEvent('auto_dispatched', sName, goal.id, { skill: nextSkill, confidence: level })
}

// ─── Prompt Optimizer Interface ──────────────────────────────────────
// Pluggable optimization strategy for prompt templates.
// Identity: passthrough, no optimization (default when disabled).
// AxGEPA: real multi-objective Pareto optimization from @ax-llm/ax.
// Controlled by FOREMAN_OPTIMIZER env var: 'identity' | 'gepa' (default: 'identity')

const OPTIMIZER_STRATEGY = process.env.FOREMAN_OPTIMIZER ?? 'identity'

interface PromptOptimizerResult {
  variant: string | null  // new template suggestion, null if no change
  score?: number
}

interface PromptOptimizer {
  name: string
  optimize(data: {
    currentVersion: number
    currentScore: number
    trainExamples: Array<{ task: string, prompt: string, outcome: string, success: boolean }>
  }): Promise<PromptOptimizerResult>
}

// Identity optimizer: does nothing, returns null. Use when you want data collection without optimization.
const identityOptimizer: PromptOptimizer = {
  name: 'identity',
  async optimize() {
    return { variant: null }
  },
}

// AxGEPA optimizer: uses @ax-llm/ax for real multi-objective prompt evolution.
const axGepaOptimizer: PromptOptimizer = {
  name: 'gepa',
  async optimize(data) {
    const axLib: any = await import('@ax-llm/ax')
    const { ai, ax, AxGEPA } = axLib

    // Student: cost-effective model for running prompts
    const studentAI = ai({ name: 'anthropic', config: { model: 'claude-sonnet-4-6' as any } })
    // Teacher: strong model for reflecting and generating better prompts
    const teacherAI = ai({ name: 'anthropic', config: { model: 'claude-opus-4-6' as any } })

    // The generator represents our prompt template as a tunable surface.
    // GEPA will optimize its instruction (the meta-prompt that guides composition).
    const promptGenerator = ax(
      'task:string, projectContext:string -> composedPrompt:string "A rich, context-loaded prompt for a Claude Code session that will accomplish the task"',
    )
    promptGenerator.setInstruction(
      `You compose dispatch prompts for autonomous coding sessions. Include: task description, quality standards, git workflow, project context, past decisions, learned patterns, and dead ends to avoid. Be specific and actionable.`
    )

    // Build training examples from our dispatch history
    const train = data.trainExamples.slice(0, 8).map(e => ({
      task: e.task.slice(0, 200),
      projectContext: 'project context available',
      composedPrompt: e.prompt.slice(0, 500),
    }))

    const validation = data.trainExamples.slice(8, 12).map(e => ({
      task: e.task.slice(0, 200),
      projectContext: 'project context available',
      composedPrompt: e.prompt.slice(0, 500),
    }))

    if (train.length < 3 || validation.length < 1) {
      log('AxGEPA: not enough data (need 3+ train, 1+ validation)')
      return { variant: null }
    }

    // Metric: did the dispatch succeed?
    const successMap = new Map(data.trainExamples.map(e => [e.task.slice(0, 200), e.success]))
    const metric = ({ prediction, example }: { prediction: any, example: any }) => {
      // Score based on whether similar tasks succeeded
      const taskSuccess = successMap.get(example.task) ? 1 : 0
      // Also score on prompt specificity (longer, more specific = better)
      const specificity = typeof prediction?.composedPrompt === 'string'
        ? Math.min(1, prediction.composedPrompt.length / 500)
        : 0
      return { taskSuccess, specificity }
    }

    const optimizer = new AxGEPA({
      studentAI,
      teacherAI,
      numTrials: 6,
      minibatch: true,
      minibatchSize: 3,
      earlyStoppingTrials: 3,
      sampleCount: 1,
    })

    try {
      const result = await optimizer.compile(promptGenerator, train, metric, {
        validationExamples: validation,
        maxMetricCalls: 60,
      })

      // Extract the optimized instruction
      const prog = result.optimizedProgram as any
      const optimizedInstruction = prog?.instruction
        ?? (prog?.instructionMap ? Object.values(prog.instructionMap)[0] : null)

      if (optimizedInstruction) {
        log(`AxGEPA: optimized instruction (score: ${result.bestScore})`)
        return {
          variant: String(optimizedInstruction),
          score: typeof result.bestScore === 'number' ? result.bestScore : undefined,
        }
      }

      // Check Pareto front for best candidate
      if (result.paretoFront?.length > 0) {
        const best = result.paretoFront[0] as any
        const instruction = best.configuration?.instruction
          ?? (best.configuration?.instructionMap ? Object.values(best.configuration.instructionMap)[0] : null)
        if (instruction) {
          log(`AxGEPA: Pareto front candidate (scores: ${JSON.stringify(best.scores)})`)
          return { variant: String(instruction) }
        }
      }

      return { variant: null }
    } catch (e) {
      log(`AxGEPA optimization failed: ${e instanceof Error ? e.message : String(e)}`)
      return { variant: null }
    }
  },
}

const optimizers: Record<string, PromptOptimizer> = {
  identity: identityOptimizer,
  gepa: axGepaOptimizer,
}

function getOptimizer(): PromptOptimizer {
  return optimizers[OPTIMIZER_STRATEGY] ?? identityOptimizer
}

// ─── Template evolution (uses optimizer interface) ───────────────────

let gepaRunning = false

async function triggerGepaVariant(currentVersion: number, currentScore: number): Promise<void> {
  if (gepaRunning) return

  const optimizer = getOptimizer()
  if (optimizer.name === 'identity') {
    // Identity optimizer: no-op, just log
    log(`Optimizer: identity (set FOREMAN_OPTIMIZER=gepa to enable AxGEPA)`)
    return
  }

  gepaRunning = true

  try {
    // Gather (task, prompt, outcome, success) pairs from decisions + sessions
    const examples = db.prepare(`
      SELECT d.task, d.status, d.outcome, s.prompt
      FROM decisions d
      LEFT JOIN sessions s ON s.decision_id = d.id
      WHERE d.status IN ('success', 'failure') AND s.prompt IS NOT NULL
      ORDER BY d.created_at DESC LIMIT 12
    `).all() as Array<{ task: string, status: string, outcome: string | null, prompt: string | null }>

    const trainExamples = examples
      .filter(e => e.prompt)
      .map(e => ({
        task: e.task,
        prompt: e.prompt!,
        outcome: e.outcome ?? '',
        success: e.status === 'success',
      }))

    if (trainExamples.length < 4) {
      log(`Optimizer: need 4+ scored dispatches with prompts (have ${trainExamples.length})`)
      gepaRunning = false
      return
    }

    const result = await optimizer.optimize({
      currentVersion,
      currentScore,
      trainExamples,
    })

    if (result.variant) {
      const newVersion = currentVersion + 1
      stmts.insertTemplate.run(newVersion, result.variant.slice(0, 2000), 0)
      log(`${optimizer.name}: generated template v${newVersion}${result.score ? ` (score: ${result.score})` : ''}`)
      promoteTemplateIfBetter()
    } else {
      log(`${optimizer.name}: no variant generated (insufficient signal or no improvement found)`)
    }
  } catch (e) {
    log(`${optimizer.name} failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    gepaRunning = false
  }
}

function promoteTemplateIfBetter(): void {
  const templates = stmts.listTemplates.all(10) as Array<{
    id: number, version: number, score: number | null, dispatches: number, active: number
  }>

  const scored = templates.filter(t => t.dispatches >= 3 && t.score !== null)
  if (scored.length < 2) return

  const best = scored.reduce((a, b) => (a.score ?? 0) > (b.score ?? 0) ? a : b)
  const active = templates.find(t => t.active === 1)

  if (active && best.id !== active.id && (best.score ?? 0) > (active.score ?? 0)) {
    db.prepare(`UPDATE prompt_templates SET active = 0`).run()
    db.prepare(`UPDATE prompt_templates SET active = 1 WHERE id = ?`).run(best.id)
    log(`Promoted template v${best.version} (${Math.round((best.score ?? 0) * 100)}%) over v${active.version} (${Math.round((active.score ?? 0) * 100)}%)`)
    emitEvent('template_promoted', null, null, { version: best.version, score: best.score })
  }
}

// ─── Desktop notifications ───────────────────────────────────────────

function sendNotification(title: string, body: string): void {
  try {
    execFileSync('notify-send', [title, body, '--app-name=Foreman', '--urgency=normal'], { stdio: 'ignore', timeout: 3_000 })
  } catch {
    // notify-send not available — silently skip
  }
}

// ─── Worktree cleanup ────────────────────────────────────────────────

async function cleanupWorktrees(): Promise<number> {
  const wtDir = join(FOREMAN_HOME, 'worktrees')
  if (!existsSync(wtDir)) return 0

  let cleaned = 0
  const cutoff = Date.now() - 24 * 60 * 60 * 1000 // 24 hours

  try {
    for (const entry of readdirSync(wtDir)) {
      const wtPath = join(wtDir, entry)
      try {
        const mtime = statSync(wtPath).mtimeMs
        if (mtime > cutoff) continue

        const sessionRow = db.prepare(`SELECT name, status FROM sessions WHERE work_dir = ?`).get(wtPath) as { name: string, status: string } | undefined
        if (sessionRow && (sessionRow.status === 'running' || sessionRow.status === 'starting')) continue

        // Auto-commit any uncommitted work before cleaning
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

// ─── Zombie session reaper ───────────────────────────────────────────
// Kill tmux sessions that have no Claude process and haven't had output in 5+ minutes.
// Auto-commit any uncommitted work before killing.

async function reapZombieSessions(): Promise<number> {
  let reaped = 0
  const backend = getBackend()

  const sessions = stmts.activeSessions.all() as Array<{ name: string, status: string, goal_id: number, work_dir: string, last_checked_at: string | null }>
  for (const s of sessions) {
    if (!backend.isAlive(s.name)) continue
    if (s.status === 'starting') continue // still booting

    // Check if Claude is actually running in this tmux session
    const hasClaude = tmux(['list-panes', '-t', s.name, '-F', '#{pane_current_command}']).trim()
    const isClaudeRunning = hasClaude.includes('node') || hasClaude.includes('claude') || hasClaude.includes('tsx')

    if (isClaudeRunning) continue // Claude is still working

    // Claude not running — this is a zombie. Check if idle for 5+ min
    if (s.status === 'idle') {
      // Already marked idle — auto-commit and kill
      await autoCommitWorktree(s.work_dir)
      backend.kill(s.name)
      stmts.updateSession.run('dead', 'reaped (zombie)', s.name)
      reaped++
      log(`Reaped zombie session: ${s.name}`)
    } else {
      // Mark as idle first — will be reaped on next tick if still idle
      stmts.updateSession.run('idle', '', s.name)
    }
  }

  return reaped
}

// Auto-commit uncommitted changes in a worktree before cleanup
async function autoCommitWorktree(workDir: string): Promise<boolean> {
  try {
    // Check for uncommitted changes
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: workDir, timeout: 5_000 })
    if (!status.trim()) return false // nothing to commit

    // Stage and commit
    await execFileAsync('git', ['add', '-A'], { cwd: workDir, timeout: 5_000 })
    await execFileAsync('git', ['commit', '-m', 'chore: auto-commit uncommitted work from foreman session'], { cwd: workDir, timeout: 10_000 })

    // Try to push
    try {
      await execFileAsync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: workDir, timeout: 15_000 })
    } catch {} // push failure is non-fatal

    log(`Auto-committed uncommitted work in ${workDir.split('/').pop()}`)
    return true
  } catch {
    return false
  }
}

// ─── Events ──────────────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>()

function emitEvent(type: string, sessionName: string | null, goalId: number | null, data?: Record<string, unknown>): void {
  stmts.insertEvent.run(type, sessionName, goalId, data ? JSON.stringify(data) : null)

  const event = { type, sessionName, goalId, data, timestamp: new Date().toISOString() }
  const payload = `data: ${JSON.stringify(event)}\n\n`

  for (const client of sseClients) {
    try { client.write(payload) } catch { sseClients.delete(client) }
  }
}

// ─── Session scanner — ingest operator's own sessions ────────────────
// Scans ~/.claude/ and ~/.pi/ for session JSONL files.
// Extracts user messages, skill invocations, and outcome signals.
// These become training data for prompt composition.

const SESSION_DIRS: Array<{ dir: string, harness: string, flat?: boolean }> = [
  { dir: join(homedir(), '.claude', 'projects'), harness: 'claude' },
  { dir: join(homedir(), '.pi', 'agent', 'sessions'), harness: 'pi' },
  // Codex stores all sessions in one flat file
  { dir: join(homedir(), '.codex'), harness: 'codex', flat: true },
]

interface ParsedSession {
  id: string
  harness: string
  repo: string
  timestamp: string
  userMessages: string[]
  skillsUsed: string[]
  outcomeSignals: string[]
}

function scanSessionFile(filePath: string, harness: string): ParsedSession | null {
  try {
    const content = readFileSync(filePath, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    if (lines.length < 2) return null

    const userMessages: string[] = []
    const skillsUsed = new Set<string>()
    const outcomeSignals: string[] = []
    let repo = ''
    let timestamp = ''

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)

        // Extract timestamp from first entry
        if (!timestamp && entry.timestamp) timestamp = entry.timestamp

        // Extract repo/project from session metadata
        if (entry.cwd && !repo) repo = entry.cwd
        if (entry.projectPath && !repo) repo = entry.projectPath

        // Claude Code JSONL format: { type: 'user', message: { role: 'user', content: '...' } }
        if (entry.type === 'human' || entry.type === 'user') {
          const msg = entry.message
          const text = typeof msg === 'string' ? msg
            : typeof msg?.content === 'string' ? msg.content
            : Array.isArray(msg?.content) ? msg.content.map((c: { text?: string }) => c.text ?? '').join('')
            : ''
          if (text && text.length > 5 && text.length < 5000) {
            userMessages.push(text)
            // Detect skill usage
            const skillMatch = text.match(/^\/(evolve|pursue|polish|verify|research|converge|critical-audit|diagnose|improve|bad)\b/)
            if (skillMatch) skillsUsed.add('/' + skillMatch[1])
          }
        }

        // Pi JSONL format
        if (entry.role === 'user' && entry.content) {
          const text = typeof entry.content === 'string' ? entry.content
            : Array.isArray(entry.content) ? entry.content.map((c: { text?: string }) => c.text ?? '').join('') : ''
          if (text && text.length > 5 && text.length < 5000) {
            userMessages.push(text)
            const skillMatch = text.match(/^\/(evolve|pursue|polish|verify|research|converge|critical-audit|diagnose|improve|bad)\b/)
            if (skillMatch) skillsUsed.add('/' + skillMatch[1])
          }
        }

        // Detect outcome signals
        if (entry.type === 'assistant' || entry.role === 'assistant') {
          const text = typeof entry.message === 'string' ? entry.message
            : entry.message?.content?.[0]?.text
            ?? (typeof entry.content === 'string' ? entry.content : '')
          if (text) {
            if (text.includes('✅') || text.includes('tests pass') || text.includes('committed')) {
              outcomeSignals.push('success')
            }
            if (text.includes('❌') || text.includes('FAIL') || text.includes('error')) {
              outcomeSignals.push('failure')
            }
          }
        }
      } catch { /* skip malformed lines */ }
    }

    if (userMessages.length === 0) return null

    // Derive repo from file path if not found in content
    if (!repo) {
      // ~/.claude/projects/--home-drew-code-phony--/session.jsonl → phony
      const pathMatch = filePath.match(/projects\/--.*?--(.*?)--/)
      if (pathMatch) repo = pathMatch[1]
    }

    const sessionId = filePath.split('/').pop()?.replace('.jsonl', '') ?? filePath

    return {
      id: sessionId,
      harness,
      repo,
      timestamp: timestamp || new Date().toISOString(),
      userMessages,
      skillsUsed: [...skillsUsed],
      outcomeSignals,
    }
  } catch { return null }
}

function scanCodexSessions(dir: string): number {
  // Codex stores sessions in ~/.codex/history.jsonl — one line per session entry
  // Format: { session_id, ts, text, ... } where text is the user prompt
  const historyPath = join(dir, 'history.jsonl')
  if (!existsSync(historyPath)) return 0

  let scanned = 0
  const cutoff = Date.now() / 1000 - 3 * 24 * 60 * 60 // 3 days in seconds

  try {
    const content = readFileSync(historyPath, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)

    // Group by session_id
    const sessionMap = new Map<string, { texts: string[], ts: number }>()
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (!entry.session_id || !entry.text) continue
        if (entry.ts && entry.ts < cutoff) continue

        const existing = sessionMap.get(entry.session_id)
        if (existing) {
          existing.texts.push(entry.text)
        } else {
          sessionMap.set(entry.session_id, { texts: [entry.text], ts: entry.ts ?? 0 })
        }
      } catch {}
    }

    for (const [sessionId, data] of sessionMap) {
      const existing = db.prepare(`SELECT id FROM operator_sessions WHERE id = ?`).get(sessionId)
      if (existing) continue

      // Filter to user messages (skip system prompts — usually the first long one)
      const userMessages = data.texts.filter(t => t.length > 10 && t.length < 2000)
      if (userMessages.length === 0) continue

      stmts.upsertOperatorSession.run(
        sessionId, 'codex', '', new Date(data.ts * 1000).toISOString(),
        userMessages.length,
        JSON.stringify(userMessages.slice(0, 20)),
        JSON.stringify([]),
        JSON.stringify([]),
      )
      scanned++
    }
  } catch {}

  return scanned
}

function scanAllSessions(): number {
  let scanned = 0

  for (const { dir, harness, flat } of SESSION_DIRS) {
    if (!existsSync(dir)) continue

    // Codex: single flat JSONL file with all sessions
    if (flat) {
      scanned += scanCodexSessions(dir)
      continue
    }

    try {
      // For claude: ~/.claude/projects/<project-hash>/<session-uuid>.jsonl
      // For pi: ~/.pi/agent/sessions/<project-dir>/<session>.jsonl
      const projectDirs = readdirSync(dir)
      for (const projectDir of projectDirs) {
        const projectPath = join(dir, projectDir)
        try {
          if (!statSync(projectPath).isDirectory()) continue
        } catch { continue }

        // Claude: ~/.claude/projects/<project-hash>/<session-uuid>.jsonl (top-level only, skip subagents/)
        // Pi: ~/.pi/agent/sessions/<project-dir>/<session>.jsonl
        try {
          const entries = readdirSync(projectPath)
          const files = entries.filter(f => f.endsWith('.jsonl'))
          // Only scan recent files (last 3 days), cap at 50 per project dir
          const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000
          let projectScanned = 0
          for (const file of files) {
            if (projectScanned >= 50) break
            const fp = join(projectPath, file)
            try {
              const st = statSync(fp)
              if (!st.isFile() || st.mtimeMs < cutoff) continue
              // Skip tiny files (<500 bytes, probably empty or just metadata)
              if (st.size < 500) continue
              // Skip very large files (>5MB, likely subagent dumps)
              if (st.size > 5 * 1024 * 1024) continue

              const sessionId = file.replace('.jsonl', '')
              const existing = db.prepare(`SELECT id FROM operator_sessions WHERE id = ?`).get(sessionId) as { id: string } | undefined
              if (existing) continue

              const parsed = scanSessionFile(fp, harness)
              if (parsed && parsed.userMessages.length > 0) {
                stmts.upsertOperatorSession.run(
                  parsed.id, parsed.harness, parsed.repo, parsed.timestamp,
                  parsed.userMessages.length,
                  JSON.stringify(parsed.userMessages.slice(0, 20)),
                  JSON.stringify(parsed.skillsUsed),
                  JSON.stringify(parsed.outcomeSignals),
                )
                scanned++
                projectScanned++
              }
            } catch { /* skip unreadable files */ }
          }
        } catch { /* skip unreadable dirs */ }
      }
    } catch { /* skip unreadable harness dirs */ }
  }

  return scanned
}

// ─── Learning loop ───────────────────────────────────────────────────
// Runs periodically. Extracts patterns from operator sessions and
// Foreman's own dispatch outcomes. Feeds into prompt composition.

function runLearningLoop(): { scanned: number, extracted: number } {
  // 1. Scan new sessions
  const scanned = scanAllSessions()
  if (scanned > 0) log(`Scanned ${scanned} new operator sessions`)

  let extracted = 0

  // 2. Extract prompt exemplars from operator sessions
  // All operator messages are valuable — they embody taste directly.
  // Weight by session quality: sessions with success signals get higher weight.
  const allSessions = db.prepare(`
    SELECT user_messages, skills_used, repo, outcome_signals FROM operator_sessions
    WHERE message_count > 1
    ORDER BY timestamp DESC LIMIT 100
  `).all() as Array<{ user_messages: string, skills_used: string, repo: string, outcome_signals: string }>

  const goodSessions = allSessions

  for (const s of goodSessions) {
    try {
      const messages = JSON.parse(s.user_messages) as string[]
      const skills = JSON.parse(s.skills_used) as string[]

      // Extract good prompts — the operator's actual task descriptions.
      // Filter out: skill templates, system messages, meta-commands, notifications.
      for (const msg of messages) {
        if (msg.length < 30 || msg.length > 1000) continue
        if (msg.startsWith('/') && msg.length < 80) continue
        if (msg.startsWith('Base directory for this skill:')) continue
        if (msg.includes('## Phase') && msg.includes('## ')) continue
        if (msg.startsWith('{') || msg.startsWith('[')) continue
        if ((msg.match(/\n/g) ?? []).length > 15) continue
        if (msg.startsWith('<task-notification>')) continue
        if (msg.startsWith('<local-command-caveat>')) continue
        if (msg.startsWith('<command-name>')) continue
        if (msg.startsWith('<system-reminder>')) continue
        if (msg.includes('DO NOT respond to these messages')) continue

        // Check if we already have this learning
        const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'exemplar'`).get(msg.slice(0, 200))
        if (exists) continue

        stmts.insertLearning.run('exemplar', msg.slice(0, 500), `session:${s.repo}`, s.repo, 1.0)
        extracted++
      }

      // Extract skill patterns
      for (const skill of skills) {
        const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND project = ? AND type = 'skill_pattern'`).get(skill, s.repo)
        if (exists) continue
        stmts.insertLearning.run('skill_pattern', skill, `session:${s.repo}`, s.repo, 1.0)
        extracted++
      }
    } catch {}
  }

  // 3. Learn from Foreman's own dispatch outcomes
  // Which prompt compositions led to successes vs failures?
  const recentDecisions = db.prepare(`
    SELECT d.id, d.skill, d.task, d.status, d.outcome, d.learnings, s.prompt
    FROM decisions d
    LEFT JOIN sessions s ON s.decision_id = d.id
    WHERE d.status IN ('success', 'failure') AND d.updated_at > datetime('now', '-7 days')
    ORDER BY d.updated_at DESC LIMIT 30
  `).all() as Array<{
    id: number, skill: string, task: string, status: string,
    outcome: string | null, learnings: string | null, prompt: string | null
  }>

  for (const d of recentDecisions) {
    // Extract learnings from successful dispatches
    if (d.status === 'success' && d.learnings) {
      try {
        const learnings = JSON.parse(d.learnings) as string[]
        for (const l of learnings) {
          const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'dispatch_success'`).get(l.slice(0, 200))
          if (exists) continue
          stmts.insertLearning.run('dispatch_success', l.slice(0, 500), `decision:${d.id}`, null, 1.5)
          extracted++
        }
      } catch {}
    }

    // Extract anti-patterns from failures
    if (d.status === 'failure' && d.outcome) {
      const key = `FAIL: ${d.skill} "${d.task.slice(0, 80)}" → ${d.outcome.slice(0, 100)}`
      const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'dead_end'`).get(key.slice(0, 200))
      if (!exists) {
        stmts.insertLearning.run('dead_end', key.slice(0, 500), `decision:${d.id}`, null, -1.0)
        extracted++
      }
    }
  }

  // 4. Update taste model from operator session patterns
  // Count skill usage across all sessions to learn preferences
  const skillFreq = db.prepare(`
    SELECT skills_used FROM operator_sessions
    WHERE skills_used != '[]'
    ORDER BY timestamp DESC LIMIT 100
  `).all() as Array<{ skills_used: string }>

  const skillCounts = new Map<string, number>()
  for (const s of skillFreq) {
    try {
      for (const skill of JSON.parse(s.skills_used) as string[]) {
        skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1)
      }
    } catch {}
  }

  if (skillCounts.size > 0) {
    const sorted = [...skillCounts.entries()].sort((a, b) => b[1] - a[1])
    const pattern = `Operator skill preferences: ${sorted.map(([s, c]) => `${s}(${c})`).join(', ')}`
    // Upsert — replace existing skill preference pattern
    db.prepare(`DELETE FROM taste WHERE pattern LIKE 'Operator skill preferences:%'`).run()
    stmts.insertTaste.run(pattern, 'learning_loop', 1.0)
  }

  // 5. Score existing prompt templates
  const templates = stmts.listTemplates.all(10) as Array<{ id: number, version: number }>
  for (const t of templates) {
    // Count dispatches and successes that used this template version
    // (For now, we track by rough time correlation — proper tracking needs template_id on decisions)
    const total = db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE status != 'dispatched'`).get() as { c: number }
    const success = db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE status = 'success'`).get() as { c: number }
    const score = total.c > 0 ? success.c / total.c : 0
    stmts.updateTemplateScore.run(score, total.c, success.c, t.id)
  }

  if (extracted > 0) log(`Extracted ${extracted} learnings from sessions`)
  return { scanned, extracted }
}

// ─── Deep session analysis (LLM-powered) ─────────────────────────────
// Dispatches a Claude session to analyze batches of operator traces.
// Extracts: workflows, recurring goals, decision patterns, taste,
// project relationships, and flows that Foreman should automate.
//
// This is Foreman learning by reading the operator's actual work —
// not keyword matching, but LLM reasoning about session content.

let lastDeepAnalysis = 0
const DEEP_ANALYSIS_INTERVAL_MS = 6 * 60 * 60 * 1000 // every 6 hours

async function runDeepAnalysis(): Promise<{ analyzed: number, flows: number }> {
  // Gather recent unanalyzed sessions with substantial content
  const sessions = db.prepare(`
    SELECT id, harness, repo, user_messages, skills_used, outcome_signals, message_count
    FROM operator_sessions
    WHERE message_count >= 3
    AND id NOT IN (SELECT source FROM learnings WHERE type = 'deep_analysis' AND source IS NOT NULL)
    ORDER BY timestamp DESC LIMIT 30
  `).all() as Array<{
    id: string, harness: string, repo: string, user_messages: string,
    skills_used: string, outcome_signals: string, message_count: number
  }>

  if (sessions.length < 3) return { analyzed: 0, flows: 0 }

  // Build a digest of sessions for the LLM to analyze
  const sessionDigest: string[] = []
  for (const s of sessions) {
    try {
      const messages = JSON.parse(s.user_messages) as string[]
      const skills = JSON.parse(s.skills_used) as string[]
      const outcomes = JSON.parse(s.outcome_signals) as string[]
      const repoName = (s.repo || 'unknown').split('/').pop()

      sessionDigest.push([
        `### Session: ${repoName} (${s.harness}, ${s.message_count} messages)`,
        `Skills: ${skills.length > 0 ? skills.join(', ') : 'none'}`,
        `Outcomes: ${outcomes.length > 0 ? outcomes.join(', ') : 'unknown'}`,
        `Operator messages:`,
        ...messages.slice(0, 8).map(m => `> ${m.slice(0, 300).replace(/\n/g, ' ')}`),
      ].join('\n'))
    } catch {}
  }

  if (sessionDigest.length === 0) return { analyzed: 0, flows: 0 }

  const analysisPrompt = `You are analyzing an operator's coding sessions to extract patterns that an autonomous agent (Foreman) can learn from.

Below are ${sessionDigest.length} recent sessions. For each, you see the tools/project, what skills were used, and what the operator actually typed.

Your job: identify FLOWS — recurring patterns of work the operator does that Foreman could automate or assist with.

A flow is: a trigger condition + a sequence of actions + a success criteria.

Examples of flows:
- "When CI fails on a PR, the operator runs /converge to fix it, then re-checks"
- "When starting work on a new project, the operator always reads README, runs tests, then identifies the most broken part"
- "The operator runs /evolve on voice quality metrics, then /verify, then opens a PR"
- "When debugging, the operator checks logs, reproduces the issue, fixes it, writes a test"

Also extract:
- **Taste signals**: what the operator values (speed vs quality, exploration vs exploitation, etc.)
- **Project relationships**: which projects relate to each other, what gets worked on together
- **Anti-patterns**: things the operator avoids or corrects
- **Skill preferences**: which skills get used for what kind of work

Respond with JSON:
{
  "flows": [
    {"trigger": "...", "actions": ["..."], "success": "...", "frequency": "high|medium|low", "projects": ["..."]}
  ],
  "taste": ["..."],
  "project_relationships": [{"a": "...", "b": "...", "relationship": "..."}],
  "anti_patterns": ["..."],
  "skill_preferences": [{"skill": "...", "when": "...", "effectiveness": "high|medium|low"}]
}

## Sessions

${sessionDigest.join('\n\n')}
`

  // Dispatch analysis via unified Claude runner
  const analysisJSON = await callClaudeForJSON(analysisPrompt)
  if (!analysisJSON) {
    log('Deep analysis: no response from Claude')
    return { analyzed: 0, flows: 0 }
  }
  const analysisResult = JSON.stringify(analysisJSON)

  // Parse the JSON response
  let analysis: {
    flows?: Array<{ trigger: string, actions: string[], success: string, frequency: string, projects?: string[] }>
    taste?: string[]
    project_relationships?: Array<{ a: string, b: string, relationship: string }>
    anti_patterns?: string[]
    skill_preferences?: Array<{ skill: string, when: string, effectiveness: string }>
  }

  try {
    const jsonMatch = analysisResult.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      log('Deep analysis: no JSON in response')
      return { analyzed: sessions.length, flows: 0 }
    }
    analysis = JSON.parse(jsonMatch[0])
  } catch {
    log('Deep analysis: failed to parse JSON response')
    return { analyzed: sessions.length, flows: 0 }
  }

  let flows = 0

  // Store extracted flows
  if (analysis.flows) {
    for (const flow of analysis.flows) {
      const content = `FLOW: When ${flow.trigger} → ${flow.actions.join(' → ')} → ${flow.success} (${flow.frequency})`
      const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'flow'`).get(content.slice(0, 200))
      if (!exists) {
        const project = flow.projects?.[0] ?? null
        stmts.insertLearning.run('flow', content.slice(0, 500), 'deep_analysis', project, flow.frequency === 'high' ? 2.0 : flow.frequency === 'medium' ? 1.0 : 0.5)
        flows++
      }
    }
  }

  // Store taste signals
  if (analysis.taste) {
    for (const t of analysis.taste) {
      const exists = db.prepare(`SELECT id FROM taste WHERE pattern = ?`).get(t.slice(0, 200))
      if (!exists) {
        stmts.insertTaste.run(t.slice(0, 500), 'deep_analysis', 1.0)
      }
    }
  }

  // Store anti-patterns
  if (analysis.anti_patterns) {
    for (const ap of analysis.anti_patterns) {
      const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'anti_pattern'`).get(ap.slice(0, 200))
      if (!exists) {
        stmts.insertLearning.run('anti_pattern', ap.slice(0, 500), 'deep_analysis', null, -1.5)
      }
    }
  }

  // Store skill preferences
  if (analysis.skill_preferences) {
    for (const sp of analysis.skill_preferences) {
      const content = `${sp.skill}: ${sp.when} (${sp.effectiveness})`
      const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'skill_preference'`).get(content.slice(0, 200))
      if (!exists) {
        stmts.insertLearning.run('skill_preference', content.slice(0, 500), 'deep_analysis', null, sp.effectiveness === 'high' ? 2.0 : 1.0)
      }
    }
  }

  // Store project relationships
  if (analysis.project_relationships) {
    for (const pr of analysis.project_relationships) {
      const content = `${pr.a} ↔ ${pr.b}: ${pr.relationship}`
      const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'project_relationship'`).get(content.slice(0, 200))
      if (!exists) {
        stmts.insertLearning.run('project_relationship', content.slice(0, 500), 'deep_analysis', null, 1.0)
      }
    }
  }

  // Mark sessions as analyzed
  for (const s of sessions) {
    stmts.insertLearning.run('deep_analysis', `analyzed:${s.id}`, s.id, s.repo, 0)
  }

  log(`Deep analysis: ${sessions.length} sessions → ${flows} flows, ${analysis.taste?.length ?? 0} taste, ${analysis.anti_patterns?.length ?? 0} anti-patterns`)
  return { analyzed: sessions.length, flows }
}

// ─── Inject flows into prompt composition ────────────────────────────
// The composePrompt function already reads learnings by type.
// Deep analysis results go into these types:
//   - 'flow': trigger → actions → success patterns
//   - 'anti_pattern': things to avoid
//   - 'skill_preference': when to use which skill
//   - 'project_relationship': how projects relate
// These get picked up by the existing sections in composePrompt.

// ─── Git worktree ────────────────────────────────────────────────────

async function createWorktree(repoPath: string, label: string): Promise<{
  path: string, branch: string, baseBranch: string
} | null> {
  const projectName = repoPath.split('/').pop() ?? 'project'
  const branch = `foreman/${label}`
  const wtPath = join(FOREMAN_HOME, 'worktrees', `${projectName}-${label}`)

  // Detect the operator's current branch — Foreman branches FROM this,
  // so its work builds on top of what the operator is doing.
  let baseBranch = 'main'
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoPath, timeout: 5_000 })
    if (stdout.trim()) baseBranch = stdout.trim()
  } catch {}

  // Clean up stale worktree if the directory exists but git doesn't know about it
  if (existsSync(wtPath)) {
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoPath, timeout: 10_000 })
    } catch {}
  }

  // Delete the branch if it exists from a previous run (allows re-dispatch with same label)
  try {
    await execFileAsync('git', ['branch', '-D', branch], { cwd: repoPath, timeout: 5_000 })
  } catch {}

  // Create worktree branching from the operator's current branch
  try {
    await execFileAsync('git', ['worktree', 'add', '-b', branch, wtPath, baseBranch], { cwd: repoPath, timeout: 15_000 })
    return { path: wtPath, branch, baseBranch }
  } catch (e) {
    // If baseBranch is detached HEAD or doesn't exist, try without explicit start point
    try {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, wtPath], { cwd: repoPath, timeout: 15_000 })
      return { path: wtPath, branch, baseBranch }
    } catch { return null }
  }
}

// ─── Prompt composer ─────────────────────────────────────────────────
// Builds a rich, context-loaded prompt for the Claude Code session.
// This is the highest-leverage surface in the entire system.

function readProjectFile(dir: string, name: string, maxLen = 2000): string | null {
  try {
    const fp = join(dir, name)
    if (existsSync(fp)) return readFileSync(fp, 'utf8').slice(0, maxLen)
  } catch {}
  return null
}

function composePrompt(opts: {
  skill: string
  task: string
  workDir: string
  goalIntent?: string
  goalId?: number
  worktreeBranch?: string | null
  baseBranch?: string | null
  repoDir?: string | null
}): string {
  const { skill, task, workDir, goalIntent, goalId, worktreeBranch, baseBranch, repoDir } = opts
  const sections: string[] = []
  const projectName = (repoDir ?? workDir).split('/').pop() ?? 'project'

  // ── Goal context ──────────────────────────────────────────────
  if (goalIntent && goalIntent !== task) {
    sections.push(`## Goal\n${goalIntent}`)
  }

  // ── Project understanding ─────────────────────────────────────
  const readme = readProjectFile(workDir, 'README.md') ?? readProjectFile(workDir, 'readme.md')
  const claudeMd = readProjectFile(workDir, 'CLAUDE.md')
  const pkg = readProjectFile(workDir, 'package.json', 500)
  const cargo = readProjectFile(workDir, 'Cargo.toml', 500)
  const pyproject = readProjectFile(workDir, 'pyproject.toml', 500)

  if (claudeMd) {
    sections.push(`## Project Instructions (CLAUDE.md)\n${claudeMd}`)
  }
  if (readme) {
    sections.push(`## What This Project Is\n${readme.slice(0, 1200)}`)
  }
  const manifest = pkg ?? cargo ?? pyproject
  if (manifest) {
    sections.push(`## Manifest\n\`\`\`\n${manifest}\n\`\`\``)
  }

  // ── Current state ─────────────────────────────────────────────
  // Git log
  try {
    const log = execFileSync('git', ['log', '--oneline', '-8'], { cwd: workDir, encoding: 'utf8', timeout: 5_000 }).trim()
    if (log) sections.push(`## Recent Git History\n${log}`)
  } catch {}

  // Git status
  try {
    const status = execFileSync('git', ['status', '--short'], { cwd: workDir, encoding: 'utf8', timeout: 5_000 }).trim()
    if (status) sections.push(`## Uncommitted Changes\n${status}`)
  } catch {}

  // Evolve state + experiment trajectory
  const evolveProgress = readProjectFile(workDir, 'evolve-progress.md', 1000)
  const autoresearchMd = readProjectFile(workDir, 'autoresearch.md', 1000)
  if (evolveProgress) sections.push(`## Current Evolve State\n${evolveProgress}`)
  if (autoresearchMd) sections.push(`## Autoresearch Config\n${autoresearchMd}`)

  // Experiment history — extract trajectory and learnings from .evolve/experiments.jsonl
  // This is the data that gets LOST when evolve-progress.md is overwritten.
  // We extract: what was tried, what worked, what failed, and the score trajectory.
  const experimentsPath = join(workDir, '.evolve', 'experiments.jsonl')
  try {
    if (existsSync(experimentsPath)) {
      const expContent = readFileSync(experimentsPath, 'utf8')
      const expLines = expContent.trim().split('\n').filter(Boolean)
      const experiments: Array<{
        hypothesis?: string, category?: string, verdict?: string,
        delta?: number, baseline?: Record<string, number>, result?: Record<string, number>,
        learnings?: string[], round?: number
      }> = []
      for (const line of expLines) {
        try { experiments.push(JSON.parse(line)) } catch {}
      }
      if (experiments.length > 0) {
        const lines = ['## Experiment History (from .evolve/experiments.jsonl)']

        // Score trajectory
        const trajectory = experiments
          .filter(e => e.result && e.round)
          .map(e => {
            const score = e.result ? Object.values(e.result)[0] : null
            return `Round ${e.round}: ${score ?? '?'}`
          })
        if (trajectory.length > 0) {
          lines.push(`\nTrajectory: ${trajectory.join(' → ')}`)
        }

        // What worked (KEEP verdicts)
        const kept = experiments.filter(e => e.verdict === 'KEEP')
        if (kept.length > 0) {
          lines.push('\nWhat worked:')
          for (const e of kept.slice(-5)) {
            lines.push(`- ✓ ${e.hypothesis ?? '?'} (${e.category ?? '?'}, Δ${e.delta ?? '?'})`)
          }
        }

        // What failed (ABANDON/REGRESSION)
        const failed = experiments.filter(e => e.verdict === 'ABANDON' || e.verdict === 'REGRESSION')
        if (failed.length > 0) {
          lines.push('\nWhat failed (DO NOT RETRY):')
          for (const f of failed.slice(-3)) {
            lines.push(`- ✗ ${f.hypothesis ?? '?'} (${f.category ?? '?'})`)
            if (f.learnings) for (const l of f.learnings.slice(0, 2)) lines.push(`    ${l.slice(0, 100)}`)
          }
        }

        // Accumulated learnings
        const allLearnings = experiments.flatMap(e => e.learnings ?? [])
        if (allLearnings.length > 0) {
          const unique = [...new Set(allLearnings)].slice(-5)
          lines.push('\nAccumulated learnings:')
          for (const l of unique) lines.push(`- ${l.slice(0, 120)}`)
        }

        sections.push(lines.join('\n'))
      }
    }
  } catch {}

  // Pursue docs — extract key findings, not the whole file
  try {
    const pursueFiles = readdirSync(workDir).filter(f => f.startsWith('pursue-') && f.endsWith('.md'))
    for (const f of pursueFiles) {
      const content = readProjectFile(workDir, f, 2000)
      if (!content) continue

      // Extract: status, thesis, what worked, what didn't, next seeds
      const lines = [`## ${f}`]
      const statusMatch = content.match(/Status:\s*(.+)/i)
      const thesisMatch = content.match(/###?\s*Thesis\n+(.+)/i)
      if (statusMatch) lines.push(`Status: ${statusMatch[1]}`)
      if (thesisMatch) lines.push(`Thesis: ${thesisMatch[1].slice(0, 200)}`)

      // Extract "What Worked" / "What Didn't Work" sections
      const workedMatch = content.match(/###?\s*What Worked\n([\s\S]*?)(?=\n###?\s|\n---|\n$)/i)
      if (workedMatch) lines.push(`What worked: ${workedMatch[1].trim().slice(0, 300)}`)
      const failedMatch = content.match(/###?\s*What Didn't Work\n([\s\S]*?)(?=\n###?\s|\n---|\n$)/i)
      if (failedMatch) lines.push(`What didn't: ${failedMatch[1].trim().slice(0, 200)}`)
      const seedsMatch = content.match(/###?\s*Next Generation Seeds\n([\s\S]*?)(?=\n---|\n$)/i)
      if (seedsMatch) lines.push(`Next seeds: ${seedsMatch[1].trim().slice(0, 200)}`)

      sections.push(lines.join('\n'))
    }
  } catch {}

  // Scorecard snapshot
  const scorecardPath = join(workDir, '.evolve', 'scorecard.json')
  try {
    if (existsSync(scorecardPath)) {
      const scorecard = JSON.parse(readFileSync(scorecardPath, 'utf8'))
      if (scorecard.flows) {
        const lines = ['## Product Scorecard']
        for (const flow of scorecard.flows) {
          const icon = flow.status === 'pass' ? '✓' : flow.status === 'fail' ? '✗' : '○'
          lines.push(`${icon} ${flow.name}: ${flow.score ?? 'unmeasured'} (target: ${flow.target})`)
        }
        if (scorecard.aggregate) lines.push(`Aggregate: ${scorecard.aggregate}`)
        sections.push(lines.join('\n'))
      }
    }
  } catch {}

  // ── Past decisions on this project ────────────────────────────
  const pastDecisions = db.prepare(
    `SELECT skill, task, status, outcome, learnings FROM decisions
     WHERE task LIKE ? OR task LIKE ?
     ORDER BY created_at DESC LIMIT 5`
  ).all(`%${projectName}%`, `%${workDir}%`) as Array<{
    skill: string, task: string, status: string, outcome: string | null, learnings: string | null
  }>

  if (pastDecisions.length > 0) {
    const lines = ['## What Foreman Has Tried Before']
    for (const d of pastDecisions) {
      const icon = d.status === 'success' ? '✓' : d.status === 'failure' ? '✗' : '○'
      lines.push(`${icon} [${d.status}] ${d.skill} — ${d.task.slice(0, 100)}`)
      if (d.outcome) lines.push(`  Result: ${d.outcome.slice(0, 120)}`)
      if (d.learnings) {
        try {
          for (const l of JSON.parse(d.learnings)) lines.push(`  Learning: ${String(l).slice(0, 100)}`)
        } catch {}
      }
    }
    sections.push(lines.join('\n'))
  }

  // Also check by goal_id for more precise matching
  if (goalId) {
    const goalDecisions = stmts.goalDecisions.all(goalId) as Array<{
      skill: string, task: string, status: string, outcome: string | null, learnings: string | null
    }>
    const relevant = goalDecisions.filter(d => !pastDecisions.some(pd => pd.task === d.task)).slice(0, 5)
    if (relevant.length > 0) {
      const lines = ['## Other Attempts on This Goal']
      for (const d of relevant) {
        const icon = d.status === 'success' ? '✓' : d.status === 'failure' ? '✗' : '○'
        lines.push(`${icon} [${d.status}] ${d.skill} — ${d.task.slice(0, 100)}`)
        if (d.outcome) lines.push(`  Result: ${d.outcome.slice(0, 120)}`)
      }
      sections.push(lines.join('\n'))
    }
  }

  // ── Taste model ───────────────────────────────────────────────
  const tasteSignals = stmts.listTaste.all(10) as Array<{ pattern: string, weight: number }>
  if (tasteSignals.length > 0) {
    const lines = ['## Operator Preferences (learned from feedback)']
    for (const t of tasteSignals) {
      lines.push(`- ${t.pattern}`)
    }
    sections.push(lines.join('\n'))
  }

  // ── Dead ends ─────────────────────────────────────────────────
  const failures = db.prepare(
    `SELECT skill, task, outcome, learnings FROM decisions
     WHERE status = 'failure' AND (task LIKE ? OR task LIKE ?)
     ORDER BY created_at DESC LIMIT 3`
  ).all(`%${projectName}%`, `%${workDir}%`) as Array<{
    skill: string, task: string, outcome: string | null, learnings: string | null
  }>

  if (failures.length > 0) {
    const lines = ['## Dead Ends (DO NOT REPEAT)']
    for (const f of failures) {
      lines.push(`- ${f.skill} "${f.task.slice(0, 80)}" → FAILED: ${(f.outcome ?? 'unknown').slice(0, 100)}`)
    }
    sections.push(lines.join('\n'))
  }

  // ── Learned exemplars from operator's own sessions ───────────
  // These are real prompts Drew wrote that led to successful sessions.
  // They teach Claude Code what good task descriptions look like.
  const exemplars = stmts.learningsByProject.all(projectName, 5) as Array<{ content: string, type: string }>
  const promptExemplars = exemplars.filter(e => e.type === 'exemplar')
  if (promptExemplars.length > 0) {
    const lines = ['## How the Operator Writes Tasks (learn from these)']
    for (const e of promptExemplars.slice(0, 3)) {
      lines.push(`> ${e.content.slice(0, 200)}`)
    }
    sections.push(lines.join('\n'))
  }

  // ── Dispatch success patterns ───────────────────────────────
  const successLearnings = stmts.learningsByType.all('dispatch_success', 5) as Array<{ content: string }>
  if (successLearnings.length > 0) {
    const lines = ['## What Works (from past dispatches)']
    for (const l of successLearnings) {
      lines.push(`- ${l.content.slice(0, 150)}`)
    }
    sections.push(lines.join('\n'))
  }

  // ── Learned flows (from deep session analysis) ──────────────
  const flows = stmts.learningsByType.all('flow', 5) as Array<{ content: string }>
  if (flows.length > 0) {
    const lines = ['## Operator Workflows (learned from session analysis)']
    for (const f of flows) {
      lines.push(`- ${f.content.slice(0, 200)}`)
    }
    sections.push(lines.join('\n'))
  }

  // ── Anti-patterns (from deep analysis) ──────────────────────
  const antiPatterns = stmts.learningsByType.all('anti_pattern', 3) as Array<{ content: string }>
  if (antiPatterns.length > 0) {
    const lines = ['## Avoid (learned from operator patterns)']
    for (const ap of antiPatterns) {
      lines.push(`- ${ap.content.slice(0, 150)}`)
    }
    sections.push(lines.join('\n'))
  }

  // ── Skill preferences (from deep analysis) ─────────────────
  const skillPrefs = stmts.learningsByType.all('skill_preference', 5) as Array<{ content: string }>
  if (skillPrefs.length > 0) {
    const lines = ['## Skill Selection Guide (learned from operator)']
    for (const sp of skillPrefs) {
      lines.push(`- ${sp.content.slice(0, 150)}`)
    }
    sections.push(lines.join('\n'))
  }

  // ── Project relationships (from deep analysis) ──────────────
  const relationships = stmts.learningsByType.all('project_relationship', 3) as Array<{ content: string }>
  if (relationships.length > 0) {
    const lines = ['## Related Projects']
    for (const r of relationships) {
      lines.push(`- ${r.content.slice(0, 150)}`)
    }
    sections.push(lines.join('\n'))
  }

  // ── Compose final prompt ──────────────────────────────────────
  // The skill command (if any) goes at the top as the primary instruction.
  // Context follows. The task is the specific goal within the context.
  let prompt = ''

  // Task instruction — this is what the session should DO
  prompt += `## Your Task\n${task}\n\n`

  // Standards
  prompt += `## Standards\n`
  prompt += `- L7/L8 staff engineer quality. Zero tolerance for slop.\n`
  prompt += `- Complete everything fully. No TODOs, no stubs.\n`
  prompt += `- ALWAYS commit your work. After every meaningful change: git add -A && git commit -m "feat/fix: description".\n`
  prompt += `- If tests exist, run them. Fix failures before moving on.\n`
  prompt += `- Never ask for permission. Act.\n`

  // Worktree + PR workflow
  if (worktreeBranch && baseBranch) {
    prompt += `\n## Git Workflow — CRITICAL\n`
    prompt += `You are working in an isolated worktree on branch \`${worktreeBranch}\`.\n`
    prompt += `The operator is working on branch \`${baseBranch}\` — your work must not interfere with theirs.\n\n`
    prompt += `**You MUST commit and push before finishing.** Uncommitted work is lost work.\n\n`
    prompt += `During work: commit after each logical change.\n`
    prompt += `When complete:\n`
    prompt += `1. \`git add -A && git status\` — verify all changes are staged\n`
    prompt += `2. \`git commit -m "feat: <what you did>"\` — if anything is uncommitted\n`
    prompt += `3. \`git push -u origin ${worktreeBranch}\`\n`
    prompt += `4. \`gh pr create --base ${baseBranch} --title "foreman: <summary>" --body "<what you did and why>"\`\n\n`
    prompt += `If you skip the commit/push, your work will be lost. The operator reviews PRs, not worktree diffs.\n`
  }
  prompt += '\n'

  // Context sections (trimmed to fit — Claude Code has limited initial prompt space)
  // Scale context budget by task complexity.
  // Simple tasks (short, direct commands) get less context.
  // Complex tasks (multi-step goals, architectural work) get full context.
  const taskWords = task.split(/\s+/).length
  const isComplex = taskWords > 20 || skill === '/pursue' || skill === '/evolve' ||
    skill === '/research' || skill === '/critical-audit' ||
    task.includes('redesign') || task.includes('architect') || task.includes('refactor')
  let contextBudget = isComplex ? 6000 : taskWords > 10 ? 3500 : 1500
  for (const section of sections) {
    if (contextBudget <= 0) break
    if (section.length <= contextBudget) {
      prompt += section + '\n\n'
      contextBudget -= section.length
    } else {
      prompt += section.slice(0, contextBudget) + '\n...(truncated)\n\n'
      contextBudget = 0
    }
  }

  // If there's a skill, prepend it so it's the FIRST thing Claude sees
  if (skill && skill.startsWith('/')) {
    // Skill goes as the very first line — Claude Code will recognize the slash command
    return `${skill} ${prompt.trim()}`
  }

  return prompt.trim()
}

// ─── Logging ─────────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
}

// ─── API helpers ─────────────────────────────────────────────────────

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(data))
}

function error(res: http.ServerResponse, msg: string, status = 400): void {
  json(res, { error: msg }, status)
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString())
}

function parseQuery(url: string): URLSearchParams {
  const idx = url.indexOf('?')
  return new URLSearchParams(idx >= 0 ? url.slice(idx + 1) : '')
}

// ─── API routes ──────────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url ?? '/'
  const method = req.method ?? 'GET'
  const path = url.split('?')[0]

  // CORS
  if (method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' })
    res.end()
    return
  }

  try {
    // ── Health ─────────────────────────────────────────────────
    if (path === '/api/health') {
      return json(res, { status: 'ok', uptime: process.uptime() })
    }

    // ── Status (portfolio overview) ───────────────────────────
    if (path === '/api/status' && method === 'GET') {
      const goals = stmts.listGoals.all()
      const sessions = stmts.activeSessions.all() as Array<{ name: string, status: string }>
      const recentDecisions = stmts.listDecisions.all(20)
      const events = stmts.recentEvents.all(10)

      // Enrich sessions with live tmux data
      const enriched = sessions.map(s => ({
        ...s,
        alive: isTmuxAlive(s.name),
        idle: detectIdle(s.name),
        lastOutput: captureTmux(s.name, 1).trim().split('\n').pop() ?? '',
      }))

      return json(res, { goals, sessions: enriched, recentDecisions, events })
    }

    // ── Goals ─────────────────────────────────────────────────
    if (path === '/api/goals' && method === 'POST') {
      const body = await readBody(req)
      const intent = String(body.intent ?? '')
      if (!intent) return error(res, 'intent required')

      const result = stmts.insertGoal.run(
        intent,
        body.workspace_path ?? null,
        body.workspace_type ?? 'repo',
        body.context ?? null,
        body.priority ?? 0,
      )
      const goal = stmts.getGoal.get(result.lastInsertRowid)
      return json(res, goal, 201)
    }

    if (path === '/api/goals' && method === 'GET') {
      return json(res, stmts.listGoals.all())
    }

    // ── Dispatch ──────────────────────────────────────────────
    if (path === '/api/dispatch' && method === 'POST') {
      const body = await readBody(req)
      const goalId = Number(body.goal_id ?? 0)
      const skill = String(body.skill ?? '')
      const task = String(body.task ?? '')
      const reasoning = String(body.reasoning ?? '')
      const workDir = String(body.work_dir ?? '')
      const label = String(body.label ?? '')
      const backendName = String(body.backend ?? 'tmux') // 'tmux' (local), 'tangle' (remote sandbox)
      // Worktree is ON by default for tmux — Foreman never touches the operator's working directory.
      // Tangle backend handles isolation via containers, so worktrees aren't needed.
      const useWorktree = backendName === 'tmux' && body.worktree !== false

      if (!task) return error(res, 'task required')
      if (!workDir && !goalId) return error(res, 'work_dir or goal_id required')

      // Resolve work directory (the operator's repo)
      let repoDir = workDir
      let effectiveWorkDir = workDir
      let worktreePath: string | null = null
      let worktreeBranch: string | null = null
      let baseBranch: string | null = null

      if (!repoDir && goalId) {
        const goal = stmts.getGoal.get(goalId) as { workspace_path?: string } | undefined
        repoDir = goal?.workspace_path ?? ''
        effectiveWorkDir = repoDir
      }

      if (!repoDir) return error(res, 'cannot resolve work directory')

      // Create worktree — Foreman always works in isolation.
      // Branches from the operator's current branch so it builds on their latest work.
      // Auto-generates a label if none provided (skill name + timestamp).
      if (useWorktree) {
        const isGitRepo = existsSync(join(repoDir, '.git'))
        if (isGitRepo) {
          const autoLabel = label || `${(skill.replace(/^\//, '') || 'work').replace(/[^a-z0-9]/gi, '-')}-${Date.now().toString(36)}`
          const wt = await createWorktree(repoDir, autoLabel)
          if (wt) {
            worktreePath = wt.path
            worktreeBranch = wt.branch
            baseBranch = wt.baseBranch
            effectiveWorkDir = wt.path
          } else {
            // Fall back to direct work if worktree fails (non-git, bare repo, etc.)
            log(`Worktree creation failed for ${repoDir}, falling back to direct`)
          }
        }
      }

      // Session name includes label for parallel dispatch support
      const sName = sessionName(label || (effectiveWorkDir.split('/').pop() ?? 'session'))
      // Get active template version for tracking
      const activeTpl = stmts.activeTemplate.get() as { version: number } | undefined
      const tplVersion = activeTpl?.version ?? 1

      // Truncate task for DB storage — full prompt goes in sessions.prompt
      const taskTruncated = task.slice(0, 500)
      const result = stmts.insertDecision.run(goalId || null, skill, taskTruncated, reasoning, sName, worktreePath, worktreeBranch, baseBranch, tplVersion, 'operator')
      const decisionId = Number(result.lastInsertRowid)

      // Compose rich, context-loaded prompt (reads project context from the REPO, not the worktree)
      const goalRow = goalId ? stmts.getGoal.get(goalId) as { intent?: string } | undefined : undefined
      const prompt = composePrompt({
        skill,
        task,
        workDir: effectiveWorkDir,
        goalIntent: goalRow?.intent,
        goalId: goalId || undefined,
        worktreeBranch,
        baseBranch,
        repoDir: worktreePath ? repoDir : null, // pass original repo for context reading
      })

      // Select model (cost optimization — cheap for mechanical, expensive for creative)
      const model = selectModel(skill, task)

      // Spawn (non-blocking — returns immediately)
      // Model: explicit override > API request > auto-selected > default
      const requestedModel = body.model ? String(body.model) : undefined
      const effectiveModel = requestedModel ?? model ?? undefined

      spawnSession({
        name: sName,
        workDir: effectiveWorkDir,
        prompt,
        goalId: goalId || null as unknown as number,
        decisionId,
        backend: backendName,
        model: effectiveModel,
      })

      const decision = stmts.getDecision.get(decisionId)
      // Confidence level for this dispatch
      const dispatchProject = (worktreePath ?? effectiveWorkDir).split('/').pop() ?? ''
      const confidenceLevel = confidence.getLevel(skill || 'direct', dispatchProject)
      const confidenceScore = confidence.getConfidence(skill || 'direct', dispatchProject)

      return json(res, { decision, session: sName, backend: backendName, model: effectiveModel, worktree: worktreePath, branch: worktreeBranch, baseBranch, confidenceLevel, confidenceScore, promptLength: prompt.length, promptPreview: prompt.slice(0, 300) }, 201)
    }

    // ── Sessions ──────────────────────────────────────────────
    if (path === '/api/sessions' && method === 'GET') {
      const sessions = stmts.listSessions.all() as Array<{ name: string }>
      const enriched = sessions.map(s => ({
        ...s,
        alive: isTmuxAlive(s.name),
        idle: detectIdle(s.name),
      }))
      return json(res, enriched)
    }

    if (path.startsWith('/api/sessions/') && method === 'GET') {
      const name = decodeURIComponent(path.slice('/api/sessions/'.length))
      const session = stmts.getSession.get(name) as { name: string } | undefined
      if (!session) return error(res, 'session not found', 404)

      const lines = parseInt(parseQuery(url).get('lines') ?? '30', 10)
      const output = isTmuxAlive(name) ? captureTmux(name, lines) : ''

      // Git stats
      let gitLog = ''
      try {
        const s = session as { work_dir?: string }
        if (s.work_dir) {
          const { stdout } = await execFileAsync('git', ['log', '--oneline', '-5'], { cwd: s.work_dir, timeout: 5_000 })
          gitLog = stdout.trim()
        }
      } catch {}

      return json(res, {
        ...session,
        alive: isTmuxAlive(name),
        idle: detectIdle(name),
        output: output.trim(),
        gitLog,
      })
    }

    if (path.startsWith('/api/sessions/') && method === 'DELETE') {
      const name = decodeURIComponent(path.slice('/api/sessions/'.length))
      tmuxQuiet(['kill-session', '-t', name])
      stmts.updateSession.run('dead', '', name)
      pendingPrompts.delete(name)
      return json(res, { killed: name })
    }

    // ── Outcomes ──────────────────────────────────────────────
    if (path === '/api/outcomes' && method === 'POST') {
      const body = await readBody(req)
      const decisionId = Number(body.decision_id ?? 0)
      if (!decisionId) return error(res, 'decision_id required')

      const status = String(body.status ?? 'success')
      const outcome = String(body.outcome ?? '')
      const learnings = body.learnings ? JSON.stringify(body.learnings) : null
      const metrics = body.metrics ? JSON.stringify(body.metrics) : null
      const tasteSignal = body.taste_signal ? String(body.taste_signal) : null
      const costUsd = body.cost_usd ? Number(body.cost_usd) : null

      stmts.updateDecision.run(status, outcome, learnings, metrics, tasteSignal, costUsd, decisionId)

      // Record taste if signal provided + update confidence
      if (tasteSignal && tasteSignal !== 'neutral') {
        const decision = stmts.getDecision.get(decisionId) as { skill: string, task: string, worktree_path: string | null } | undefined
        if (decision) {
          const pattern = `${tasteSignal}: ${decision.skill} for "${decision.task.slice(0, 100)}"`
          stmts.insertTaste.run(pattern, `decision:${decisionId}`, tasteSignal === 'approved' ? 1.0 : -1.0)

          // Operator taste → confidence signal
          const projectName = (decision.worktree_path ?? '').split('/').pop() ?? 'unknown'
          const confSignal = tasteSignal === 'approved' ? 'agree' as const : 'disagree' as const
          confidence.update(decision.skill || 'direct', projectName, confSignal)
        }
      }

      emitEvent('outcome_logged', null, null, { decisionId, status })

      return json(res, stmts.getDecision.get(decisionId))
    }

    // ── Decisions search ──────────────────────────────────────
    if (path === '/api/decisions' && method === 'GET') {
      const query = parseQuery(url)
      const q = query.get('q')
      const goalId = query.get('goal_id')
      const limit = parseInt(query.get('limit') ?? '50', 10)

      if (goalId) {
        return json(res, stmts.goalDecisions.all(parseInt(goalId, 10)))
      }
      if (q) {
        const pattern = `%${q}%`
        return json(res, stmts.searchDecisions.all(pattern, pattern, pattern, pattern, pattern, pattern, limit))
      }
      return json(res, stmts.listDecisions.all(limit))
    }

    // ── Taste ─────────────────────────────────────────────────
    if (path === '/api/taste' && method === 'GET') {
      const limit = parseInt(parseQuery(url).get('limit') ?? '20', 10)
      return json(res, stmts.listTaste.all(limit))
    }

    if (path === '/api/taste' && method === 'POST') {
      const body = await readBody(req)
      stmts.insertTaste.run(String(body.pattern ?? ''), body.source ?? null, Number(body.weight ?? 1.0))
      return json(res, { ok: true }, 201)
    }

    // ── Events (SSE) ──────────────────────────────────────────
    if (path === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    // ── Project context (reads filesystem) ────────────────────
    if (path === '/api/context' && method === 'GET') {
      const projectPath = parseQuery(url).get('path')
      if (!projectPath) return error(res, 'path required')

      try {
        if (!statSync(projectPath).isDirectory()) return error(res, 'not a directory')
      } catch { return error(res, 'path does not exist') }

      const context: Record<string, string> = {}

      for (const f of ['README.md', 'readme.md', 'CLAUDE.md', 'package.json', 'Cargo.toml', 'pyproject.toml']) {
        const fp = join(projectPath, f)
        if (existsSync(fp)) {
          try { context[f] = readFileSync(fp, 'utf8').slice(0, 2000) } catch {}
        }
      }

      // Git log
      try {
        const { stdout } = await execFileAsync('git', ['log', '--oneline', '-10'], { cwd: projectPath, timeout: 5_000 })
        context['git_log'] = stdout.trim()
      } catch {}

      // Evolve/autoresearch state
      for (const f of ['evolve-progress.md', 'autoresearch.md', '.evolve/scorecard.json']) {
        const fp = join(projectPath, f)
        if (existsSync(fp)) {
          try { context[f] = readFileSync(fp, 'utf8').slice(0, 1000) } catch {}
        }
      }

      // Pursue docs
      try {
        for (const f of readdirSync(projectPath)) {
          if (f.startsWith('pursue-') && f.endsWith('.md')) {
            context[f] = readFileSync(join(projectPath, f), 'utf8').slice(0, 1000)
          }
        }
      } catch {}

      return json(res, context)
    }

    // ── Learning loop ──────────────────────────────────────────
    if (path === '/api/learn' && method === 'POST') {
      const result = runLearningLoop()
      return json(res, result)
    }

    if (path === '/api/analyze' && method === 'POST') {
      try {
        const result = await runDeepAnalysis()
        return json(res, result)
      } catch (e) {
        return error(res, e instanceof Error ? e.message : String(e), 500)
      }
    }

    if (path === '/api/cleanup' && method === 'POST') {
      try {
        const cleaned = await cleanupWorktrees()
        return json(res, { cleaned })
      } catch (e) {
        return error(res, e instanceof Error ? e.message : String(e), 500)
      }
    }

    // ── Self-improvement (Hyperagents-inspired) ────────────────
    // Dispatches a session on the Foreman repo itself.
    // The session works in a worktree, can modify service code,
    // runs tests, and opens a PR for operator review.
    if (path === '/api/self-improve' && method === 'POST') {
      const body = await readBody(req)
      const task = String(body.task ?? 'Review the Foreman service code and suggest improvements')
      const skill = String(body.skill ?? '/evolve')

      // Foreman's own repo
      const foremanRepo = process.cwd()

      // Create a goal if none exists for self-improvement
      let goalId: number
      const existingGoal = db.prepare(`SELECT id FROM goals WHERE intent LIKE '%foreman%self%' OR intent LIKE '%improve foreman%' LIMIT 1`).get() as { id: number } | undefined
      if (existingGoal) {
        goalId = existingGoal.id
      } else {
        const r = stmts.insertGoal.run('Improve Foreman itself — better prompts, better code, better outcomes', foremanRepo, 'repo', null, 0)
        goalId = Number(r.lastInsertRowid)
      }

      // Dispatch with worktree isolation
      const autoLabel = `self-${skill.replace(/^\//, '')}-${Date.now().toString(36)}`
      const wt = await createWorktree(foremanRepo, autoLabel)
      if (!wt) return error(res, 'Failed to create worktree for self-improvement')

      const sName = sessionName(autoLabel)
      const activeTpl = stmts.activeTemplate.get() as { version: number } | undefined
      const selfTask = `${task.slice(0, 500)}\n\nIMPORTANT: After making changes, run the type checker: ./node_modules/.bin/tsc --noEmit --esModuleInterop --target ES2022 --module nodenext --moduleResolution nodenext --skipLibCheck service/index.ts\nFix any errors before committing.`

      const result = stmts.insertDecision.run(goalId, skill, selfTask.slice(0, 500), 'self-improvement dispatch', sName, wt.path, wt.branch, wt.baseBranch, activeTpl?.version ?? 1, 'auto')
      const decisionId = Number(result.lastInsertRowid)

      const prompt = composePrompt({
        skill, task: selfTask, workDir: wt.path, goalIntent: 'Improve Foreman itself',
        goalId, worktreeBranch: wt.branch, baseBranch: wt.baseBranch, repoDir: foremanRepo,
      })

      const model = selectModel(skill, selfTask)
      spawnSession({ name: sName, workDir: wt.path, prompt, goalId, decisionId, model: model ?? undefined })

      return json(res, { decision: stmts.getDecision.get(decisionId), session: sName, worktree: wt.path, branch: wt.branch }, 201)
    }

    // ── Confidence ─────────────────────────────────────────────
    if (path === '/api/confidence' && method === 'GET') {
      const project = parseQuery(url).get('project') ?? undefined
      const entries = confidence.list(project)
      return json(res, entries)
    }

    if (path === '/api/confidence/override' && method === 'POST') {
      const body = await readBody(req)
      const project = String(body.project ?? '')
      const override = body.override ? String(body.override) : null
      if (!project) return error(res, 'project required')
      confidence.setOverride(project, override as any)
      return json(res, { ok: true, project, override })
    }

    if (path === '/api/confidence/log' && method === 'GET') {
      const limit = parseInt(parseQuery(url).get('limit') ?? '30', 10)
      return json(res, confidence.getLog(limit))
    }

    if (path === '/api/learnings' && method === 'GET') {
      const query = parseQuery(url)
      const type = query.get('type')
      const project = query.get('project')
      const limit = parseInt(query.get('limit') ?? '30', 10)

      if (project) return json(res, stmts.learningsByProject.all(project, limit))
      if (type) return json(res, stmts.learningsByType.all(type, limit))
      return json(res, stmts.allLearnings.all(limit))
    }

    if (path === '/api/templates' && method === 'GET') {
      return json(res, stmts.listTemplates.all(10))
    }

    if (path === '/api/stats' && method === 'GET') {
      const sessionCount = (stmts.operatorSessionCount.get() as { count: number }).count
      const decisionCount = (db.prepare(`SELECT COUNT(*) as c FROM decisions`).get() as { c: number }).c
      const learningCount = (db.prepare(`SELECT COUNT(*) as c FROM learnings`).get() as { c: number }).c
      const tasteCount = (db.prepare(`SELECT COUNT(*) as c FROM taste`).get() as { c: number }).c
      const successCount = (db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE status = 'success'`).get() as { c: number }).c
      const successRate = decisionCount > 0 ? successCount / decisionCount : 0

      // Origin breakdown
      const operatorDispatches = (db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE origin = 'operator'`).get() as { c: number }).c
      const autoDispatches = (db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE origin = 'auto'`).get() as { c: number }).c

      // Cost breakdown
      const totalCost = (db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) as total FROM decisions`).get() as { total: number }).total
      const todayCost = (db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) as total FROM decisions WHERE date(created_at) = date('now')`).get() as { total: number }).total
      const costBySkill = db.prepare(`
        SELECT skill, COUNT(*) as dispatches, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as successes,
               COALESCE(SUM(cost_usd), 0) as cost
        FROM decisions GROUP BY skill ORDER BY dispatches DESC
      `).all() as Array<{ skill: string, dispatches: number, successes: number, cost: number }>

      return json(res, {
        operatorSessions: sessionCount,
        decisions: decisionCount,
        operatorDispatches,
        autoDispatches,
        learnings: learningCount,
        tasteSignals: tasteCount,
        successRate: Math.round(successRate * 100),
        cost: {
          total: totalCost,
          today: todayCost,
          bySkill: costBySkill,
        },
      })
    }

    // ── MCP servers ─────────────────────────────────────────
    if (path === '/api/mcp' && method === 'GET') {
      return json(res, stmts.listMcp.all())
    }

    if (path === '/api/mcp' && method === 'POST') {
      const body = await readBody(req)
      const id = String(body.id ?? '')
      const name = String(body.name ?? id)
      const command = String(body.command ?? '')
      const args = body.args ? JSON.stringify(body.args) : '[]'
      const env = body.env ? JSON.stringify(body.env) : null
      const scope = String(body.scope ?? 'global')
      if (!id || !command) return error(res, 'id and command required')
      stmts.upsertMcp.run(id, name, command, args, env, scope)
      return json(res, { ok: true, id }, 201)
    }

    if (path.startsWith('/api/mcp/') && method === 'DELETE') {
      const id = decodeURIComponent(path.slice('/api/mcp/'.length))
      stmts.deleteMcp.run(id)
      return json(res, { ok: true, deleted: id })
    }

    // ── Plans ──────────────────────────────────────────────
    if (path === '/api/plans' && method === 'GET') {
      const status = parseQuery(url).get('status') ?? undefined
      return json(res, listPlans(status))
    }

    if (path === '/api/plans/generate' && method === 'POST') {
      // Build context from current state
      const goals = stmts.listGoals.all() as Array<{ intent: string, workspace_path: string | null }>
      const decisions = db.prepare(`
        SELECT d.skill, d.task, d.status, d.outcome, COALESCE(g.workspace_path, d.worktree_path) as project
        FROM decisions d LEFT JOIN goals g ON g.id = d.goal_id
        WHERE d.status IN ('success', 'failure')
        ORDER BY d.created_at DESC LIMIT 15
      `).all() as Array<{ skill: string, task: string, status: string, outcome: string | null, project: string }>

      const flows = stmts.learningsByType.all('flow', 10) as Array<{ content: string }>
      const prefs = stmts.learningsByType.all('skill_preference', 10) as Array<{ content: string }>
      const taste = stmts.listTaste.all(10) as Array<{ pattern: string }>
      const deadEnds = stmts.learningsByType.all('dead_end', 5) as Array<{ content: string }>

      // Find projects with recent sessions
      const recentProjects = db.prepare(`SELECT DISTINCT repo FROM operator_sessions WHERE repo != '' ORDER BY timestamp DESC LIMIT 10`)
        .all() as Array<{ repo: string }>

      const sessionCount = (stmts.operatorSessionCount.get() as { count: number }).count
      const learningCount = (db.prepare(`SELECT COUNT(*) as c FROM learnings`).get() as { c: number }).c

      const ctx: PlanGeneratorContext = {
        recentDecisions: decisions.map(d => ({
          skill: d.skill.slice(0, 20), task: d.task.slice(0, 100),
          status: d.status, outcome: d.outcome?.slice(0, 100) ?? null,
          project: (d.project ?? '').split('/').pop() ?? 'unknown',
        })),
        learnedFlows: flows.map(f => f.content),
        skillPreferences: prefs.map(p => p.content),
        tasteSignals: taste.map(t => t.pattern),
        deadEnds: deadEnds.map(d => d.content),
        activeGoals: goals.map(g => ({ intent: g.intent, workspacePath: g.workspace_path })),
        recentProjects: recentProjects.map(p => p.repo.split('/').pop() ?? p.repo),
        sessionCount,
        learningCount,
      }

      // Dispatch plan ideation as a regular Foreman session
      const dispatch = buildIdeationDispatch(ctx)
      const autoLabel = `plan-ideate-${Date.now().toString(36)}`
      const wt = await createWorktree(process.cwd(), autoLabel)
      if (!wt) return error(res, 'Failed to create worktree for plan ideation')

      const sName = sessionName(autoLabel)
      const activeTpl = stmts.activeTemplate.get() as { version: number } | undefined
      const result = stmts.insertDecision.run(
        null, '/plan', dispatch.prompt.slice(0, 500), 'plan ideation',
        sName, wt.path, wt.branch, wt.baseBranch, activeTpl?.version ?? 1, 'auto',
      )
      const decisionId = Number(result.lastInsertRowid)

      // Use the ideation prompt directly — it tells Claude to write JSON to a file
      spawnSession({
        name: sName, workDir: wt.path, prompt: dispatch.prompt,
        goalId: null as any, decisionId,
      })

      return json(res, {
        dispatched: true,
        session: sName,
        outputPath: dispatch.outputPath,
        message: 'Plan ideation dispatched. Check session status and parse output when complete.',
      }, 202)
    }

    if (path.startsWith('/api/plans/') && method === 'PATCH') {
      const id = decodeURIComponent(path.slice('/api/plans/'.length))
      const body = await readBody(req)
      const status = String(body.status ?? '')
      const tasteSignal = body.taste_signal ? String(body.taste_signal) as 'approved' | 'rejected' : undefined

      if (status === 'approved') {
        // Convert plan to goal
        const plan = getPlan(id)
        if (plan) {
          const goalResult = stmts.insertGoal.run(
            plan.proposedGoal.intent,
            plan.proposedGoal.workspacePath ?? null,
            'repo', null, 0,
          )
          updatePlanStatus(id, 'approved', 'approved')

          // Record taste — exploration approvals are worth 3x
          const weight = plan.isExploration ? 3.0 : 1.0
          stmts.insertTaste.run(`approved plan: ${plan.title.slice(0, 100)}`, `plan:${id}`, weight)

          return json(res, { ok: true, id, goalId: Number(goalResult.lastInsertRowid) })
        }
      }

      if (status === 'rejected') {
        const plan = getPlan(id)
        updatePlanStatus(id, 'rejected', 'rejected')
        if (plan) {
          const weight = plan.isExploration ? -1.0 : -1.5  // rejecting exploitation is stronger signal
          stmts.insertTaste.run(`rejected plan: ${plan.title.slice(0, 100)}`, `plan:${id}`, weight)
        }
        return json(res, { ok: true, id, status: 'rejected' })
      }

      return error(res, 'status must be approved or rejected')
    }

    // ── Skill proposals ─────────────────────────────────────
    if (path === '/api/proposals' && method === 'GET') {
      const status = parseQuery(url).get('status') ?? undefined
      return json(res, listProposals(status))
    }

    if (path === '/api/proposals' && method === 'POST') {
      const body = await readBody(req)
      const proposal = createProposal({
        skillName: String(body.skillName ?? ''),
        proposedSkillMd: String(body.proposedSkillMd ?? ''),
        evidence: (body.evidence as string[]) ?? [],
        whatImproves: (body.whatImproves as string[]) ?? [],
        whatCouldGoWrong: (body.whatCouldGoWrong as string[]) ?? [],
        whatWouldBeRemoved: (body.whatWouldBeRemoved as string[]) ?? [],
      })
      return json(res, proposal, 201)
    }

    if (path.startsWith('/api/proposals/') && path.endsWith('/pr') && method === 'POST') {
      // Open a draft PR for this proposal against the skill's source repo
      const id = decodeURIComponent(path.slice('/api/proposals/'.length).replace(/\/pr$/, ''))
      try {
        const prUrl = await openSkillPR(id)
        if (!prUrl) return error(res, 'Could not open PR — skill may not be in a git repo', 400)
        return json(res, { ok: true, id, prUrl })
      } catch (e) {
        return error(res, e instanceof Error ? e.message : String(e), 500)
      }
    }

    if (path.startsWith('/api/proposals/') && method === 'PATCH') {
      const id = decodeURIComponent(path.slice('/api/proposals/'.length))
      const body = await readBody(req)
      const status = String(body.status ?? '')
      if (status !== 'approved' && status !== 'rejected') return error(res, 'status must be approved or rejected')
      const ok = updateProposalStatus(id, status)
      if (!ok) return error(res, 'proposal not found', 404)
      return json(res, { ok: true, id, status })
    }

    // ── Session search (FTS5 index) ─────────────────────────
    if (path === '/api/search' && method === 'GET') {
      const q = parseQuery(url).get('q') ?? ''
      const limit = parseInt(parseQuery(url).get('limit') ?? '20', 10)
      if (!q) return error(res, 'q required')

      try {
        const { SessionIndex } = await import('@drew/foreman-memory/session-index')
        const idx = new SessionIndex()
        const results = idx.search({ query: q, limit })
        const formatted = results.map((r: any) => ({
          text: r.message?.text?.slice(0, 300),
          repo: r.message?.repo,
          harness: r.message?.harness,
          timestamp: r.message?.timestamp,
          role: r.message?.role,
        }))
        idx.close()
        return json(res, formatted)
      } catch (e) {
        // Session index may not be built yet
        return json(res, [])
      }
    }

    // ── 404 ───────────────────────────────────────────────────
    error(res, `Not found: ${path}`, 404)

  } catch (e) {
    error(res, e instanceof Error ? e.message : String(e), 500)
  }
}

// ─── Server ──────────────────────────────────────────────────────────

const server = http.createServer(handleRequest)

server.listen(PORT, '127.0.0.1', () => {
  log(`Foreman service listening on http://127.0.0.1:${PORT}`)
  log(`Database: ${DB_PATH}`)
  log(`Home: ${FOREMAN_HOME}`)

  // Start session watcher
  setInterval(watcherTick, WATCHER_INTERVAL_MS)
  log(`Session watcher running (${WATCHER_INTERVAL_MS / 1000}s interval)`)

  // Zombie session reaper — every 5 minutes
  setInterval(async () => {
    const reaped = await reapZombieSessions()
    if (reaped > 0) log(`Reaped ${reaped} zombie sessions`)
  }, 5 * 60 * 1000)

  // Run initial learning loop (fast pattern extraction), then every hour
  setTimeout(() => {
    const result = runLearningLoop()
    log(`Initial learning: scanned ${result.scanned} sessions, extracted ${result.extracted} learnings`)
  }, 5_000)
  setInterval(() => {
    const result = runLearningLoop()
    if (result.scanned > 0 || result.extracted > 0) {
      log(`Learning loop: scanned ${result.scanned}, extracted ${result.extracted}`)
    }
  }, 60 * 60 * 1000) // every hour

  // Deep analysis (LLM-powered) — runs every 6 hours, dispatches Claude
  // to analyze operator sessions and extract workflows, taste, anti-patterns.
  // First run after 2 minutes (let fast learning finish first).
  setTimeout(async () => {
    try {
      const result = await runDeepAnalysis()
      if (result.flows > 0) log(`Deep analysis: ${result.analyzed} sessions → ${result.flows} new flows`)
    } catch (e) { log(`Deep analysis failed: ${e}`) }
  }, 2 * 60 * 1000)
  setInterval(async () => {
    try {
      const result = await runDeepAnalysis()
      if (result.flows > 0) log(`Deep analysis: ${result.analyzed} sessions → ${result.flows} new flows`)
    } catch (e) { log(`Deep analysis failed: ${e}`) }
  }, DEEP_ANALYSIS_INTERVAL_MS)

  // Worktree cleanup — every 6 hours
  setInterval(async () => {
    const cleaned = await cleanupWorktrees()
    if (cleaned > 0) log(`Cleaned ${cleaned} stale worktrees`)
  }, 6 * 60 * 60 * 1000)

  // GEPA dispatch policy — retrain every 6 hours from accumulated decisions
  if (process.env.FOREMAN_DISPATCH_POLICY === 'gepa') {
    const trainGepaPolicy = async () => {
      const decisions = db.prepare(`
        SELECT d.skill, d.task, d.status, d.outcome, d.goal_id,
               g.intent as goal_intent, g.workspace_path
        FROM decisions d
        LEFT JOIN goals g ON g.id = d.goal_id
        WHERE d.status IN ('success', 'failure') AND d.skill != ''
        ORDER BY d.created_at DESC LIMIT 50
      `).all() as Array<{
        skill: string, task: string, status: string, outcome: string | null,
        goal_id: number | null, goal_intent: string | null, workspace_path: string | null
      }>

      if (decisions.length < 5) { log('GEPA policy: need 5+ decisions'); return }

      const flows = stmts.learningsByType.all('flow', 10) as Array<{ content: string }>
      const prefs = stmts.learningsByType.all('skill_preference', 10) as Array<{ content: string }>

      const trainingData = decisions.map(d => ({
        context: {
          goalIntent: d.goal_intent ?? d.task.slice(0, 100),
          projectName: (d.workspace_path ?? '').split('/').pop() ?? 'unknown',
          recentDecisions: [{ skill: d.skill, status: d.status, outcome: d.outcome }],
          learnedFlows: flows.map(f => f.content),
          skillPreferences: prefs.map(p => p.content),
          confidenceLevel: 'dry-run',
        },
        decision: { skill: d.skill, task: d.task.slice(0, 200), reasoning: '' },
        outcome: d.status as 'success' | 'failure',
      }))

      await initGepaPolicy(trainingData)
    }

    // Initial training after 30 seconds
    setTimeout(() => trainGepaPolicy().catch(e => log(`GEPA policy train failed: ${e}`)), 30_000)
    // Retrain every 6 hours
    setInterval(() => trainGepaPolicy().catch(e => log(`GEPA policy retrain failed: ${e}`)), 6 * 60 * 60 * 1000)
  }

  // Helper to build plan context from current state
  const buildPlanContext = (): PlanGeneratorContext => {
    const goals = stmts.listGoals.all() as Array<{ intent: string, workspace_path: string | null }>
    const decisions = db.prepare(`SELECT d.skill, d.task, d.status, d.outcome, COALESCE(g.workspace_path, d.worktree_path) as project FROM decisions d LEFT JOIN goals g ON g.id = d.goal_id WHERE d.status IN ('success','failure') ORDER BY d.created_at DESC LIMIT 15`).all() as any[]
    const flows = stmts.learningsByType.all('flow', 10) as any[]
    const prefs = stmts.learningsByType.all('skill_preference', 10) as any[]
    const taste = stmts.listTaste.all(10) as any[]
    const deadEnds = stmts.learningsByType.all('dead_end', 5) as any[]
    const recentProjects = db.prepare(`SELECT DISTINCT repo FROM operator_sessions WHERE repo != '' ORDER BY timestamp DESC LIMIT 10`).all() as any[]
    const sessionCount = (stmts.operatorSessionCount.get() as { count: number }).count
    const learningCount = (db.prepare(`SELECT COUNT(*) as c FROM learnings`).get() as { c: number }).c
    return {
      recentDecisions: decisions.map((d: any) => ({ skill: (d.skill??'').slice(0,20), task: (d.task??'').slice(0,100), status: d.status, outcome: d.outcome?.slice(0,100)??null, project: (d.project??'').split('/').pop()??'?' })),
      learnedFlows: flows.map((f: any) => f.content), skillPreferences: prefs.map((p: any) => p.content),
      tasteSignals: taste.map((t: any) => t.pattern), deadEnds: deadEnds.map((d: any) => d.content),
      activeGoals: goals.map(g => ({ intent: g.intent, workspacePath: g.workspace_path })),
      recentProjects: recentProjects.map((p: any) => (p.repo??'').split('/').pop() ?? ''),
      sessionCount, learningCount,
    }
  }

  // Plan generation — dispatched as regular Foreman sessions every 12 hours
  // Uses the same dispatch pipeline as all other work
  const dispatchPlanIdeation = async () => {
    const pending = listPlans('proposed')
    if (pending.length >= 5) return
    log('Dispatching plan ideation session...')
    // Build context and dispatch
    const ctx = buildPlanContext()
    const dispatch = buildIdeationDispatch(ctx)
    const autoLabel = `plan-ideate-${Date.now().toString(36)}`
    const sName = sessionName(autoLabel)
    const activeTpl = stmts.activeTemplate.get() as { version: number } | undefined
    const result = stmts.insertDecision.run(
      null, '/plan', dispatch.prompt.slice(0, 500), 'auto plan ideation',
      sName, null, null, null, activeTpl?.version ?? 1, 'auto',
    )
    spawnSession({
      name: sName, workDir: dispatch.workspace, prompt: dispatch.prompt,
      goalId: null as any, decisionId: Number(result.lastInsertRowid),
    })
    log(`Plan ideation dispatched: ${sName}`)
  }
  setTimeout(() => dispatchPlanIdeation().catch(e => log(`Plan ideation failed: ${e}`)), 5 * 60 * 1000)
  setInterval(() => dispatchPlanIdeation().catch(e => log(`Plan ideation failed: ${e}`)), 12 * 60 * 60 * 1000)

  // Bootstrap prompt template if none exists
  const hasTemplate = stmts.activeTemplate.get()
  if (!hasTemplate) {
    stmts.insertTemplate.run(1, 'v1-default', 1)
    log('Bootstrapped prompt template v1')
  }
})

// Graceful shutdown
process.on('SIGTERM', () => { log('Shutting down'); confidence.close(); db.close(); server.close(); process.exit(0) })
process.on('SIGINT', () => { log('Shutting down'); confidence.close(); db.close(); server.close(); process.exit(0) })
