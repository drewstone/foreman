/**
 * Foreman daemon.
 *
 * Event loop that reacts to file changes, webhooks, and timers.
 * Feeds the policy function and manages confidence gating.
 *
 * This is the nervous system. Policy is the brain.
 */

import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat, mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ConfidenceStore } from '@drew/foreman-memory/confidence'
import { runPolicyCycle, type PolicyDecision } from './policy.js'
import type { ForemanEvent } from './state-snapshot.js'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
const LOG_PATH = join(FOREMAN_HOME, 'logs', 'daemon.log')

// ─── Configuration ──────────────────────────────────────────────────

export interface DaemonConfig {
  dryRun: boolean
  pollIntervalMs: number           // default: 5 minutes
  minPolicyCycleMs: number         // rate limit: min gap between policy calls
  maxActionsPerHour: number        // safety: max actions in rolling hour
  watchSessionDirs: boolean        // watch ~/.claude, ~/.pi, etc.
  watchGitDirs: string[]           // managed repo paths to watch
  logPath: string
}

const DEFAULT_CONFIG: DaemonConfig = {
  dryRun: false,
  pollIntervalMs: 5 * 60 * 1000,
  minPolicyCycleMs: 60 * 1000,
  maxActionsPerHour: 10,
  watchSessionDirs: true,
  watchGitDirs: [],
  logPath: LOG_PATH,
}

// ─── Daemon state ───────────────────────────────────────────────────

interface DaemonState {
  running: boolean
  lastPolicyCycle: number
  recentEvents: ForemanEvent[]
  recentActions: Array<{ timestamp: number }>
  watchers: FSWatcher[]
  pollTimer: ReturnType<typeof setInterval> | null
  confidenceStore: ConfidenceStore
}

// ─── Event queue ────────────────────────────────────────────────────

function createEvent(
  type: ForemanEvent['type'],
  project: string,
  data: Record<string, string> = {},
): ForemanEvent {
  return {
    type,
    project,
    timestamp: new Date().toISOString(),
    data,
  }
}

// ─── Debouncing ─────────────────────────────────────────────────────

let debounceTimer: ReturnType<typeof setTimeout> | null = null
const DEBOUNCE_MS = 5000 // batch events within 5 seconds

function debouncedPolicyCycle(state: DaemonState, config: DaemonConfig): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    triggerPolicyCycle(state, config).catch((e) => {
      log(config, `Policy cycle error: ${e}`)
    })
  }, DEBOUNCE_MS)
}

// ─── Logging ────────────────────────────────────────────────────────

async function log(config: DaemonConfig, msg: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  process.stdout.write(line)
  try {
    await mkdir(join(config.logPath, '..'), { recursive: true })
    await appendFile(config.logPath, line, 'utf8')
  } catch { /* best effort */ }
}

// ─── File watchers ──────────────────────────────────────────────────

function watchSessionDirs(state: DaemonState, config: DaemonConfig): void {
  const sessionDirs = [
    join(homedir(), '.claude', 'projects'),
    join(homedir(), '.pi'),
    join(homedir(), '.codex'),
  ]

  for (const dir of sessionDirs) {
    try {
      const harness = dir.includes('.claude') ? 'claude'
        : dir.includes('.pi') ? 'pi'
        : 'codex'

      const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return
        const event = createEvent('session-ended', harness, { file: filename })
        pushEvent(state, config, event)
      })
      state.watchers.push(watcher)
      log(config, `Watching: ${dir}`)
    } catch {
      // Dir may not exist
    }
  }
}

function watchGitDirs(state: DaemonState, config: DaemonConfig): void {
  for (const repoPath of config.watchGitDirs) {
    try {
      const gitDir = join(repoPath, '.git')
      const watcher = watch(gitDir, { recursive: false }, (_eventType, filename) => {
        if (!filename) return
        const name = repoPath.split('/').pop() ?? repoPath
        if (filename.includes('HEAD') || filename.includes('refs')) {
          const event = createEvent('git-push', name, { repo: repoPath, ref: filename })
          pushEvent(state, config, event)
        }
      })
      state.watchers.push(watcher)
      log(config, `Watching git: ${repoPath}`)
    } catch {
      // Repo may not exist
    }
  }
}

// ─── Event handling ─────────────────────────────────────────────────

