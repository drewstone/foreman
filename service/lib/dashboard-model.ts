import { basename } from 'node:path'

import type Database from 'better-sqlite3'

import { buildDispatchTrainingData, type DispatchTrainingExample } from './dispatch-policy.js'
import { pullSamples } from './prompt-lab.js'
import { listReplayExamples, summarizeReplayExamples, type ReplayExample } from './replay.js'
import { getDispatchPolicyControl, getLatestReplayPolicyEvaluation, listReplayPolicyEvaluations } from './policy-control.js'
import promptPolicyGovernor from './prompt-policy-governor.js'
import telemetry from './telemetry.js'
import telemetryImport from './telemetry-import.js'

const {
  summarizeTelemetry,
  summarizeTelemetryCoverage,
  summarizeTelemetrySources,
  summarizeTelemetryHarnessHealth,
  getDailyTelemetryCost,
} = telemetry

const {
  getLatestTelemetryImportRun,
  listTelemetryImportRuns,
} = telemetryImport
const {
  getActivePromptPolicy,
  getLatestPromptPolicyEvaluation,
  listPromptPolicyEvaluations,
} = promptPolicyGovernor

type AnyRow = Record<string, unknown>

interface DashboardInput {
  db: Database.Database
  maxDailyCostUsd: number
  uptimeSeconds: number
  goals: AnyRow[]
  sessions: AnyRow[]
  recentDecisions: AnyRow[]
  recentEvents: AnyRow[]
  confidenceEntries: AnyRow[]
}

type ProjectRecommendationKind = 'autoresearch' | 'optimize' | 'loop'
type RecommendationFocus = ProjectRecommendationKind | 'all'
type PromptSample = ReturnType<typeof pullSamples>[number]

interface DashboardQueryOptions {
  projects?: string[]
  limit?: number
  windowDays?: number
  focus?: RecommendationFocus | string
  selectedProject?: string
}

interface ProjectRecommendation {
  project: string
  recommendation: ProjectRecommendationKind
  confidence: number
  rationale: string[]
  whyNow: string
  whyNot: string[]
  nextActions: string[]
  warnings: Array<{
    key: string
    level: 'info' | 'warn' | 'critical'
    summary: string
  }>
  scores: Record<ProjectRecommendationKind, number>
  evidence: {
    windowDays: number
    lastReplayAt: string | null
    lastTrainingAt: string | null
    lastOperatorAt: string | null
    lastTelemetryAt: string | null
    promptSamples: number
    promptSuccessRate: number | null
    topSkills: Array<{ key: string, count: number }>
    topTrajectories: Array<{ key: string, count: number }>
    telemetryHarnesses: Array<{ key: string, count: number }>
    freshness: 'fresh' | 'stale' | 'cold'
  }
  metrics: {
    replayExamples: number
    trainingExamples: number
    activeGoals: number
    operatorSessions: number
    telemetryRuns7d: number
    successRate: number | null
    deliverablePassRate: number | null
    scopeViolationRate: number | null
    cost7dUsd: number
  }
}

interface ProjectRecommendationQuestion {
  focus: RecommendationFocus
  windowDays: number
  projects: string[]
  question: string
  answer: string
  confidence: number
  rationale: string[]
  recommendationCounts: Record<ProjectRecommendationKind, number>
  recommendations: ProjectRecommendation[]
  alternatives: Array<{
    project: string
    recommendation: ProjectRecommendationKind
    whyNow: string
    confidence: number
  }>
}

interface RecommendationPreset {
  id: string
  label: string
  focus: RecommendationFocus
  windowDays: number
  description: string
}

interface ProjectDrilldown {
  project: string
  windowDays: number
  recommendation: ProjectRecommendation | null
  activeGoals: Array<{
    id: number
    intent: string
    updatedAt: string | null
    workspacePath: string | null
  }>
  operatorSessions: Array<{
    id: string
    harness: string
    timestamp: string
    skills: string[]
    outcomes: string[]
    preview: string | null
  }>
  replayExamples: Array<{
    decisionId: number
    sessionName: string | null
    createdAt: string
    skill: string
    task: string
    status: string
    deliverableStatus: string
    trajectory: string
    costUsd: number | null
    refs: {
      decision: string
      session: string | null
      transcript: string | null
    }
  }>
  trainingExamples: Array<{
    createdAt: string
    source: string
    decisionId: number | null
    sessionName: string | null
    operatorSessionId: string | null
    mode: string | null | undefined
    skill: string
    outcome: string
    goalIntent: string
    refs: {
      decision: string | null
      session: string | null
      transcript: string | null
    }
  }>
  promptSamples: Array<{
    id: number
    createdAt: string
    skill: string
    promptPolicyId: string
    success: boolean
    deliverableStatus: string
    scopeViolation: boolean
    refs: {
      decision: string
    }
  }>
  telemetryRuns: Array<{
    id: number
    decisionId: number | null
    sessionName: string | null
    harness: string
    skill: string | null
    model: string | null
    costUsd: number | null
    finishedAt: string | null
    source: string | null
    refs: {
      telemetry: string
      decision: string | null
      session: string | null
      transcript: string | null
    }
  }>
}

interface DatasetHealthCheck {
  key: string
  level: 'good' | 'warn' | 'critical'
  summary: string
  detail: string
}

function toProjectName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!trimmed.includes('/')) return trimmed
  const base = basename(trimmed)
  return base || trimmed
}

function normalizeProjects(projects?: string[]): string[] {
  return [...new Set((projects ?? []).map(project => project.trim()).filter(Boolean))]
}

function normalizeWindowDays(windowDays?: number): number {
  if (!Number.isFinite(windowDays)) return 30
  return Math.min(90, Math.max(1, Math.floor(windowDays as number)))
}

