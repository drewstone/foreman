/**
 * Intent Engine — the core intelligence layer.
 *
 * Answers: "What is this person trying to accomplish, and how do we
 * help them do it faster, better, cheaper?"
 *
 * Three components:
 *   1. Intent extractor — reads sessions, extracts goals + strategic intent
 *   2. Campaign tracker — groups intents into multi-repo campaigns
 *   3. Prediction + comparison — predicts actions, compares to reality, learns
 *
 * This is what makes Foreman a clone of the operator's thinking, not just
 * a task runner. It models WHY the operator does things, not just WHAT.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { SessionIndex, type IndexedMessage } from '@drew/foreman-memory/session-index'
import { createClaudeProvider, parseJsonOutput, type TextProvider } from '@drew/foreman-providers'
import { VersionedStore } from '@drew/foreman-core'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

// ─── Types ──────────────────────────────────────────────────────────

export interface SessionIntent {
  sessionId: string
  repo: string
  timestamp: string
  /** What the operator did in this session segment */
  immediateGoal: string
  /** Why they did it — the larger objective */
  strategicIntent: string
  /** Other repos connected to this intent */
  connectedRepos: string[]
  /** Estimated time horizon */
  timeHorizon: 'hours' | 'days' | 'week' | 'multi-week'
  /** What logically comes next */
  nextSteps: string[]
  /** Confidence in this interpretation */
  confidence: number
}

export interface Campaign {
  id: string
  name: string
  description: string
  status: 'active' | 'paused' | 'completed' | 'abandoned'
  repos: string[]
  intents: string[] // intent IDs
  startedAt: string
  lastActivityAt: string
  estimatedCompletion?: string
  progress: number // 0-1
  /** What needs to happen for this campaign to be done */
  completionCriteria: string[]
  /** What's blocking progress */
  blockers: string[]
}

export interface DailyPrediction {
  date: string
  generatedAt: string
  /** Active campaigns ranked by predicted focus */
  campaigns: Array<{
    campaignId: string
    name: string
    predictedFocusPct: number
    reason: string
    predictedRepos: string[]
    predictedActions: string[]
  }>
  /** Specific action predictions */
  predictions: Array<{
    id: string
    action: string
    repo: string
    confidence: number
    reason: string
    campaignId?: string
  }>
}

export interface PredictionScore {
  date: string
  scoredAt: string
  predictions: Array<{
    predictionId: string
    action: string
    matched: boolean
    partialMatch: boolean
    signal: 'strong_positive' | 'positive' | 'neutral' | 'negative'
    actualAction?: string
    reason: string
  }>
  campaignAccuracy: number
  overallAccuracy: number
}

// ─── Intent Extraction ──────────────────────────────────────────────

/**
 * Extract intents from recent session messages using LLM.
 * Groups messages by session, sends each to the LLM for interpretation.
 */
