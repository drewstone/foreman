/**
 * Foreman Slack Gateway
 *
 * Two functions:
 * 1. Bot: receives slash commands + messages → calls Foreman service API
 * 2. Ingestor: reads Slack channel history → feeds into Foreman's learning loop
 *
 * Setup:
 *   1. Create a Slack app with Bot Token Scopes:
 *      - chat:write, channels:history, channels:read, commands, im:history, im:read, im:write
 *   2. Set SLACK_BOT_TOKEN=xoxb-...
 *   3. Set SLACK_SIGNING_SECRET=... (for request verification)
 *   4. Set SLACK_APP_PORT=3847 (default)
 *   5. Set up slash commands pointing to https://your-host:3847/slack/commands
 *   6. Set up Event Subscriptions URL: https://your-host:3847/slack/events
 *   7. Start: tsx gateway/slack.ts
 *
 * Slash commands:
 *   /foreman-status   — portfolio overview
 *   /foreman-dispatch  — dispatch work
 *   /foreman-sessions — list sessions
 *   /foreman-goals    — list goals
 *
 * DM the bot for free-form interaction.
 *
 * Ingestion:
 *   Set SLACK_INGEST_CHANNELS=general,engineering,standup
 *   The gateway periodically reads channel history and feeds messages
 *   into the Foreman learning loop as operator context.
 */

import http from 'node:http'
import crypto from 'node:crypto'

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? ''
const PORT = parseInt(process.env.SLACK_APP_PORT ?? '3847', 10)
const SERVICE_URL = process.env.FOREMAN_URL ?? 'http://127.0.0.1:7374'
const INGEST_CHANNELS = (process.env.SLACK_INGEST_CHANNELS ?? '').split(',').filter(Boolean)
const INGEST_INTERVAL_MS = 30 * 60 * 1000 // every 30 minutes

if (!BOT_TOKEN) {
  console.error('SLACK_BOT_TOKEN required.')
  process.exit(1)
}

// ─── Slack API ───────────────────────────────────────────────────────

async function slack(method: string, body?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`)
  return data
}

async function postMessage(channel: string, text: string, blocks?: any[]): Promise<void> {
  await slack('chat.postMessage', {
    channel,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  })
}

// ─── Foreman API client ──────────────────────────────────────────────

async function api<T = any>(path: string, opts?: { method?: string, body?: unknown }): Promise<T> {
  const res = await fetch(`${SERVICE_URL}${path}`, {
    method: opts?.method ?? 'GET',
    headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  })
  return res.json() as Promise<T>
}

// ─── Request verification ────────────────────────────────────────────

function verifySlackRequest(body: string, timestamp: string, signature: string): boolean {
  if (!SIGNING_SECRET) return true // skip if not configured
  const sigBasestring = `v0:${timestamp}:${body}`
  const mySignature = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(sigBasestring).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature))
}

// ─── Command handlers (same logic as telegram) ──────────────────────

async function handleCommand(command: string, text: string, channelId: string, userId: string): Promise<string> {
  switch (command) {
    case '/foreman-status':
    case '/foreman': {
      const st = await api('/api/status')
      const goals = st.goals as any[]
      const sessions = st.sessions as any[]
      let msg = `📊 *Foreman Status*\n`
      msg += `Goals: ${goals.length} | Active sessions: ${sessions.filter((s: any) => s.alive).length}\n\n`
      for (const g of goals) msg += `• #${g.id} ${g.intent.slice(0, 60)}\n`
      if (sessions.length > 0) {
        msg += '\n'
        for (const s of sessions) {
          const icon = !s.alive ? '⚫' : s.idle ? '🟡' : '🟢'
          msg += `${icon} ${s.name.replace('foreman-', '')}\n`
        }
      }
      return msg
    }

    case '/foreman-dispatch': {
      if (!text) return 'Usage: /foreman-dispatch /skill task description'
      const skillMatch = text.match(/^(\/\w+)\s+(.+)/)
      const skill = skillMatch ? skillMatch[1] : ''
      const task = skillMatch ? skillMatch[2] : text
      const goals = await api('/api/goals') as any[]
      const workDir = goals.find((g: any) => g.workspace_path)?.workspace_path
      if (!workDir) return '❌ No goals with workspace paths.'
      const result = await api('/api/dispatch', { method: 'POST', body: { skill, task, work_dir: workDir, goal_id: goals[0]?.id } })
      return `✅ Dispatched ${skill || 'direct'} → ${result.session}\nTask: ${task.slice(0, 80)}`
    }

    case '/foreman-sessions': {
      const sessions = await api('/api/sessions') as any[]
      if (sessions.length === 0) return 'No sessions.'
      return sessions.map((s: any) => {
        const icon = !s.alive ? '⚫' : s.idle ? '🟡' : '🟢'
        return `${icon} ${s.name.replace('foreman-', '')} (${s.status})`
      }).join('\n')
    }

    case '/foreman-goals': {
      const goals = await api('/api/goals') as any[]
      if (goals.length === 0) return 'No goals.'
      return goals.map((g: any) => `#${g.id} ${g.intent.slice(0, 80)}`).join('\n')
    }

    default:
      return `Unknown command: ${command}`
  }
}

// ─── Slack channel ingestion ─────────────────────────────────────────
// Reads channel history and feeds into Foreman's learning as operator context.
// This lets Foreman learn from team discussions, standup notes, etc.

let lastIngestTimestamp: Record<string, string> = {}