function normalizeFocus(focus?: string | null): RecommendationFocus {
  return focus === 'autoresearch' || focus === 'optimize' || focus === 'loop' ? focus : 'all'
}

function withinWindow(createdAt: string | null | undefined, windowDays: number): boolean {
  if (!createdAt) return false
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000
  const timestamp = Date.parse(createdAt)
  return Number.isFinite(timestamp) && timestamp >= cutoff
}

function filterReplayExamples(
  replayExamples: ReplayExample[],
  options: DashboardQueryOptions,
): ReplayExample[] {
  const projects = new Set(normalizeProjects(options.projects))
  const windowDays = normalizeWindowDays(options.windowDays)
  return replayExamples.filter(example => {
    const matchesProject = projects.size === 0 || (!!example.context.project && projects.has(example.context.project))
    return matchesProject && withinWindow(example.createdAt, windowDays)
  })
}

function filterDispatchTraining(
  dispatchTraining: DispatchTrainingExample[],
  options: DashboardQueryOptions,
): DispatchTrainingExample[] {
  const projects = new Set(normalizeProjects(options.projects))
  const windowDays = normalizeWindowDays(options.windowDays)
  return dispatchTraining.filter(example => {
    const matchesProject = projects.size === 0 || (!!example.context.projectName && projects.has(example.context.projectName))
    return matchesProject && withinWindow(example.createdAt, windowDays)
  })
}

function filterPromptSamples(
  promptSamples: PromptSample[],
  options: DashboardQueryOptions,
): PromptSample[] {
  const windowDays = normalizeWindowDays(options.windowDays)
  return promptSamples.filter(sample => withinWindow(sample.createdAt, windowDays))
}

