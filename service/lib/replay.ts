import type Database from 'better-sqlite3'
import type { DispatchContext, DispatchDecision } from './dispatch-policy.js'
import { estimateTelemetryCost, type TelemetryCostEstimate } from './telemetry.js'

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

export type ReplayOutcomeClass = 'good' | 'bad' | 'mixed'

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
    policyContext: DispatchContext
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

export interface ReplayPolicyEvaluationExample {
  observed: ReplayExample
  candidate: {
    policyName: string
    decision: DispatchDecision
    predictedCostUsd: number | null
    predictedCostSource: TelemetryCostEstimate['source'] | null
    predictedCostSamples: number
  }
  baseline?: {
    policyName: string
    decision: DispatchDecision
    predictedCostUsd: number | null
    predictedCostSource: TelemetryCostEstimate['source'] | null
    predictedCostSamples: number
  }
  surrogate: {
    exactSkillMatch: number
    preservedGoodDecision: number | null
    safeGoodContinuation: number | null
    divergedFromBadDecision: number | null
    repeatedBadDecision: number | null
    scalarScore: number | null
    outcomeClass: ReplayOutcomeClass
  }
  comparison?: {
    changedFromBaseline: number
    predictedCostDeltaUsd: number | null
    safeGoodContinuationDelta: number | null
    divergedFromBadDecisionDelta: number | null
    repeatedBadDecisionDelta: number | null
  }
}

export interface ReplayObjectiveVectorSummary {
  constraints: {
    safeGoodContinuationRate: number | null
    repeatedBadDecisionRate: number | null
  }
  primary: {
    divergedFromBadDecisionRate: number | null
    avgPredictedCostUsd: number | null
  }
  diagnostics: {
    preservedGoodDecisionRate: number | null
    exactSkillMatchRate: number
    contextSwitchRate: number
    avgObservedCostUsd: number | null
    predictedCostCoverage: number
    predictedCostEvidenceSamples: number
    predictedCostSources: Array<{ key: string, count: number }>
  }
}

export interface ReplayPolicyEvaluationSummary {
  policyName: string
  examples: number
  coverage: {
    goodExamples: number
    badExamples: number
    mixedExamples: number
    predictedCostMeasured: number
  }
  exactSkillMatchRate: number
  preservedGoodDecisionRate: number | null
  safeGoodContinuationRate: number | null
  divergedFromBadDecisionRate: number | null
  repeatedBadDecisionRate: number | null
  avgScalarScore: number | null
  avgPredictedCostUsd: number | null
  contextSwitchRate: number
  objectiveVector: ReplayObjectiveVectorSummary
  byCandidateSkill: Array<{ key: string, count: number }>
  topTransitions: Array<{ fromSkill: string, toSkill: string, count: number }>
}

export interface ReplayPolicyComparison {
  baselinePolicyName: string
  delta: {
    safeGoodContinuationRate: number | null
    divergedFromBadDecisionRate: number | null
    repeatedBadDecisionRate: number | null
    avgPredictedCostUsd: number | null
    preservedGoodDecisionRate: number | null
    exactSkillMatchRate: number
    contextSwitchRate: number
  }
}

export interface ReplayPromotionRule {
  minExamples: number
  minGoodExamples: number
  minBadExamples: number
  maxSafeGoodRegression: number
  maxRepeatedBadRegression: number
  minBadDivergenceImprovement: number
  minCostImprovementUsd: number
}

export interface ReplayPromotionCheck {
  name: string
  passed: boolean
  actual: number | null
  baseline: number | null
  threshold: number | null
  comparator: '>=' | '<=' | 'coverage'
}

export interface ReplayPromotionDecision {
  status: 'promote' | 'hold' | 'reject'
  reasons: string[]
  checks: ReplayPromotionCheck[]
}

