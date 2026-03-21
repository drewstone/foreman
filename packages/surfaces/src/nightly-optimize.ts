/**
 * Nightly optimization orchestrator.
 *
 * Runs the full optimization pipeline:
 *   1. Generate variants for underperforming artifacts
 *   2. Run AxLLM GEPA optimization on traces with enough data
 *   3. Auto-promote winning artifact versions
 *   4. Track skill performance
 *   5. Generate golden suites from successful traces
 *   6. Check cost budgets
 *   7. Send notifications
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { VersionedStore } from '@drew/foreman-core'
import { FilesystemTraceStore } from '@drew/foreman-tracing'
import {
  buildPromptDataset,
  rankPromptVariants,
  recommendPromptVariants,
  updatePromptPolicy,
  FilesystemPromptPolicyStore,
  FilesystemOptimizationStore,
  AxPromptOptimizerAdapter,
  type PromptOptimizerConfig,
} from '@drew/foreman-optimizer'
import { generateVariants } from './variant-generator.js'
import { trackSkillPerformance, detectDegradation } from './skill-tracker.js'
import { generateGoldenSuiteFromTraces } from './golden-suite-generator.js'
import { notifyPromotion, notifyDegradation } from './notify.js'
import { loadSessionMetrics, aggregateMetrics } from './session-metrics.js'
import { analyzeSessionsDeep } from './session-analysis.js'
import { extractIntents, updateCampaigns } from './intent-engine.js'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export interface NightlyResult {
  variantsGenerated: number
  promotions: string[]
  skillAlerts: number
  goldenCases: number
  gepaRan: boolean
  costLast24h: number
  budgetExceeded: boolean
}

export async function runNightlyOptimization(options?: {
  onProgress?: (msg: string) => void
  costBudgetUsd?: number
  skipGepa?: boolean
}): Promise<NightlyResult> {
  const log = options?.onProgress ?? (() => {})
  const result: NightlyResult = {
    variantsGenerated: 0,
    promotions: [],
    skillAlerts: 0,
    goldenCases: 0,
    gepaRan: false,
    costLast24h: 0,
    budgetExceeded: false,
  }

  // Step 1: Generate variants
  log('[1/6] Generating artifact variants...')
  try {
    const proposals = await generateVariants({
      scoreThreshold: 0.8,
      maxPerArtifact: 1,
      onProgress: log,
    })
    result.variantsGenerated = proposals.length
  } catch (e) {
    log(`  variant generation failed: ${e}`)
  }

  // Step 2: GEPA optimization (if enough traces)
  if (!options?.skipGepa) {
    log('[2/6] Running GEPA optimization...')
    try {
      const traceStore = new FilesystemTraceStore(join(FOREMAN_HOME, 'traces', 'evals'))
      const refs = await traceStore.list()

      if (refs.length >= 10) {
        const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY
        if (apiKey) {
          const provider = process.env.ANTHROPIC_API_KEY ? 'anthropic' as const : 'openai' as const
          const model = provider === 'anthropic' ? 'claude-sonnet-4-6-20250514' : 'gpt-4o'

          const adapter = new AxPromptOptimizerAdapter({
            provider,
            apiKey,
            model,
            teacherModel: provider === 'anthropic' ? 'claude-opus-4-6-20250514' : 'gpt-4o',
            maxRecommendations: 3,
          })

          const dataset = await buildPromptDataset(traceStore)
          const scores = rankPromptVariants(dataset, { minimumRunsPerVariant: 2 })
          const recommendations = recommendPromptVariants(scores)

          if (scores.length >= 2) {
            const policyStore = new FilesystemPromptPolicyStore(join(FOREMAN_HOME, 'optimizer', 'policies'))
            const taskShape = dataset[0]?.taskShape ?? 'eval'
            const existingPolicy = await policyStore.get(taskShape)

            const policy = updatePromptPolicy({
              policy: existingPolicy,
              taskShape,
              scores,
              recommendations,
              autoPromoteShadows: true,
              autoRollbackActives: true,
            })

            await policyStore.put(policy)

            // Run GEPA adapter for generating optimized selector
            const adapterResult = await adapter.run({ taskShape, rows: dataset, scores, policy })
            if (adapterResult.recommendations?.length) {
              log(`  GEPA produced ${adapterResult.recommendations.length} recommendation(s)`)
            }

            // Save optimization snapshot
            const optStore = new FilesystemOptimizationStore(join(FOREMAN_HOME, 'optimizer', 'snapshots'))
            await optStore.writeSnapshot({
              generatedAt: new Date().toISOString(),
              taskShape,
              rows: dataset,
              scores,
              recommendations: [...recommendations, ...(adapterResult.recommendations ?? [])],
              policy,
              adapter: { name: adapter.name, result: adapterResult.metadata },
            })

            result.gepaRan = true
            log(`  GEPA complete: ${scores.length} variants scored, ${recommendations.length} recommendations`)
          } else {
            log(`  GEPA skipped: only ${scores.length} scored variants (need 2+)`)
          }
        } else {
          log('  GEPA skipped: no API key (ANTHROPIC_API_KEY or OPENAI_API_KEY)')
        }
      } else {
        log(`  GEPA skipped: only ${refs.length} traces (need 10+)`)
      }
    } catch (e) {
      log(`  GEPA failed: ${e}`)
    }
  }

  // Step 3: Auto-promote
  log('[3/6] Auto-promoting artifact versions...')
  try {
    const store = new VersionedStore()
    const kinds = await store.listKinds()
    for (const kind of kinds) {
      const names = await store.listNames(kind)
      for (const name of names) {
        const promoted = await store.autoPromote(kind, name, { minScores: 3, minImprovement: 0.05 })
        if (promoted) {
          result.promotions.push(`${kind}/${name}: ${promoted.id} (${promoted.averageScore?.toFixed(3)})`)
          log(`  promoted ${kind}/${name} → ${promoted.id}`)
        }
      }
    }
    if (result.promotions.length > 0) {
      await notifyPromotion(result.promotions)
    }
  } catch (e) {
    log(`  auto-promote failed: ${e}`)
  }

  // Step 4: Skill tracking
  log('[4/6] Tracking skill performance...')
  try {
    const performances = await trackSkillPerformance({ hoursBack: 168, onProgress: log })
    const alerts = detectDegradation(performances)
    result.skillAlerts = alerts.length
    if (alerts.length > 0) {
      await notifyDegradation(alerts)
    }
  } catch (e) {
    log(`  skill tracking failed: ${e}`)
  }

  // Step 5: Golden suites
  log('[5/6] Generating golden suites...')
  try {
    const suite = await generateGoldenSuiteFromTraces({ name: `nightly-${new Date().toISOString().slice(0, 10)}` })
    result.goldenCases = suite.cases.length
    log(`  ${suite.cases.length} golden cases from traces`)
  } catch (e) {
    log(`  golden suite generation failed: ${e}`)
  }

  // Step 6: Deep session analysis + campaign update
  log('[6/7] Deep session analysis...')
  try {
    const analysis = await analyzeSessionsDeep({ hoursBack: 72, maxRepos: 8, onProgress: log })
    log(`  Focus: ${analysis.operatorFocus}`)
    log(`  Themes: ${analysis.crossCuttingThemes.length}, Dependencies: ${analysis.dependencies.length}`)

    // Update campaigns with deeper understanding
    const intents = await extractIntents({ hoursBack: 72, maxSessions: 15 })
    await updateCampaigns(intents, { onProgress: log })
  } catch (e) {
    log(`  Session analysis failed: ${e}`)
  }

  // Step 7: Cost check
  log('[6/6] Checking costs...')
  try {
    const metrics = await loadSessionMetrics({ hoursBack: 24 })
    const agg = aggregateMetrics(metrics)
    result.costLast24h = agg.totalCostUsd
    const budget = options?.costBudgetUsd ?? 10
    result.budgetExceeded = result.costLast24h > budget
    log(`  24h cost: $${result.costLast24h.toFixed(2)} (budget: $${budget})`)
    if (result.budgetExceeded) {
      const { notify: n } = await import('./notify.js')
      await n({
        title: 'Cost Budget Exceeded',
        body: `24h cost $${result.costLast24h.toFixed(2)} exceeds budget $${budget}`,
        severity: 'warning',
        source: 'cost-monitor',
      })
    }
  } catch (e) {
    log(`  cost check failed: ${e}`)
  }

  return result
}
