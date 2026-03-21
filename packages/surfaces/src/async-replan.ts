/**
 * Async replanning — updates predictions when significant events happen.
 *
 * Predictions aren't static daily forecasts. They're living documents
 * that adapt as the day unfolds. When something changes (CI failure,
 * new PR, urgent message, blocker resolved), replan.
 *
 * Triggers:
 *   - Heartbeat detects new blocked session → replan
 *   - Heartbeat detects session unblocked → replan
 *   - Learning loop discovers new pattern → update campaigns
 *   - High-urgency session message detected → shift predictions
 *
 * This runs as part of the heartbeat (every 15min), not as a separate cron.
 * Lightweight: only replans if something significant changed.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DailyPrediction, Campaign } from './intent-engine.js'
import { SessionIndex } from '@drew/foreman-memory/session-index'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export interface ReplanTrigger {
  type: 'ci-failure' | 'ci-fixed' | 'urgent-message' | 'blocker-resolved' | 'new-pr' | 'campaign-shift'
  repo: string
  description: string
  timestamp: string
}

export interface ReplanResult {
  triggered: boolean
  triggers: ReplanTrigger[]
  predictionsUpdated: boolean
  campaignsUpdated: boolean
}

/**
 * Detect if anything significant changed since last check.
 * Called by the heartbeat every 15min.
 */
export async function detectReplanTriggers(options: {
  currentSessions: Array<{ id: string; status: string; ciStatus?: string; repoPath: string; branch: string; blockerReason?: string }>
  previousSessions?: Array<{ id: string; status: string; ciStatus?: string }>
}): Promise<ReplanTrigger[]> {
  const triggers: ReplanTrigger[] = []
  const now = new Date().toISOString()

  const prevMap = new Map(
    (options.previousSessions ?? []).map((s) => [s.id, s]),
  )

  for (const session of options.currentSessions) {
    const prev = prevMap.get(session.id)

    // New CI failure
    if (session.ciStatus === 'fail' && prev?.ciStatus !== 'fail') {
      triggers.push({
        type: 'ci-failure',
        repo: session.repoPath.split('/').pop() ?? '',
        description: `CI failed on ${session.branch}: ${session.blockerReason ?? 'unknown'}`,
        timestamp: now,
      })
    }

    // CI fixed
    if (session.ciStatus === 'pass' && prev?.ciStatus === 'fail') {
      triggers.push({
        type: 'ci-fixed',
        repo: session.repoPath.split('/').pop() ?? '',
        description: `CI now passing on ${session.branch}`,
        timestamp: now,
      })
    }

    // Blocker resolved
    if (session.status !== 'blocked' && prev?.status === 'blocked') {
      triggers.push({
        type: 'blocker-resolved',
        repo: session.repoPath.split('/').pop() ?? '',
        description: `${session.branch} unblocked`,
        timestamp: now,
      })
    }
  }

  // Check for urgent messages in last 15min
  try {
    const index = new SessionIndex()
    try {
      const recent = index.recentUserMessages({ limit: 10, hoursBack: 0.25 }) // 15 min
        .filter((m) => m.content.length > 20 && !m.content.startsWith('<'))

      for (const msg of recent) {
        const lower = msg.content.toLowerCase()
        const isUrgent = lower.includes('urgent') || lower.includes('asap') ||
          lower.includes('now') || lower.includes('immediately') ||
          lower.includes('breaking') || lower.includes('down') ||
          lower.includes('blocker') || lower.includes('ship today') ||
          lower.includes('launch')

        if (isUrgent) {
          triggers.push({
            type: 'urgent-message',
            repo: msg.repo,
            description: msg.content.slice(0, 150),
            timestamp: msg.timestamp,
          })
        }
      }
    } finally {
      index.close()
    }
  } catch {}

  return triggers
}

/**
 * Update today's predictions based on replan triggers.
 * Lightweight: adjusts confidence/priority, doesn't regenerate from scratch.
 */
export async function replanPredictions(triggers: ReplanTrigger[]): Promise<ReplanResult> {
  if (triggers.length === 0) {
    return { triggered: false, triggers: [], predictionsUpdated: false, campaignsUpdated: false }
  }

  const date = new Date().toISOString().slice(0, 10)
  let prediction: DailyPrediction
  try {
    prediction = JSON.parse(await readFile(join(FOREMAN_HOME, 'predictions', `${date}.json`), 'utf8'))
  } catch {
    return { triggered: true, triggers, predictionsUpdated: false, campaignsUpdated: false }
  }

  let updated = false

  for (const trigger of triggers) {
    switch (trigger.type) {
      case 'ci-failure': {
        // Boost confidence for CI fix predictions in that repo
        const existing = prediction.predictions.find((p) => p.repo === trigger.repo)
        if (existing) {
          existing.confidence = Math.min(existing.confidence + 0.2, 1)
          existing.reason += ` [REPLAN: CI just failed — priority boosted]`
          updated = true
        } else {
          // Add a new prediction
          prediction.predictions.push({
            id: `replan-ci-${trigger.repo}`,
            action: `Fix CI failure: ${trigger.description}`,
            repo: trigger.repo,
            confidence: 0.85,
            reason: `CI just failed — needs immediate attention`,
            campaignId: undefined,
          })
          updated = true
        }
        break
      }

      case 'ci-fixed':
      case 'blocker-resolved': {
        // Reduce urgency for fix predictions, boost next-step predictions
        const fixPred = prediction.predictions.find(
          (p) => p.repo === trigger.repo && (p.action.toLowerCase().includes('fix') || p.action.toLowerCase().includes('ci')),
        )
        if (fixPred) {
          fixPred.confidence = Math.max(fixPred.confidence - 0.3, 0)
          fixPred.reason += ` [REPLAN: resolved]`
          updated = true
        }
        break
      }

      case 'urgent-message': {
        // Boost predictions for that repo
        for (const p of prediction.predictions) {
          if (p.repo === trigger.repo) {
            p.confidence = Math.min(p.confidence + 0.15, 1)
            p.reason += ` [REPLAN: urgent activity detected]`
            updated = true
          }
        }
        break
      }
    }
  }

  if (updated) {
    // Re-sort by confidence
    prediction.predictions.sort((a, b) => b.confidence - a.confidence)

    // Save updated predictions
    await writeFile(
      join(FOREMAN_HOME, 'predictions', `${date}.json`),
      JSON.stringify(prediction, null, 2) + '\n',
      'utf8',
    )
  }

  // Log the replan
  try {
    const dir = join(FOREMAN_HOME, 'traces', 'replans')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
      JSON.stringify({ timestamp: new Date().toISOString(), triggers, predictionsUpdated: updated }, null, 2) + '\n',
      'utf8',
    )
  } catch {}

  return { triggered: true, triggers, predictionsUpdated: updated, campaignsUpdated: false }
}
