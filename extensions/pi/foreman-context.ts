/**
 * Foreman context management for Pi.
 *
 * Handles:
 * - Session start context injection (operator profile, skill suggestions)
 * - Compaction hooks (save before, re-inject after)
 * - Memory nudges (post-session learning prompts)
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadState } from './foreman-tools.js'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export function registerForemanContext(pi: ExtensionAPI): void {

  // ── Session start: inject context ──────────────────────────────

  pi.on('before_agent_start', async (event) => {
    const state = loadState()
    const lines: string[] = []

    if (state) {
      const sessions = (state.sessions ?? []) as Array<Record<string, unknown>>
      const blocked = sessions.filter((s) => s.status === 'blocked')
      const active = sessions.filter((s) => s.status === 'active')
      if (blocked.length > 0 || active.length > 0) {
        lines.push(`[Foreman] ${sessions.length} sessions.${blocked.length > 0 ? ` ⚠ ${blocked.length} blocked.` : ''} ${active.length > 0 ? `${active.length} active.` : ''}`)
      }
    }

    // Skill suggestions based on prompt
    const prompt = event.prompt?.toLowerCase() ?? ''
    const skills: string[] = []
    if (prompt.includes('fix') || prompt.includes('ci') || prompt.includes('failing')) skills.push('/converge', '/diagnose')
    if (prompt.includes('improve') || prompt.includes('better') || prompt.includes('optimize')) skills.push('/evolve', '/pursue')
    if (prompt.includes('review') || prompt.includes('audit')) skills.push('/critical-audit', '/polish')
    if (prompt.includes('ship') || prompt.includes('push') || prompt.includes('pr')) skills.push('/verify', '/code-review')
    if (prompt.includes('research') || prompt.includes('investigate')) skills.push('/research')
    if (skills.length > 0) lines.push(`[Foreman] Skills: ${skills.join(', ')}`)

    // Operator profile (compact)
    try {
      const profile = JSON.parse(readFileSync(join(FOREMAN_HOME, 'memory', 'user', 'operator.json'), 'utf8'))
      if (profile.operatorPatterns?.length) {
        lines.push(`[Foreman] Operator: ${profile.operatorPatterns.slice(0, 3).join('. ')}.`)
      }
    } catch {}

    if (lines.length > 0) {
      pi.sendMessage({ customType: 'foreman-context', content: lines.join('\n'), display: false })
    }
  })

  // ── Compaction: save before, re-inject after ───────────────────

  pi.on('session_before_compact', async (_event, ctx) => {
    try {
      const entries = ctx.sessionManager.getBranch?.() ?? []
      const recentUser: string[] = []
      const recentTools: string[] = []

      for (const entry of (entries as Array<Record<string, unknown>>).slice(-20)) {
        if (entry.type !== 'message' || !entry.message) continue
        const msg = entry.message as Record<string, unknown>
        if (msg.role === 'user' && typeof msg.content === 'string') recentUser.push(msg.content.slice(0, 200))
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          for (const b of msg.content as Array<Record<string, unknown>>) {
            if (b.type === 'tool_use' && typeof b.name === 'string') recentTools.push(b.name)
          }
        }
      }

      const { mkdirSync, writeFileSync } = await import('node:fs')
      const dir = join(FOREMAN_HOME, 'traces', 'compactions')
      try { mkdirSync(dir, { recursive: true }) } catch {}
      writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
        JSON.stringify({ cwd: ctx.cwd, timestamp: new Date().toISOString(), recentUserMessages: recentUser.slice(-5), recentTools: [...new Set(recentTools)], contextTokens: ctx.getContextUsage?.()?.tokens }, null, 2) + '\n')
    } catch {}
  })

  pi.on('session_compact', async (_event, ctx) => {
    const lines: string[] = []
    try {
      const profile = JSON.parse(readFileSync(join(FOREMAN_HOME, 'memory', 'user', 'operator.json'), 'utf8'))
      if (profile.operatorPatterns?.length) lines.push(`[Foreman] Operator: ${profile.operatorPatterns.join('. ')}.`)
    } catch {}
    try {
      const repo = ctx.cwd.split('/').pop() ?? ''
      const env = JSON.parse(readFileSync(join(FOREMAN_HOME, 'memory', 'environment', `${repo}.json`), 'utf8'))
      if (env.facts?.length) lines.push(`[Foreman] Repo: ${env.facts.join('. ')}.`)
    } catch {}

    if (lines.length > 0) {
      pi.sendMessage({ customType: 'foreman-post-compact', content: lines.join('\n'), display: false })
    }
  })

  // ── Memory nudge: post-session learning ────────────────────────

  pi.on('agent_end', async (event, ctx) => {
    const messages = event.messages ?? []
    if (messages.length < 4) return

    const toolNames = new Set<string>()
    const userMsgs: string[] = []
    let hasError = false

    for (const msg of messages) {
      const m = msg as { role?: string; content?: unknown }
      if (m.role === 'user' && typeof m.content === 'string') userMsgs.push(m.content.slice(0, 200))
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content as Array<Record<string, unknown>>) {
          if (b.type === 'tool_use' && typeof b.name === 'string') toolNames.add(b.name)
        }
      }
      if (m.role === 'tool_result') {
        if ((m as { is_error?: boolean }).is_error) hasError = true
      }
    }

    const isComplex = toolNames.size >= 5
    const hadCorrection = userMsgs.some((m) => {
      const l = m.toLowerCase()
      return l.includes('no ') || l.includes('not that') || l.includes('instead') || l.includes('wrong') || l.includes("don't")
    })

    if ((isComplex || (hasError && messages.length > 6) || hadCorrection) && ctx.hasUI) {
      const msg = isComplex
        ? `[Foreman] Complex session (${toolNames.size} tools). Worth saving as a pattern?`
        : hadCorrection
          ? `[Foreman] Correction noted. Save preference?`
          : `[Foreman] Error recovery. Save as repair recipe?`
      ctx.ui.setStatus('foreman-nudge', msg)
      setTimeout(() => ctx.ui.setStatus('foreman-nudge', undefined), 30_000)
    }
  })
}