function pushEvent(state: DaemonState, config: DaemonConfig, event: ForemanEvent): void {
  // Deduplicate rapid identical events
  const last = state.recentEvents[state.recentEvents.length - 1]
  if (last && last.type === event.type && last.project === event.project
    && Date.now() - new Date(last.timestamp).getTime() < 1000) {
    return // skip duplicate within 1 second
  }

  state.recentEvents.push(event)
  if (state.recentEvents.length > 50) {
    state.recentEvents = state.recentEvents.slice(-50)
  }

  log(config, `Event: [${event.type}] ${event.project}`)

  // Debounce: batch rapid events into single policy cycle
  debouncedPolicyCycle(state, config)
}

// ─── Policy cycle ───────────────────────────────────────────────────

async function triggerPolicyCycle(state: DaemonState, config: DaemonConfig): Promise<void> {
  if (!state.running) return

  const now = Date.now()

  // Rate limit
  if (now - state.lastPolicyCycle < config.minPolicyCycleMs) return
  state.lastPolicyCycle = now

  // Safety: max actions per hour
  const oneHourAgo = now - 60 * 60 * 1000
  state.recentActions = state.recentActions.filter((a) => a.timestamp > oneHourAgo)
  if (state.recentActions.length >= config.maxActionsPerHour) {
    await log(config, `Rate limited: ${state.recentActions.length} actions in last hour (max ${config.maxActionsPerHour})`)
    return
  }

  await log(config, 'Running policy cycle...')

  const decision = await runPolicyCycle({
    dryRun: config.dryRun,
    confidenceStore: state.confidenceStore,
    recentEvents: state.recentEvents.slice(-10),
    onProgress: (msg) => log(config, `  ${msg}`),
  })

  if (decision.executed) {
    state.recentActions.push({ timestamp: now })
  }

  const actionDesc = decision.action
    ? `${decision.action.type} on ${decision.action.project}`
    : 'do-nothing'
  const execDesc = decision.executed
    ? `EXECUTED (${decision.outcome?.success ? 'success' : 'failure'})`
    : `NOT EXECUTED (${decision.confidenceLevel})`

  await log(config, `Decision: ${actionDesc} → ${execDesc}`)
}

// ─── Timer-based polling ────────────────────────────────────────────

function startPollTimer(state: DaemonState, config: DaemonConfig): void {
  state.pollTimer = setInterval(() => {
    // Only push timer events, don't log each one — too noisy
    state.recentEvents.push(createEvent('timer', 'system', { source: 'poll' }))
    if (state.recentEvents.length > 50) {
      state.recentEvents = state.recentEvents.slice(-50)
    }
    // Trigger policy directly (not through pushEvent to avoid log spam)
    triggerPolicyCycle(state, config).catch((e) => {
      log(config, `Poll cycle error: ${e}`)
    })
  }, config.pollIntervalMs)
}

// ─── Public API ─────────────────────────────────────────────────────

export interface ForemanDaemon {
  start(): Promise<void>
  stop(): void
  getState(): {
    running: boolean
    recentEvents: ForemanEvent[]
    recentActionsCount: number
    lastPolicyCycle: string | null
  }
}

export function createDaemon(overrides?: Partial<DaemonConfig>): ForemanDaemon {
  const config: DaemonConfig = { ...DEFAULT_CONFIG, ...overrides }
  const state: DaemonState = {
    running: false,
    lastPolicyCycle: 0,
    recentEvents: [],
    recentActions: [],
    watchers: [],
    pollTimer: null,
    confidenceStore: new ConfidenceStore(),
  }

  return {
    async start() {
      state.running = true
      await log(config, `Foreman daemon starting (dryRun: ${config.dryRun})`)

      // Set up watchers
      if (config.watchSessionDirs) {
        watchSessionDirs(state, config)
      }
      if (config.watchGitDirs.length > 0) {
        watchGitDirs(state, config)
      }

      // Start poll timer
      startPollTimer(state, config)

      // Run initial policy cycle
      await triggerPolicyCycle(state, config)

      await log(config, 'Foreman daemon running')

      // Handle shutdown
      const shutdown = () => {
        this.stop()
        process.exit(0)
      }
      process.on('SIGTERM', shutdown)
      process.on('SIGINT', shutdown)
    },

    stop() {
      state.running = false
      for (const w of state.watchers) {
        try { w.close() } catch {}
      }
      state.watchers = []
      if (state.pollTimer) {
        clearInterval(state.pollTimer)
        state.pollTimer = null
      }
      state.confidenceStore.close()
      log(config, 'Foreman daemon stopped')
    },

    getState() {
      return {
        running: state.running,
        recentEvents: state.recentEvents,
        recentActionsCount: state.recentActions.length,
        lastPolicyCycle: state.lastPolicyCycle > 0
          ? new Date(state.lastPolicyCycle).toISOString()
          : null,
      }
    },
  }
}
