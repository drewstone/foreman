import type Database from 'better-sqlite3'

import {
  DEFAULT_PROMPT_POLICY,
  parsePromptPolicy,
  resolvePromptPolicyById,
  serializePromptPolicy,
  type PromptPolicy,
} from './prompt-policy.js'

export interface PromptPolicySummary {
  policyId: string
  examples: number
  successRate: number | null
  deliverablePassRate: number | null
  scopeViolationRate: number | null
  testsPassedRate: number | null
  avgCostUsd: number | null
  bySkill: Array<{ key: string, count: number }>
}

export interface PromptPolicyComparison {
  baselinePolicyId: string
  delta: {
    successRate: number | null
    deliverablePassRate: number | null
    scopeViolationRate: number | null
    testsPassedRate: number | null
    avgCostUsd: number | null
  }
}

export interface PromptPolicyPromotionRule {
  minCandidateExamples: number
  minBaselineExamples: number
  maxScopeViolationRegression: number
  maxDeliverableRegression: number
  maxSuccessRegression: number
  minDeliverableImprovement: number
  minCostImprovementUsd: number
}

export interface PromptPolicyPromotionCheck {
  name: string
  passed: boolean
  actual: number | null
  baseline: number | null
  threshold: number | null
  comparator: '>=' | '<=' | 'coverage'
}

export interface PromptPolicyPromotionDecision {
  status: 'promote' | 'hold' | 'reject'
  reasons: string[]
  checks: PromptPolicyPromotionCheck[]
}

export interface PromptPolicyEvaluation {
  generatedAt: string
  candidate: PromptPolicySummary
  baseline: PromptPolicySummary | null
  comparison: PromptPolicyComparison | null
  promotionRule: PromptPolicyPromotionRule
  promotion: PromptPolicyPromotionDecision | null
}

export interface PromptPolicyEvaluationRecord {
  id: number
  candidatePolicyId: string
  baselinePolicyId: string | null
  scopeProject: string | null
  scopeSkill: string | null
  applied: number
  candidateSummary: PromptPolicySummary
  baselineSummary: PromptPolicySummary | null
  comparison: PromptPolicyComparison | null
  promotionRule: PromptPolicyPromotionRule | null
  promotion: PromptPolicyPromotionDecision | null
  createdAt: string
}

export interface PromptPolicyPromotionRequest {
  policyId: string
  baselinePolicyId?: string | null
  project?: string
  skill?: string
  limit?: number
  apply?: boolean
  force?: boolean
  promotionRule?: Partial<PromptPolicyPromotionRule>
}

interface PromptPolicyExampleRow {
  skill: string
  status: string
  metrics: string | null
  deliverable_status: string | null
  prompt_policy_id: string | null
  template: string | null
  cost_usd: number | null
}

export const DEFAULT_PROMPT_POLICY_PROMOTION_RULE: PromptPolicyPromotionRule = {
  minCandidateExamples: 6,
  minBaselineExamples: 6,
  maxScopeViolationRegression: 0.02,
  maxDeliverableRegression: 0.03,
  maxSuccessRegression: 0.03,
  minDeliverableImprovement: 0.03,
  minCostImprovementUsd: 0.1,
}