export async function extractIntents(options?: {
  hoursBack?: number
  maxSessions?: number
  provider?: TextProvider
  onProgress?: (msg: string) => void
}): Promise<SessionIntent[]> {
  const hoursBack = options?.hoursBack ?? 48
  const maxSessions = options?.maxSessions ?? 15
  const provider = options?.provider ?? createClaudeProvider('intent-extractor', { model: 'claude-sonnet-4-6' })
  const log = options?.onProgress ?? (() => {})

  const index = new SessionIndex()
  const intents: SessionIntent[] = []

  try {
    // Get recent user messages grouped by repo
    const messages = index.recentUserMessages({ limit: 200, hoursBack })
      .filter((m) => m.content.length > 20 && !m.content.startsWith('<'))

    // Group by repo+session
    const grouped = new Map<string, IndexedMessage[]>()
    for (const msg of messages) {
      const key = `${msg.repo}:${msg.sessionId}`
      const existing = grouped.get(key) ?? []
      existing.push(msg)
      grouped.set(key, existing)
    }

    // Process top sessions by message count
    const sessions = [...grouped.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, maxSessions)

    for (const [key, msgs] of sessions) {
      const repo = key.split(':')[0]
      if (!repo) continue

      const userMessages = msgs
        .map((m) => `[${m.timestamp.slice(0, 16)}] ${m.content.slice(0, 300)}`)
        .join('\n')

      const prompt = `Analyze these session messages from an operator working in repo "${repo}". Extract the intent.

Messages:
${userMessages}

Return ONLY valid JSON:
{
  "immediateGoal": "what they were doing in this session (1 sentence)",
  "strategicIntent": "WHY they were doing it — the larger objective (1 sentence)",
  "connectedRepos": ["other repos this work connects to"],
  "timeHorizon": "hours|days|week|multi-week",
  "nextSteps": ["what logically comes next (2-3 items)"],
  "confidence": 0.0 to 1.0
}

Be specific. "Fix code" is useless. "Fix billing auth bypass before developer portal launch" is useful.
Don't hallucinate repos — only list ones mentioned or clearly implied.`

      try {
        const execution = await provider.run(prompt, { timeoutMs: 30_000 })
        if (execution.exitCode !== 0) continue

        const parsed = parseJsonOutput(execution.stdout) as Partial<SessionIntent>
        if (!parsed.immediateGoal) continue

        intents.push({
          sessionId: msgs[0].sessionId,
          repo,
          timestamp: msgs[0].timestamp,
          immediateGoal: parsed.immediateGoal ?? '',
          strategicIntent: parsed.strategicIntent ?? '',
          connectedRepos: Array.isArray(parsed.connectedRepos) ? parsed.connectedRepos : [],
          timeHorizon: (['hours', 'days', 'week', 'multi-week'].includes(parsed.timeHorizon ?? '') ? parsed.timeHorizon : 'days') as SessionIntent['timeHorizon'],
          nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [],
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        })

        log(`  ${repo}: "${parsed.immediateGoal?.slice(0, 80)}" → "${parsed.strategicIntent?.slice(0, 80)}"`)
      } catch { continue }
    }
  } finally {
    index.close()
  }

  // Persist
  try {
    const dir = join(FOREMAN_HOME, 'traces', 'intents')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
      JSON.stringify({ timestamp: new Date().toISOString(), intents }, null, 2) + '\n',
      'utf8',
    )
  } catch {}

  return intents
}

// ─── Campaign Tracking ──────────────────────────────────────────────

const CAMPAIGNS_FILE = join(FOREMAN_HOME, 'campaigns.json')

async function loadCampaigns(): Promise<Campaign[]> {
  try {
    return JSON.parse(await readFile(CAMPAIGNS_FILE, 'utf8'))
  } catch {
    return []
  }
}

async function saveCampaigns(campaigns: Campaign[]): Promise<void> {
  await mkdir(FOREMAN_HOME, { recursive: true })
  await writeFile(CAMPAIGNS_FILE, JSON.stringify(campaigns, null, 2) + '\n', 'utf8')
}

/**
 * Update campaigns from extracted intents.
 * Groups related intents into campaigns, creates new ones, updates existing.
 */
