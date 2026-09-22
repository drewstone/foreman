export type PromptStandardsProfile = 'balanced' | 'strict' | 'delivery'
export type PromptGitWorkflowDetail = 'brief' | 'full'
export type PromptSkillGuideMode = 'auto' | 'always' | 'never'

export interface PromptPolicy {
  id: string
  standardsProfile: PromptStandardsProfile
  reasoningContextBudget: number
  executionContextBudget: number
  includeProjectHistory: boolean
  includeGoalHistory: boolean
  includeOperatorSignals: boolean
  includeOperatorExemplars: boolean
  includeDeadEnds: boolean
  includeGitWorkflow: boolean
  gitWorkflowDetail: PromptGitWorkflowDetail
  skillGuideMode: PromptSkillGuideMode
}

export interface PromptPolicyTrainingExample {
  skill: string
  task: string
  taskShape: string
  taskLengthBucket: 'short' | 'medium' | 'long'
  hasScope: boolean
  hasDeliverable: boolean
  success: boolean
  scopeViolation: boolean
  deliverableStatus: 'pass' | 'fail' | 'unchecked'
  variantId: string
}

export const DEFAULT_PROMPT_POLICY: PromptPolicy = {
  id: 'balanced-default',
  standardsProfile: 'balanced',
  reasoningContextBudget: 8000,
  executionContextBudget: 4000,
  includeProjectHistory: true,
  includeGoalHistory: true,
  includeOperatorSignals: true,
  includeOperatorExemplars: true,
  includeDeadEnds: true,
  includeGitWorkflow: true,
  gitWorkflowDetail: 'full',
  skillGuideMode: 'auto',
}

const BUILTIN_POLICIES: Record<string, PromptPolicy> = {
  [DEFAULT_PROMPT_POLICY.id]: DEFAULT_PROMPT_POLICY,
  'strict-guarded': {
    id: 'strict-guarded',
    standardsProfile: 'strict',
    reasoningContextBudget: 7000,
    executionContextBudget: 3200,
    includeProjectHistory: true,
    includeGoalHistory: true,
    includeOperatorSignals: true,
    includeOperatorExemplars: false,
    includeDeadEnds: true,
    includeGitWorkflow: true,
    gitWorkflowDetail: 'full',
    skillGuideMode: 'auto',
  },
  'rich-reasoning': {
    id: 'rich-reasoning',
    standardsProfile: 'delivery',
    reasoningContextBudget: 10000,
    executionContextBudget: 4500,
    includeProjectHistory: true,
    includeGoalHistory: true,
    includeOperatorSignals: true,
    includeOperatorExemplars: true,
    includeDeadEnds: true,
    includeGitWorkflow: true,
    gitWorkflowDetail: 'brief',
    skillGuideMode: 'always',
  },
  'lean-execution': {
    id: 'lean-execution',
    standardsProfile: 'delivery',
    reasoningContextBudget: 6500,
    executionContextBudget: 2600,
    includeProjectHistory: false,
    includeGoalHistory: false,
    includeOperatorSignals: true,
    includeOperatorExemplars: false,
    includeDeadEnds: true,
    includeGitWorkflow: true,
    gitWorkflowDetail: 'brief',
    skillGuideMode: 'never',
  },
  'history-heavy': {
    id: 'history-heavy',
    standardsProfile: 'balanced',
    reasoningContextBudget: 9500,
    executionContextBudget: 4200,
    includeProjectHistory: true,
    includeGoalHistory: true,
    includeOperatorSignals: true,
    includeOperatorExemplars: true,
    includeDeadEnds: true,
    includeGitWorkflow: true,
    gitWorkflowDetail: 'full',
    skillGuideMode: 'auto',
  },
}

function asPolicy(input: Partial<PromptPolicy> & { id: string }): PromptPolicy {
  return {
    ...DEFAULT_PROMPT_POLICY,
    ...input,
    id: input.id,
  }
}

function isStandardsProfile(value: unknown): value is PromptStandardsProfile {
  return value === 'balanced' || value === 'strict' || value === 'delivery'
}

function isGitWorkflowDetail(value: unknown): value is PromptGitWorkflowDetail {
  return value === 'brief' || value === 'full'
}

function isSkillGuideMode(value: unknown): value is PromptSkillGuideMode {
  return value === 'auto' || value === 'always' || value === 'never'
}

