import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export type ConfidenceSignal = 'agree' | 'disagree' | 'success' | 'failure' | 'transfer'
export type ConfidenceLevel = 'dry-run' | 'propose' | 'act-notify' | 'autonomous'
export type ConfidenceOverride = 'never-auto' | 'always-auto'

export const ACTION_TYPES = [
  'spawn-session', 'resume-session', 'create-pr', 'invoke-skill',
  'run-experiment', 'cross-pollinate', 'send-notification', 'run-eval',
  'continue-work', 'do-nothing',
] as const
export type ActionType = typeof ACTION_TYPES[number]

export interface ConfidenceEntry {
  actionType: string
  project: string
  score: number
  level: ConfidenceLevel
  totalSignals: number
  lastUpdated: string
}

const SIGNAL_WEIGHTS: Record<ConfidenceSignal, number> = {
  agree: 0.1,
  disagree: -0.15,
  success: 0.05,
  failure: -0.1,
  transfer: 0.02,
}

export class ConfidenceStore {
  private db: InstanceType<typeof Database>

  constructor(dbPath?: string) {
    const path = dbPath ?? join(FOREMAN_HOME, 'confidence.db')
    const dir = join(path, '..')
    mkdirSync(dir, { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS confidence (
        action_type TEXT NOT NULL,
        project TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0.0,
        total_signals INTEGER NOT NULL DEFAULT 0,
        last_updated TEXT NOT NULL,
        PRIMARY KEY (action_type, project)
      );

      CREATE TABLE IF NOT EXISTS overrides (
        project TEXT NOT NULL,
        override TEXT NOT NULL,
        PRIMARY KEY (project)
      );

      CREATE TABLE IF NOT EXISTS confidence_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_type TEXT NOT NULL,
        project TEXT NOT NULL,
        signal TEXT NOT NULL,
        old_score REAL NOT NULL,
        new_score REAL NOT NULL,
        timestamp TEXT NOT NULL
      );
    `)
  }

  getConfidence(actionType: string, project: string): number {
    const row = this.db.prepare(
      'SELECT score FROM confidence WHERE action_type = ? AND project = ?',
    ).get(actionType, project) as { score: number } | undefined
    return row?.score ?? 0.0
  }

  getLevelForScore(score: number): ConfidenceLevel {
    if (score >= 0.8) return 'autonomous'
    if (score >= 0.6) return 'act-notify'
    if (score >= 0.3) return 'propose'
    return 'dry-run'
  }

  getLevel(actionType: string, project: string): ConfidenceLevel {
    const override = this.getOverride(project)
    if (override === 'never-auto') return 'dry-run'
    if (override === 'always-auto') return 'autonomous'
    return this.getLevelForScore(this.getConfidence(actionType, project))
  }

  update(actionType: string, project: string, signal: ConfidenceSignal): void {
    const oldScore = this.getConfidence(actionType, project)
    const delta = SIGNAL_WEIGHTS[signal]
    const newScore = Math.max(0.0, Math.min(1.0, oldScore + delta))
    const now = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO confidence (action_type, project, score, total_signals, last_updated)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (action_type, project)
      DO UPDATE SET
        score = ?,
        total_signals = total_signals + 1,
        last_updated = ?
    `).run(actionType, project, newScore, now, newScore, now)

    this.db.prepare(`
      INSERT INTO confidence_log (action_type, project, signal, old_score, new_score, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(actionType, project, signal, oldScore, newScore, now)
  }

  list(project?: string): ConfidenceEntry[] {
    const rows = project
      ? this.db.prepare('SELECT * FROM confidence WHERE project = ?').all(project) as Array<{
          action_type: string
          project: string
          score: number
          total_signals: number
          last_updated: string
        }>
      : this.db.prepare('SELECT * FROM confidence').all() as Array<{
          action_type: string
          project: string
          score: number
          total_signals: number
          last_updated: string
        }>

    return rows.map((r) => ({
      actionType: r.action_type,
      project: r.project,
      score: r.score,
      level: this.getLevelForScore(r.score),
      totalSignals: r.total_signals,
      lastUpdated: r.last_updated,
    }))
  }

  setOverride(project: string, override: ConfidenceOverride | null): void {
    if (override === null) {
      this.db.prepare('DELETE FROM overrides WHERE project = ?').run(project)
    } else {
      this.db.prepare(`
        INSERT INTO overrides (project, override) VALUES (?, ?)
        ON CONFLICT (project) DO UPDATE SET override = ?
      `).run(project, override, override)
    }
  }

  getOverride(project: string): ConfidenceOverride | null {
    const row = this.db.prepare(
      'SELECT override FROM overrides WHERE project = ?',
    ).get(project) as { override: string } | undefined
    return (row?.override as ConfidenceOverride) ?? null
  }

  close(): void {
    this.db.close()
  }
}
