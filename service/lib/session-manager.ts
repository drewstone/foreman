/**
 * Session manager — tmux helpers, execution backends, spawn, prompt delivery.
 */

import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import {
  type SpawnRequest, type ExecutionBackend,
  ENV, FOREMAN_HOME, CLAUDE_BIN,
  getStmts, log, emitEvent,
} from './state.js'

const execFileAsync = promisify(execFile)

// ─── Tmux helpers ────────────────────────────────────────────────────

export function tmux(args: string[]): string {
  try {
    return execFileSync('tmux', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      env: ENV,
    }) as string
  } catch { return '' }
}

export function tmuxQuiet(args: string[]): boolean {
  try {
    execFileSync('tmux', args, { stdio: 'ignore', timeout: 5_000, env: ENV })
    return true
  } catch { return false }
}

export function isTmuxAlive(name: string): boolean {
  return tmuxQuiet(['has-session', '-t', name])
}

export function captureTmux(name: string, lines: number = 30): string {
  return tmux(['capture-pane', '-t', name, '-p', '-S', `-${lines}`])
}

export function detectIdle(name: string): boolean {
  if (!isTmuxAlive(name)) return false
  try {
    const output = captureTmux(name, 10).trim()

    const activePatterns = [
      /tokens · thinking\)/,
      /Waiting for task/i,
      /⎿ {2}.*running/i,
    ]
    for (const pat of activePatterns) {
      if (pat.test(output)) return false
    }

    const hasCompletion = /[✻✓✶✽●].*\b\w+(?:ed|ing).*\bfor\b/i.test(output)
    const hasPrompt = output.includes('❯')

    const lines = output.split('\n').map(l => l.trim()).filter(Boolean)
    const last = lines.pop() ?? ''
    if (last.endsWith('$') || last.endsWith('#')) return true

    if (hasPrompt && hasCompletion) return true
    if (output.includes('Session complete')) return true

    return false
  } catch { return false }
}

export function detectClaudeReady(name: string): boolean {
  try {
    const p = captureTmux(name, 5)
    return p.includes('❯') || p.includes('▐▛')
  } catch { return false }
}

export function sessionName(label: string): string {
  return `foreman-${label}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50)
}

// ─── MCP config generation ───────────────────────────────────────────

export function generateMcpConfig(sessionName: string): string {
  const stmts = getStmts()
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

// ─── Pending prompts ─────────────────────────────────────────────────

export const pendingPrompts = new Map<string, SpawnRequest>()

// ─── tmux backend ────────────────────────────────────────────────────

export const tmuxBackend: ExecutionBackend = {
  spawn(req: SpawnRequest): void {
    const { name, workDir, prompt } = req
    const model = req.model ?? ''
    const modelFlag = model ? ` --model ${model}` : ''

    if (isTmuxAlive(name)) {
      tmuxQuiet(['kill-session', '-t', name])
    }

    tmuxQuiet(['new-session', '-d', '-s', name, '-c', workDir])

    const logFile = join(FOREMAN_HOME, 'logs', `session-${name}.log`)
    mkdirSync(join(FOREMAN_HOME, 'logs'), { recursive: true })
    tmuxQuiet(['pipe-pane', '-t', name, `-o`, `cat >> "${logFile}"`])

    const mcpFlag = generateMcpConfig(name)

    tmuxQuiet(['send-keys', '-t', name, `${CLAUDE_BIN} --dangerously-skip-permissions${modelFlag}${mcpFlag}`, 'Enter'])

    pendingPrompts.set(name, req)
    const stmts = getStmts()
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

// ─── Tangle Sandbox backend ──────────────────────────────────────────

import type {
  SandboxClientConfig,
  CreateSandboxOptions,
  TaskOptions,
  TaskResult,
  BackendConfig,
} from '@tangle-network/sandbox'

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

async function spawnTangleSandbox(req: SpawnRequest): Promise<void> {
  const client = await createTangleClient()
  const stmts = getStmts()

  const backendType: BackendConfig['type'] = req.model === 'codex' ? 'codex' : 'claude-code'

  const createOpts: CreateSandboxOptions = {
    name: `foreman-${req.name}`,
    backend: { type: backendType },
    metadata: {
      foremanSession: req.name,
      foremanDecision: String(req.decisionId),
    },
  }

  if (req.workDir.startsWith('http') || req.workDir.startsWith('git@')) {
    createOpts.git = { url: req.workDir }
  }

  const sandbox = await client.create(createOpts)
  const sandboxId = sandbox.id

  tangleSandboxes.set(req.name, { sandboxId, status: 'running' })
  stmts.updateSession.run('running', `sandbox:${sandboxId}`, req.name)
  emitEvent('session_started', req.name, req.goalId, { sandboxId })

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

export const tangleBackend: ExecutionBackend = {
  spawn(req: SpawnRequest): void {
    const stmts = getStmts()
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

// ─── Backend registry ────────────────────────────────────────────────

const backends: Record<string, ExecutionBackend> = {
  tmux: tmuxBackend,
  tangle: tangleBackend,
}

export function getBackend(name?: string): ExecutionBackend {
  return backends[name ?? 'tmux'] ?? tmuxBackend
}

export function spawnSession(req: SpawnRequest): void {
  getBackend(req.backend).spawn(req)
}

// ─── Model routing ───────────────────────────────────────────────────

export function selectModel(skill: string, _task: string): string | undefined {
  const stmts = getStmts()
  const prefs = stmts.learningsByType.all('skill_preference', 10) as Array<{ content: string }>
  for (const p of prefs) {
    if (p.content.includes(skill) && p.content.includes('opus')) return 'opus'
    if (p.content.includes(skill) && p.content.includes('haiku')) return 'haiku'
    if (p.content.includes(skill) && p.content.includes('sonnet')) return 'sonnet'
  }

  switch (skill) {
    case '/converge': return 'sonnet'
    case '/verify': return 'sonnet'
    case '/polish': return 'sonnet'
    case '/pursue': return undefined
    case '/evolve': return undefined
    case '/critical-audit': return undefined
    default: return undefined
  }
}

// ─── Prompt delivery ─────────────────────────────────────────────────

export function sendPrompt(name: string, prompt: string): void {
  const promptDir = join(FOREMAN_HOME, 'prompts')
  mkdirSync(promptDir, { recursive: true })
  const promptFile = join(promptDir, `${name}.md`)
  writeFileSync(promptFile, prompt)

  const instruction = `Read ${promptFile} — that is your complete task. Execute it fully. Do not summarize or ask questions.`
  tmuxQuiet(['send-keys', '-t', name, '-l', instruction])
  tmuxQuiet(['send-keys', '-t', name, 'Enter'])
}