async function ingestChannels(): Promise<number> {
  if (INGEST_CHANNELS.length === 0) return 0
  let ingested = 0

  for (const channelName of INGEST_CHANNELS) {
    try {
      // Find channel ID
      const listResult = await slack('conversations.list', { types: 'public_channel,private_channel', limit: 200 })
      const channel = listResult.channels?.find((c: any) => c.name === channelName)
      if (!channel) { console.log(`Channel not found: ${channelName}`); continue }

      // Read history since last ingest
      const oldest = lastIngestTimestamp[channelName] ?? String(Date.now() / 1000 - 24 * 60 * 60) // last 24h on first run
      const historyResult = await slack('conversations.history', {
        channel: channel.id,
        oldest,
        limit: 50,
      })

      const messages = historyResult.messages ?? []
      if (messages.length === 0) continue

      // Update timestamp for next run
      lastIngestTimestamp[channelName] = messages[0].ts

      // Feed messages into Foreman's taste/learnings system
      const messageTexts = messages
        .filter((m: any) => m.type === 'message' && m.text && !m.bot_id)
        .map((m: any) => m.text.slice(0, 500))

      if (messageTexts.length > 0) {
        // Store as taste signals (team context)
        for (const text of messageTexts.slice(0, 10)) {
          if (text.length > 30) {
            await api('/api/taste', {
              method: 'POST',
              body: { pattern: `[slack:${channelName}] ${text.slice(0, 200)}`, source: `slack:${channelName}`, weight: 0.3 },
            })
            ingested++
          }
        }
      }
    } catch (e) {
      console.error(`Ingest error for ${channelName}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return ingested
}

// ─── Event listener — push notifications from service ────────────────

let notificationChannel: string | null = null

async function listenForEvents(): Promise<void> {
  if (!notificationChannel) return

  try {
    const res = await fetch(`${SERVICE_URL}/api/events`)
    if (!res.body) return

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const event = JSON.parse(line.slice(6))
          if (event.type === 'outcome_harvested') {
            const d = event.data
            await postMessage(notificationChannel!,
              `${d.status === 'success' ? '✅' : '❌'} *Session completed:* ${event.sessionName}\nCommits: ${d.commits}`)
          } else if (event.type === 'auto_dispatched') {
            await postMessage(notificationChannel!,
              `🤖 *Auto-dispatched:* ${event.data.skill} on ${event.sessionName} (confidence: ${event.data.confidence})`)
          }
        } catch {}
      }
    }
  } catch {
    // Reconnect after delay
    setTimeout(listenForEvents, 5000)
  }
}

// ─── HTTP server ─────────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url ?? '/'

  // Slack URL verification challenge
  if (url === '/slack/events' && req.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString()

    // Verify request
    const timestamp = req.headers['x-slack-request-timestamp'] as string
    const signature = req.headers['x-slack-signature'] as string
    if (SIGNING_SECRET && !verifySlackRequest(body, timestamp, signature)) {
      res.writeHead(401); res.end('Unauthorized'); return
    }

    const data = JSON.parse(body)

    // URL verification
    if (data.type === 'url_verification') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ challenge: data.challenge }))
      return
    }

    // Event handling
    if (data.event?.type === 'message' && data.event.channel_type === 'im' && !data.event.bot_id) {
      // DM to the bot — treat as a Foreman command
      const text = data.event.text || ''
      const channel = data.event.channel
      try {
        const response = text.startsWith('/')
          ? await handleCommand(text.split(' ')[0], text.slice(text.indexOf(' ') + 1), channel, data.event.user)
          : `To dispatch: /foreman-dispatch /skill ${text.slice(0, 60)}`
        await postMessage(channel, response)
      } catch (e) {
        await postMessage(channel, `❌ ${e instanceof Error ? e.message : String(e)}`)
      }

      // Track notification channel for push events
      if (!notificationChannel) {
        notificationChannel = channel
        listenForEvents()
      }
    }

    res.writeHead(200); res.end('ok')
    return
  }

  // Slash command handler
  if (url === '/slack/commands' && req.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString()
    const params = new URLSearchParams(body)

    const command = params.get('command') ?? ''
    const text = params.get('text') ?? ''
    const channelId = params.get('channel_id') ?? ''
    const userId = params.get('user_id') ?? ''

    try {
      const response = await handleCommand(command, text, channelId, userId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ response_type: 'ephemeral', text: response }))
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ response_type: 'ephemeral', text: `❌ ${e instanceof Error ? e.message : String(e)}` }))
    }
    return
  }

  // Health check
  if (url === '/health') {
    res.writeHead(200); res.end('ok'); return
  }

  res.writeHead(404); res.end('Not found')
}

// ─── Start ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Verify service
  try {
    await api('/api/health')
    console.log(`Foreman service: ${SERVICE_URL} (OK)`)
  } catch {
    console.error(`Foreman service not reachable at ${SERVICE_URL}`)
    process.exit(1)
  }

  // Start HTTP server for Slack events + commands
  const server = http.createServer(handleRequest)
  server.listen(PORT, () => {
    console.log(`Slack gateway listening on port ${PORT}`)
    console.log(`Commands URL: http://localhost:${PORT}/slack/commands`)
    console.log(`Events URL: http://localhost:${PORT}/slack/events`)
  })

  // Start channel ingestion if configured
  if (INGEST_CHANNELS.length > 0) {
    console.log(`Ingesting channels: ${INGEST_CHANNELS.join(', ')}`)
    // Initial ingest after 10 seconds
    setTimeout(async () => {
      const n = await ingestChannels()
      if (n > 0) console.log(`Ingested ${n} messages from Slack`)
    }, 10_000)
    // Periodic ingest
    setInterval(async () => {
      const n = await ingestChannels()
      if (n > 0) console.log(`Ingested ${n} messages from Slack`)
    }, INGEST_INTERVAL_MS)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
