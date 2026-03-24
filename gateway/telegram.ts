/**
 * Foreman Telegram Gateway
 *
 * Bridges Telegram messages to the Foreman service API.
 * Receives messages → calls service endpoints → sends responses back.
 *
 * Setup:
 *   1. Create a bot via @BotFather on Telegram
 *   2. Set TELEGRAM_BOT_TOKEN=<token>
 *   3. Start: tsx gateway/telegram.ts
 *
 * Commands:
 *   /status    — portfolio overview
 *   /dispatch  — dispatch work (e.g. /dispatch /evolve fix tests on phony)
 *   /sessions  — list active sessions
 *   /check <name> — check a session
 *   /goals     — list active goals
 *   /confidence — show confidence scores
 *   /reflect   — trigger deep analysis
 *   /learn     — trigger learning loop
 *   /cleanup   — clean stale worktrees
 *   Any other text → forwarded as a /foreman goal
 */

import http from 'node:http'
import https from 'node:https'

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
const SERVICE_URL = process.env.FOREMAN_URL ?? 'http://127.0.0.1:7374'
const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USERS ?? '').split(',').filter(Boolean)
const POLL_INTERVAL_MS = 2000

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN required. Get one from @BotFather.')
  process.exit(1)
}

// ─── Telegram API ────────────────────────────────────────────────────

async function tg(method: string, body?: Record<string, unknown>): Promise<any> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`Telegram API error: ${data.description}`)
  return data.result
}

async function sendMessage(chatId: number, text: string, parseMode = 'Markdown'): Promise<void> {
  // Telegram has a 4096 char limit per message
  const chunks = splitMessage(text, 4000)
  for (const chunk of chunks) {
    try {
      await tg('sendMessage', { chat_id: chatId, text: chunk, parse_mode: parseMode })
    } catch {
      // Markdown might fail — retry without formatting
      await tg('sendMessage', { chat_id: chatId, text: chunk })
    }
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break }
    // Split at last newline before maxLen
    let splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt < maxLen / 2) splitAt = maxLen
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }
  return chunks
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

// ─── Command handlers ────────────────────────────────────────────────

async function handleStatus(): Promise<string> {
  const st = await api('/api/status')
  const goals = st.goals as any[]
  const sessions = st.sessions as any[]
  const decisions = (st.recentDecisions as any[]).slice(0, 5)

  let msg = `📊 *Foreman Status*\n\n`
  msg += `Goals: ${goals.length} | Sessions: ${sessions.filter((s: any) => s.alive).length} active | ${sessions.filter((s: any) => s.idle).length} idle\n\n`

  if (goals.length > 0) {
    msg += `*Goals:*\n`
    for (const g of goals) msg += `  #${g.id} ${g.intent.slice(0, 60)}\n`
    msg += '\n'
  }

  if (sessions.length > 0) {
    msg += `*Sessions:*\n`
    for (const s of sessions) {
      const icon = !s.alive ? '⚫' : s.idle ? '🟡' : '🟢'
      msg += `${icon} ${s.name.replace('foreman-', '')}\n`
    }
    msg += '\n'
  }

  if (decisions.length > 0) {
    msg += `*Recent:*\n`
    for (const d of decisions) {
      const icon = d.status === 'success' ? '✅' : d.status === 'failure' ? '❌' : '⏳'
      msg += `${icon} ${d.skill || 'direct'} — ${d.task.slice(0, 50)}\n`
    }
  }

  return msg
}

async function handleDispatch(text: string): Promise<string> {
  // Parse: /dispatch /skill task description on /path/to/project
  // Or: /dispatch /skill task description (uses last active goal's workspace)
  const parts = text.replace(/^\/dispatch\s*/i, '').trim()
  if (!parts) return '❌ Usage: /dispatch /skill task description\n\nExample: /dispatch /evolve fix auth tests'

  // Try to extract skill and task
  const skillMatch = parts.match(/^(\/\w+)\s+(.+)/)
  const skill = skillMatch ? skillMatch[1] : ''
  const task = skillMatch ? skillMatch[2] : parts

  // Find a workspace from active goals
  const goals = await api('/api/goals') as any[]
  const workDir = goals.find((g: any) => g.workspace_path)?.workspace_path

  if (!workDir) return '❌ No goals with workspace paths. Create a goal first.'

  const result = await api('/api/dispatch', {
    method: 'POST',
    body: { skill, task, work_dir: workDir, goal_id: goals[0]?.id },
  })

  return `✅ Dispatched ${skill || 'direct'}\n` +
    `Task: ${task.slice(0, 80)}\n` +
    `Session: ${result.session}\n` +
    `Confidence: ${result.confidenceLevel} (${result.confidenceScore})\n` +
    (result.worktree ? `Branch: ${result.branch}` : '')
}

