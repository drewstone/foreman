import type Database from 'better-sqlite3'
import type {
  ReplayPolicyComparison,
  ReplayPolicyEvaluationSummary,
  ReplayPromotionDecision,
  ReplayPromotionRule,
} from './replay.js'

export interface DispatchPolicyControlRow {
  policyName: string
  source: string
  baselinePolicyName: string | null
  updatedAt: string
}

export interface ReplayEvaluationRecord {
  id: number
  surface: string
  candidatePolicyName: string
  baselinePolicyName: string | null
  scopeProject: string | null
  scopeSkill: string | null
  examples: number
  promotionStatus: string | null
  applied: number
  summary: ReplayPolicyEvaluationSummary
  baselineSummary: ReplayPolicyEvaluationSummary | null
  comparison: ReplayPolicyComparison | null
  promotion: ReplayPromotionDecision | null
  promotionRule: ReplayPromotionRule | null
  createdAt: string
}

export function ensurePolicyControlSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_policy_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      policy_name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'env',
      baseline_policy_name TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS replay_policy_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface TEXT NOT NULL DEFAULT 'dispatch_policy',
      candidate_policy_name TEXT NOT NULL,
      baseline_policy_name TEXT,
      scope_project TEXT,
      scope_skill TEXT,
      examples INTEGER NOT NULL,
      promotion_status TEXT,
      applied INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT NOT NULL,
      baseline_summary_json TEXT,
      comparison_json TEXT,
      promotion_json TEXT,
      promotion_rule_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_replay_policy_evaluations_surface_created
      ON replay_policy_evaluations(surface, created_at DESC);
  `)
}

export function getDispatchPolicyControl(db: Database.Database): DispatchPolicyControlRow | null {
  const row = db.prepare(`
    SELECT policy_name as policyName, source, baseline_policy_name as baselinePolicyName, updated_at as updatedAt
    FROM dispatch_policy_control
    WHERE id = 1
  `).get() as DispatchPolicyControlRow | undefined
  return row ?? null
}

export function setDispatchPolicyControl(
  db: Database.Database,
  input: { policyName: string, source: string, baselinePolicyName?: string | null },
): DispatchPolicyControlRow {
  db.prepare(`
    INSERT INTO dispatch_policy_control (id, policy_name, source, baseline_policy_name, updated_at)
    VALUES (1, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      policy_name = excluded.policy_name,
      source = excluded.source,
      baseline_policy_name = excluded.baseline_policy_name,
      updated_at = datetime('now')
  `).run(input.policyName, input.source, input.baselinePolicyName ?? null)

  return getDispatchPolicyControl(db) as DispatchPolicyControlRow
}

export function recordReplayPolicyEvaluation(
  db: Database.Database,
  input: {
    candidatePolicyName: string
    baselinePolicyName?: string | null
    scopeProject?: string | null
    scopeSkill?: string | null
    summary: ReplayPolicyEvaluationSummary
    baselineSummary?: ReplayPolicyEvaluationSummary | null
    comparison?: ReplayPolicyComparison | null
    promotion?: ReplayPromotionDecision | null
    promotionRule?: ReplayPromotionRule | null
    applied?: boolean
  },
): ReplayEvaluationRecord {
  const result = db.prepare(`
    INSERT INTO replay_policy_evaluations (
      candidate_policy_name, baseline_policy_name, scope_project, scope_skill, examples,
      promotion_status, applied, summary_json, baseline_summary_json, comparison_json,
      promotion_json, promotion_rule_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.candidatePolicyName,
    input.baselinePolicyName ?? null,
    input.scopeProject ?? null,
    input.scopeSkill ?? null,
    input.summary.examples,
    input.promotion?.status ?? null,
    input.applied ? 1 : 0,
    JSON.stringify(input.summary),
    input.baselineSummary ? JSON.stringify(input.baselineSummary) : null,
    input.comparison ? JSON.stringify(input.comparison) : null,
    input.promotion ? JSON.stringify(input.promotion) : null,
    input.promotionRule ? JSON.stringify(input.promotionRule) : null,
  )

  return getReplayPolicyEvaluation(db, Number(result.lastInsertRowid)) as ReplayEvaluationRecord
}

export function getReplayPolicyEvaluation(db: Database.Database, id: number): ReplayEvaluationRecord | null {
  const row = db.prepare(`
    SELECT *
    FROM replay_policy_evaluations
    WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined
  return row ? hydrateReplayEvaluation(row) : null
}

export function getLatestReplayPolicyEvaluation(
  db: Database.Database,
  surface = 'dispatch_policy',
): ReplayEvaluationRecord | null {
  const row = db.prepare(`
    SELECT *
    FROM replay_policy_evaluations
    WHERE surface = ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 1
  `).get(surface) as Record<string, unknown> | undefined
  return row ? hydrateReplayEvaluation(row) : null
}

export function listReplayPolicyEvaluations(
  db: Database.Database,
  input?: { surface?: string, limit?: number },
): ReplayEvaluationRecord[] {
  const surface = input?.surface ?? 'dispatch_policy'
  const limit = input?.limit ?? 10
  const rows = db.prepare(`
    SELECT *
    FROM replay_policy_evaluations
    WHERE surface = ?
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(surface, limit) as Array<Record<string, unknown>>

  return rows.map(hydrateReplayEvaluation)
}

function hydrateReplayEvaluation(row: Record<string, unknown>): ReplayEvaluationRecord {
  return {
    id: Number(row.id),
    surface: String(row.surface),
    candidatePolicyName: String(row.candidate_policy_name),
    baselinePolicyName: row.baseline_policy_name ? String(row.baseline_policy_name) : null,
    scopeProject: row.scope_project ? String(row.scope_project) : null,
    scopeSkill: row.scope_skill ? String(row.scope_skill) : null,
    examples: Number(row.examples),
    promotionStatus: row.promotion_status ? String(row.promotion_status) : null,
    applied: Number(row.applied),
    summary: JSON.parse(String(row.summary_json)) as ReplayPolicyEvaluationSummary,
    baselineSummary: row.baseline_summary_json
      ? JSON.parse(String(row.baseline_summary_json)) as ReplayPolicyEvaluationSummary
      : null,
    comparison: row.comparison_json
      ? JSON.parse(String(row.comparison_json)) as ReplayPolicyComparison
      : null,
    promotion: row.promotion_json
      ? JSON.parse(String(row.promotion_json)) as ReplayPromotionDecision
      : null,
    promotionRule: row.promotion_rule_json
      ? JSON.parse(String(row.promotion_rule_json)) as ReplayPromotionRule
      : null,
    createdAt: String(row.created_at),
  }
}

export default {
  ensurePolicyControlSchema,
  getDispatchPolicyControl,
  setDispatchPolicyControl,
  recordReplayPolicyEvaluation,
  getReplayPolicyEvaluation,
  getLatestReplayPolicyEvaluation,
  listReplayPolicyEvaluations,
}
