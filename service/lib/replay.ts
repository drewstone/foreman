import type Database from 'better-sqlite3'

export interface ReplayGroupRow {
  key: string
  count: number
  successRate: number
  deliverablePassRate: number | null
  avgCostUsd: number | null
}

export interface ReplayObjectiveVector {
  dispatchSucceeded: number
  deliverablePassed: number | null
  approvalSignal: number | null
  rejectionSignal: number | null
  costUsd: number | null
  scopeViolation: number | null
  testsPassed: number | null
}

export interface ReplayExample {
  decisionId: number
  goalId: number | null
  createdAt: string
  context: {
    skill: string
    task: string
    reasoning: string
    project: string | null
    goalIntent: string | null
    origin: string | null
    templateVersion: number | null
    promptSections: string[]
    previousProjectDecisions: number
    previousProjectSkillDecisions: number
    previousGoalDecisions: number
  }
  observed: {
    status: string
    deliverableStatus: string
    tasteSignal: string | null
    costUsd: number | null
    sessionName: string | null
    worktreePath: string | null
    outcome: string | null
    learnings: string | null
    metricsRaw: Record<string, unknown> | null
    scopeStatus: string | null
    testsPassed: boolean | null
  }
  objectives: ReplayObjectiveVector
}

export interface ReplaySummary {
  examples: number
  successRate: number
  deliverablePassRate: number | null
  approvalRate: number | null
  rejectionRate: number | null
  avgCostUsd: number | null
  objectiveCoverage: {
    deliverableMeasured: number
    costMeasured: number
    scopeMeasured: number
    testsMeasured: number
    feedbackMeasured: number
  }
  bySkill: ReplayGroupRow[]
  byProject: ReplayGroupRow[]
  byStatus: ReplayGroupRow[]
  byDeliverableStatus: ReplayGroupRow[]
}

export interface ReplayDataset {
  generatedAt: string
  summary: ReplaySummary
  examples: ReplayExample[]
}

interface ReplayRow {
  id: number
  goal_id: number | null
  skill: string
  task: string
  reasoning: string
  status: string
  origin: string | null
  outcome: string | null
  learnings: string | null
  metrics: string | null
  taste_signal: string | null
  session_name: string | null
  worktree_path: string | null
  project_path: string | null
  template_version: number | null
  cost_usd: number | null
  prompt_sections: string | null
  deliverable_status: string | null
  created_at: string
  goal_intent: string | null
}

export function listReplayExamples(
  db: Database.Database,
  options?: { limit?: number, project?: string, skill?: string },
): ReplayExample[] {
  const limit = options?.limit ?? 100
  const where: string[] = []
  const args: unknown[] = []

  if (options?.project) {
    where.push(`COALESCE(g.workspace_path, d.worktree_path) LIKE ?`)
    args.push(`%${options.project}%`)
  }
  if (options?.skill) {
    where.push(`d.skill = ?`)
    args.push(options.skill)
  }

  const rows = db.prepare(`
    SELECT
      d.id,
      d.goal_id,
      d.skill,
      d.task,
      d.reasoning,
      d.status,
      d.origin,
      d.outcome,
      d.learnings,
      d.metrics,
      d.taste_signal,
      d.session_name,
      d.worktree_path,
      COALESCE(g.workspace_path, d.worktree_path) as project_path,
      d.template_version,
      d.cost_usd,
      d.prompt_sections,
      d.deliverable_status,
      d.created_at,
      g.intent as goal_intent
    FROM decisions d
    LEFT JOIN goals g ON g.id = d.goal_id
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT ?
  `).all(...args, limit) as ReplayRow[]

  return rows.map((row) => toReplayExample(db, row))
}

export function summarizeReplayExamples(examples: ReplayExample[]): ReplaySummary {
  const bySkill = summarizeGroups(examples, ex => ex.context.skill)
  const byProject = summarizeGroups(examples, ex => ex.context.project ?? 'unknown')
  const byStatus = summarizeGroups(examples, ex => ex.observed.status)
  const byDeliverableStatus = summarizeGroups(examples, ex => ex.observed.deliverableStatus)

  const successCount = examples.filter(ex => ex.objectives.dispatchSucceeded === 1).length
  const deliverableMeasured = examples.filter(ex => ex.objectives.deliverablePassed != null)
  const deliverablePassed = deliverableMeasured.filter(ex => ex.objectives.deliverablePassed === 1).length
  const feedbackMeasured = examples.filter(ex => ex.objectives.approvalSignal != null || ex.objectives.rejectionSignal != null)
  const approvalMeasured = examples.filter(ex => ex.objectives.approvalSignal != null)
  const rejectionMeasured = examples.filter(ex => ex.objectives.rejectionSignal != null)
  const approvalCount = approvalMeasured.filter(ex => ex.objectives.approvalSignal === 1).length
  const rejectionCount = rejectionMeasured.filter(ex => ex.objectives.rejectionSignal === 1).length
  const costs = examples.map(ex => ex.objectives.costUsd).filter((n): n is number => n != null)
  const scopeMeasured = examples.filter(ex => ex.objectives.scopeViolation != null)
  const testsMeasured = examples.filter(ex => ex.objectives.testsPassed != null)

  return {
    examples: examples.length,
    successRate: rate(successCount, examples.length),
    deliverablePassRate: rateOrNull(deliverablePassed, deliverableMeasured.length),
    approvalRate: rateOrNull(approvalCount, approvalMeasured.length),
    rejectionRate: rateOrNull(rejectionCount, rejectionMeasured.length),
    avgCostUsd: averageOrNull(costs),
    objectiveCoverage: {
      deliverableMeasured: deliverableMeasured.length,
      costMeasured: costs.length,
      scopeMeasured: scopeMeasured.length,
      testsMeasured: testsMeasured.length,
      feedbackMeasured: feedbackMeasured.length,
    },
    bySkill,
    byProject,
    byStatus,
    byDeliverableStatus,
  }
}