async function handleSessions(): Promise<string> {
  const sessions = await api('/api/sessions') as any[]
  if (sessions.length === 0) return 'No active sessions.'

  let msg = `*Sessions:*\n\n`
  for (const s of sessions) {
    const icon = !s.alive ? '⚫' : s.idle ? '🟡' : '🟢'
    msg += `${icon} *${s.name.replace('foreman-', '')}*\n`
    msg += `  Status: ${s.status} | Dir: ${s.work_dir?.split('/').pop() || '?'}\n\n`
  }
  return msg
}

async function handleCheck(name: string): Promise<string> {
  if (!name) return '❌ Usage: /check session-name'
  try {
    const s = await api(`/api/sessions/${encodeURIComponent(name)}`) as any
    const icon = !s.alive ? '⚫ DEAD' : s.idle ? '🟡 IDLE' : '🟢 RUNNING'
    let msg = `${icon} — ${s.name}\n\n`
    if (s.output) msg += `\`\`\`\n${s.output.slice(-1000)}\n\`\`\`\n`
    if (s.gitLog) msg += `\nRecent commits:\n${s.gitLog}\n`
    return msg
  } catch {
    return `❌ Session "${name}" not found`
  }
}

async function handleGoals(): Promise<string> {
  const goals = await api('/api/goals') as any[]
  if (goals.length === 0) return 'No active goals. Send a message to create one.'

  let msg = `*Goals:*\n\n`
  for (const g of goals) {
    const path = g.workspace_path?.split('/').pop() || ''
    msg += `#${g.id} [${path}] ${g.intent.slice(0, 80)}\n`
  }
  return msg
}

async function handleConfidence(): Promise<string> {
  const entries = await api('/api/confidence') as any[]
  if (entries.length === 0) return 'No confidence data yet. Run some dispatches first.'

  let msg = `*Confidence Scores:*\n\n`
  for (const e of entries) {
    const bar = '█'.repeat(Math.round(e.score * 10)) + '░'.repeat(10 - Math.round(e.score * 10))
    msg += `${e.actionType}@${e.project.split('/').pop()}\n  ${bar} ${(e.score * 100).toFixed(0)}% (${e.level})\n\n`
  }
  return msg
}

async function handleFreeText(text: string, chatId: number): Promise<string> {
  // Treat any non-command text as a Foreman goal
  // Create a goal and dispatch if there's enough context
  return `🏗 To dispatch work, use:\n` +
    `/dispatch /evolve ${text.slice(0, 60)}\n\n` +
    `Or create a goal first:\n` +
    `Send: /goal <intent> | <workspace_path>`
}

async function handlePlans(): Promise<string> {
  const plans = await api('/api/plans') as any[]
  if (plans.length === 0) return 'No plans. Generate with /generate-plans'

  let msg = `📋 *Plans (${plans.length}):*\n\n`
  for (const p of plans.slice(0, 5)) {
    const icon = p.isExploration ? '🔭' : (p.rank === 'critical' ? '🔴' : p.rank === 'high' ? '🟠' : p.rank === 'medium' ? '🟡' : '⚪')
    const tag = p.isExploration ? ' [EXPLORATION]' : ''
    msg += `${icon} *${p.title}*${tag}\n`
    msg += `  ${p.rank} | ${p.type} | ${p.status}\n`
    msg += `  ${p.reasoning.slice(0, 100)}\n`
    msg += `  Approve: /approve-plan ${p.id}\n\n`
  }
  return msg
}