export async function updateCampaigns(intents: SessionIntent[], options?: {
  provider?: TextProvider
  onProgress?: (msg: string) => void
}): Promise<Campaign[]> {
  const provider = options?.provider ?? createClaudeProvider('campaign-tracker', { model: 'claude-sonnet-4-6' })
  const log = options?.onProgress ?? (() => {})
  const existing = await loadCampaigns()

  if (intents.length === 0) return existing

  // Build context for the LLM
  const existingDesc = existing.length > 0
    ? existing.map((c) => `- "${c.name}" (${c.status}): ${c.description} [repos: ${c.repos.join(', ')}]`).join('\n')
    : '(none)'

  const intentDesc = intents
    .map((i) => `- ${i.repo}: "${i.immediateGoal}" → "${i.strategicIntent}" [connected: ${i.connectedRepos.join(', ')}] [horizon: ${i.timeHorizon}]`)
    .join('\n')

  const prompt = `You are tracking an operator's active campaigns (multi-repo initiatives).

Existing campaigns:
${existingDesc}

New intents from the last 48h:
${intentDesc}

Update the campaign list. Return ONLY valid JSON — an array of campaigns:
[
  {
    "id": "campaign-id (reuse existing IDs, or new-N for new ones)",
    "name": "short name (3-5 words)",
    "description": "what this campaign is trying to accomplish",
    "status": "active|paused|completed|abandoned",
    "repos": ["repos involved"],
    "progress": 0.0 to 1.0,
    "completionCriteria": ["what needs to happen for this to be done"],
    "blockers": ["what's blocking progress, if anything"]
  }
]

Rules:
- Merge intents into existing campaigns when they're clearly the same initiative
- Create new campaigns only for genuinely new initiatives
- Mark campaigns as "paused" if no activity in 3+ days
- Mark as "completed" if completion criteria are met
- Keep the list to 10 or fewer active campaigns
- Be specific about completion criteria — "ship it" is useless, "CI green + PR merged + deployed to staging" is useful`

  try {
    const execution = await provider.run(prompt, { timeoutMs: 45_000 })
    if (execution.exitCode !== 0) {
      log('  Campaign update failed')
      return existing
    }

    const parsed = parseJsonOutput(execution.stdout) as Array<Partial<Campaign>>
    if (!Array.isArray(parsed)) return existing

    const now = new Date().toISOString()
    const updated: Campaign[] = parsed.map((c, i) => ({
      id: c.id ?? `campaign-${i}`,
      name: c.name ?? 'Unnamed',
      description: c.description ?? '',
      status: (['active', 'paused', 'completed', 'abandoned'].includes(c.status ?? '') ? c.status : 'active') as Campaign['status'],
      repos: Array.isArray(c.repos) ? c.repos : [],
      intents: [],
      startedAt: existing.find((e) => e.id === c.id)?.startedAt ?? now,
      lastActivityAt: now,
      progress: typeof c.progress === 'number' ? c.progress : 0,
      completionCriteria: Array.isArray(c.completionCriteria) ? c.completionCriteria : [],
      blockers: Array.isArray(c.blockers) ? c.blockers : [],
    }))

    await saveCampaigns(updated)
    log(`  ${updated.filter((c) => c.status === 'active').length} active campaigns`)
    return updated
  } catch (e) {
    log(`  Campaign update error: ${e}`)
    return existing
  }
}

// ─── Prediction ─────────────────────────────────────────────────────

/**
 * Generate predictions for what the operator will work on.
 * Uses campaigns, recent intents, and session patterns.
 */
