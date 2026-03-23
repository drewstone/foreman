/**
 * pi-foreman — Thin client for the Foreman service.
 *
 * Tools call the service HTTP API. Widget reads from API.
 * The conversation IS the policy — this extension just provides the tools.
 *
 * Requires: Foreman service running on localhost:7374
 *           Start with: cd ~/code/foreman && tsx service/index.ts
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent'
import { truncateToWidth, matchesKey, type Component } from '@mariozechner/pi-tui'

function text(content: string): Component {
  return { render: (w: number) => [truncateToWidth(content, w)] }
}
function multiline(content: string[]): Component {
  return { render: (w: number) => content.map(l => truncateToWidth(l, w)) }
}
import { Type, type TUnsafe } from '@sinclair/typebox'

function StringEnum<T extends readonly string[]>(values: T, opts?: { description?: string }): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ type: 'string', enum: values as any, ...(opts?.description && { description: opts.description }) })
}

// ─── Config ──────────────────────────────────────────────────────────

const SERVICE_URL = process.env.FOREMAN_URL ?? 'http://127.0.0.1:7374'

// ─── HTTP client ─────────────────────────────────────────────────────

async function api<T = unknown>(path: string, opts?: { method?: string, body?: unknown }): Promise<T> {
  const res = await fetch(`${SERVICE_URL}${path}`, {
    method: opts?.method ?? 'GET',
    headers: opts?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

async function serviceHealthy(): Promise<boolean> {
  try {
    await api('/api/health')
    return true
  } catch { return false }
}

// ─── Types ───────────────────────────────────────────────────────────

interface Goal { id: number, intent: string, status: string, workspace_path: string | null, workspace_type: string, priority: number }
interface Decision { id: number, goal_id: number, skill: string, task: string, reasoning: string, status: string, outcome: string | null, learnings: string | null, session_name: string | null, worktree_path: string | null, worktree_branch: string | null }
interface Session { name: string, goal_id: number, decision_id: number, work_dir: string, status: string, alive?: boolean, idle?: boolean, lastOutput?: string, output?: string, gitLog?: string }
interface Status { goals: Goal[], sessions: Session[], recentDecisions: Decision[], events: unknown[] }

// ─── Runtime ─────────────────────────────────────────────────────────

interface ForemanRuntime {
  foremanMode: boolean
  dashboardExpanded: boolean
}

function createRuntime(): ForemanRuntime {
  return { foremanMode: false, dashboardExpanded: false }
}

// ─── Extension ───────────────────────────────────────────────────────

export default function foremanExtension(pi: ExtensionAPI) {
  const runtimes = new Map<string, ForemanRuntime>()
  const getKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId()
  const getRuntime = (ctx: ExtensionContext): ForemanRuntime => {
    const key = getKey(ctx)
    let rt = runtimes.get(key)
    if (!rt) { rt = createRuntime(); runtimes.set(key, rt) }
    return rt
  }

  const reconstruct = async (ctx: ExtensionContext) => {
    const rt = getRuntime(ctx)
    rt.foremanMode = await serviceHealthy()
    if (rt.foremanMode) await refreshCache()
    updateWidget(ctx)
  }

  pi.on('session_start', async (_e, ctx) => reconstruct(ctx))
  pi.on('session_switch', async (_e, ctx) => reconstruct(ctx))
  pi.on('session_shutdown', async (_e, ctx) => {
    if (ctx.hasUI) ctx.ui.setWidget('foreman', undefined)
    runtimes.delete(getKey(ctx))
  })

  // System prompt injection
  pi.on('before_agent_start', async (event, ctx) => {
    const rt = getRuntime(ctx)
    if (!rt.foremanMode) return

    let extra = '\n\n## Foreman Mode (ACTIVE)'
    extra += '\nYou have Foreman tools: portfolio_status, dispatch_skill, check_session, log_outcome, project_context, search_history.'
    extra += '\nDrive the operator\'s goal. Never stop. Always have work in flight.'

    // Inject recent state from service
    try {
      const status = await api<Status>('/api/status')
      if (status.goals.length > 0) {
        extra += '\n\n### Active Goals'
        for (const g of status.goals.slice(0, 5)) {
          extra += `\n- [${g.status}] ${g.intent.slice(0, 100)}`
        }
      }
      if (status.sessions.length > 0) {
        extra += '\n\n### Sessions'
        for (const s of status.sessions) {
          const icon = s.idle ? '🟡' : s.alive ? '🟢' : '⚫'
          extra += `\n- ${icon} ${s.name} (${s.status})`
        }
      }
    } catch {}

    return { systemPrompt: event.systemPrompt + extra }
  })

  // ── Widget ──────────────────────────────────────────────────────────

  // Cached status for widget rendering (avoids blocking fetch in render)
  let cachedStatus: Status | null = null
  let cacheAge = 0

  async function refreshCache(): Promise<void> {
    try {
      cachedStatus = await api<Status>('/api/status')
      cacheAge = Date.now()
    } catch { cachedStatus = null }
  }

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return
    const rt = getRuntime(ctx)

    if (!rt.foremanMode) {
      ctx.ui.setWidget('foreman', undefined)
      return
    }

    // Refresh cache in background
    if (!cachedStatus || Date.now() - cacheAge > 10_000) {
      refreshCache()
    }

    if (rt.dashboardExpanded) {
      ctx.ui.setWidget('foreman', (_tui, theme) => {
        const width = process.stdout.columns || 120
        const lines: string[] = []
        const st = cachedStatus

        const hintText = ' ctrl+x collapse • ctrl+shift+x fullscreen '
        const label = '🏗 foreman'
        const fillLen = Math.max(0, width - 3 - 1 - label.length - 1 - hintText.length)
        lines.push(truncateToWidth(
          theme.fg('borderMuted', '───') + theme.fg('accent', ' ' + label + ' ') +
          theme.fg('borderMuted', '─'.repeat(fillLen)) + theme.fg('dim', hintText), width))

        if (!st) {
          lines.push(`  ${theme.fg('error', 'Service not running. Start: tsx service/index.ts')}`)
          return { render: (w: number) => lines.map((l: string) => truncateToWidth(l, w)) }
        }

        lines.push(...renderDashboard(st, width, theme))
        return { render: (w: number) => lines.map((l: string) => truncateToWidth(l, w)) }
      })
    } else {
      ctx.ui.setWidget('foreman', (_tui, theme) => {
        const st = cachedStatus
        if (!st) return text(theme.fg('error', '🏗 Foreman service not running'))

        const alive = st.sessions.filter(s => s.alive)
        const idle = st.sessions.filter(s => s.idle)
        const successes = st.recentDecisions.filter(d => d.status === 'success').length
        const failures = st.recentDecisions.filter(d => d.status === 'failure').length

        const parts = [
          theme.fg('accent', '🏗'),
          st.goals.length > 0 ? theme.fg('muted', ` ${st.goals.length} goals`) : '',
          alive.length > 0 ? theme.fg('success', ` ${alive.length} active`) : '',
          idle.length > 0 ? theme.fg('warning', ` ${idle.length} idle`) : '',
          successes > 0 ? theme.fg('success', ` ${successes}✓`) : '',
          failures > 0 ? theme.fg('error', ` ${failures}✗`) : '',
        ]

        if (alive.length > 0 && alive.length <= 5) {
          parts.push(theme.fg('dim', ' │ '))
          for (const s of alive) {
            const icon = s.idle ? '🟡' : '🟢'
            parts.push(theme.fg('dim', `${icon}${s.name.replace('foreman-', '')} `))
          }
        }

        parts.push(theme.fg('dim', '  (ctrl+x • ctrl+shift+x)'))
        return text(parts.filter(Boolean).join(''))
      })
    }
  }

  function renderDashboard(st: Status, width: number, theme: any): string[] {
    const lines: string[] = []

    // Goals
    if (st.goals.length > 0) {
      lines.push(`  ${theme.fg('muted', 'Goals:')}`)
      for (const g of st.goals) {
        lines.push(truncateToWidth(
          `  ${theme.fg('accent', `#${g.id}`)} ${theme.fg('text', g.intent.slice(0, width - 12))}`, width))
      }
      lines.push('')
    }

    // Sessions
    if (st.sessions.length > 0) {
      const col = { icon: 3, name: 22, status: 10, output: 0 }
      col.output = Math.max(15, width - col.icon - col.name - col.status - 6)

      lines.push(truncateToWidth(
        `  ${theme.fg('muted', ''.padEnd(col.icon))}` +
        `${theme.fg('muted', 'session'.padEnd(col.name))}` +
        `${theme.fg('muted', 'status'.padEnd(col.status))}` +
        `${theme.fg('muted', 'last output')}`, width))
      lines.push(truncateToWidth(`  ${theme.fg('borderMuted', '─'.repeat(width - 4))}`, width))

      for (const s of st.sessions) {
        const icon = !s.alive ? '⚫' : s.idle ? '🟡' : '🟢'
        const statusStr = !s.alive ? 'dead' : s.idle ? 'idle' : s.status
        const statusColor: string = !s.alive ? 'dim' : s.idle ? 'warning' : 'success'
        const output = (s.lastOutput ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, col.output)

        lines.push(truncateToWidth(
          `  ${icon} ` +
          `${theme.fg('accent', s.name.replace('foreman-', '').padEnd(col.name).slice(0, col.name))}` +
          `${theme.fg(statusColor, statusStr.padEnd(col.status))}` +
          `${theme.fg('dim', output)}`, width))
      }
      lines.push('')
    }

    // Recent decisions
    const recent = st.recentDecisions.slice(0, 8)
    if (recent.length > 0) {
      const col = { id: 5, status: 10, skill: 14, task: 0 }
      col.task = Math.max(15, width - col.id - col.status - col.skill - 6)

      lines.push(truncateToWidth(
        `  ${theme.fg('muted', '#'.padEnd(col.id))}` +
        `${theme.fg('muted', 'status'.padEnd(col.status))}` +
        `${theme.fg('muted', 'skill'.padEnd(col.skill))}` +
        `${theme.fg('muted', 'task')}`, width))
      lines.push(truncateToWidth(`  ${theme.fg('borderMuted', '─'.repeat(width - 4))}`, width))

      for (const d of recent) {
        const icon = d.status === 'success' ? '✓' : d.status === 'failure' ? '✗' : d.status === 'dispatched' ? '→' : '○'
        const color: string =
          d.status === 'success' ? 'success' : d.status === 'failure' ? 'error' : 'accent'

        lines.push(truncateToWidth(
          `  ${theme.fg('dim', String(d.id).padEnd(col.id))}` +
          `${theme.fg(color, (icon + ' ' + d.status).padEnd(col.status))}` +
          `${theme.fg('text', (d.skill || '—').padEnd(col.skill))}` +
          `${theme.fg('muted', d.task.slice(0, col.task))}`, width))
      }
    }

    return lines
  }

  // ── Shortcuts ───────────────────────────────────────────────────────

  pi.registerShortcut('ctrl+x', {
    description: 'Toggle foreman dashboard',
    handler: async (ctx) => {
      const rt = getRuntime(ctx)
      rt.dashboardExpanded = !rt.dashboardExpanded
      await refreshCache()
      updateWidget(ctx)
    },
  })

  pi.registerShortcut('ctrl+shift+x', {
    description: 'Fullscreen foreman dashboard',
    handler: async (ctx) => {
      await refreshCache()
      const st = cachedStatus
      if (!st) { ctx.ui.notify('Foreman service not running', 'error'); return }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        let scrollOffset = 0
        return {
          render(width: number): string[] {
            const termH = process.stdout.rows || 40
            const content = renderDashboard(st, width, theme)
            const viewportRows = Math.max(4, termH - 4)
            const maxScroll = Math.max(0, content.length - viewportRows)
            if (scrollOffset > maxScroll) scrollOffset = maxScroll

            const out: string[] = []
            const title = '🏗 foreman'
            out.push(truncateToWidth(
              theme.fg('borderMuted', '───') + theme.fg('accent', ' ' + title + ' ') +
              theme.fg('borderMuted', '─'.repeat(Math.max(0, width - title.length - 5))), width))
            for (const line of content.slice(scrollOffset, scrollOffset + viewportRows)) out.push(truncateToWidth(line, width))
            for (let i = content.slice(scrollOffset, scrollOffset + viewportRows).length; i < viewportRows; i++) out.push('')
            const help = ` ↑↓/j/k scroll • esc close `
            out.push(truncateToWidth(theme.fg('borderMuted', '─'.repeat(Math.max(0, width - help.length))) + theme.fg('dim', help), width))
            return out
          },
          handleInput(data: string): void {
            const viewportRows = Math.max(4, (process.stdout.rows || 40) - 4)
            const maxScroll = Math.max(0, (renderDashboard(st, process.stdout.columns || 120, {} as any).length) - viewportRows)
            if (matchesKey(data, 'escape') || data === 'q') { done(undefined); return }
            if (matchesKey(data, 'up') || data === 'k') scrollOffset = Math.max(0, scrollOffset - 1)
            else if (matchesKey(data, 'down') || data === 'j') scrollOffset = Math.min(maxScroll, scrollOffset + 1)
            else if (data === 'g') scrollOffset = 0
            else if (data === 'G') scrollOffset = maxScroll
            _tui.requestRender()
          },
          invalidate(): void {},
          dispose(): void {},
        }
      }, { overlay: true, overlayOptions: { width: '95%', maxHeight: '90%', anchor: 'center' as const } })
    },
  })

  // ── Tool: portfolio_status ──────────────────────────────────────────

  pi.registerTool({
    name: 'portfolio_status',
    label: 'Portfolio Status',
    description: 'Get a snapshot of all goals, sessions, and recent decisions from the Foreman service.',
    promptSnippet: 'Get portfolio overview',
    promptGuidelines: ['Call at the start of each cycle.', 'Identifies what needs attention.'],
    parameters: Type.Object({}),

    async execute(_id, _params, _signal, _onUpdate, ctx) {
      try {
        const st = await api<Status>('/api/status')
        let text = `# Portfolio Status\n\n`
        text += `${st.goals.length} goals | ${st.sessions.filter((s: Session) => s.alive).length} active sessions | ${st.sessions.filter((s: Session) => s.idle).length} idle\n\n`

        if (st.goals.length > 0) {
          text += '## Goals\n'
          for (const g of st.goals) text += `- **#${g.id}** [${g.status}] ${g.intent}${g.workspace_path ? ` (${g.workspace_path})` : ''}\n`
          text += '\n'
        }

        if (st.sessions.length > 0) {
          text += '## Sessions\n'
          for (const s of st.sessions as Session[]) {
            const icon = !s.alive ? '⚫' : s.idle ? '🟡' : '🟢'
            text += `${icon} **${s.name}** — ${s.status}${s.lastOutput ? ` — ${s.lastOutput}` : ''}\n`
          }
          text += '\n'
        }

        if (st.recentDecisions.length > 0) {
          text += '## Recent Decisions\n'
          for (const d of st.recentDecisions.slice(0, 10) as Decision[]) {
            const icon = d.status === 'success' ? '✓' : d.status === 'failure' ? '✗' : '→'
            text += `${icon} #${d.id} [${d.status}] ${d.skill || 'direct'} — ${d.task.slice(0, 80)}\n`
            if (d.outcome) text += `  → ${d.outcome.slice(0, 80)}\n`
          }
        }

        // Identify what needs attention
        const needsWork = (st.sessions as Session[]).filter(s => s.idle || !s.alive)
        const goalsWithoutSessions = st.goals.filter(g =>
          !(st.sessions as Session[]).some(s => s.goal_id === g.id && s.alive))
        if (needsWork.length > 0 || goalsWithoutSessions.length > 0) {
          text += '\n## Needs Attention\n'
          for (const s of needsWork) text += `- ${s.idle ? '🟡' : '⚫'} ${s.name}: ${s.idle ? 'idle — check outcome' : 'dead — investigate'}\n`
          for (const g of goalsWithoutSessions) text += `- ⚪ Goal #${g.id}: no active session — dispatch work\n`
        }

        await refreshCache()
        updateWidget(ctx)
        return { content: [{ type: 'text' as const, text }], details: st }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `❌ Foreman service not reachable at ${SERVICE_URL}\nError: ${e instanceof Error ? e.message : String(e)}\nStart: cd ~/code/foreman && npm run service` }], details: {} }
      }
    },
    renderCall(_a, theme) { return text(theme.fg('toolTitle', theme.bold('portfolio_status'))) },
    renderResult(r, _o, theme) { const t = r.content[0]; const txt = t?.type === 'text' ? t.text : ''; return multiline(txt.split('\n').slice(0, 6).map((l: string) => theme.fg('muted', l))) },
  })

  // ── Tool: dispatch_skill ────────────────────────────────────────────

  pi.registerTool({
    name: 'dispatch_skill',
    label: 'Dispatch Skill',
    description: 'Dispatch work to a Claude Code session. Returns immediately — the session boots in the background. Use check_session to monitor.',
    promptSnippet: 'Dispatch work (non-blocking)',
    promptGuidelines: [
      'Read project_context before first dispatch on a project.',
      'Be SPECIFIC: "Fix the 3 failing tests in auth module" not "make tests pass".',
      'Use worktree + label for parallel experiments on the same project.',
      'Returns immediately — use check_session to monitor progress.',
    ],
    parameters: Type.Object({
      goal_id: Type.Optional(Type.Number({ description: 'Goal ID to associate with. Omit if creating ad-hoc work.' })),
      work_dir: Type.Optional(Type.String({ description: 'Working directory. Required if no goal_id with a workspace_path.' })),
      skill: Type.String({ description: 'Skill (/evolve, /pursue, /polish, /verify, /research, /converge, /critical-audit) or custom prompt.' }),
      task: Type.String({ description: 'Specific task description. What does "done" look like?' }),
      reasoning: Type.Optional(Type.String({ description: 'Why this is the highest-value action right now.' })),
      worktree: Type.Optional(Type.Boolean({ description: 'Default: true for local (tmux). Foreman works in worktrees so it never touches the operator\'s directory. Set false for non-git workspaces.' })),
      label: Type.Optional(Type.String({ description: 'Label for parallel sessions (e.g. "lora-16"). Used in session name and branch.' })),
      backend: Type.Optional(Type.String({ description: 'Execution backend: "tmux" (local, default) or "tangle" (remote Tangle sandbox). Use tangle for GPU work or isolation.' })),
      model: Type.Optional(Type.String({ description: 'Model override: "opus", "sonnet", "haiku". Overrides auto-selection. Omit to let Foreman choose based on task complexity.' })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await api<{ decision: Decision, session: string, backend: string, model: string | null, worktree: string | null, branch: string | null, baseBranch: string | null }>('/api/dispatch', {
          method: 'POST',
          body: {
            goal_id: params.goal_id,
            work_dir: params.work_dir,
            skill: params.skill,
            task: params.task,
            reasoning: params.reasoning ?? '',
            worktree: params.worktree,
            label: params.label,
            backend: params.backend,
            model: params.model,
          },
        })

        await refreshCache()
        updateWidget(ctx)

        const wt = result.worktree
          ? `\nWorktree: ${result.worktree}\nBranch: ${result.branch} → PR against ${result.baseBranch ?? 'main'}`
          : ''
        return {
          content: [{ type: 'text' as const, text: `✅ Dispatched ${params.skill} → ${result.session}${params.label ? ` [${params.label}]` : ''}\nTask: ${params.task}\nBackend: ${result.backend}${result.model ? ` | Model: ${result.model}` : ''}\nDecision #${result.decision.id}${wt}\n\nSession is starting in background. Use check_session("${result.session}") to monitor.` }],
          details: result,
        }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `❌ Dispatch failed: ${e instanceof Error ? e.message : String(e)}` }], details: {} }
      }
    },
    renderCall(args, theme) {
      return text(theme.fg('toolTitle', theme.bold('dispatch_skill ')) + theme.fg('accent', args.skill ?? '') + theme.fg('dim', ` "${(args.task ?? '').slice(0, 40)}"`))
    },
    renderResult(r, _o, theme) { return text(r.content[0]?.type === 'text' ? r.content[0].text.split('\n')[0] : '') },
  })

  // ── Tool: check_session ─────────────────────────────────────────────

  pi.registerTool({
    name: 'check_session',
    label: 'Check Session',
    description: 'Inspect a running session — see output, status, git commits. Use to monitor dispatched work.',
    promptSnippet: 'Check session status and output',
    promptGuidelines: ['Check after dispatch to monitor progress.', 'If idle, read output and log_outcome.'],
    parameters: Type.Object({
      session: Type.String({ description: 'Session name (e.g. "foreman-phony" or full name from dispatch)' }),
      lines: Type.Optional(Type.Number({ description: 'Output lines to capture (default: 30)' })),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const s = await api<Session>(`/api/sessions/${encodeURIComponent(params.session)}?lines=${params.lines ?? 30}`)
        const icon = !s.alive ? '⚫ DEAD' : s.idle ? '🟡 IDLE' : '🟢 RUNNING'

        let text = `${icon} — ${s.name}\n\n`
        if (s.output) text += `### Output\n\`\`\`\n${s.output.slice(-2000)}\n\`\`\`\n`
        if (s.gitLog) text += `\n### Recent Commits\n${s.gitLog}\n`
        if (s.idle) text += '\n⚡ Session is idle — log_outcome to record results.'

        return { content: [{ type: 'text' as const, text }], details: s }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `❌ ${e instanceof Error ? e.message : String(e)}` }], details: {} }
      }
    },
    renderCall(args, theme) { return text(theme.fg('toolTitle', theme.bold('check_session ')) + theme.fg('accent', args.session ?? '')) },
    renderResult(r, _o, theme) {
      const d = r.details as Session | undefined
      if (!d) return text('')
      const icon = !d.alive ? '⚫' : d.idle ? '🟡' : '🟢'
      return text(theme.fg(d.idle ? 'warning' : d.alive ? 'success' : 'error', `${icon} ${d.status}`))
    },
  })

  // ── Tool: log_outcome ───────────────────────────────────────────────

  pi.registerTool({
    name: 'log_outcome',
    label: 'Log Outcome',
    description: 'Record what happened after a dispatched session completed. Logs to the service DB for learning.',
    promptSnippet: 'Record outcome + learnings',
    promptGuidelines: [
      'Always call after a session finishes (idle or dead).',
      'Be honest. Include specific learnings.',
      'Set taste_signal based on whether the operator would approve.',
    ],
    parameters: Type.Object({
      decision_id: Type.Number({ description: 'Decision ID from dispatch_skill' }),
      status: StringEnum(['success', 'failure', 'reverted'] as const),
      outcome: Type.String({ description: 'What happened — specific results' }),
      learnings: Type.Array(Type.String(), { description: 'Reusable insights' }),
      metrics: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Measurable outcomes' })),
      taste_signal: Type.Optional(StringEnum(['approved', 'rejected', 'neutral'] as const)),
      cost_usd: Type.Optional(Type.Number({ description: 'Estimated cost of this session' })),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await api<Decision>('/api/outcomes', { method: 'POST', body: params })
        await refreshCache()
        updateWidget(ctx)

        let text = `📝 Decision #${result.id} → ${params.status}\n`
        text += `Outcome: ${params.outcome}\n`
        if (params.learnings.length > 0) {
          text += '\nLearnings:\n'
          for (const l of params.learnings) text += `- ${l}\n`
        }
        return { content: [{ type: 'text' as const, text }], details: result }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `❌ ${e instanceof Error ? e.message : String(e)}` }], details: {} }
      }
    },
    renderCall(args, theme) { return text(theme.fg('toolTitle', theme.bold('log_outcome ')) + theme.fg(args.status === 'success' ? 'success' : 'error', `#${args.decision_id} ${args.status}`)) },
    renderResult(r, _o, _t) { return text(r.content[0]?.type === 'text' ? r.content[0].text.split('\n')[0] : '') },
  })

  // ── Tool: project_context ───────────────────────────────────────────

  pi.registerTool({
    name: 'project_context',
    label: 'Project Context',
    description: 'Deep read of a project — README, CLAUDE.md, git log, evolve/autoresearch state. Read before dispatching.',
    promptSnippet: 'Deep project read',
    promptGuidelines: ['Always before first dispatch on a project.'],
    parameters: Type.Object({
      path: Type.String({ description: 'Absolute path to the project' }),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const ctx = await api<Record<string, string>>(`/api/context?path=${encodeURIComponent(params.path)}`)
        let text = `# ${params.path.split('/').pop()}\n\n`
        for (const [file, content] of Object.entries(ctx)) {
          text += `## ${file}\n${content}\n\n`
        }
        return { content: [{ type: 'text' as const, text }], details: ctx }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `❌ ${e instanceof Error ? e.message : String(e)}` }], details: {} }
      }
    },
    renderCall(args, theme) { return text(theme.fg('toolTitle', theme.bold('project_context ')) + theme.fg('accent', (args.path ?? '').split('/').pop() ?? '')) },
    renderResult(r, _o, theme) { const txt = r.content[0]?.type === 'text' ? r.content[0].text : ''; return multiline(txt.split('\n').slice(0, 3).map((l: string) => theme.fg('muted', l))) },
  })

  // ── Tool: search_history ────────────────────────────────────────────

  pi.registerTool({
    name: 'search_history',
    label: 'Search History',
    description: 'Search past decisions. Avoid dead ends, find patterns, cross-pollinate learnings.',
    promptSnippet: 'Search past decisions',
    promptGuidelines: ['Search before dispatching — know what was tried.'],
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      goal_id: Type.Optional(Type.Number({ description: 'Filter to a specific goal' })),
      limit: Type.Optional(Type.Number({ description: 'Max results (default: 20)' })),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const qs = params.goal_id
          ? `goal_id=${params.goal_id}`
          : `q=${encodeURIComponent(params.query)}&limit=${params.limit ?? 20}`
        const decisions = await api<Decision[]>(`/api/decisions?${qs}`)

        if (decisions.length === 0) {
          return { content: [{ type: 'text' as const, text: `No results for "${params.query}"` }], details: { count: 0 } }
        }

        let text = `## ${decisions.length} results for "${params.query}"\n\n`
        for (const d of decisions) {
          const icon = d.status === 'success' ? '✓' : d.status === 'failure' ? '✗' : '○'
          text += `${icon} #${d.id} [${d.status}] ${d.skill || 'direct'} — ${d.task.slice(0, 80)}\n`
          if (d.outcome) text += `  → ${d.outcome.slice(0, 80)}\n`
          if (d.learnings) {
            try {
              for (const l of JSON.parse(d.learnings)) text += `  💡 ${String(l).slice(0, 80)}\n`
            } catch {}
          }
          text += '\n'
        }
        return { content: [{ type: 'text' as const, text }], details: { count: decisions.length } }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `❌ ${e instanceof Error ? e.message : String(e)}` }], details: {} }
      }
    },
    renderCall(args, theme) { return text(theme.fg('toolTitle', theme.bold('search_history ')) + theme.fg('muted', args.query ?? '')) },
    renderResult(r, _o, theme) { return text(theme.fg('muted', `${(r.details as { count?: number })?.count ?? 0} results`)) },
  })

  // ── Tool: analyze_sessions ───────────────────────────────────────────

  pi.registerTool({
    name: 'analyze_sessions',
    label: 'Analyze Sessions',
    description: 'Trigger deep LLM analysis of the operator\'s recent sessions. Extracts workflows, taste signals, skill preferences, anti-patterns, and project relationships. The service dispatches a Claude session to reason about session traces. Results feed into future prompt compositions.',
    promptSnippet: 'Deep-analyze operator sessions for flows and patterns',
    promptGuidelines: [
      'Call periodically or when you want to understand the operator\'s patterns better.',
      'This dispatches an LLM call — takes 30-60 seconds.',
      'Results show up in future dispatches as learned flows, taste, and skill preferences.',
    ],
    parameters: Type.Object({}),

    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      try {
        const result = await api<{ analyzed: number, flows: number }>('/api/analyze', { method: 'POST' })
        if (result.analyzed === 0) {
          return { content: [{ type: 'text' as const, text: 'No new sessions to analyze. Analysis runs automatically every 6 hours.' }], details: result }
        }

        // Fetch what was learned
        const flows = await api<Array<{ content: string }>>('/api/learnings?type=flow&limit=5')
        const taste = await api<Array<{ pattern: string }>>('/api/taste?limit=5')
        const antiPatterns = await api<Array<{ content: string }>>('/api/learnings?type=anti_pattern&limit=3')

        let text = `🧠 Analyzed ${result.analyzed} sessions → ${result.flows} new flows discovered\n\n`

        if (flows.length > 0) {
          text += '### Workflows Found\n'
          for (const f of flows) text += `- ${f.content.slice(0, 200)}\n`
          text += '\n'
        }
        if (taste.length > 0) {
          text += '### Taste Signals\n'
          for (const t of taste) text += `- ${t.pattern.slice(0, 150)}\n`
          text += '\n'
        }
        if (antiPatterns.length > 0) {
          text += '### Anti-Patterns\n'
          for (const ap of antiPatterns) text += `- ${ap.content.slice(0, 150)}\n`
        }

        return { content: [{ type: 'text' as const, text }], details: result }
      } catch (e) {
        return { content: [{ type: 'text' as const, text: `❌ ${e instanceof Error ? e.message : String(e)}` }], details: {} }
      }
    },
    renderCall(_a, theme) { return text(theme.fg('toolTitle', theme.bold('analyze_sessions'))) },
    renderResult(r, _o, theme) {
      const d = r.details as { analyzed?: number, flows?: number } | undefined
      return text(theme.fg('muted', `${d?.analyzed ?? 0} sessions → ${d?.flows ?? 0} flows`))
    },
  })

  // ── Command: /foreman ───────────────────────────────────────────────

  pi.registerCommand('foreman', {
    description: 'Give Foreman a goal. Your prompt IS the mission.',
    handler: async (args, ctx) => {
      const rt = getRuntime(ctx)
      const trimmed = (args ?? '').trim()

      if (!trimmed) {
        ctx.ui.notify(
          '/foreman <your goal> — give Foreman a mission\n/foreman off — exit\n/foreman clear — reset\n\n' +
          'Examples:\n  /foreman drive phony to SOTA, track experiments, write a paper\n  /foreman manage all projects\n  /foreman make foreman better', 'info')
        return
      }

      if (trimmed.toLowerCase() === 'off') { rt.foremanMode = false; updateWidget(ctx); ctx.ui.notify('Foreman OFF', 'info'); return }
      if (trimmed.toLowerCase() === 'clear') {
        rt.foremanMode = false; updateWidget(ctx)
        // Note: clearing DB requires service restart or a clear endpoint
        ctx.ui.notify('Foreman OFF (clear DB: restart service with --reset)', 'info')
        return
      }

      // Check service health
      const healthy = await serviceHealthy()
      if (!healthy) {
        ctx.ui.notify('Foreman service not running.\nStart: cd ~/code/foreman && tsx service/index.ts', 'error')
        return
      }

      rt.foremanMode = true
      await refreshCache()
      updateWidget(ctx)
      ctx.ui.notify('Foreman ON', 'info')

      // The operator's prompt IS the goal. Pass through.
      pi.sendUserMessage(trimmed)
    },
  })
}