function rate(count: number, total: number): number | null {
  return total > 0 ? count / total : null
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function parseMetrics(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function policyIdForRow(row: PromptPolicyExampleRow): string {
  if (row.prompt_policy_id) return row.prompt_policy_id
  return parsePromptPolicy(row.template).id
}

function summarizePolicyRows(policyId: string, rows: PromptPolicyExampleRow[]): PromptPolicySummary {
  const deliverableMeasured = rows.filter(row => row.deliverable_status === 'pass' || row.deliverable_status === 'fail')
  const scopeMeasured = rows.filter(row => parseMetrics(row.metrics).scopeStatus != null)
  const testsMeasured = rows.filter(row => typeof parseMetrics(row.metrics).testsPassed === 'boolean')
  const costs = rows.map(row => row.cost_usd).filter((value): value is number => typeof value === 'number')
  const bySkillMap = new Map<string, number>()

  for (const row of rows) {
    bySkillMap.set(row.skill || 'direct', (bySkillMap.get(row.skill || 'direct') ?? 0) + 1)
  }

  return {
    policyId,
    examples: rows.length,
    successRate: rate(rows.filter(row => row.status === 'success').length, rows.length),
    deliverablePassRate: rate(deliverableMeasured.filter(row => row.deliverable_status === 'pass').length, deliverableMeasured.length),
    scopeViolationRate: rate(scopeMeasured.filter(row => parseMetrics(row.metrics).scopeStatus === 'violation').length, scopeMeasured.length),
    testsPassedRate: rate(testsMeasured.filter(row => parseMetrics(row.metrics).testsPassed === true).length, testsMeasured.length),
    avgCostUsd: average(costs),
    bySkill: [...bySkillMap.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([key, count]) => ({ key, count })),
  }
}

function compareCandidateToBaseline(candidate: PromptPolicySummary, baseline: PromptPolicySummary): PromptPolicyComparison {
  return {
    baselinePolicyId: baseline.policyId,
    delta: {
      successRate: candidate.successRate != null && baseline.successRate != null ? candidate.successRate - baseline.successRate : null,
      deliverablePassRate: candidate.deliverablePassRate != null && baseline.deliverablePassRate != null
        ? candidate.deliverablePassRate - baseline.deliverablePassRate
        : null,
      scopeViolationRate: candidate.scopeViolationRate != null && baseline.scopeViolationRate != null
        ? candidate.scopeViolationRate - baseline.scopeViolationRate
        : null,
      testsPassedRate: candidate.testsPassedRate != null && baseline.testsPassedRate != null
        ? candidate.testsPassedRate - baseline.testsPassedRate
        : null,
      avgCostUsd: candidate.avgCostUsd != null && baseline.avgCostUsd != null
        ? candidate.avgCostUsd - baseline.avgCostUsd
        : null,
    },
  }
}

function decidePromptPolicyPromotion(
  candidate: PromptPolicySummary,
  baseline: PromptPolicySummary | null,
  rule: PromptPolicyPromotionRule,
): PromptPolicyPromotionDecision | null {
  if (!baseline) return null

  const checks: PromptPolicyPromotionCheck[] = [
    {
      name: 'candidate_examples',
      passed: candidate.examples >= rule.minCandidateExamples,
      actual: candidate.examples,
      baseline: null,
      threshold: rule.minCandidateExamples,
      comparator: 'coverage',
    },
    {
      name: 'baseline_examples',
      passed: baseline.examples >= rule.minBaselineExamples,
      actual: baseline.examples,
      baseline: null,
      threshold: rule.minBaselineExamples,
      comparator: 'coverage',
    },
    {
      name: 'success_regression',
      passed: candidate.successRate == null || baseline.successRate == null || candidate.successRate >= baseline.successRate - rule.maxSuccessRegression,
      actual: candidate.successRate,
      baseline: baseline.successRate,
      threshold: baseline.successRate != null ? baseline.successRate - rule.maxSuccessRegression : null,
      comparator: '>=',
    },
    {
      name: 'deliverable_regression',
      passed: candidate.deliverablePassRate == null || baseline.deliverablePassRate == null || candidate.deliverablePassRate >= baseline.deliverablePassRate - rule.maxDeliverableRegression,
      actual: candidate.deliverablePassRate,
      baseline: baseline.deliverablePassRate,
      threshold: baseline.deliverablePassRate != null ? baseline.deliverablePassRate - rule.maxDeliverableRegression : null,
      comparator: '>=',
    },
    {
      name: 'scope_regression',
      passed: candidate.scopeViolationRate == null || baseline.scopeViolationRate == null || candidate.scopeViolationRate <= baseline.scopeViolationRate + rule.maxScopeViolationRegression,
      actual: candidate.scopeViolationRate,
      baseline: baseline.scopeViolationRate,
      threshold: baseline.scopeViolationRate != null ? baseline.scopeViolationRate + rule.maxScopeViolationRegression : null,
      comparator: '<=',
    },
  ]

  const positiveSignals = [
    candidate.deliverablePassRate != null && baseline.deliverablePassRate != null
      ? candidate.deliverablePassRate - baseline.deliverablePassRate >= rule.minDeliverableImprovement
      : false,
    candidate.avgCostUsd != null && baseline.avgCostUsd != null
      ? baseline.avgCostUsd - candidate.avgCostUsd >= rule.minCostImprovementUsd
      : false,
    candidate.successRate != null && baseline.successRate != null
      ? candidate.successRate > baseline.successRate
      : false,
  ]
  const allChecksPassed = checks.every(check => check.passed)
  const anyPositive = positiveSignals.some(Boolean)

  if (!allChecksPassed) {
    return {
      status: 'reject',
      reasons: checks.filter(check => !check.passed).map(check => `failed ${check.name}`),
      checks,
    }
  }
  if (anyPositive) {
    return {
      status: 'promote',
      reasons: ['candidate clears regression checks and shows at least one material improvement'],
      checks,
    }
  }
  return {
    status: 'hold',
    reasons: ['candidate is not clearly worse, but evidence of improvement is not strong enough'],
    checks,
  }
}

export function ensurePromptPolicyGovernanceSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompt_policy_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_policy_id TEXT NOT NULL,
      baseline_policy_id TEXT,
      scope_project TEXT,
      scope_skill TEXT,
      applied INTEGER NOT NULL DEFAULT 0,
      candidate_summary_json TEXT NOT NULL,
      baseline_summary_json TEXT,
      comparison_json TEXT,
      promotion_rule_json TEXT,
      promotion_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_policy_evaluations_created
      ON prompt_policy_evaluations(created_at DESC);
  `)
}

function listObservedPromptPolicyRows(
  db: Database.Database,
  input?: { project?: string, skill?: string, limit?: number },
): PromptPolicyExampleRow[] {
  const where: string[] = [`d.status IN ('success', 'failure')`]
  const args: unknown[] = []

  if (input?.project) {
    where.push(`COALESCE(g.workspace_path, d.worktree_path) LIKE ?`)
    args.push(`%${input.project}%`)
  }
  if (input?.skill) {
    where.push(`d.skill = ?`)
    args.push(input.skill)
  }

  const limit = input?.limit ?? 160
  return db.prepare(`
    SELECT
      d.skill,
      d.status,
      d.metrics,
      d.deliverable_status,
      d.prompt_policy_id,
      pt.template,
      COALESCE(
        (SELECT SUM(t.cost_usd) FROM telemetry_runs t WHERE t.decision_id = d.id),
        d.cost_usd
      ) as cost_usd
    FROM decisions d
    LEFT JOIN goals g ON g.id = d.goal_id
    LEFT JOIN prompt_templates pt ON pt.version = d.template_version
    WHERE ${where.join(' AND ')}
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT ?
  `).all(...args, limit) as PromptPolicyExampleRow[]
}

function findPolicyTemplate(db: Database.Database, policyId: string): { id: number, version: number, template: string } | null {
  const rows = db.prepare(`
    SELECT id, version, template
    FROM prompt_templates
    ORDER BY version DESC, id DESC
    LIMIT 100
  `).all() as Array<{ id: number, version: number, template: string }>

  for (const row of rows) {
    if (parsePromptPolicy(row.template).id === policyId) return row
  }
  return null
}

function ensurePromptTemplateForPolicy(db: Database.Database, policyId: string): { id: number, version: number, template: string } | null {
  const existing = findPolicyTemplate(db, policyId)
  if (existing) return existing

  const builtin = resolvePromptPolicyById(policyId)
  if (!builtin) return null

  const nextVersion = ((db.prepare(`SELECT COALESCE(MAX(version), 0) as maxVersion FROM prompt_templates`).get() as { maxVersion: number }).maxVersion ?? 0) + 1
  const template = serializePromptPolicy(builtin).trim()
  const result = db.prepare(`
    INSERT INTO prompt_templates (version, template, active)
    VALUES (?, ?, 0)
  `).run(nextVersion, template)

  return {
    id: Number(result.lastInsertRowid),
    version: nextVersion,
    template,
  }
}

export function evaluatePromptPolicy(
  db: Database.Database,
  input: {
    policyId: string
    baselinePolicyId?: string | null
    project?: string
    skill?: string
    limit?: number
    promotionRule?: Partial<PromptPolicyPromotionRule>
  },
): PromptPolicyEvaluation {
  const rows = listObservedPromptPolicyRows(db, input)
  const candidateRows = rows.filter(row => policyIdForRow(row) === input.policyId)
  const baselineId = input.baselinePolicyId ?? null
  const baselineRows = baselineId ? rows.filter(row => policyIdForRow(row) === baselineId) : []
  const candidate = summarizePolicyRows(input.policyId, candidateRows)
  const baseline = baselineId ? summarizePolicyRows(baselineId, baselineRows) : null
  const promotionRule = { ...DEFAULT_PROMPT_POLICY_PROMOTION_RULE, ...input.promotionRule }

  return {
    generatedAt: new Date().toISOString(),
    candidate,
    baseline,
    comparison: baseline ? compareCandidateToBaseline(candidate, baseline) : null,
    promotionRule,
    promotion: decidePromptPolicyPromotion(candidate, baseline, promotionRule),
  }
}

export function recordPromptPolicyEvaluation(
  db: Database.Database,
  input: {
    candidatePolicyId: string
    baselinePolicyId?: string | null
    scopeProject?: string | null
    scopeSkill?: string | null
    candidateSummary: PromptPolicySummary
    baselineSummary?: PromptPolicySummary | null
    comparison?: PromptPolicyComparison | null
    promotionRule?: PromptPolicyPromotionRule | null
    promotion?: PromptPolicyPromotionDecision | null
    applied?: boolean
  },
): PromptPolicyEvaluationRecord {
  ensurePromptPolicyGovernanceSchema(db)
  const result = db.prepare(`
    INSERT INTO prompt_policy_evaluations (
      candidate_policy_id, baseline_policy_id, scope_project, scope_skill, applied,
      candidate_summary_json, baseline_summary_json, comparison_json, promotion_rule_json, promotion_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.candidatePolicyId,
    input.baselinePolicyId ?? null,
    input.scopeProject ?? null,
    input.scopeSkill ?? null,
    input.applied ? 1 : 0,
    JSON.stringify(input.candidateSummary),
    input.baselineSummary ? JSON.stringify(input.baselineSummary) : null,
    input.comparison ? JSON.stringify(input.comparison) : null,
    input.promotionRule ? JSON.stringify(input.promotionRule) : null,
    input.promotion ? JSON.stringify(input.promotion) : null,
  )
  return getPromptPolicyEvaluation(db, Number(result.lastInsertRowid)) as PromptPolicyEvaluationRecord
}

export function getPromptPolicyEvaluation(db: Database.Database, id: number): PromptPolicyEvaluationRecord | null {
  ensurePromptPolicyGovernanceSchema(db)
  const row = db.prepare(`
    SELECT *
    FROM prompt_policy_evaluations
    WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined
  return row ? hydrateEvaluation(row) : null
}

export function getLatestPromptPolicyEvaluation(db: Database.Database): PromptPolicyEvaluationRecord | null {
  ensurePromptPolicyGovernanceSchema(db)
  const row = db.prepare(`
    SELECT *
    FROM prompt_policy_evaluations
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 1
  `).get() as Record<string, unknown> | undefined
  return row ? hydrateEvaluation(row) : null
}

export function listPromptPolicyEvaluations(
  db: Database.Database,
  input?: { limit?: number },
): PromptPolicyEvaluationRecord[] {
  ensurePromptPolicyGovernanceSchema(db)
  const limit = input?.limit ?? 10
  const rows = db.prepare(`
    SELECT *
    FROM prompt_policy_evaluations
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>
  return rows.map(hydrateEvaluation)
}

export function listPromptPolicyIds(db: Database.Database): string[] {
  const ids = new Set<string>([
    DEFAULT_PROMPT_POLICY.id,
    'strict-guarded',
    'rich-reasoning',
    'lean-execution',
    'history-heavy',
  ])
  const rows = db.prepare(`
    SELECT template
    FROM prompt_templates
    ORDER BY version DESC
    LIMIT 100
  `).all() as Array<{ template: string }>

  for (const row of rows) ids.add(parsePromptPolicy(row.template).id)
  return [...ids].sort((left, right) => left.localeCompare(right))
}

export function getActivePromptPolicy(db: Database.Database): PromptPolicy {
  const row = db.prepare(`
    SELECT template
    FROM prompt_templates
    WHERE active = 1
    ORDER BY version DESC
    LIMIT 1
  `).get() as { template?: string | null } | undefined
  return parsePromptPolicy(row?.template)
}

export function applyPromptPolicy(db: Database.Database, policyId: string): { policyId: string, version: number | null } {
  const template = ensurePromptTemplateForPolicy(db, policyId)
  if (!template) throw new Error(`unknown prompt policy: ${policyId}`)
  db.prepare(`UPDATE prompt_templates SET active = CASE WHEN id = ? THEN 1 ELSE 0 END`).run(template.id)
  return { policyId, version: template.version }
}

export function promotePromptPolicy(
  db: Database.Database,
  input: PromptPolicyPromotionRequest,
): {
  evaluation: PromptPolicyEvaluation
  activePolicy: PromptPolicy
  persisted: PromptPolicyEvaluationRecord
  appliedPolicy: { policyId: string, version: number | null } | null
} {
  const baselinePolicyId = input.baselinePolicyId ?? (input.policyId === getActivePromptPolicy(db).id ? null : getActivePromptPolicy(db).id)
  const evaluation = evaluatePromptPolicy(db, {
    policyId: input.policyId,
    baselinePolicyId,
    project: input.project,
    skill: input.skill,
    limit: input.limit,
    promotionRule: input.promotionRule,
  })

  const shouldApply = input.apply === true && (input.force === true || evaluation.promotion?.status === 'promote')
  const appliedPolicy = shouldApply ? applyPromptPolicy(db, input.policyId) : null
  const persisted = recordPromptPolicyEvaluation(db, {
    candidatePolicyId: input.policyId,
    baselinePolicyId,
    scopeProject: input.project ?? null,
    scopeSkill: input.skill ?? null,
    candidateSummary: evaluation.candidate,
    baselineSummary: evaluation.baseline,
    comparison: evaluation.comparison,
    promotionRule: evaluation.promotionRule,
    promotion: evaluation.promotion,
    applied: shouldApply,
  })

  return {
    evaluation,
    activePolicy: getActivePromptPolicy(db),
    persisted,
    appliedPolicy,
  }
}

function hydrateEvaluation(row: Record<string, unknown>): PromptPolicyEvaluationRecord {
  return {
    id: Number(row.id),
    candidatePolicyId: String(row.candidate_policy_id),
    baselinePolicyId: row.baseline_policy_id ? String(row.baseline_policy_id) : null,
    scopeProject: row.scope_project ? String(row.scope_project) : null,
    scopeSkill: row.scope_skill ? String(row.scope_skill) : null,
    applied: Number(row.applied),
    candidateSummary: JSON.parse(String(row.candidate_summary_json)) as PromptPolicySummary,
    baselineSummary: row.baseline_summary_json ? JSON.parse(String(row.baseline_summary_json)) as PromptPolicySummary : null,
    comparison: row.comparison_json ? JSON.parse(String(row.comparison_json)) as PromptPolicyComparison : null,
    promotionRule: row.promotion_rule_json ? JSON.parse(String(row.promotion_rule_json)) as PromptPolicyPromotionRule : null,
    promotion: row.promotion_json ? JSON.parse(String(row.promotion_json)) as PromptPolicyPromotionDecision : null,
    createdAt: String(row.created_at),
  }
}

export default {
  DEFAULT_PROMPT_POLICY_PROMOTION_RULE,
  ensurePromptPolicyGovernanceSchema,
  listPromptPolicyIds,
  getActivePromptPolicy,
  evaluatePromptPolicy,
  recordPromptPolicyEvaluation,
  getPromptPolicyEvaluation,
  getLatestPromptPolicyEvaluation,
  listPromptPolicyEvaluations,
  applyPromptPolicy,
  promotePromptPolicy,
}
