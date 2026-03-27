import type Database from 'better-sqlite3'
import { getDispatchPolicyByName, policyRequiresLiveCalls } from './dispatch-policy.js'
import { evaluateReplayPolicy, listReplayExamples } from './replay.js'
import {
  getDispatchPolicyControl,
  getLatestReplayPolicyEvaluation,
  recordReplayPolicyEvaluation,
  setDispatchPolicyControl,
} from './policy-control.js'

export interface ReplayPromotionRequest {
  policyName: string
  baselineName?: string | null
  project?: string
  skill?: string
  limit?: number
  apply?: boolean
  force?: boolean
  allowLive?: boolean
  promotionRule?: {
    minExamples?: number
    minGoodExamples?: number
    minBadExamples?: number
  }
}

export async function promoteReplayPolicy(
  db: Database.Database,
  input: ReplayPromotionRequest,
): Promise<{
  evaluation: Awaited<ReturnType<typeof evaluateReplayPolicy>>
  activePolicy: ReturnType<typeof getDispatchPolicyControl>
  persisted: ReturnType<typeof recordReplayPolicyEvaluation>
}> {
  const baselineName = input.baselineName ?? (input.policyName === 'identity' ? null : 'identity')
  const policy = getDispatchPolicyByName(input.policyName)
  const baselinePolicy = baselineName ? getDispatchPolicyByName(baselineName) : null

  if (!policy) throw new Error(`unknown policy: ${input.policyName}`)
  if (baselineName && !baselinePolicy) throw new Error(`unknown baseline policy: ${baselineName}`)
  if (policyRequiresLiveCalls(input.policyName) && !input.allowLive) {
    throw new Error(`policy ${input.policyName} requires live model calls; pass allowLive=true to run it`)
  }
  if (baselineName && policyRequiresLiveCalls(baselineName) && !input.allowLive) {
    throw new Error(`baseline policy ${baselineName} requires live model calls; pass allowLive=true to run it`)
  }

  const examples = listReplayExamples(db, {
    limit: Number.isFinite(input.limit) ? input.limit : 50,
    project: input.project,
    skill: input.skill,
  })
  const evaluation = await evaluateReplayPolicy(examples, {
    policyName: input.policyName,
    decide: (ctx) => policy.decide(ctx),
    baseline: baselineName && baselinePolicy
      ? {
          policyName: baselineName,
          decide: (ctx) => baselinePolicy.decide(ctx),
        }
      : undefined,
    telemetryDb: db,
    promotionRule: input.promotionRule,
  })

  const shouldApply = input.apply === true && (input.force === true || evaluation.promotion?.status === 'promote')
  const activePolicy = shouldApply
    ? setDispatchPolicyControl(db, {
        policyName: input.policyName,
        source: input.force ? 'manual_force' : 'replay_promotion',
        baselinePolicyName: baselineName,
      })
    : getDispatchPolicyControl(db)

  const persisted = recordReplayPolicyEvaluation(db, {
    candidatePolicyName: input.policyName,
    baselinePolicyName: baselineName,
    scopeProject: input.project ?? null,
    scopeSkill: input.skill ?? null,
    summary: evaluation.summary,
    baselineSummary: evaluation.baselineSummary ?? null,
    comparison: evaluation.comparison ?? null,
    promotion: evaluation.promotion ?? null,
    promotionRule: evaluation.promotionRule ?? null,
    applied: shouldApply,
  })

  return { evaluation, activePolicy, persisted }
}

export function getReplayGovernanceSnapshot(db: Database.Database): {
  activePolicy: ReturnType<typeof getDispatchPolicyControl>
  latest: ReturnType<typeof getLatestReplayPolicyEvaluation>
} {
  return {
    activePolicy: getDispatchPolicyControl(db),
    latest: getLatestReplayPolicyEvaluation(db),
  }
}

export default {
  promoteReplayPolicy,
  getReplayGovernanceSnapshot,
}
