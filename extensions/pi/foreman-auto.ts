/**
 * Foreman autonomous behavior for Pi.
 *
 * Auto-loop: agent_end → check → fix → review → ship
 * Watchdog: mid-session stuck detection with nudges
 *
 * These are opt-in behaviors, not always-on tools.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

// ─── Types ──────────────────────────────────────────────────────────

type AutoPhase = 'idle' | 'implementing' | 'checking' | 'fixing' | 'reviewing' | 'shipping'

interface AutoState {
  enabled: boolean
  phase: AutoPhase
  iteration: number
  maxIterations: number
  checkFailures: number
  lastCheckOutput: string
  repoPath: string | null
  goal: string | null
}

interface WatchdogState {
  enabled: boolean
  lastActivityTs: number
  lastNudgeTs: number
  consecutiveNudges: number
  checkIntervalMs: number
  stuckThresholdMs: number
  maxNudges: number
  judgeInProgress: boolean
  timer: ReturnType<typeof setInterval> | null
}

// ─── Helpers ────────────────────────────────────────────────────────

function detectChecks(repoPath: string): string[] {
  const checks: string[] = []
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8'))
    const scripts = pkg.scripts ?? {}
    if (scripts.check) checks.push('npm run check')
    else {
      if (scripts['check:types'] || scripts.typecheck) checks.push(scripts['check:types'] ? 'npm run check:types' : 'npm run typecheck')
      if (scripts.lint) checks.push('npm run lint')
      if (scripts.test) checks.push('npm run test')
    }
    if (checks.length === 0 && scripts.build) checks.push('npm run build')
  } catch {}
  if (checks.length === 0) {
    try { readFileSync(join(repoPath, 'Cargo.toml'), 'utf8'); checks.push('cargo check', 'cargo test') } catch {}
  }
  if (checks.length === 0) {
    try { readFileSync(join(repoPath, 'Makefile'), 'utf8'); checks.push('make test') } catch {}
  }
  return checks
}

function looksLikeQuestion(text: string): boolean {
  const last200 = text.slice(-200).toLowerCase()
  return /\?\s*$/.test(last200.trim()) ||
    /should i |what do you|do you want|would you like|let me know|your thoughts/i.test(last200)
}

function extractTextFromMessage(msg: { content?: Array<{ type: string; text?: string }> }): string {
  if (!msg.content || !Array.isArray(msg.content)) return ''
  return msg.content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n')
}

// ─── Registration ───────────────────────────────────────────────────

export function registerForemanAuto(pi: ExtensionAPI): void {
  const auto: AutoState = {
    enabled: false, phase: 'idle', iteration: 0, maxIterations: 10,
    checkFailures: 0, lastCheckOutput: '', repoPath: null, goal: null,
  }

  const watchdog: WatchdogState = {
    enabled: true, lastActivityTs: Date.now(), lastNudgeTs: 0,
    consecutiveNudges: 0, checkIntervalMs: 30_000, stuckThresholdMs: 120_000,
    maxNudges: 3, judgeInProgress: false, timer: null,
  }

  // ── Flag + command ─────────────────────────────────────────────

  pi.registerFlag('foreman-auto', {
    description: 'Enable autonomous check→fix→review→ship loop',
    type: 'boolean',
    default: false,
  })

  pi.registerCommand('auto', {
    description: 'Toggle autonomous loop (check → fix → review → ship)',
    handler: async (args, ctx) => {
      if (args.trim() === 'off') {
        auto.enabled = false; auto.phase = 'idle'; auto.iteration = 0
        ctx.ui.notify('[Foreman] Auto mode OFF', 'info')
        return
      }
      auto.enabled = !auto.enabled
      if (auto.enabled) {
        auto.repoPath = ctx.cwd; auto.iteration = 0; auto.phase = 'implementing'; auto.checkFailures = 0
        if (args.trim()) auto.goal = args.trim()
        ctx.ui.notify(`[Foreman] Auto mode ON — max ${auto.maxIterations} iterations`, 'info')
      } else {
        auto.phase = 'idle'
        ctx.ui.notify('[Foreman] Auto mode OFF', 'info')
      }
    },
  })

  pi.registerCommand('watchdog', {
    description: 'Toggle stuck detection (on/off)',
    handler: async (args, ctx) => {
      if (args.trim() === 'off') {
        watchdog.enabled = false; ctx.ui.setStatus('watchdog', undefined)
        ctx.ui.notify('[Watchdog] Disabled', 'info')
      } else {
        watchdog.enabled = true; watchdog.consecutiveNudges = 0; watchdog.lastActivityTs = Date.now()
        ctx.ui.setStatus('watchdog', '[watchdog] active')
        ctx.ui.notify('[Watchdog] Enabled — nudge after 2min inactivity', 'info')
      }
    },
  })

  // ── Watchdog activity tracking ─────────────────────────────────

  function updateActivity() { watchdog.lastActivityTs = Date.now(); watchdog.consecutiveNudges = 0 }

  pi.on('turn_end', async () => { updateActivity() })
  pi.on('tool_execution_end', async () => { updateActivity() })
  pi.on('message_end', async () => { updateActivity() })

  pi.on('session_start', async (_event, ctx) => {
    updateActivity()
    if (watchdog.timer) clearInterval(watchdog.timer)

    watchdog.timer = setInterval(async () => {
      if (!watchdog.enabled || ctx.isIdle()) return
      const elapsed = Date.now() - watchdog.lastActivityTs
      if (elapsed < watchdog.stuckThresholdMs || watchdog.judgeInProgress) return

      watchdog.judgeInProgress = true
      try {
        if (watchdog.consecutiveNudges >= watchdog.maxNudges) {
          ctx.abort()
          pi.sendUserMessage('[Watchdog] Stuck after ' + watchdog.maxNudges + ' nudges. Cancelled.', { deliverAs: 'followUp' })
          watchdog.enabled = false
          ctx.ui.setStatus('watchdog', '[watchdog] stopped')
          return
        }
        ctx.abort()
        watchdog.consecutiveNudges++
        watchdog.lastActivityTs = Date.now()
        watchdog.lastNudgeTs = Date.now()
        ctx.ui.setStatus('watchdog', `[watchdog] nudge ${watchdog.consecutiveNudges}/${watchdog.maxNudges}`)
        pi.sendUserMessage(
          `[Watchdog] No progress for ${Math.round(elapsed / 1000)}s. Cancelled. Try a different approach.`,
          { deliverAs: 'followUp' },
        )
      } catch {} finally { watchdog.judgeInProgress = false }
    }, watchdog.checkIntervalMs)
  })

  pi.on('session_shutdown', async () => {
    if (watchdog.timer) { clearInterval(watchdog.timer); watchdog.timer = null }
  })

  // ── Auto-loop ──────────────────────────────────────────────────

  pi.on('agent_end', async (event, ctx) => {
    if (Date.now() - watchdog.lastNudgeTs < 5000) return

    if (!auto.enabled) {
      if (pi.getFlag('foreman-auto') === true) {
        auto.enabled = true; auto.repoPath = ctx.cwd; auto.phase = 'implementing'
      }
      if (!auto.enabled) return
    }

    auto.iteration++
    if (auto.iteration > auto.maxIterations) {
      ctx.ui.notify(`[Foreman] Max iterations reached.`, 'warning')
      auto.enabled = false; auto.phase = 'idle'; return
    }

    const messages = event.messages ?? []
    const lastMsg = messages[messages.length - 1]
    if (!lastMsg) return

    const lastText = extractTextFromMessage(lastMsg as { content?: Array<{ type: string; text?: string }> })
    if (looksLikeQuestion(lastText)) {
      ctx.ui.setStatus('foreman', `[auto] paused — question (iter ${auto.iteration})`)
      return
    }

    const repoPath = auto.repoPath ?? ctx.cwd

    if (auto.phase === 'implementing' || auto.phase === 'fixing') {
      auto.phase = 'checking'
      ctx.ui.setStatus('foreman', `[auto] checking (iter ${auto.iteration})...`)

      const checks = detectChecks(repoPath)
      if (checks.length === 0) {
        auto.phase = 'reviewing'
        pi.sendUserMessage('No checks detected. Run /verify, then commit and push.', { deliverAs: 'followUp' })
        return
      }

      const results: Array<{ cmd: string; ok: boolean; output: string }> = []
      for (const cmd of checks) {
        try {
          const r = await pi.exec('bash', ['-c', cmd], { cwd: repoPath, timeout: 120_000 })
          results.push({ cmd, ok: r.code === 0, output: (r.stdout + '\n' + r.stderr).trim() })
        } catch (e) {
          results.push({ cmd, ok: false, output: String(e) })
        }
      }

      const allPassed = results.every((r) => r.ok)
      const summary = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.cmd}${r.ok ? '' : '\n' + r.output.slice(-500)}`).join('\n\n')

      if (allPassed) {
        auto.phase = 'reviewing'; auto.checkFailures = 0
        pi.sendUserMessage(`Checks passed:\n\`\`\`\n${summary}\n\`\`\`\n\nReview, commit, push, and create PR.`, { deliverAs: 'followUp' })
      } else {
        auto.checkFailures++
        if (auto.checkFailures > 3) {
          ctx.ui.notify('[Foreman] 3 check failures. Stopping.', 'warning')
          auto.enabled = false; auto.phase = 'idle'; return
        }
        auto.phase = 'fixing'
        pi.sendUserMessage(`Checks failed:\n\`\`\`\n${summary}\n\`\`\`\n\nFix the failures.`, { deliverAs: 'followUp' })
      }
      return
    }

    if (auto.phase === 'reviewing' || auto.phase === 'shipping') {
      auto.phase = 'shipping'
      try {
        const r = await pi.exec('git', ['status', '--porcelain'], { cwd: repoPath, timeout: 10_000 })
        if (r.stdout.trim() === '') {
          ctx.ui.notify(`[Foreman] Complete after ${auto.iteration} iterations.`, 'info')
          auto.enabled = false; auto.phase = 'idle'; return
        }
      } catch {}
      pi.sendUserMessage('Uncommitted changes remain. Commit, push, and create PR.', { deliverAs: 'followUp' })
    }
  })
}