function normalizeBudget(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1500
    ? Math.round(value)
    : fallback
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function resolvePromptPolicyById(id: string | null | undefined): PromptPolicy | null {
  if (!id) return null
  const policy = BUILTIN_POLICIES[id]
  return policy ? { ...policy } : null
}

export function parsePromptPolicy(raw: string | null | undefined): PromptPolicy {
  if (!raw || raw === 'v1-default') return { ...DEFAULT_PROMPT_POLICY }

  const builtin = resolvePromptPolicyById(raw)
  if (builtin) return builtin

  try {
    const parsed = JSON.parse(raw) as Partial<PromptPolicy> & { id?: unknown }
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PROMPT_POLICY }
    const id = typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id : DEFAULT_PROMPT_POLICY.id
    return asPolicy({
      id,
      standardsProfile: isStandardsProfile(parsed.standardsProfile) ? parsed.standardsProfile : DEFAULT_PROMPT_POLICY.standardsProfile,
      reasoningContextBudget: normalizeBudget(parsed.reasoningContextBudget, DEFAULT_PROMPT_POLICY.reasoningContextBudget),
      executionContextBudget: normalizeBudget(parsed.executionContextBudget, DEFAULT_PROMPT_POLICY.executionContextBudget),
      includeProjectHistory: normalizeBoolean(parsed.includeProjectHistory, DEFAULT_PROMPT_POLICY.includeProjectHistory),
      includeGoalHistory: normalizeBoolean(parsed.includeGoalHistory, DEFAULT_PROMPT_POLICY.includeGoalHistory),
      includeOperatorSignals: normalizeBoolean(parsed.includeOperatorSignals, DEFAULT_PROMPT_POLICY.includeOperatorSignals),
      includeOperatorExemplars: normalizeBoolean(parsed.includeOperatorExemplars, DEFAULT_PROMPT_POLICY.includeOperatorExemplars),
      includeDeadEnds: normalizeBoolean(parsed.includeDeadEnds, DEFAULT_PROMPT_POLICY.includeDeadEnds),
      includeGitWorkflow: normalizeBoolean(parsed.includeGitWorkflow, DEFAULT_PROMPT_POLICY.includeGitWorkflow),
      gitWorkflowDetail: isGitWorkflowDetail(parsed.gitWorkflowDetail) ? parsed.gitWorkflowDetail : DEFAULT_PROMPT_POLICY.gitWorkflowDetail,
      skillGuideMode: isSkillGuideMode(parsed.skillGuideMode) ? parsed.skillGuideMode : DEFAULT_PROMPT_POLICY.skillGuideMode,
    })
  } catch {
    return { ...DEFAULT_PROMPT_POLICY }
  }
}

export function serializePromptPolicy(policy: PromptPolicy): string {
  const normalized = parsePromptPolicy(JSON.stringify(policy))
  return `${JSON.stringify(normalized)}\n`
}

export function shouldIncludeSkillGuide(skill: string, policy: PromptPolicy): boolean {
  if (policy.skillGuideMode === 'always') return true
  if (policy.skillGuideMode === 'never') return false
  return new Set(['/pursue', '/plan', '/research', '/reflect']).has(skill) || !skill
}

export function getContextBudgetForSkill(skill: string, policy: PromptPolicy): number {
  const reasoningSkills = new Set(['/pursue', '/plan', '/research', '/reflect', '/evolve'])
  return reasoningSkills.has(skill) ? policy.reasoningContextBudget : policy.executionContextBudget
}

export function classifyPromptTaskShape(skill: string, task: string): string {
  if (skill === '/verify' || skill === '/critical-audit') return 'verification'
  if (skill === '/diagnose' || skill === '/converge') return 'recovery'
  if (skill === '/pursue') return 'redesign'
  if (skill === '/research') return 'research'
  if (skill === '/evolve') return 'implementation'
  const lower = task.toLowerCase()
  if (lower.includes('verify') || lower.includes('audit')) return 'verification'
  if (lower.includes('diagnos') || lower.includes('debug') || lower.includes('repair')) return 'recovery'
  if (lower.includes('redesign') || lower.includes('architecture')) return 'redesign'
  return 'general'
}

export function classifyTaskLengthBucket(task: string): 'short' | 'medium' | 'long' {
  if (task.length < 80) return 'short'
  if (task.length < 220) return 'medium'
  return 'long'
}

export function inferRecommendedPromptPolicyId(example: PromptPolicyTrainingExample, currentPolicyId = DEFAULT_PROMPT_POLICY.id): string {
  if (example.scopeViolation || (example.hasScope && !example.success)) return 'strict-guarded'
  if (example.taskShape === 'verification' || example.taskShape === 'recovery') return 'lean-execution'
  if ((example.taskShape === 'redesign' || example.taskShape === 'research' || example.taskShape === 'implementation') && example.success) {
    return 'rich-reasoning'
  }
  return currentPolicyId
}

export function buildPromptPolicyCandidates(current: PromptPolicy): PromptPolicy[] {
  const variants = [
    current,
    ...Object.values(BUILTIN_POLICIES),
    asPolicy({
      ...current,
      id: `${current.id}-strict`,
      standardsProfile: 'strict',
      includeOperatorExemplars: false,
      executionContextBudget: Math.max(2200, current.executionContextBudget - 600),
    }),
    asPolicy({
      ...current,
      id: `${current.id}-lean`,
      standardsProfile: 'delivery',
      includeProjectHistory: false,
      includeGoalHistory: false,
      includeOperatorExemplars: false,
      executionContextBudget: Math.max(2200, current.executionContextBudget - 800),
      gitWorkflowDetail: 'brief',
      skillGuideMode: 'never',
    }),
    asPolicy({
      ...current,
      id: `${current.id}-rich`,
      reasoningContextBudget: current.reasoningContextBudget + 1500,
      includeProjectHistory: true,
      includeGoalHistory: true,
      includeOperatorSignals: true,
      includeOperatorExemplars: true,
      includeDeadEnds: true,
      gitWorkflowDetail: 'brief',
      skillGuideMode: 'always',
    }),
  ]

  const deduped = new Map<string, PromptPolicy>()
  for (const variant of variants) {
    deduped.set(variant.id, parsePromptPolicy(JSON.stringify(variant)))
  }
  return [...deduped.values()]
}

export function chooseHeuristicPromptPolicy(
  current: PromptPolicy,
  examples: PromptPolicyTrainingExample[],
): PromptPolicy {
  if (examples.length === 0) return current

  const weighted = new Map<string, number>()
  for (const example of examples) {
    const id = inferRecommendedPromptPolicyId(example, current.id)
    const weight = example.success ? 1 : 1.5
    weighted.set(id, (weighted.get(id) ?? 0) + weight)
  }

  const winnerId = [...weighted.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]

  return resolvePromptPolicyById(winnerId) ?? current
}
