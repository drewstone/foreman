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
import { runPolicyCycle, clearDedup, type PolicyDecision } from './policy.js'
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
  maxActionsPerHour: 30,
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

function debouncedPolicyCycle(state: DaemonState, config: DaemonConfig): void {
  // Don't schedule if we're within the rate limit window
  const now = Date.now()
  if (now - state.lastPolicyCycle < config.minPolicyCycleMs) return

  // Debounce: fire 30s after FIRST event, not 30s of silence
  // (active sessions generate continuous events — waiting for silence never works)
  if (debounceTimer) return // already scheduled, let it fire
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    triggerPolicyCycle(state, config).catch((e) => {
      log(config, `Policy cycle error: ${e}`)
    })
  }, 30_000)
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

function watchSessionDirs(state: DaemonState, _config: DaemonConfig): void {
  // Skip session dir watchers — they exhaust inotify instances on large
  // session stores (~/.claude/projects has thousands of nested dirs).
  // The poll timer handles session discovery instead.
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

  // New events clear dedup so the policy can reconsider with fresh context
  clearDedup()

  // Debounce: batch rapid events into single policy cycle
  debouncedPolicyCycle(state, config)
}

// ─── Policy cycle ───────────────────────────────────────────────────

let policyRunning = false

async function triggerPolicyCycle(state: DaemonState, config: DaemonConfig): Promise<void> {
  if (!state.running) return

  // Mutex: only one policy cycle at a time (prevents concurrent spawns)
  if (policyRunning) return
  policyRunning = true

  const now = Date.now()

  // Rate limit
  if (now - state.lastPolicyCycle < config.minPolicyCycleMs) {
    policyRunning = false
    return
  }
  state.lastPolicyCycle = now

  // Safety: max actions per hour
  const oneHourAgo = now - 60 * 60 * 1000
  state.recentActions = state.recentActions.filter((a) => a.timestamp > oneHourAgo)
  if (state.recentActions.length >= config.maxActionsPerHour) {
    await log(config, `Rate limited: ${state.recentActions.length} actions in last hour (max ${config.maxActionsPerHour})`)
    return
  }

  await log(config, 'Running policy cycle...')

  try {
    const decision = await runPolicyCycle({
      dryRun: config.dryRun,
      confidenceStore: state.confidenceStore,
      recentEvents: state.recentEvents.slice(-10),
      watchedDirs: config.watchGitDirs,
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
  } finally {
    policyRunning = false
  }
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
