/**
 * Notification surfaces.
 *
 * Sends Foreman alerts to Telegram, Slack, and webhooks.
 * All notifications are fire-and-forget — failures are logged, never thrown.
 *
 * Config via env vars:
 *   FOREMAN_TELEGRAM_BOT_TOKEN — Telegram bot token
 *   FOREMAN_TELEGRAM_CHAT_ID — default chat ID (supports topic threads: "chatId:topicId")
 *   FOREMAN_SLACK_WEBHOOK — Slack incoming webhook URL
 *   FOREMAN_WEBHOOK_URL — generic webhook URL (POST with JSON body)
 */

import { join } from 'node:path'
import { homedir } from 'node:os'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export type NotifyChannel = 'telegram' | 'slack' | 'webhook'

export interface NotifyConfig {
  telegram?: {
    botToken: string
    chatId: string
  }
  slack?: {
    webhookUrl: string
  }
  webhook?: {
    url: string
    headers?: Record<string, string>
  }
}

function loadConfig(): NotifyConfig {
  const config: NotifyConfig = {}

  const botToken = process.env.FOREMAN_TELEGRAM_BOT_TOKEN
  const chatId = process.env.FOREMAN_TELEGRAM_CHAT_ID
  if (botToken && chatId) {
    config.telegram = { botToken, chatId }
  }

  const slackWebhook = process.env.FOREMAN_SLACK_WEBHOOK
  if (slackWebhook) {
    config.slack = { webhookUrl: slackWebhook }
  }

  const webhookUrl = process.env.FOREMAN_WEBHOOK_URL
  if (webhookUrl) {
    config.webhook = { url: webhookUrl }
  }

  return config
}

// ─── Telegram ───────────────────────────────────────────────────────

async function sendTelegram(config: NonNullable<NotifyConfig['telegram']>, message: string): Promise<boolean> {
  const { botToken, chatId } = config

  // Handle topic threads (chatId:topicId format)
  const [baseChatId, topicId] = chatId.includes(':') ? chatId.split(':') : [chatId, undefined]

  const params = new URLSearchParams({
    chat_id: baseChatId,
    text: message.slice(0, 4096), // Telegram max
    parse_mode: 'Markdown',
  })
  if (topicId) params.set('message_thread_id', topicId)

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    return resp.ok
  } catch {
    return false
  }
}

// ─── Slack ──────────────────────────────────────────────────────────

async function sendSlack(config: NonNullable<NotifyConfig['slack']>, message: string): Promise<boolean> {
  try {
    const resp = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    })
    return resp.ok
  } catch {
    return false
  }
}

// ─── Webhook ────────────────────────────────────────────────────────

async function sendWebhook(config: NonNullable<NotifyConfig['webhook']>, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const resp = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...config.headers },
      body: JSON.stringify(payload),
    })
    return resp.ok
  } catch {
    return false
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export type NotifySeverity = 'info' | 'warning' | 'critical'

export interface ForemanNotification {
  title: string
  body: string
  severity: NotifySeverity
  source: string
  metadata?: Record<string, string>
}

const SEVERITY_EMOJI: Record<NotifySeverity, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🔴',
}

/**
 * Send a notification to all configured channels.
 */
export async function notify(notification: ForemanNotification): Promise<Record<NotifyChannel, boolean>> {
  const config = loadConfig()
  const results: Record<NotifyChannel, boolean> = { telegram: false, slack: false, webhook: false }

  const text = `${SEVERITY_EMOJI[notification.severity]} *Foreman — ${notification.title}*\n\n${notification.body}`

  const promises: Promise<void>[] = []

  if (config.telegram) {
    promises.push(
      sendTelegram(config.telegram, text).then((ok) => { results.telegram = ok }),
    )
  }

  if (config.slack) {
    promises.push(
      sendSlack(config.slack, text).then((ok) => { results.slack = ok }),
    )
  }

  if (config.webhook) {
    promises.push(
      sendWebhook(config.webhook, {
        type: 'foreman_notification',
        ...notification,
        timestamp: new Date().toISOString(),
      }).then((ok) => { results.webhook = ok }),
    )
  }

  await Promise.all(promises)
  return results
}

// ─── Pre-built notifications ────────────────────────────────────────

export async function notifyHeartbeatAction(action: { sessionId: string; action: string; result: string }): Promise<void> {
  await notify({
    title: 'Heartbeat Action',
    body: `*${action.sessionId.split(':').pop()}*: ${action.action}\nResult: ${action.result}`,
    severity: action.result === 'success' ? 'info' : 'warning',
    source: 'heartbeat',
  })
}

export async function notifyDailyReport(reportPath: string, scores: { deterministic: string; llm?: string }): Promise<void> {
  await notify({
    title: 'Daily Report',
    body: `Report: ${reportPath}\nDeterministic: ${scores.deterministic}\n${scores.llm ? `LLM Judge: ${scores.llm}` : ''}`,
    severity: 'info',
    source: 'daily-report',
  })
}

export async function notifyDegradation(proposals: Array<{ skillName: string; reason: string; severity: string }>): Promise<void> {
  if (proposals.length === 0) return
  const body = proposals.map((p) => `• /${p.skillName}: ${p.reason}`).join('\n')
  await notify({
    title: `${proposals.length} Skill Degradation Alert(s)`,
    body,
    severity: 'warning',
    source: 'skill-tracker',
  })
}

export async function notifyPromotion(promotions: string[]): Promise<void> {
  if (promotions.length === 0) return
  await notify({
    title: `${promotions.length} Artifact Promotion(s)`,
    body: promotions.join('\n'),
    severity: 'info',
    source: 'nightly-optimize',
  })
}

export async function notifyCIFailure(repo: string, branch: string, diagnosis: string): Promise<void> {
  await notify({
    title: `CI Failure — ${repo}/${branch}`,
    body: diagnosis.slice(0, 500),
    severity: 'critical',
    source: 'ci-diagnosis',
  })
}
