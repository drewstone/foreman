/**
 * Shared service context — passed to all modules instead of globals.
 * This is the dependency injection root for the Foreman service.
 */

import type Database from 'better-sqlite3'
import type { ConfidenceStore } from '@drew/foreman-memory/confidence'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface ServiceConfig {
  port: number
  foremanHome: string
  dbPath: string
  claudeBin: string
  maxDailyCostUsd: number
  maxConcurrentSessions: number
  autoMerge: boolean
  postCompletionStrategy: string
  optimizerStrategy: string
}

export interface ServiceContext {
  config: ServiceConfig
  db: InstanceType<typeof Database>
  stmts: Record<string, any>  // prepared statements
  confidence: ConfidenceStore
  log: (msg: string) => void
  emitEvent: (type: string, sessionName: string | null, goalId: number | null, data?: Record<string, unknown>) => void
}

export function loadConfig(): ServiceConfig {
  const home = homedir()
  return {
    port: parseInt(process.env.FOREMAN_PORT ?? '7374', 10),
    foremanHome: process.env.FOREMAN_HOME ?? join(home, '.foreman'),
    dbPath: join(process.env.FOREMAN_HOME ?? join(home, '.foreman'), 'foreman.db'),
    claudeBin: process.env.CLAUDE_PATH ?? join(home, '.local/bin/claude'),
    maxDailyCostUsd: parseFloat(process.env.FOREMAN_MAX_DAILY_COST ?? '20'),
    maxConcurrentSessions: parseInt(process.env.FOREMAN_MAX_SESSIONS ?? '5', 10),
    autoMerge: process.env.FOREMAN_AUTO_MERGE === 'true',
    postCompletionStrategy: process.env.FOREMAN_POST_COMPLETION ?? 'digest',
    optimizerStrategy: process.env.FOREMAN_OPTIMIZER ?? 'identity',
  }
}