async function handleApprovePlan(id: string): Promise<string> {
  if (!id) return '❌ Usage: /approve-plan <plan-id>'
  const result = await api(`/api/plans/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: { status: 'approved', taste_signal: 'approved' },
  })
  if (result.goalId) return `✅ Plan approved → Goal #${result.goalId} created`
  return '❌ Plan not found'
}

async function handleGoalCreate(text: string): Promise<string> {
  const parts = text.replace(/^\/goal\s*/i, '').trim()
  if (!parts) return '❌ Usage: /goal <intent> | <workspace_path>\n\nExample: /goal Fix PiGraph tests | /home/drew/foreman-projects/PiGraph/repo/pigraph-run-ready'

  const [intent, workspacePath] = parts.split('|').map(s => s.trim())
  const result = await api('/api/goals', {
    method: 'POST',
    body: { intent, workspace_path: workspacePath || null },
  })

  return `✅ Goal #${result.id} created: ${intent}`
}

async function handleLearn(): Promise<string> {
  const result = await api('/api/learn', { method: 'POST' })
  return `📚 Learning loop: scanned ${result.scanned} sessions, extracted ${result.extracted} learnings`
}

async function handleAnalyze(): Promise<string> {
  const result = await api('/api/analyze', { method: 'POST' })
  return `🧠 Deep analysis: ${result.analyzed} sessions analyzed → ${result.flows} new flows discovered`
}

// ─── Message router ──────────────────────────────────────────────────

async function handleMessage(msg: any): Promise<void> {
  const chatId = msg.chat.id
  const text = (msg.text || '').trim()
  const username = msg.from?.username || String(msg.from?.id || '')

  // Auth check
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(username) && !ALLOWED_USERS.includes(String(msg.from?.id))) {
    await sendMessage(chatId, '🔒 Unauthorized. Set TELEGRAM_ALLOWED_USERS to allow your username.')
    return
  }

  try {
    let response: string

    if (text.startsWith('/status') || text.startsWith('/start')) {
      response = await handleStatus()
    } else if (text.startsWith('/dispatch')) {
      response = await handleDispatch(text)
    } else if (text.startsWith('/sessions')) {
      response = await handleSessions()
    } else if (text.startsWith('/check')) {
      response = await handleCheck(text.replace(/^\/check\s*/i, '').trim())
    } else if (text.startsWith('/goals')) {
      response = await handleGoals()
    } else if (text.startsWith('/goal ')) {
      response = await handleGoalCreate(text)
    } else if (text.startsWith('/confidence')) {
      response = await handleConfidence()
    } else if (text.startsWith('/learn')) {
      response = await handleLearn()
    } else if (text.startsWith('/reflect') || text.startsWith('/analyze')) {
      response = await handleAnalyze()
    } else if (text.startsWith('/cleanup')) {
      const result = await api('/api/cleanup', { method: 'POST' })
      response = `🧹 Cleaned ${result.cleaned} stale worktrees`
    } else if (text.startsWith('/plans')) {
      response = await handlePlans()
    } else if (text.startsWith('/approve-plan')) {
      response = await handleApprovePlan(text.replace(/^\/approve-plan\s*/i, '').trim())
    } else if (text.startsWith('/generate-plans')) {
      const result = await api('/api/plans/generate', { method: 'POST' })
      const plans = Array.isArray(result) ? result : []
      response = `🧠 Generated ${plans.length} plans\n\n` +
        plans.map((p: any) => `${p.isExploration ? '🔭' : '📋'} *${p.title}* [${p.rank}]\n${p.reasoning.slice(0, 100)}`).join('\n\n')
    } else if (text.startsWith('/help')) {
      response = `🏗 *Foreman Bot*\n\n` +
        `/status — portfolio overview\n` +
        `/goals — list goals\n` +
        `/goal <intent> | <path> — create goal\n` +
        `/dispatch /skill task — dispatch work\n` +
        `/sessions — list sessions\n` +
        `/check <name> — inspect session\n` +
        `/confidence — show confidence scores\n` +
        `/plans — view pending plans\n` +
        `/generate-plans — generate new strategic plans\n` +
        `/approve-plan <id> — approve a plan → creates goal\n` +
        `/learn — trigger learning\n` +
        `/reflect — deep analysis\n` +
        `/cleanup — clean worktrees`
    } else {
      response = await handleFreeText(text, chatId)
    }

    await sendMessage(chatId, response)
  } catch (e) {
    await sendMessage(chatId, `❌ Error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ─── Polling loop ────────────────────────────────────────────────────

let lastUpdateId = 0

async function poll(): Promise<void> {
  try {
    const updates = await tg('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['message'],
    })

    for (const update of updates) {
      lastUpdateId = update.update_id
      if (update.message?.text) {
        await handleMessage(update.message)
      }
    }
  } catch (e) {
    console.error(`Poll error: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ─── Event listener — push notifications from service ────────────────

async function listenForEvents(chatId: number): Promise<void> {
  // SSE connection to the service for real-time events
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
            await sendMessage(chatId,
              `📋 *Session completed*\n` +
              `${d.status === 'success' ? '✅' : '❌'} ${event.sessionName}\n` +
              `Commits: ${d.commits}`)
          } else if (event.type === 'auto_dispatched') {
            await sendMessage(chatId,
              `🤖 *Auto-dispatched*\n` +
              `${event.data.skill} on ${event.sessionName}\n` +
              `Confidence: ${event.data.confidence}`)
          } else if (event.type === 'template_promoted') {
            await sendMessage(chatId,
              `📈 *Template promoted*\n` +
              `v${event.data.version} (${Math.round(event.data.score * 100)}%)`)
          }
        } catch {}
      }
    }
  } catch (e) {
    console.error(`SSE error: ${e instanceof Error ? e.message : String(e)}`)
    // Reconnect after delay
    setTimeout(() => listenForEvents(chatId), 5000)
  }
}

// ─── Start ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Verify bot token
  const me = await tg('getMe')
  console.log(`Foreman Telegram gateway: @${me.username} (${me.id})`)

  // Verify service is reachable
  try {
    await api('/api/health')
    console.log(`Service: ${SERVICE_URL} (OK)`)
  } catch {
    console.error(`Service not reachable at ${SERVICE_URL}`)
    process.exit(1)
  }

  console.log(`Polling for messages...`)
  if (ALLOWED_USERS.length > 0) {
    console.log(`Allowed users: ${ALLOWED_USERS.join(', ')}`)
  } else {
    console.log(`WARNING: No TELEGRAM_ALLOWED_USERS set — anyone can use this bot`)
  }

  // Start polling
  const pollLoop = async () => {
    while (true) {
      await poll()
    }
  }
  pollLoop()
}

main().catch(e => { console.error(e); process.exit(1) })