export async function generatePredictions(options?: {
  campaigns?: Campaign[]
  intents?: SessionIntent[]
  provider?: TextProvider
}): Promise<DailyPrediction> {
  const campaigns = options?.campaigns ?? await loadCampaigns()
  const provider = options?.provider ?? createClaudeProvider('predictor', { model: 'claude-sonnet-4-6' })
  const date = new Date().toISOString().slice(0, 10)

  // Load recent session activity for context
  const index = new SessionIndex()
  let recentActivity = ''
  try {
    const msgs = index.recentUserMessages({ limit: 30, hoursBack: 24 })
      .filter((m) => m.content.length > 20 && !m.content.startsWith('<'))
    recentActivity = msgs
      .map((m) => `[${m.repo}] ${m.content.slice(0, 150)}`)
      .join('\n')
  } finally {
    index.close()
  }

  const activeCampaigns = campaigns.filter((c) => c.status === 'active')
  const campaignDesc = activeCampaigns.length > 0
    ? activeCampaigns.map((c) => `- "${c.name}" (${(c.progress * 100).toFixed(0)}%): ${c.description}\n  repos: ${c.repos.join(', ')}\n  blockers: ${c.blockers.join(', ') || 'none'}\n  criteria: ${c.completionCriteria.join(', ')}`).join('\n')
    : '(no active campaigns)'

  const prompt = `You are predicting what an operator will work on today (${date}).

Active campaigns:
${campaignDesc}

Recent activity (last 24h):
${recentActivity || '(no recent activity)'}

Generate predictions. Return ONLY valid JSON:
{
  "campaigns": [
    {
      "campaignId": "id",
      "name": "name",
      "predictedFocusPct": 0-100,
      "reason": "why this will get attention today",
      "predictedRepos": ["repos"],
      "predictedActions": ["specific actions like 'fix CI on X', 'review PR #Y'"]
    }
  ],
  "predictions": [
    {
      "id": "pred-1",
      "action": "specific action",
      "repo": "repo name",
      "confidence": 0.0-1.0,
      "reason": "why",
      "campaignId": "optional campaign link"
    }
  ]
}

Rules:
- Predict 3-7 specific actions, ranked by confidence
- Focus predictions should sum to ~100%
- Consider: what was the operator doing yesterday that isn't finished?
- Consider: are there CI failures or PR reviews waiting?
- Consider: what campaign has the nearest deadline?
- Be specific: "merge credits-system PR after fixing test failures" not "work on phony"`

  try {
    const execution = await provider.run(prompt, { timeoutMs: 45_000 })
    if (execution.exitCode === 0) {
      const parsed = parseJsonOutput(execution.stdout) as Partial<DailyPrediction>

      const prediction: DailyPrediction = {
        date,
        generatedAt: new Date().toISOString(),
        campaigns: Array.isArray(parsed.campaigns) ? parsed.campaigns as DailyPrediction['campaigns'] : [],
        predictions: Array.isArray(parsed.predictions) ? parsed.predictions as DailyPrediction['predictions'] : [],
      }

      // Persist
      const dir = join(FOREMAN_HOME, 'predictions')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${date}.json`), JSON.stringify(prediction, null, 2) + '\n', 'utf8')

      // Version it for optimization
      const store = new VersionedStore()
      await store.put('prediction', date, JSON.stringify(prediction), { source: 'daily-prediction' })

      return prediction
    }
  } catch {}

  return { date, generatedAt: new Date().toISOString(), campaigns: [], predictions: [] }
}

// ─── Comparison / Scoring ───────────────────────────────────────────

/**
 * Score yesterday's predictions against what actually happened.
 */
export async function scorePredictions(predictionDate: string, options?: {
  provider?: TextProvider
  onProgress?: (msg: string) => void
}): Promise<PredictionScore> {
  const provider = options?.provider ?? createClaudeProvider('prediction-scorer', { model: 'claude-sonnet-4-6' })
  const log = options?.onProgress ?? (() => {})

  // Load the prediction
  let prediction: DailyPrediction
  try {
    prediction = JSON.parse(await readFile(join(FOREMAN_HOME, 'predictions', `${predictionDate}.json`), 'utf8'))
  } catch {
    return { date: predictionDate, scoredAt: new Date().toISOString(), predictions: [], campaignAccuracy: 0, overallAccuracy: 0 }
  }

  // Load what actually happened (from session index)
  const index = new SessionIndex()
  let actualActivity = ''
  try {
    // Get messages from the prediction date
    const dateStart = new Date(predictionDate).getTime()
    const dateEnd = dateStart + 24 * 3600 * 1000
    const msgs = index.recentUserMessages({ limit: 100, hoursBack: Math.ceil((Date.now() - dateStart) / 3600000) })
      .filter((m) => {
        const ts = new Date(m.timestamp).getTime()
        return ts >= dateStart && ts < dateEnd && m.content.length > 20 && !m.content.startsWith('<')
      })

    const byRepo = new Map<string, string[]>()
    for (const m of msgs) {
      const existing = byRepo.get(m.repo) ?? []
      existing.push(m.content.slice(0, 200))
      byRepo.set(m.repo, existing)
    }

    actualActivity = [...byRepo.entries()]
      .map(([repo, actions]) => `${repo}: ${actions.slice(0, 3).join(' | ')}`)
      .join('\n')
  } finally {
    index.close()
  }

  if (!actualActivity) {
    log('  No session activity found for ' + predictionDate)
    return { date: predictionDate, scoredAt: new Date().toISOString(), predictions: [], campaignAccuracy: 0, overallAccuracy: 0 }
  }

  const predictionDesc = prediction.predictions
    .map((p) => `[${p.id}] (${p.confidence.toFixed(1)}) ${p.repo}: ${p.action}`)
    .join('\n')

  const prompt = `Score these predictions against what actually happened.

Predictions for ${predictionDate}:
${predictionDesc}

What actually happened:
${actualActivity}

Return ONLY valid JSON:
{
  "predictions": [
    {
      "predictionId": "pred-1",
      "action": "the predicted action",
      "matched": true/false,
      "partialMatch": true/false,
      "signal": "strong_positive|positive|neutral|negative",
      "actualAction": "what actually happened in that repo (if anything)",
      "reason": "why this signal"
    }
  ],
  "campaignAccuracy": 0.0-1.0,
  "overallAccuracy": 0.0-1.0
}

Scoring rules:
- "strong_positive": prediction exactly matched what happened
- "positive": prediction was in the right direction (correct repo, similar action)
- "neutral": prediction didn't match but the actual action was reasonable (different priority)
- "negative": prediction was opposite of reality (predicted X, operator explicitly avoided X)`

  try {
    const execution = await provider.run(prompt, { timeoutMs: 30_000 })
    if (execution.exitCode === 0) {
      const parsed = parseJsonOutput(execution.stdout) as Partial<PredictionScore>

      const score: PredictionScore = {
        date: predictionDate,
        scoredAt: new Date().toISOString(),
        predictions: Array.isArray(parsed.predictions) ? parsed.predictions as PredictionScore['predictions'] : [],
        campaignAccuracy: typeof parsed.campaignAccuracy === 'number' ? parsed.campaignAccuracy : 0,
        overallAccuracy: typeof parsed.overallAccuracy === 'number' ? parsed.overallAccuracy : 0,
      }

      // Persist
      const dir = join(FOREMAN_HOME, 'predictions', 'scores')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${predictionDate}.json`), JSON.stringify(score, null, 2) + '\n', 'utf8')

      // Score the prediction version in artifact store
      try {
        const store = new VersionedStore()
        const versions = await store.list('prediction', predictionDate)
        if (versions.length > 0) {
          await store.score('prediction', predictionDate, versions[0].id, {
            judgeId: 'prediction-scorer',
            score: score.overallAccuracy,
            maxScore: 1,
          })
        }
      } catch {}

      log(`  Prediction accuracy: ${(score.overallAccuracy * 100).toFixed(0)}%`)
      return score
    }
  } catch {}

  return { date: predictionDate, scoredAt: new Date().toISOString(), predictions: [], campaignAccuracy: 0, overallAccuracy: 0 }
}

