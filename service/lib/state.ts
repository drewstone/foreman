/**
 * Shared state singleton for the Foreman service.
 * Initialized once by index.ts, imported by all extracted modules.
 */

import type Database from 'better-sqlite3'
import type { ConfidenceStore } from '@drew/foreman-memory/confidence'
import http from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ─── Config ──────────────────────────────────────────────────────────

export const PORT = parseInt(process.env.FOREMAN_PORT ?? '7374', 10)
export const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
export const CLAUDE_BIN = process.env.CLAUDE_PATH ?? join(homedir(), '.local/bin/claude')
export const ENV = { ...process.env, PATH: `${homedir()}/.local/bin:${process.env.PATH}` }
export const WATCHER_INTERVAL_MS = 10_000
export const CLAUDE_BOOT_POLL_MS = 3_000
export const MAX_DAILY_COST_USD = parseFloat(process.env.FOREMAN_MAX_DAILY_COST ?? '20')
export const MAX_CONCURRENT_SESSIONS = parseInt(process.env.FOREMAN_MAX_SESSIONS ?? '5', 10)
export const AUTO_MERGE = process.env.FOREMAN_AUTO_MERGE === 'true'
export const CLAUDE_BOOT_TIMEOUT_MS = 60_000
export const POST_COMPLETION_STRATEGY = process.env.FOREMAN_POST_COMPLETION ?? 'digest'
export const OPTIMIZER_STRATEGY = process.env.FOREMAN_OPTIMIZER ?? 'identity'

// ─── Types ───────────────────────────────────────────────────────────

export interface SpawnRequest {
  name: string
  workDir: string
  prompt: string
  goalId: number
  decisionId: number
  backend?: string
  model?: string
}

export interface ExecutionBackend {
  spawn(req: SpawnRequest): void
  isAlive(name: string): boolean
  isIdle(name: string): boolean
  capture(name: string, lines: number): string
  kill(name: string): void
}

export interface PostCompletionDigest {
  summary: string | null
  qualityScore: number | null
  goalAchieved: boolean | null
  learnings: string[] | null
  nextAction: { skill: string, task: string } | null
  fullLogPath: string | null
}

export interface PostCompletionAgent {
  name: string
  run(ctx: {
    decisionId: number
    sessionName: string
    skill: string
    task: string
    workDir: string
    output: string
    status: string
    outcomeText: string
  }): Promise<Partial<PostCompletionDigest>>
}

// ─── Prepared statement types ────────────────────────────────────────

export interface Stmts {
  insertGoal: Database.Statement
  updateGoal: Database.Statement
  getGoal: Database.Statement
  listGoals: Database.Statement

  insertDecision: Database.Statement
  updateDecision: Database.Statement
  getDecision: Database.Statement
  listDecisions: Database.Statement
  searchDecisions: Database.Statement
  goalDecisions: Database.Statement

  insertSession: Database.Statement
  updateSession: Database.Statement
  getSession: Database.Statement
  listSessions: Database.Statement
  activeSessions: Database.Statement
  deleteSession: Database.Statement

  insertTaste: Database.Statement
  listTaste: Database.Statement

  insertEvent: Database.Statement
  recentEvents: Database.Statement

  upsertMcp: Database.Statement
  deleteMcp: Database.Statement
  listMcp: Database.Statement
  getMcp: Database.Statement
  mcpByScope: Database.Statement

  upsertOperatorSession: Database.Statement
  operatorSessionCount: Database.Statement
  recentOperatorSessions: Database.Statement
  latestScanTimestamp: Database.Statement

  insertLearning: Database.Statement
  learningsByType: Database.Statement
  learningsByProject: Database.Statement
  allLearnings: Database.Statement

  insertTemplate: Database.Statement
  activeTemplate: Database.Statement
  updateTemplateScore: Database.Statement
  promoteTemplate: Database.Statement
  listTemplates: Database.Statement
}

// ─── Singleton state ─────────────────────────────────────────────────

let _db: Database.Database
let _stmts: Stmts
let _confidence: ConfidenceStore

export function initState(db: Database.Database, stmts: Stmts, confidence: ConfidenceStore): void {
  _db = db
  _stmts = stmts
  _confidence = confidence
}

export function getDb(): Database.Database { return _db }
export function getStmts(): Stmts { return _stmts }
export function getConfidence(): ConfidenceStore { return _confidence }

// ─── SSE clients ─────────────────────────────────────────────────────

export const sseClients = new Set<http.ServerResponse>()

// ─── Logging ─────────────────────────────────────────────────────────

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
}

// ─── Events ──────────────────────────────────────────────────────────

export function emitEvent(type: string, sessionName: string | null, goalId: number | null, data?: Record<string, unknown>): void {
  _stmts.insertEvent.run(type, sessionName, goalId, data ? JSON.stringify(data) : null)

  const event = { type, sessionName, goalId, data, timestamp: new Date().toISOString() }
  const payload = `data: ${JSON.stringify(event)}\n\n`

  for (const client of sseClients) {
    try { client.write(payload) } catch { sseClients.delete(client) }
  }
}

// ─── Notifications ───────────────────────────────────────────────────

export function sendNotification(title: string, body: string): void {
  try {
    const { execFileSync } = require('node:child_process')
    execFileSync('notify-send', [title, body, '--app-name=Foreman', '--urgency=normal'], { stdio: 'ignore', timeout: 3_000 })
  } catch {}
}