function loadPromptSamples(db: Database.Database, limit = 100): PromptSample[] {
  const rows = db.prepare(`
    SELECT d.id, d.skill, d.task, d.prompt_sections, d.prompt_policy_id, d.deliverable_status,
           d.scope_spec, d.deliverable_spec, d.status, d.metrics, d.created_at, d.worktree_path, pt.template
    FROM decisions d
    LEFT JOIN prompt_templates pt ON pt.version = d.template_version
    WHERE d.status IN ('success', 'failure')
    ORDER BY d.created_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: number
    skill: string
    task: string
    prompt_sections: string | null
    prompt_policy_id: string | null
    deliverable_status: string | null
    scope_spec: string | null
    deliverable_spec: string | null
    status: string
    metrics: string | null
    created_at: string
    worktree_path: string | null
    template: string | null
  }>

  return rows.map(row => {
    let scopeViolation = false
    try {
      const metrics = row.metrics ? JSON.parse(row.metrics) as Record<string, unknown> : {}
      scopeViolation = metrics.scopeStatus === 'violation' || false
    } catch {}

    return {
      id: row.id,
      createdAt: row.created_at,
      worktreePath: row.worktree_path,
      skill: row.skill || 'direct',
      task: row.task,
      promptSections: row.prompt_sections ? JSON.parse(row.prompt_sections) : [],
      promptTier: row.prompt_sections ? 'known' : 'unknown',
      promptPolicyId: row.prompt_policy_id || 'balanced-default',
      deliverableStatus: row.deliverable_status === 'pass' || row.deliverable_status === 'fail'
        ? row.deliverable_status
        : 'unchecked',
      scopeViolation,
      success: row.status === 'success',
      hasScope: !!row.scope_spec,
      hasDeliverable: !!row.deliverable_spec,
    } satisfies PromptSample
  })
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

function latestIso(values: Array<string | null | undefined>): string | null {
  const parsed = values
    .map(value => value ? Date.parse(value) : NaN)
    .filter(value => Number.isFinite(value))
    .sort((left, right) => right - left)
  return parsed.length > 0 ? new Date(parsed[0]).toISOString() : null
}

function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
  } catch {
    return []
  }
}

function freshnessLevel(values: Array<string | null | undefined>, windowDays: number): 'fresh' | 'stale' | 'cold' {
  const latest = latestIso(values)
  if (!latest) return 'cold'
  const ageMs = Date.now() - Date.parse(latest)
  if (ageMs <= Math.min(windowDays, 14) * 24 * 60 * 60 * 1000) return 'fresh'
  if (ageMs <= windowDays * 24 * 60 * 60 * 1000) return 'stale'
  return 'cold'
}

function groupCounts<T>(items: T[], keyFn: (item: T) => string | null | undefined, limit = 8): Array<{ key: string, count: number }> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = keyFn(item)
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }))
}

function buildRecommendationScores(input: {
  replayExamples: number
  trainingExamples: number
  activeGoals: number
  telemetryRuns: number
  successRate: number | null
  deliverablePassRate: number | null
  scopeViolationRate: number | null
}): Record<ProjectRecommendationKind, number> {
  const signalStrength = clamp((Math.min(input.replayExamples, 12) + Math.min(input.trainingExamples, 12)) / 24)
  const success = input.successRate ?? 0.5
  const deliverable = input.deliverablePassRate ?? 0.5
  const scope = input.scopeViolationRate ?? 0.1
  const activeDemand = clamp(input.activeGoals / 3)
  const telemetry = clamp(input.telemetryRuns / 4)

  const loop = clamp(
    success * 0.3 +
    deliverable * 0.25 +
    (1 - scope) * 0.2 +
    activeDemand * 0.15 +
    telemetry * 0.1,
  )
  const optimize = clamp(
    (1 - success) * 0.3 +
    (1 - deliverable) * 0.2 +
    scope * 0.25 +
    activeDemand * 0.15 +
    signalStrength * 0.1,
  )
  const autoresearch = clamp(
    (1 - signalStrength) * 0.55 +
    (1 - telemetry) * 0.15 +
    clamp(Math.abs(loop - optimize) < 0.1 ? 0.2 : 0) +
    clamp(input.activeGoals > 0 ? 0.1 : 0),
  )

  return { loop, optimize, autoresearch }
}

function buildRecommendationWarnings(input: {
  replayExamples: number
  trainingExamples: number
  telemetryRuns: number
  deliverablePassRate: number | null
  scopeViolationRate: number | null
  costUsd: number
  freshness: 'fresh' | 'stale' | 'cold'
}): ProjectRecommendation['warnings'] {
  const warnings: ProjectRecommendation['warnings'] = []
  if (input.replayExamples < 4) warnings.push({ key: 'thin_replay', level: 'warn', summary: 'Replay evidence is thin.' })
  if (input.trainingExamples < 4) warnings.push({ key: 'thin_training', level: 'warn', summary: 'Dispatch training evidence is thin.' })
  if (input.telemetryRuns === 0) warnings.push({ key: 'telemetry_missing', level: 'critical', summary: 'Recent telemetry is missing.' })
  else if (input.freshness !== 'fresh') warnings.push({ key: 'telemetry_stale', level: 'warn', summary: 'Evidence freshness is slipping.' })
  if (input.deliverablePassRate != null && input.deliverablePassRate < 0.6) warnings.push({ key: 'deliverable_risk', level: 'warn', summary: 'Deliverable pass rate is below the safe threshold.' })
  if (input.scopeViolationRate != null && input.scopeViolationRate > 0.15) warnings.push({ key: 'scope_risk', level: 'critical', summary: 'Scope violation rate is too high.' })
  if (input.costUsd >= 10) warnings.push({ key: 'cost_pressure', level: 'warn', summary: 'Recent spend is high enough to justify tighter gating.' })
  return warnings
}

function buildRecommendationNextActions(
  recommendation: ProjectRecommendationKind,
  project: string,
  warnings: ProjectRecommendation['warnings'],
): string[] {
  if (recommendation === 'loop') {
    return [
      `Increase autonomous looping on ${project} behind the current replay and budget gates.`,
      'Watch telemetry freshness and deliverable pass before widening the loop window.',
      warnings.some(warning => warning.key === 'telemetry_stale')
        ? 'Repair telemetry coverage before raising autonomy further.'
        : 'Use prompt and dispatch promotions only when replay still clears.',
    ]
  }
  if (recommendation === 'optimize') {
    return [
      `Treat ${project} as an optimization target before raising autonomy.`,
      'Inspect scope violations, failed deliverables, and bad replay trajectories first.',
      'Promote only bounded policy changes and rerun replay before dispatching harder.',
    ]
  }
  return [
    `Use ${project} to gather sharper evidence before changing autonomy levels.`,
    'Run targeted research or verification passes to increase replay and training volume.',
    'Keep the project visible, but avoid aggressive looping until the signal is cleaner.',
  ]
}

function buildRecommendationPresets(): RecommendationPreset[] {
  return [
    { id: 'portfolio', label: 'Portfolio', focus: 'all', windowDays: 30, description: 'Balanced default across the active portfolio.' },
    { id: 'loop', label: 'Loop Candidates', focus: 'loop', windowDays: 30, description: 'Projects stable enough for more autonomous looping.' },
    { id: 'optimize', label: 'Optimize First', focus: 'optimize', windowDays: 30, description: 'Projects where policy or workflow tightening should come first.' },
    { id: 'research', label: 'Research First', focus: 'autoresearch', windowDays: 30, description: 'Projects with thin or ambiguous evidence.' },
    { id: 'hot', label: 'Hot Window', focus: 'all', windowDays: 14, description: 'Short-window view of what changed recently.' },
  ]
}

function buildProjectRecommendations(
  db: Database.Database,
  replayExamples: ReplayExample[],
  dispatchTraining: DispatchTrainingExample[],
  options?: DashboardQueryOptions,
): ProjectRecommendation[] {
  const requestedProjects = new Set(normalizeProjects(options?.projects))
  const focus = normalizeFocus(options?.focus)
  const windowDays = normalizeWindowDays(options?.windowDays)
  const limit = options?.limit ?? (requestedProjects.size > 0 ? Math.max(requestedProjects.size, 8) : 8)
  const projectNames = new Set<string>()
  const shouldTrackProject = (project: string | null): project is string =>
    !!project && (requestedProjects.size === 0 || requestedProjects.has(project))

  for (const example of replayExamples) {
    if (shouldTrackProject(example.context.project)) projectNames.add(example.context.project)
  }
  for (const example of dispatchTraining) {
    if (shouldTrackProject(example.context.projectName) && example.context.projectName !== 'unknown') {
      projectNames.add(example.context.projectName)
    }
  }

  const goalProjects = db.prepare(`
    SELECT workspace_path
    FROM goals
    WHERE status = 'active' AND workspace_path IS NOT NULL
    ORDER BY updated_at DESC, id DESC
    LIMIT 50
  `).all() as Array<{ workspace_path: string | null }>
  for (const row of goalProjects) {
    const project = toProjectName(row.workspace_path)
    if (shouldTrackProject(project)) projectNames.add(project)
  }

  const operatorProjects = db.prepare(`
    SELECT repo
    FROM operator_sessions
    WHERE repo IS NOT NULL AND repo != ''
    ORDER BY timestamp DESC
    LIMIT 50
  `).all() as Array<{ repo: string | null }>
  for (const row of operatorProjects) {
    const project = toProjectName(row.repo)
    if (shouldTrackProject(project)) projectNames.add(project)
  }

  const recommendations: ProjectRecommendation[] = []
  if (requestedProjects.size > 0) {
    for (const project of requestedProjects) projectNames.add(project)
  }

  for (const project of [...projectNames]) {
    const replay = replayExamples.filter(example => example.context.project === project)
    const training = dispatchTraining.filter(example => example.context.projectName === project)
    const activeGoals = (db.prepare(`
      SELECT COUNT(*) as count
      FROM goals
      WHERE status = 'active' AND workspace_path LIKE ?
    `).get(`%${project}%`) as { count: number }).count
    const operatorSessions = (db.prepare(`
      SELECT COUNT(*) as count
      FROM operator_sessions
      WHERE repo LIKE ?
    `).get(`%${project}%`) as { count: number }).count
    const telemetry = db.prepare(`
      SELECT COUNT(*) as runs, COALESCE(SUM(cost_usd), 0) as costUsd,
             MAX(datetime(COALESCE(finished_at, created_at))) as lastSeenAt
      FROM telemetry_runs
      WHERE repo LIKE ?
        AND datetime(COALESCE(finished_at, created_at)) >= datetime('now', '-168 hours')
    `).get(`%${project}%`) as { runs: number, costUsd: number, lastSeenAt: string | null }
    const promptStats = db.prepare(`
      SELECT COUNT(*) as samples,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
             MAX(created_at) as lastPromptAt
      FROM decisions
      WHERE prompt_policy_id IS NOT NULL
        AND worktree_path LIKE ?
        AND datetime(created_at) >= datetime('now', ?)
    `).get(`%${project}%`, `-${windowDays} days`) as { samples: number, successes: number | null, lastPromptAt: string | null }
    const telemetryHarnesses = db.prepare(`
      SELECT COALESCE(harness, 'unknown') as key, COUNT(*) as count
      FROM telemetry_runs
      WHERE repo LIKE ?
        AND datetime(COALESCE(finished_at, created_at)) >= datetime('now', ?)
      GROUP BY harness
      ORDER BY count DESC, harness ASC
      LIMIT 3
    `).all(`%${project}%`, `-${windowDays} days`) as Array<{ key: string, count: number }>

    const successRate = rate(
      replay.filter(example => example.objectives.dispatchSucceeded === 1).length,
      replay.length,
    )
    const deliverableMeasured = replay.filter(example => example.objectives.deliverablePassed != null)
    const deliverablePassRate = rate(
      deliverableMeasured.filter(example => example.objectives.deliverablePassed === 1).length,
      deliverableMeasured.length,
    )
    const scopeMeasured = replay.filter(example => example.objectives.scopeViolation != null)
    const scopeViolationRate = rate(
      scopeMeasured.filter(example => example.objectives.scopeViolation === 1).length,
      scopeMeasured.length,
    )
    const topSkills = groupCounts(training, example => example.decision.skill, 3)
    const topTrajectories = groupCounts(replay, example => example.observed.trajectory, 3)
    const lastReplayAt = latestIso(replay.map(example => example.createdAt))
    const lastTrainingAt = latestIso(training.map(example => example.createdAt))
    const lastOperatorAt = latestIso(training.filter(example => example.source === 'operator_session').map(example => example.createdAt))
    const freshness = freshnessLevel([lastReplayAt, lastTrainingAt, lastOperatorAt, telemetry.lastSeenAt], windowDays)
    const scores = buildRecommendationScores({
      replayExamples: replay.length,
      trainingExamples: training.length,
      activeGoals,
      telemetryRuns: telemetry.runs,
      successRate,
      deliverablePassRate,
      scopeViolationRate,
    })

    const rationale: string[] = []
    let recommendation: ProjectRecommendationKind = 'autoresearch'
    let confidence = 0.55

    if (replay.length < 4 || training.length < 4) {
      recommendation = 'autoresearch'
      confidence = 0.8
      rationale.push('Signal is thin; gather more evidence before pushing autonomy harder.')
      if (activeGoals > 0) rationale.push('There is active intent here, but the eval surface is still sparse.')
    } else if ((successRate ?? 0) < 0.55 || (deliverablePassRate != null && deliverablePassRate < 0.6) || (scopeViolationRate != null && scopeViolationRate > 0.15)) {
      recommendation = 'optimize'
      confidence = 0.82
      rationale.push('Outcomes are noisy enough that policy or workflow tightening should come before more looping.')
      if (deliverablePassRate != null && deliverablePassRate < 0.6) rationale.push('Deliverable pass rate is below the safe threshold.')
      if (scopeViolationRate != null && scopeViolationRate > 0.15) rationale.push('Scope control is weak relative to the rest of the portfolio.')
    } else if ((successRate ?? 0) >= 0.7 && (deliverablePassRate ?? 0) >= 0.65 && telemetry.runs >= 3 && activeGoals > 0) {
      recommendation = 'loop'
      confidence = 0.85
      rationale.push('This project has enough measured stability and active demand to justify more autonomous looping.')
      rationale.push('Telemetry coverage is present, so cost and outcome drift will be visible.')
    } else {
      recommendation = 'autoresearch'
      confidence = 0.66
      rationale.push('The project is neither clearly unstable nor clearly loop-ready; targeted research should sharpen the next move.')
    }

    if (telemetry.costUsd > 10 && recommendation !== 'loop') {
      rationale.push('Recent spend is material, so tighter evaluation discipline matters here.')
      confidence = Math.min(0.92, confidence + 0.04)
    }
    const warnings = buildRecommendationWarnings({
      replayExamples: replay.length,
      trainingExamples: training.length,
      telemetryRuns: telemetry.runs,
      deliverablePassRate,
      scopeViolationRate,
      costUsd: telemetry.costUsd,
      freshness,
    })
    const whyNow = rationale[0] ?? 'This project is the strongest fit for the current recommendation.'
    const whyNot = ([
      recommendation !== 'loop'
        ? 'It is not loop-ready because measured stability, telemetry coverage, or active demand are still insufficient.'
        : null,
      recommendation !== 'optimize'
        ? 'It does not need immediate optimization because failure pressure is lower than the current portfolio bottlenecks.'
        : null,
      recommendation !== 'autoresearch'
        ? 'It does not need to stay in research mode because the evidence is already strong enough to act on.'
        : null,
    ].filter(Boolean) as string[]).slice(0, 2)
    const nextActions = buildRecommendationNextActions(recommendation, project, warnings)

    recommendations.push({
      project,
      recommendation,
      confidence,
      rationale: rationale.slice(0, 3),
      whyNow,
      whyNot,
      nextActions,
      warnings,
      scores,
      evidence: {
        windowDays,
        lastReplayAt,
        lastTrainingAt,
        lastOperatorAt,
        lastTelemetryAt: telemetry.lastSeenAt,
        promptSamples: promptStats.samples,
        promptSuccessRate: rate(promptStats.successes ?? 0, promptStats.samples),
        topSkills,
        topTrajectories,
        telemetryHarnesses,
        freshness,
      },
      metrics: {
        replayExamples: replay.length,
        trainingExamples: training.length,
        activeGoals,
        operatorSessions,
        telemetryRuns7d: telemetry.runs,
        successRate,
        deliverablePassRate,
        scopeViolationRate,
        cost7dUsd: telemetry.costUsd,
      },
    })
  }

  const rank = { loop: 0, optimize: 1, autoresearch: 2 }
  const filtered = focus === 'all'
    ? recommendations
    : recommendations.filter(recommendation => recommendation.recommendation === focus)

  return filtered
    .sort((left, right) => {
      const priority = rank[left.recommendation] - rank[right.recommendation]
      if (priority !== 0) return priority
      const scoreDelta = right.scores[right.recommendation] - left.scores[left.recommendation]
      if (scoreDelta !== 0) return scoreDelta
      if (right.confidence !== left.confidence) return right.confidence - left.confidence
      return right.metrics.activeGoals - left.metrics.activeGoals
    })
    .slice(0, limit)
}

function buildDatasetHealth(
  replayExamples: ReplayExample[],
  dispatchTraining: DispatchTrainingExample[],
  promptSamples: ReturnType<typeof pullSamples>,
  telemetryCoverage: ReturnType<typeof summarizeTelemetryCoverage>,
): DatasetHealthCheck[] {
  const checks: DatasetHealthCheck[] = []
  const operatorExamples = dispatchTraining.filter(example => example.source === 'operator_session').length
  const operatorShare = rate(operatorExamples, dispatchTraining.length) ?? 0

  checks.push(
    replayExamples.length >= 20
      ? {
          key: 'replay_volume',
          level: 'good',
          summary: 'Replay volume is usable.',
          detail: `${replayExamples.length} replay examples are available for evaluation.`,
        }
      : {
          key: 'replay_volume',
          level: 'warn',
          summary: 'Replay volume is still thin.',
          detail: `Only ${replayExamples.length} replay examples are available; promotion results may be unstable.`,
        }
  )

  checks.push(
    telemetryCoverage.coverageRate >= 0.7
      ? {
          key: 'telemetry_coverage',
          level: 'good',
          summary: 'Telemetry coverage is healthy.',
          detail: `${Math.round(telemetryCoverage.coverageRate * 100)}% of completed decisions have telemetry attached.`,
        }
      : {
          key: 'telemetry_coverage',
          level: telemetryCoverage.coverageRate >= 0.45 ? 'warn' : 'critical',
          summary: 'Telemetry coverage is incomplete.',
          detail: `${Math.round(telemetryCoverage.coverageRate * 100)}% of completed decisions have telemetry; cost and harness inference will be biased.`,
        }
  )

  checks.push(
    operatorShare >= 0.2 && operatorShare <= 0.75
      ? {
          key: 'operator_mix',
          level: 'good',
          summary: 'Operator / Foreman training mix is balanced enough.',
          detail: `${Math.round(operatorShare * 100)}% of dispatch training examples come from operator sessions.`,
        }
      : {
          key: 'operator_mix',
          level: 'warn',
          summary: 'Dispatch training mix is skewed.',
          detail: `${Math.round(operatorShare * 100)}% of dispatch training examples come from operator sessions; imitation or underfitting risk is higher.`,
        }
  )

  checks.push(
    promptSamples.length >= 12
      ? {
          key: 'prompt_samples',
          level: 'good',
          summary: 'Prompt-policy sample volume is usable.',
          detail: `${promptSamples.length} prompt-policy samples are available for analysis.`,
        }
      : {
          key: 'prompt_samples',
          level: 'warn',
          summary: 'Prompt-policy evidence is thin.',
          detail: `${promptSamples.length} prompt-policy samples are available; prompt policy changes should stay conservative.`,
        }
  )

  return checks
}

function buildProjectQuestion(
  recommendations: ProjectRecommendation[],
  options?: DashboardQueryOptions,
  allRecommendations: ProjectRecommendation[] = recommendations,
): ProjectRecommendationQuestion {
  const focus = normalizeFocus(options?.focus)
  const windowDays = normalizeWindowDays(options?.windowDays)
  const projects = normalizeProjects(options?.projects)
  const recommendationCounts = {
    autoresearch: allRecommendations.filter(item => item.recommendation === 'autoresearch').length,
    optimize: allRecommendations.filter(item => item.recommendation === 'optimize').length,
    loop: allRecommendations.filter(item => item.recommendation === 'loop').length,
  }

  const focusLabel = focus === 'all' ? 'next' : focus
  const scopeLabel = projects.length > 0 ? projects.join(', ') : 'the current portfolio'
  const question = focus === 'all'
    ? `What should Drew focus on next across ${scopeLabel}?`
    : `What should Drew ${focusLabel} over the next ${windowDays}d across ${scopeLabel}?`

  if (recommendations.length === 0) {
    const fallback = allRecommendations[0]
    return {
      focus,
      windowDays,
      projects,
      question,
      answer: fallback
        ? `No project cleanly supports ${focus}; ${fallback.project} currently points to ${fallback.recommendation} instead.`
        : `No ${focus === 'all' ? '' : `${focus} `}recommendations are supported by the current filtered evidence.`,
      confidence: 0.42,
      rationale: [
        'The filtered evidence window is too thin for a reliable recommendation.',
        fallback ? fallback.rationale[0] : 'Broaden the window or remove some project filters before promoting autonomy changes.',
      ],
      recommendationCounts,
      recommendations: [],
      alternatives: allRecommendations.slice(0, 3).map(item => ({
        project: item.project,
        recommendation: item.recommendation,
        whyNow: item.whyNow,
        confidence: item.confidence,
      })),
    }
  }

  const top = recommendations[0]
  const answer = focus === 'all'
    ? `${top.project} is the strongest immediate focus for ${top.recommendation}.`
    : top.recommendation === focus
      ? `${top.project} is the strongest ${focus} candidate right now.`
      : `No project cleanly supports ${focus}; ${top.project} instead points to ${top.recommendation}.`

  const rationale = [
    top.rationale[0],
    recommendationCounts.loop > 0 ? `${recommendationCounts.loop} project${recommendationCounts.loop === 1 ? '' : 's'} are loop-ready in this slice.` : 'No project is clearly loop-ready in this slice.',
    recommendationCounts.optimize > 0 ? `${recommendationCounts.optimize} project${recommendationCounts.optimize === 1 ? '' : 's'} need optimization before more autonomy.` : 'Optimization pressure is limited in this slice.',
  ].filter(Boolean)

  return {
    focus,
    windowDays,
    projects,
    question,
    answer,
    confidence: top.confidence,
    rationale,
    recommendationCounts,
    recommendations,
    alternatives: allRecommendations.slice(0, 3).map(item => ({
      project: item.project,
      recommendation: item.recommendation,
      whyNow: item.whyNow,
      confidence: item.confidence,
    })),
  }
}

function buildProjectDrilldown(
  db: Database.Database,
  project: string | null | undefined,
  options: DashboardQueryOptions,
  recommendation: ProjectRecommendation | null,
  replayExamples: ReplayExample[],
  dispatchTraining: DispatchTrainingExample[],
  promptSamples: PromptSample[],
): ProjectDrilldown | null {
  const projectName = project?.trim()
  if (!projectName) return null
  const windowDays = normalizeWindowDays(options.windowDays)
  const lowerLike = `%${projectName}%`
  const goals = db.prepare(`
    SELECT id, intent, workspace_path, updated_at
    FROM goals
    WHERE workspace_path LIKE ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 8
  `).all(lowerLike) as Array<{ id: number, intent: string, workspace_path: string | null, updated_at: string | null }>
  const operatorRows = db.prepare(`
    SELECT id, harness, timestamp, user_messages, skills_used, outcome_signals
    FROM operator_sessions
    WHERE repo LIKE ?
      AND datetime(timestamp) >= datetime('now', ?)
    ORDER BY timestamp DESC
    LIMIT 8
  `).all(lowerLike, `-${windowDays} days`) as Array<{
    id: string
    harness: string
    timestamp: string
    user_messages: string | null
    skills_used: string | null
    outcome_signals: string | null
  }>
  const telemetryRows = db.prepare(`
    SELECT id, decision_id, session_name, COALESCE(harness, 'unknown') as harness, skill, model, cost_usd, source,
           COALESCE(finished_at, created_at) as finished_at
    FROM telemetry_runs
    WHERE repo LIKE ?
      AND datetime(COALESCE(finished_at, created_at)) >= datetime('now', ?)
    ORDER BY datetime(COALESCE(finished_at, created_at)) DESC
    LIMIT 10
  `).all(lowerLike, `-${windowDays} days`) as Array<{
    id: number
    decision_id: number | null
    session_name: string | null
    harness: string
    skill: string | null
    model: string | null
    cost_usd: number | null
    source: string | null
    finished_at: string | null
  }>

  return {
    project: projectName,
    windowDays,
    recommendation,
    activeGoals: goals.map(goal => ({
      id: goal.id,
      intent: goal.intent,
      updatedAt: goal.updated_at,
      workspacePath: goal.workspace_path,
    })),
    operatorSessions: operatorRows.map(row => {
      const messages = parseJsonStringArray(row.user_messages)
      return {
        id: row.id,
        harness: row.harness,
        timestamp: row.timestamp,
        skills: parseJsonStringArray(row.skills_used),
        outcomes: parseJsonStringArray(row.outcome_signals),
        preview: messages.find(message => message.trim() && !message.trim().startsWith('/')) ?? messages[0] ?? null,
      }
    }),
    replayExamples: replayExamples
      .filter(example => example.context.project === projectName)
      .slice(0, 10)
      .map(example => ({
        decisionId: example.decisionId,
        sessionName: example.observed.sessionName,
        createdAt: example.createdAt,
        skill: example.context.skill,
        task: example.context.task,
        status: example.observed.status,
        deliverableStatus: example.observed.deliverableStatus,
        trajectory: example.observed.trajectory,
        costUsd: example.objectives.costUsd,
        refs: {
          decision: `/api/decisions/${example.decisionId}`,
          session: example.observed.sessionName ? `/api/sessions/${encodeURIComponent(example.observed.sessionName)}` : null,
          transcript: example.observed.sessionName ? `/api/sessions/${encodeURIComponent(example.observed.sessionName)}/transcript` : null,
        },
      })),
    trainingExamples: dispatchTraining
      .filter(example => example.context.projectName === projectName)
      .slice(0, 10)
      .map(example => ({
        createdAt: example.createdAt,
        source: example.source,
        decisionId: example.decisionId ?? null,
        sessionName: example.sessionName ?? null,
        operatorSessionId: example.operatorSessionId ?? null,
        mode: example.decision.mode,
        skill: example.decision.skill,
        outcome: example.outcome,
        goalIntent: example.context.goalIntent,
        refs: {
          decision: example.decisionId ? `/api/decisions/${example.decisionId}` : null,
          session: example.sessionName ? `/api/sessions/${encodeURIComponent(example.sessionName)}` : null,
          transcript: example.sessionName ? `/api/sessions/${encodeURIComponent(example.sessionName)}/transcript` : null,
        },
      })),
    promptSamples: promptSamples
      .filter(sample => toProjectName(sample.worktreePath) === projectName)
      .slice(0, 10)
      .map(sample => ({
        id: sample.id,
        createdAt: sample.createdAt,
        skill: sample.skill,
        promptPolicyId: sample.promptPolicyId,
        success: sample.success,
        deliverableStatus: sample.deliverableStatus,
        scopeViolation: sample.scopeViolation,
        refs: {
          decision: `/api/decisions/${sample.id}`,
        },
      })),
    telemetryRuns: telemetryRows.map(row => ({
      id: row.id,
      decisionId: row.decision_id,
      sessionName: row.session_name,
      harness: row.harness,
      skill: row.skill,
      model: row.model,
      costUsd: row.cost_usd,
      finishedAt: row.finished_at,
      source: row.source,
      refs: {
        telemetry: `/api/telemetry/runs/${row.id}`,
        decision: row.decision_id ? `/api/decisions/${row.decision_id}` : null,
        session: row.session_name ? `/api/sessions/${encodeURIComponent(row.session_name)}` : null,
        transcript: row.session_name ? `/api/sessions/${encodeURIComponent(row.session_name)}/transcript` : null,
      },
    })),
  }
}

export function buildDashboardModel(input: DashboardInput, options?: DashboardQueryOptions): Record<string, unknown> {
  const { db } = input
  const filters = {
    projects: normalizeProjects(options?.projects),
    limit: options?.limit ?? 8,
    windowDays: normalizeWindowDays(options?.windowDays),
    focus: normalizeFocus(options?.focus),
  }
  const replayExamples = filterReplayExamples(listReplayExamples(db, { limit: 320 }), filters)
  const replaySummary = summarizeReplayExamples(replayExamples)
  const replayHistory = listReplayPolicyEvaluations(db, { limit: 8 })
  const latestReplay = getLatestReplayPolicyEvaluation(db)
  const activeDispatchPolicy = getDispatchPolicyControl(db)

  const dispatchTraining = filterDispatchTraining(buildDispatchTrainingData(db, {
    decisionLimit: 80,
    operatorSessionLimit: 60,
  }), filters)
  const promptSamples = filterPromptSamples(loadPromptSamples(db, 180), filters)
  const activePromptPolicy = getActivePromptPolicy(db)
  const latestPromptPolicyEvaluation = getLatestPromptPolicyEvaluation(db)
  const promptPolicyHistory = listPromptPolicyEvaluations(db, { limit: 8 })

  const telemetry24h = summarizeTelemetry(db, 24)
  const telemetryCoverage = summarizeTelemetryCoverage(db)
  const telemetrySources = summarizeTelemetrySources(db, 24 * 7)
  const telemetryHarnessHealth = summarizeTelemetryHarnessHealth(db, 24 * 7)
  const latestImport = getLatestTelemetryImportRun(db)
  const recentImports = listTelemetryImportRuns(db, { limit: 6 })
  const todayCost = getDailyTelemetryCost(db)

  const decisionCount = (db.prepare(`SELECT COUNT(*) as count FROM decisions`).get() as { count: number }).count
  const successCount = (db.prepare(`SELECT COUNT(*) as count FROM decisions WHERE status = 'success'`).get() as { count: number }).count
  const operatorSessionCount = (db.prepare(`SELECT COUNT(*) as count FROM operator_sessions`).get() as { count: number }).count
  const activeGoals = input.goals.length
  const dispatchTrainingModes = groupCounts(dispatchTraining, example => example.decision.mode ?? 'unknown', 10)
  const dispatchTrainingSkills = groupCounts(dispatchTraining, example => example.decision.skill, 10)
  const dispatchTrainingProjects = groupCounts(dispatchTraining, example => example.context.projectName, 10)
  const promptPolicies = groupCounts(promptSamples, sample => sample.promptPolicyId, 10)
  const promptSampleSkills = groupCounts(promptSamples, sample => sample.skill, 10)
  const promptSampleOutcomes = [
    {
      key: 'success',
      count: promptSamples.filter(sample => sample.success).length,
    },
    {
      key: 'failure',
      count: promptSamples.filter(sample => !sample.success).length,
    },
  ]
  const allProjectRecommendations = buildProjectRecommendations(db, replayExamples, dispatchTraining, {
    ...filters,
    focus: 'all',
    limit: Math.max(filters.limit, 12),
  })
  const projectRecommendations = filters.focus === 'all'
    ? allProjectRecommendations.slice(0, filters.limit)
    : buildProjectRecommendations(db, replayExamples, dispatchTraining, filters)
  const selectedProject = options?.selectedProject?.trim()
    || projectRecommendations[0]?.project
    || allProjectRecommendations[0]?.project
    || filters.projects[0]
    || null
  const selectedRecommendation = selectedProject
    ? allProjectRecommendations.find(item => item.project === selectedProject) ?? null
    : null

  return {
    generatedAt: new Date().toISOString(),
    filters,
    recommendationPresets: buildRecommendationPresets(),
    selectedProject,
    uptimeSeconds: input.uptimeSeconds,
    overview: {
      decisions: decisionCount,
      successRate: rate(successCount, decisionCount),
      activeGoals,
      activeSessions: input.sessions.length,
      operatorSessions: operatorSessionCount,
      activeDispatchPolicy,
      todayCostUsd: todayCost,
      budgetBlocked: todayCost >= input.maxDailyCostUsd,
      budgetDailyUsd: input.maxDailyCostUsd,
      telemetryCoverage,
      latestReplay,
    },
    live: {
      goals: input.goals,
      sessions: input.sessions,
      recentDecisions: input.recentDecisions,
      recentEvents: input.recentEvents,
      confidenceEntries: input.confidenceEntries,
    },
    telemetry: {
      summary24h: telemetry24h,
      coverage: telemetryCoverage,
      sources: telemetrySources,
      harnessHealth: telemetryHarnessHealth,
      latestImport,
      recentImports,
    },
    replay: {
      summary: replaySummary,
      latest: latestReplay,
      history: replayHistory,
      recentExamples: replayExamples.slice(0, 16).map(example => ({
        decisionId: example.decisionId,
        project: example.context.project,
        skill: example.context.skill,
        task: example.context.task,
        status: example.observed.status,
        deliverableStatus: example.observed.deliverableStatus,
        trajectory: example.observed.trajectory,
        costUsd: example.objectives.costUsd,
        scopeViolation: example.objectives.scopeViolation,
        testsPassed: example.objectives.testsPassed,
      })),
    },
    dispatchTraining: {
      examples: dispatchTraining.length,
      bySource: groupCounts(dispatchTraining, example => example.source, 10),
      byOutcome: groupCounts(dispatchTraining, example => example.outcome, 10),
      byMode: dispatchTrainingModes,
      bySkill: dispatchTrainingSkills,
      byProject: dispatchTrainingProjects,
      sampleExamples: dispatchTraining.slice(0, 18).map(example => ({
        source: example.source,
        project: example.context.projectName,
        goalIntent: example.context.goalIntent,
        mode: example.decision.mode,
        skill: example.decision.skill,
        outcome: example.outcome,
        projectPhase: example.context.projectPhase,
        budgetStatus: example.context.budgetStatus,
      })),
    },
    promptPolicy: {
      active: activePromptPolicy,
      latestEvaluation: latestPromptPolicyEvaluation,
      history: promptPolicyHistory,
      samples: promptSamples.length,
      successRate: rate(promptSamples.filter(sample => sample.success).length, promptSamples.length),
      byPolicy: promptPolicies,
      bySkill: promptSampleSkills,
      byOutcome: promptSampleOutcomes,
      sampleExamples: promptSamples.slice(0, 18).map(sample => ({
        id: sample.id,
        skill: sample.skill,
        task: sample.task,
        promptPolicyId: sample.promptPolicyId,
        success: sample.success,
        deliverableStatus: sample.deliverableStatus,
        scopeViolation: sample.scopeViolation,
      })),
    },
    questionSurface: buildProjectQuestion(projectRecommendations, filters, allProjectRecommendations),
    projectRecommendations,
    projectDrilldown: buildProjectDrilldown(
      db,
      selectedProject,
      filters,
      selectedRecommendation,
      replayExamples,
      dispatchTraining,
      promptSamples,
    ),
    datasetHealth: buildDatasetHealth(replayExamples, dispatchTraining, promptSamples, telemetryCoverage),
  }
}

export function listProjectRecommendations(
  db: Database.Database,
  options?: DashboardQueryOptions,
): ProjectRecommendation[] {
  const filters = {
    projects: normalizeProjects(options?.projects),
    limit: options?.limit ?? 8,
    windowDays: normalizeWindowDays(options?.windowDays),
    focus: normalizeFocus(options?.focus),
  }
  const replayExamples = filterReplayExamples(listReplayExamples(db, { limit: 400 }), filters)
  const dispatchTraining = filterDispatchTraining(buildDispatchTrainingData(db, {
    decisionLimit: 100,
    operatorSessionLimit: 80,
  }), filters)
  return buildProjectRecommendations(db, replayExamples, dispatchTraining, filters)
}

export function answerProjectQuestion(
  db: Database.Database,
  options?: DashboardQueryOptions,
): ProjectRecommendationQuestion {
  const filters = {
    projects: normalizeProjects(options?.projects),
    limit: options?.limit ?? 8,
    windowDays: normalizeWindowDays(options?.windowDays),
    focus: normalizeFocus(options?.focus),
  }
  const allRecommendations = listProjectRecommendations(db, {
    ...filters,
    focus: 'all',
    limit: Math.max(filters.limit, 12),
  })
  const recommendations = filters.focus === 'all'
    ? allRecommendations.slice(0, filters.limit)
    : listProjectRecommendations(db, filters)
  return buildProjectQuestion(recommendations, filters, allRecommendations)
}

export function getProjectDrilldown(
  db: Database.Database,
  project: string,
  options?: DashboardQueryOptions,
): ProjectDrilldown | null {
  const scopedProjects = normalizeProjects([project, ...(options?.projects ?? [])])
  const filters = {
    projects: scopedProjects,
    limit: options?.limit ?? 8,
    windowDays: normalizeWindowDays(options?.windowDays),
    focus: normalizeFocus(options?.focus),
    selectedProject: project,
  }
  const replayExamples = filterReplayExamples(listReplayExamples(db, { limit: 400 }), filters)
  const dispatchTraining = filterDispatchTraining(buildDispatchTrainingData(db, {
    decisionLimit: 100,
    operatorSessionLimit: 80,
  }), filters)
  const promptSamples = filterPromptSamples(loadPromptSamples(db, 180), filters)
  const allRecommendations = buildProjectRecommendations(db, replayExamples, dispatchTraining, {
    ...filters,
    focus: 'all',
    limit: Math.max(filters.limit, 12),
  })
  const recommendation = allRecommendations.find(item => item.project === project) ?? null
  return buildProjectDrilldown(db, project, filters, recommendation, replayExamples, dispatchTraining, promptSamples)
}

export default {
  buildDashboardModel,
  listProjectRecommendations,
  answerProjectQuestion,
  getProjectDrilldown,
}