export function exportReplayDataset(
  db: Database.Database,
  options?: { limit?: number, project?: string, skill?: string },
): ReplayDataset {
  const examples = listReplayExamples(db, options)
  return {
    generatedAt: new Date().toISOString(),
    summary: summarizeReplayExamples(examples),
    examples,
  }
}

function toReplayExample(db: Database.Database, row: ReplayRow): ReplayExample {
  const metricsRaw = parseJsonRecord(row.metrics)
  const promptSections = parseJsonArray(row.prompt_sections)
  const project = projectName(row.project_path)
  const scopeStatus = optionalString(metricsRaw?.scopeStatus)
  const testsPassed = optionalBoolean(metricsRaw?.testsPassed)
  const deliverableStatus = row.deliverable_status ?? optionalString(metricsRaw?.deliverableStatus) ?? 'unchecked'

  const previousProjectDecisions = countPrevious(
    db,
    `SELECT COUNT(*) as count
     FROM decisions
     WHERE id < ? AND worktree_path LIKE ?`,
    [row.id, `%/${project ?? ''}%`],
    project != null,
  )
  const previousProjectSkillDecisions = countPrevious(
    db,
    `SELECT COUNT(*) as count
     FROM decisions
     WHERE id < ? AND skill = ? AND worktree_path LIKE ?`,
    [row.id, row.skill, `%/${project ?? ''}%`],
    project != null,
  )
  const previousGoalDecisions = countPrevious(
    db,
    `SELECT COUNT(*) as count
     FROM decisions
     WHERE id < ? AND goal_id = ?`,
    [row.id, row.goal_id],
    row.goal_id != null,
  )

  return {
    decisionId: row.id,
    goalId: row.goal_id,
    createdAt: row.created_at,
    context: {
      skill: row.skill,
      task: row.task,
      reasoning: row.reasoning,
      project,
      goalIntent: row.goal_intent,
      origin: row.origin,
      templateVersion: row.template_version,
      promptSections,
      previousProjectDecisions,
      previousProjectSkillDecisions,
      previousGoalDecisions,
    },
    observed: {
      status: row.status,
      deliverableStatus,
      tasteSignal: row.taste_signal,
      costUsd: row.cost_usd,
      sessionName: row.session_name,
      worktreePath: row.worktree_path,
      outcome: row.outcome,
      learnings: row.learnings,
      metricsRaw,
      scopeStatus,
      testsPassed,
    },
    objectives: {
      dispatchSucceeded: row.status === 'success' ? 1 : 0,
      deliverablePassed: deliverableStatus === 'pass' ? 1 : deliverableStatus === 'fail' ? 0 : null,
      approvalSignal: row.taste_signal === 'approved' ? 1 : row.taste_signal === 'rejected' ? 0 : null,
      rejectionSignal: row.taste_signal === 'rejected' ? 1 : row.taste_signal === 'approved' ? 0 : null,
      costUsd: row.cost_usd,
      scopeViolation: scopeStatus === 'violation' ? 1 : scopeStatus === 'clean' ? 0 : null,
      testsPassed: testsPassed == null ? null : testsPassed ? 1 : 0,
    },
  }
}

function summarizeGroups(examples: ReplayExample[], keyFn: (example: ReplayExample) => string): ReplayGroupRow[] {
  const groups = new Map<string, ReplayExample[]>()
  for (const example of examples) {
    const key = keyFn(example)
    const current = groups.get(key) ?? []
    current.push(example)
    groups.set(key, current)
  }

  return [...groups.entries()]
    .map(([key, items]) => {
      const successCount = items.filter(item => item.objectives.dispatchSucceeded === 1).length
      const deliverableMeasured = items.filter(item => item.objectives.deliverablePassed != null)
      const deliverablePassed = deliverableMeasured.filter(item => item.objectives.deliverablePassed === 1).length
      const costs = items.map(item => item.objectives.costUsd).filter((n): n is number => n != null)

      return {
        key,
        count: items.length,
        successRate: rate(successCount, items.length),
        deliverablePassRate: rateOrNull(deliverablePassed, deliverableMeasured.length),
        avgCostUsd: averageOrNull(costs),
      }
    })
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
}

function countPrevious(db: Database.Database, query: string, args: unknown[], enabled: boolean): number {
  if (!enabled) return 0
  const row = db.prepare(query).get(...args) as { count: number }
  return row.count
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function projectName(worktreePath: string | null): string | null {
  if (!worktreePath) return null
  const parts = worktreePath.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : null
}

function rate(value: number, total: number): number {
  if (total <= 0) return 0
  return value / total
}

function rateOrNull(value: number, total: number): number | null {
  if (total <= 0) return null
  return value / total
}

function averageOrNull(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export default {
  listReplayExamples,
  summarizeReplayExamples,
  exportReplayDataset,
}