// ─── Rendering ──────────────────────────────────────────────────────

export function renderCampaigns(campaigns: Campaign[]): string {
  const active = campaigns.filter((c) => c.status === 'active')
  if (active.length === 0) return ''

  const lines: string[] = []
  lines.push('## Active Campaigns')
  lines.push('')

  for (const c of active.sort((a, b) => b.progress - a.progress)) {
    const bar = '█'.repeat(Math.round(c.progress * 10)) + '░'.repeat(10 - Math.round(c.progress * 10))
    lines.push(`### ${c.name} ${bar} ${(c.progress * 100).toFixed(0)}%`)
    lines.push(c.description)
    lines.push(`Repos: ${c.repos.join(', ')}`)
    if (c.blockers.length > 0) lines.push(`Blockers: ${c.blockers.join(', ')}`)
    if (c.completionCriteria.length > 0) lines.push(`Done when: ${c.completionCriteria.join('; ')}`)
    lines.push('')
  }

  return lines.join('\n')
}

export function renderPredictions(prediction: DailyPrediction): string {
  const lines: string[] = []
  lines.push('## Today\'s Predictions')
  lines.push('')

  if (prediction.campaigns.length > 0) {
    lines.push('**Focus split:**')
    for (const c of prediction.campaigns.sort((a, b) => b.predictedFocusPct - a.predictedFocusPct)) {
      lines.push(`- ${c.name}: ${c.predictedFocusPct}% — ${c.reason}`)
    }
    lines.push('')
  }

  if (prediction.predictions.length > 0) {
    lines.push('**Predicted actions:**')
    for (const p of prediction.predictions.sort((a, b) => b.confidence - a.confidence)) {
      const conf = p.confidence >= 0.8 ? '🟢' : p.confidence >= 0.5 ? '🟡' : '⚪'
      lines.push(`${conf} ${p.repo}: ${p.action} (${(p.confidence * 100).toFixed(0)}%)`)
      lines.push(`  → ${p.reason}`)
    }
    lines.push('')
  }

  lines.push('> At end of day, Foreman will compare these predictions against your actual sessions and learn from the delta.')
  lines.push('')

  return lines.join('\n')
}

export function renderPredictionScore(score: PredictionScore): string {
  const lines: string[] = []
  lines.push(`## Yesterday's Prediction Score: ${(score.overallAccuracy * 100).toFixed(0)}%`)
  lines.push('')

  for (const p of score.predictions) {
    const icon = p.signal === 'strong_positive' ? '✅' : p.signal === 'positive' ? '🟢' : p.signal === 'neutral' ? '🟡' : '🔴'
    lines.push(`${icon} ${p.action}`)
    lines.push(`  ${p.signal}: ${p.reason}`)
    if (p.actualAction) lines.push(`  Actually: ${p.actualAction}`)
    lines.push('')
  }

  return lines.join('\n')
}