export interface ReplayPolicyEvaluation {
  generatedAt: string
  summary: ReplayPolicyEvaluationSummary
  baselineSummary?: ReplayPolicyEvaluationSummary
  comparison?: ReplayPolicyComparison
  promotionRule?: ReplayPromotionRule
  promotion?: ReplayPromotionDecision
  examples: ReplayPolicyEvaluationExample[]
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

export const DEFAULT_REPLAY_PROMOTION_RULE: ReplayPromotionRule = {
  minExamples: 8,
  minGoodExamples: 2,
  minBadExamples: 2,
  maxSafeGoodRegression: 0.05,
  maxRepeatedBadRegression: 0,
  minBadDivergenceImprovement: 0.05,
  minCostImprovementUsd: 0.1,
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

export async function evaluateReplayPolicy(
  examples: ReplayExample[],
  input: {
    policyName: string
    decide: (ctx: DispatchContext) => Promise<DispatchDecision>
    baseline?: {
      policyName: string
      decide: (ctx: DispatchContext) => Promise<DispatchDecision>
    }
    telemetryDb?: Database.Database
    promotionRule?: Partial<ReplayPromotionRule>
  },
): Promise<ReplayPolicyEvaluation> {
  const candidateRuns = await runReplayPolicy(examples, input.policyName, input.decide, input.telemetryDb)
  const candidateSummary = summarizeReplayPolicyEvaluation(input.policyName, candidateRuns)

  if (!input.baseline) {
    return {
      generatedAt: new Date().toISOString(),
      summary: candidateSummary,
      examples: candidateRuns,
    }
  }

  const baselineRuns = await runReplayPolicy(examples, input.baseline.policyName, input.baseline.decide, input.telemetryDb)
  const baselineSummary = summarizeReplayPolicyEvaluation(input.baseline.policyName, baselineRuns)
  const comparedExamples = buildComparedExamples(candidateRuns, baselineRuns)
  const promotionRule = {
    ...DEFAULT_REPLAY_PROMOTION_RULE,
    ...input.promotionRule,
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: candidateSummary,
    baselineSummary,
    comparison: compareReplaySummaries(candidateSummary, baselineSummary),
    promotionRule,
    promotion: decideReplayPromotion(candidateSummary, baselineSummary, promotionRule),
    examples: comparedExamples,
  }
}

async function runReplayPolicy(
  examples: ReplayExample[],
  policyName: string,
  decide: (ctx: DispatchContext) => Promise<DispatchDecision>,
  telemetryDb?: Database.Database,
): Promise<ReplayPolicyEvaluationExample[]> {
  const evaluated: ReplayPolicyEvaluationExample[] = []

  for (const example of examples) {
    const decision = await decide(example.context.policyContext)
    const costEstimate = telemetryDb
      ? estimateReplayCostFromTelemetry(telemetryDb, example, decision.skill)
      : null
    const outcomeClass = classifyObservedOutcome(example)
    const exactSkillMatch = decision.skill === example.context.skill ? 1 : 0
    const safeGoodContinuation = outcomeClass === 'good'
      ? (decision.skill === example.context.skill || decision.skill === '/verify' ? 1 : 0)
      : null
    const preservedGoodDecision = outcomeClass === 'good'
      ? exactSkillMatch
      : null
    const divergedFromBadDecision = outcomeClass === 'bad'
      ? (decision.skill !== example.context.skill ? 1 : 0)
      : null
    const repeatedBadDecision = outcomeClass === 'bad'
      ? (decision.skill === example.context.skill ? 1 : 0)
      : null
    const scalarScore = outcomeClass === 'good'
      ? safeGoodContinuation
      : outcomeClass === 'bad'
        ? divergedFromBadDecision
        : null

    evaluated.push({
      observed: example,
      candidate: {
        policyName,
        decision,
        predictedCostUsd: costEstimate?.costUsd ?? null,
        predictedCostSource: costEstimate?.source ?? null,
        predictedCostSamples: costEstimate?.sampleSize ?? 0,
      },
      surrogate: {
        exactSkillMatch,
        preservedGoodDecision,
        safeGoodContinuation,
        divergedFromBadDecision,
        repeatedBadDecision,
        scalarScore,
        outcomeClass,
      },
    })
  }

  return evaluated
}

function buildComparedExamples(
  candidateRuns: ReplayPolicyEvaluationExample[],
  baselineRuns: ReplayPolicyEvaluationExample[],
): ReplayPolicyEvaluationExample[] {
  const baselineByDecisionId = new Map(
    baselineRuns.map(example => [example.observed.decisionId, example]),
  )

  return candidateRuns.map((example) => {
    const baseline = baselineByDecisionId.get(example.observed.decisionId)
    if (!baseline) return example

    return {
      ...example,
      baseline: {
        policyName: baseline.candidate.policyName,
        decision: baseline.candidate.decision,
        predictedCostUsd: baseline.candidate.predictedCostUsd,
        predictedCostSource: baseline.candidate.predictedCostSource,
        predictedCostSamples: baseline.candidate.predictedCostSamples,
      },
      comparison: {
        changedFromBaseline: example.candidate.decision.skill !== baseline.candidate.decision.skill ? 1 : 0,
        predictedCostDeltaUsd: subtractOrNull(example.candidate.predictedCostUsd, baseline.candidate.predictedCostUsd),
        safeGoodContinuationDelta: subtractOrNull(example.surrogate.safeGoodContinuation, baseline.surrogate.safeGoodContinuation),
        divergedFromBadDecisionDelta: subtractOrNull(example.surrogate.divergedFromBadDecision, baseline.surrogate.divergedFromBadDecision),
        repeatedBadDecisionDelta: subtractOrNull(example.surrogate.repeatedBadDecision, baseline.surrogate.repeatedBadDecision),
      },
    }
  })
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
  const recentDecisions = listPreviousDecisions(
    db,
    row.id,
    row.goal_id,
    row.project_path,
    5,
  )
  const learnedFlows = listHistoricalLearnings(db, 'flow', row.created_at, 10)
  const skillPreferences = listHistoricalLearnings(db, 'skill_preference', row.created_at, 10)
  const goalIntent = row.goal_intent ?? row.task.slice(0, 200)

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
      policyContext: {
        goalIntent,
        projectName: project ?? 'unknown',
        recentDecisions,
        learnedFlows,
        skillPreferences,
        confidenceLevel: 'dry-run',
      },
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

function listPreviousDecisions(
  db: Database.Database,
  decisionId: number,
  goalId: number | null,
  projectPath: string | null,
  limit: number,
): DispatchContext['recentDecisions'] {
  try {
    if (goalId != null) {
      return db.prepare(`
        SELECT skill, status, outcome
        FROM decisions
        WHERE id < ? AND goal_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(decisionId, goalId, limit) as DispatchContext['recentDecisions']
    }
    if (projectPath) {
      return db.prepare(`
        SELECT skill, status, outcome
        FROM decisions
        WHERE id < ? AND worktree_path LIKE ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(decisionId, `%${projectPath}%`, limit) as DispatchContext['recentDecisions']
    }
  } catch {}
  return []
}

function listHistoricalLearnings(
  db: Database.Database,
  type: string,
  createdAt: string,
  limit: number,
): string[] {
  try {
    const rows = db.prepare(`
      SELECT content
      FROM learnings
      WHERE type = ? AND created_at <= ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(type, createdAt, limit) as Array<{ content: string }>
    return rows.map(row => row.content)
  } catch {
    return []
  }
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

function subtractOrNull(left: number | null, right: number | null): number | null {
  if (left == null || right == null) return null
  return left - right
}

function compareWithTolerance(
  candidate: number | null,
  baseline: number | null,
  tolerance: number,
): boolean {
  if (candidate == null || baseline == null) return true
  return candidate >= baseline + tolerance
}

function compareLessOrEqualWithTolerance(
  candidate: number | null,
  baseline: number | null,
  tolerance: number,
): boolean {
  if (candidate == null || baseline == null) return true
  return candidate <= baseline + tolerance
}

function estimateReplayCostFromTelemetry(
  db: Database.Database,
  example: ReplayExample,
  skill: string,
): TelemetryCostEstimate | null {
  return estimateTelemetryCost(db, {
    repo: example.context.project,
    skill,
  })
}

function summarizeReplayPolicyEvaluation(
  policyName: string,
  examples: ReplayPolicyEvaluationExample[],
): ReplayPolicyEvaluationSummary {
  const scalarValues = examples.map(ex => ex.surrogate.scalarScore).filter((n): n is number => n != null)
  const goodExamples = examples.filter(ex => ex.surrogate.outcomeClass === 'good')
  const badExamples = examples.filter(ex => ex.surrogate.outcomeClass === 'bad')
  const mixedExamples = examples.filter(ex => ex.surrogate.outcomeClass === 'mixed')
  const predictedCosts = examples.map(ex => ex.candidate.predictedCostUsd).filter((n): n is number => n != null)
  const predictedCostSamples = examples.reduce((sum, ex) => sum + ex.candidate.predictedCostSamples, 0)
  const predictedCostSources = summarizeCounts(
    examples
      .map(ex => ex.candidate.predictedCostSource)
      .filter((value): value is TelemetryCostEstimate['source'] => value != null),
  )
  const observedCosts = examples.map(ex => ex.observed.objectives.costUsd).filter((n): n is number => n != null)
  const byCandidateSkill = summarizeCounts(examples.map(ex => ex.candidate.decision.skill))
  const topTransitions = summarizeTransitions(examples)
  const exactSkillMatchRate = rate(
    examples.filter(ex => ex.surrogate.exactSkillMatch === 1).length,
    examples.length,
  )
  const preservedGoodDecisionRate = rateOrNull(
    goodExamples.filter(ex => ex.surrogate.preservedGoodDecision === 1).length,
    goodExamples.length,
  )
  const safeGoodContinuationRate = rateOrNull(
    goodExamples.filter(ex => ex.surrogate.safeGoodContinuation === 1).length,
    goodExamples.length,
  )
  const divergedFromBadDecisionRate = rateOrNull(
    badExamples.filter(ex => ex.surrogate.divergedFromBadDecision === 1).length,
    badExamples.length,
  )
  const repeatedBadDecisionRate = rateOrNull(
    badExamples.filter(ex => ex.surrogate.repeatedBadDecision === 1).length,
    badExamples.length,
  )
  const contextSwitchRate = rate(
    examples.filter(ex => ex.candidate.decision.skill !== ex.observed.context.skill).length,
    examples.length,
  )
  const avgPredictedCostUsd = averageOrNull(predictedCosts)
  const avgObservedCostUsd = averageOrNull(observedCosts)

  return {
    policyName,
    examples: examples.length,
    coverage: {
      goodExamples: goodExamples.length,
      badExamples: badExamples.length,
      mixedExamples: mixedExamples.length,
      predictedCostMeasured: predictedCosts.length,
    },
    exactSkillMatchRate,
    preservedGoodDecisionRate,
    safeGoodContinuationRate,
    divergedFromBadDecisionRate,
    repeatedBadDecisionRate,
    avgScalarScore: averageOrNull(scalarValues),
    avgPredictedCostUsd,
    contextSwitchRate,
    objectiveVector: {
      constraints: {
        safeGoodContinuationRate,
        repeatedBadDecisionRate,
      },
      primary: {
        divergedFromBadDecisionRate,
        avgPredictedCostUsd,
      },
      diagnostics: {
        preservedGoodDecisionRate,
        exactSkillMatchRate,
        contextSwitchRate,
        avgObservedCostUsd,
        predictedCostCoverage: predictedCosts.length,
        predictedCostEvidenceSamples: predictedCostSamples,
        predictedCostSources,
      },
    },
    byCandidateSkill,
    topTransitions,
  }
}

function classifyObservedOutcome(example: ReplayExample): ReplayOutcomeClass {
  const badSignals = [
    example.objectives.dispatchSucceeded === 0,
    example.objectives.deliverablePassed === 0,
    example.objectives.rejectionSignal === 1,
    example.objectives.scopeViolation === 1,
    example.objectives.testsPassed === 0,
  ].filter(Boolean).length

  const goodSignals = [
    example.objectives.dispatchSucceeded === 1,
    example.objectives.deliverablePassed === 1,
    example.objectives.approvalSignal === 1,
    example.objectives.scopeViolation === 0,
    example.objectives.testsPassed === 1,
  ].filter(Boolean).length

  if (badSignals > 0 && goodSignals === 0) return 'bad'
  if (goodSignals > 0 && badSignals === 0) return 'good'
  if (badSignals > goodSignals) return 'bad'
  if (goodSignals > badSignals) return 'good'
  return 'mixed'
}

function compareReplaySummaries(
  candidate: ReplayPolicyEvaluationSummary,
  baseline: ReplayPolicyEvaluationSummary,
): ReplayPolicyComparison {
  return {
    baselinePolicyName: baseline.policyName,
    delta: {
      safeGoodContinuationRate: subtractOrNull(candidate.safeGoodContinuationRate, baseline.safeGoodContinuationRate),
      divergedFromBadDecisionRate: subtractOrNull(candidate.divergedFromBadDecisionRate, baseline.divergedFromBadDecisionRate),
      repeatedBadDecisionRate: subtractOrNull(candidate.repeatedBadDecisionRate, baseline.repeatedBadDecisionRate),
      avgPredictedCostUsd: subtractOrNull(candidate.avgPredictedCostUsd, baseline.avgPredictedCostUsd),
      preservedGoodDecisionRate: subtractOrNull(candidate.preservedGoodDecisionRate, baseline.preservedGoodDecisionRate),
      exactSkillMatchRate: candidate.exactSkillMatchRate - baseline.exactSkillMatchRate,
      contextSwitchRate: candidate.contextSwitchRate - baseline.contextSwitchRate,
    },
  }
}

function decideReplayPromotion(
  candidate: ReplayPolicyEvaluationSummary,
  baseline: ReplayPolicyEvaluationSummary,
  rule: ReplayPromotionRule,
): ReplayPromotionDecision {
  const checks: ReplayPromotionCheck[] = [
    {
      name: 'min_examples',
      passed: candidate.examples >= rule.minExamples,
      actual: candidate.examples,
      baseline: baseline.examples,
      threshold: rule.minExamples,
      comparator: 'coverage',
    },
    {
      name: 'min_good_examples',
      passed: candidate.coverage.goodExamples >= rule.minGoodExamples,
      actual: candidate.coverage.goodExamples,
      baseline: baseline.coverage.goodExamples,
      threshold: rule.minGoodExamples,
      comparator: 'coverage',
    },
    {
      name: 'min_bad_examples',
      passed: candidate.coverage.badExamples >= rule.minBadExamples,
      actual: candidate.coverage.badExamples,
      baseline: baseline.coverage.badExamples,
      threshold: rule.minBadExamples,
      comparator: 'coverage',
    },
    {
      name: 'safe_good_non_regression',
      passed: compareWithTolerance(candidate.safeGoodContinuationRate, baseline.safeGoodContinuationRate, -rule.maxSafeGoodRegression),
      actual: candidate.safeGoodContinuationRate,
      baseline: baseline.safeGoodContinuationRate,
      threshold: baseline.safeGoodContinuationRate == null ? null : baseline.safeGoodContinuationRate - rule.maxSafeGoodRegression,
      comparator: '>=',
    },
    {
      name: 'repeated_bad_non_regression',
      passed: compareLessOrEqualWithTolerance(candidate.repeatedBadDecisionRate, baseline.repeatedBadDecisionRate, rule.maxRepeatedBadRegression),
      actual: candidate.repeatedBadDecisionRate,
      baseline: baseline.repeatedBadDecisionRate,
      threshold: baseline.repeatedBadDecisionRate == null ? null : baseline.repeatedBadDecisionRate + rule.maxRepeatedBadRegression,
      comparator: '<=',
    },
  ]

  const coverageFailed = checks.some(check => check.comparator === 'coverage' && !check.passed)
  const safetyFailed = checks.some(check => check.comparator !== 'coverage' && !check.passed)
  const divergenceDelta = subtractOrNull(candidate.divergedFromBadDecisionRate, baseline.divergedFromBadDecisionRate)
  const costDelta = subtractOrNull(candidate.avgPredictedCostUsd, baseline.avgPredictedCostUsd)
  const reasons: string[] = []

  if (coverageFailed) {
    reasons.push('Not enough replay coverage to promote this policy yet.')
  }
  if (safetyFailed) {
    reasons.push('Candidate regresses a constraint metric relative to the baseline.')
  }

  const improvedBadDiversion = divergenceDelta != null && divergenceDelta >= rule.minBadDivergenceImprovement
  const cheaperWithoutSafetyRegression = !safetyFailed
    && costDelta != null
    && costDelta <= -rule.minCostImprovementUsd
    && (candidate.safeGoodContinuationRate == null || baseline.safeGoodContinuationRate == null || candidate.safeGoodContinuationRate >= baseline.safeGoodContinuationRate)
    && (candidate.repeatedBadDecisionRate == null || baseline.repeatedBadDecisionRate == null || candidate.repeatedBadDecisionRate <= baseline.repeatedBadDecisionRate)

  if (!coverageFailed && !safetyFailed && improvedBadDiversion) {
    reasons.push('Candidate improves divergence from historically bad decisions without violating constraints.')
    return { status: 'promote', reasons, checks }
  }
  if (!coverageFailed && !safetyFailed && cheaperWithoutSafetyRegression) {
    reasons.push('Candidate is meaningfully cheaper on predicted cost while preserving safety-oriented constraints.')
    return { status: 'promote', reasons, checks }
  }
  if (safetyFailed) {
    return { status: 'reject', reasons, checks }
  }

  reasons.push('Candidate is viable but does not yet clear the promotion improvement thresholds.')
  return { status: 'hold', reasons, checks }
}

function summarizeCounts(items: string[]): Array<{ key: string, count: number }> {
  const counts = new Map<string, number>()
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
}

function summarizeTransitions(examples: ReplayPolicyEvaluationExample[]): Array<{ fromSkill: string, toSkill: string, count: number }> {
  const counts = new Map<string, number>()
  for (const example of examples) {
    const key = `${example.observed.context.skill}=>${example.candidate.decision.skill}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [fromSkill, toSkill] = key.split('=>')
      return { fromSkill, toSkill, count }
    })
    .sort((left, right) => right.count - left.count || left.fromSkill.localeCompare(right.fromSkill))
    .slice(0, 20)
}

export default {
  listReplayExamples,
  summarizeReplayExamples,
  exportReplayDataset,
  evaluateReplayPolicy,
}
