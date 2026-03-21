/**
 * Foreman extension for Pi Mono.
 *
 * Thin wrapper — calls Foreman CLI via bash, reads state files directly.
 * No Foreman library imports needed. Pi provides bash, read, write.
 *
 * Install:
 *   ln -s ~/code/foreman/extensions/pi/foreman.ts ~/.pi/agent/extensions/foreman.ts
 *
 * Tools registered:
 *   foreman_status   — show session portfolio across all repos
 *   foreman_resume   — resume a session by ID or repo/branch
 *   foreman_harden   — expand a goal into task envelope with checks
 *   foreman_validate — run CI checks + review on current work
 *   foreman_insights — deep analysis of recent session patterns
 *   foreman_memory   — read/write Foreman memory for a repo
 *
 * Commands:
 *   /foreman         — show status dashboard
 *   /heartbeat       — run a heartbeat scan now
 *   /auto [goal]     — toggle autonomous check→fix→review→ship loop
 *   /watchdog        — toggle mid-session stuck detection
 *   /qmd             — generate and show CLAUDE.md context for current repo
 *
 * Flags:
 *   --foreman-auto   — enable autonomous loop from CLI
 */

import { Type } from '@mariozechner/pi-ai';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const FOREMAN_DIR = process.env.FOREMAN_DIR ?? join(homedir(), 'code', 'foreman');
const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman');
const FOREMAN_STATE = join(FOREMAN_HOME, 'operator-state.json');

function run(cmd: string, timeoutMs = 30_000): string {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      cwd: FOREMAN_DIR,
      env: { ...process.env, PATH: process.env.PATH },
    }).trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return err.stdout?.trim() || err.stderr?.trim() || err.message || 'command failed';
  }
}

function loadState(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(FOREMAN_STATE, 'utf8'));
  } catch {
    return null;
  }
}

function formatSessions(state: Record<string, unknown> | null): string {
  if (!state) return 'No Foreman state found. Run /heartbeat first.';
  const sessions = (state.sessions ?? []) as Array<Record<string, unknown>>;
  if (sessions.length === 0) return 'No active sessions discovered.';

  const sorted = [...sessions]
    .filter((s) => s.status !== 'completed')
    .sort((a, b) => (b.priority as number ?? 0) - (a.priority as number ?? 0));

  return sorted.slice(0, 20).map((s, i) => {
    const ci = s.ciStatus ? ` [CI:${s.ciStatus}]` : '';
    const pr = s.prNumber ? ` PR#${s.prNumber}` : '';
    const blocker = s.blockerReason ? ` ⚠ ${s.blockerReason}` : '';
    const repo = String(s.repoPath ?? '').split('/').pop();
    return `${i + 1}. [${s.status}] ${repo}/${s.branch}${pr}${ci}${blocker}\n   ${s.goal}`;
  }).join('\n');
}

// ─── Watchdog: mid-session stuck detection ────────────────────────

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

function createWatchdogState(): WatchdogState {
  return {
    enabled: true,
    lastActivityTs: Date.now(),
    lastNudgeTs: 0,
    consecutiveNudges: 0,
    checkIntervalMs: 30_000,   // check every 30s
    stuckThresholdMs: 120_000, // 2min no activity = stuck
    maxNudges: 3,
    judgeInProgress: false,
    timer: null,
  }
}

function formatRecentActivity(messages: Array<{ role?: string; content?: unknown }>, maxChars = 3000): string {
  const lines: string[] = []
  let chars = 0
  for (const msg of messages.slice(-15)) {
    if (chars >= maxChars) break
    const role = (msg.role ?? 'unknown').toUpperCase()
    let text = ''
    if (typeof msg.content === 'string') {
      text = msg.content.slice(0, 300)
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b.type === 'text' && typeof b.text === 'string') {
          text += b.text.slice(0, 200) + ' '
        } else if (b.type === 'tool_use' || b.type === 'toolCall') {
          text += `[${b.name ?? b.toolName ?? 'tool'}] `
        }
      }
    }
    if (!text.trim()) continue
    const line = `[${role}] ${text.trim().slice(0, 250)}`
    lines.push(line)
    chars += line.length
  }
  return lines.join('\n')
}

// ─── Automation state machine ─────────────────────────────────────

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

function createAutoState(): AutoState {
  return {
    enabled: false,
    phase: 'idle',
    iteration: 0,
    maxIterations: 10,
    checkFailures: 0,
    lastCheckOutput: '',
    repoPath: null,
    goal: null,
  }
}

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
  } catch { /* no package.json */ }
  if (checks.length === 0) {
    try { readFileSync(join(repoPath, 'Cargo.toml'), 'utf8'); checks.push('cargo check', 'cargo test') } catch { /* no Cargo.toml */ }
  }
  if (checks.length === 0) {
    try { readFileSync(join(repoPath, 'Makefile'), 'utf8'); checks.push('make test') } catch { /* no Makefile */ }
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
    .filter((c: { type: string; text?: string }) => c.type === 'text' && c.text)
    .map((c: { type: string; text?: string }) => c.text)
    .join('\n')
}

export default function foremanExtension(pi: ExtensionAPI) {
  const auto = createAutoState()

  // ── Tool: foreman_status ─────────────────────────────────────────

  pi.registerTool({
    name: 'foreman_status',
    label: 'Foreman: Session Status',
    description: 'Show the current session portfolio across all managed repos. Shows branches, CI status, PRs, blockers, and priorities.',
    promptSnippet: 'foreman_status — show all active sessions across repos with CI status',
    parameters: Type.Object({}),

    async execute(_id, _params, _signal, onUpdate) {
      const state = loadState();
      const text = formatSessions(state);
      const lastHeartbeat = state?.lastHeartbeatAt ? `Last heartbeat: ${state.lastHeartbeatAt}` : '';
      const result = [text, '', lastHeartbeat].filter(Boolean).join('\n');
      onUpdate?.({ content: [{ type: 'text', text: result }] });
      return { content: [{ type: 'text', text: result }] };
    },
  });

  // ── Tool: foreman_resume ─────────────────────────────────────────

  pi.registerTool({
    name: 'foreman_resume',
    label: 'Foreman: Resume Session',
    description: 'Resume a discovered session by ID (repo:branch format) or partial match. Spawns a Claude session with Foreman-generated CLAUDE.md context.',
    promptSnippet: 'foreman_resume — resume a session with full Foreman context',
    parameters: Type.Object({
      sessionId: Type.String({ description: 'Session ID (repo/branch) or partial match' }),
      goal: Type.Optional(Type.String({ description: 'Override the session goal' })),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const { sessionId, goal } = params as { sessionId: string; goal?: string };
      onUpdate?.({ content: [{ type: 'text', text: `Resuming session: ${sessionId}...` }] });
      const goalFlag = goal ? `--goal ${JSON.stringify(goal)}` : '';
      const output = run(
        `npx tsx packages/surfaces/src/operator-cli.ts --resume ${JSON.stringify(sessionId)} ${goalFlag} -v`,
        5 * 60_000,
      );
      return { content: [{ type: 'text', text: output }] };
    },
  });

  // ── Tool: foreman_harden ─────────────────────────────────────────

  pi.registerTool({
    name: 'foreman_harden',
    label: 'Foreman: Harden Task',
    description: 'Expand a vague goal into an executable task envelope. Reads repo CI config, package manifests, and product docs to infer success criteria and check commands.',
    promptSnippet: 'foreman_harden — expand goal into task with checks and criteria',
    parameters: Type.Object({
      goal: Type.String({ description: 'The goal to harden' }),
      repoPath: Type.String({ description: 'Absolute path to the repo' }),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const { goal, repoPath } = params as { goal: string; repoPath: string };
      onUpdate?.({ content: [{ type: 'text', text: `Hardening: ${goal.slice(0, 80)}...` }] });
      const escaped = JSON.stringify({ goal, repoPath });
      const output = run(
        `npx tsx -e "
import('./packages/surfaces/src/engineering-tools.ts').then(async ({ hardenTask }) => {
  const { createClaudeProvider } = await import('./packages/providers/src/index.ts');
  const opts = ${escaped};
  const r = await hardenTask({ ...opts, provider: createClaudeProvider() });
  console.log(JSON.stringify(r, null, 2));
});
"`,
        2 * 60_000,
      );
      return { content: [{ type: 'text', text: output }] };
    },
  });

  // ── Tool: foreman_validate ───────────────────────────────────────

  pi.registerTool({
    name: 'foreman_validate',
    label: 'Foreman: Validate Work',
    description: 'Run the full validation pipeline: deterministic checks from CI config, then LLM review. Returns pass/warn/fail with specific findings.',
    promptSnippet: 'foreman_validate — run CI checks + LLM review on current repo',
    parameters: Type.Object({
      repoPath: Type.String({ description: 'Absolute path to the repo' }),
      goal: Type.String({ description: 'What was being implemented' }),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const { repoPath, goal } = params as { repoPath: string; goal: string };
      onUpdate?.({ content: [{ type: 'text', text: 'Running validation pipeline...' }] });
      const output = run(
        `npx tsx packages/surfaces/src/cli.ts --repo ${JSON.stringify(repoPath)} --goal ${JSON.stringify(goal)} --max-rounds 1`,
        10 * 60_000,
      );
      try {
        const parsed = JSON.parse(output);
        const v = parsed.validation;
        if (v) {
          const findings = (v.findings ?? []).map((f: Record<string, string>) => `- [${f.severity}] ${f.title}`).join('\n');
          const text = `**${v.status}** | ${v.recommendation}\n${v.summary}\n${findings}`;
          return { content: [{ type: 'text', text }], details: v };
        }
      } catch { /* not JSON */ }
      return { content: [{ type: 'text', text: output.slice(0, 2000) }] };
    },
  });

  // ── Tool: foreman_insights ───────────────────────────────────────

  pi.registerTool({
    name: 'foreman_insights',
    label: 'Foreman: Session Insights',
    description: 'Analyze recent Claude/Codex session patterns across repos. Shows recurring commands, key files, cross-repo themes, and suggested CLAUDE.md rules.',
    promptSnippet: 'foreman_insights — analyze session patterns for workflow improvements',
    parameters: Type.Object({
      repoPaths: Type.Array(Type.String(), { description: 'Repos to analyze' }),
      hoursBack: Type.Optional(Type.Number({ description: 'Hours to look back (default 72)' })),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const { repoPaths, hoursBack } = params as { repoPaths: string[]; hoursBack?: number };
      onUpdate?.({ content: [{ type: 'text', text: 'Analyzing sessions...' }] });
      const escaped = JSON.stringify({ repoPaths, hoursBack: hoursBack ?? 72 });
      const output = run(
        `npx tsx -e "
import('./packages/surfaces/src/session-insights.ts').then(async ({ extractDeepSessionInsights }) => {
  const opts = ${escaped};
  const r = await extractDeepSessionInsights(opts);
  console.log(JSON.stringify(r, null, 2));
});
"`,
        60_000,
      );
      return { content: [{ type: 'text', text: output }] };
    },
  });

  // ── Tool: foreman_memory ─────────────────────────────────────────

  pi.registerTool({
    name: 'foreman_memory',
    label: 'Foreman: Read Memory',
    description: 'Read what Foreman knows about a repo — environment facts, CI requirements, worker performance, repair recipes.',
    promptSnippet: 'foreman_memory — read what Foreman remembers about a repo',
    parameters: Type.Object({
      repoPath: Type.String({ description: 'Absolute path to the repo' }),
    }),

    async execute(_id, params) {
      const { repoPath } = params as { repoPath: string };
      const memDir = join(repoPath, '.foreman', 'memory');
      if (!existsSync(memDir)) {
        return { content: [{ type: 'text', text: `No Foreman memory at ${memDir}` }] };
      }
      const parts: string[] = [];
      for (const type of ['environment', 'worker', 'strategy', 'profile']) {
        const typeDir = join(memDir, type);
        try {
          for (const file of readdirSync(typeDir)) {
            if (!file.endsWith('.json')) continue;
            try {
              const data = readFileSync(join(typeDir, file), 'utf8');
              parts.push(`### ${type}/${file}\n\`\`\`json\n${data.trim()}\n\`\`\``);
            } catch { continue; }
          }
        } catch { continue; }
      }
      const text = parts.length > 0 ? parts.join('\n\n') : 'Memory exists but is empty.';
      return { content: [{ type: 'text', text }] };
    },
  });

  // ── Command: /foreman ────────────────────────────────────────────

  pi.registerCommand('foreman', {
    description: 'Show Foreman session portfolio',
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatSessions(loadState()), 'info');
    },
  });

  // ── Command: /heartbeat ──────────────────────────────────────────

  pi.registerCommand('heartbeat', {
    description: 'Run Foreman heartbeat scan now',
    handler: async (_args, ctx) => {
      ctx.ui.notify('Running heartbeat...', 'info');
      const output = run(
        'npx tsx packages/surfaces/src/operator-cli.ts --heartbeat --dry-run -v',
        60_000,
      );
      ctx.ui.notify(output.slice(0, 1000), 'info');
    },
  });

  // ── Flag: --foreman-auto ────────────────────────────────────────

  pi.registerFlag('foreman-auto', {
    description: 'Enable autonomous check→fix→review→ship loop',
    type: 'boolean',
    default: false,
  })

  // ── Command: /auto ─────────────────────────────────────────────

  pi.registerCommand('auto', {
    description: 'Toggle autonomous foreman loop (check → fix → review → ship)',
    handler: async (args, ctx) => {
      if (args.trim() === 'off') {
        auto.enabled = false
        auto.phase = 'idle'
        auto.iteration = 0
        ctx.ui.notify('[Foreman] Auto mode OFF', 'info')
        return
      }
      auto.enabled = !auto.enabled
      if (auto.enabled) {
        auto.repoPath = ctx.cwd
        auto.iteration = 0
        auto.phase = 'implementing'
        auto.checkFailures = 0
        if (args.trim()) auto.goal = args.trim()
        ctx.ui.notify(`[Foreman] Auto mode ON — repo: ${ctx.cwd}, max ${auto.maxIterations} iterations`, 'info')
      } else {
        auto.phase = 'idle'
        ctx.ui.notify('[Foreman] Auto mode OFF', 'info')
      }
    },
  })

  // ── Watchdog: mid-session stuck detection ───────────────────────

  const watchdog = createWatchdogState()

  function updateWatchdogActivity() {
    watchdog.lastActivityTs = Date.now()
    watchdog.consecutiveNudges = 0
  }

  pi.on('turn_end', async () => { updateWatchdogActivity() })
  pi.on('tool_execution_end', async () => { updateWatchdogActivity() })
  pi.on('message_end', async () => { updateWatchdogActivity() })

  pi.on('session_start', async (_event, ctx) => {
    updateWatchdogActivity()
    if (watchdog.timer) clearInterval(watchdog.timer)

    watchdog.timer = setInterval(async () => {
      if (!watchdog.enabled || ctx.isIdle()) return
      const elapsed = Date.now() - watchdog.lastActivityTs
      if (elapsed < watchdog.stuckThresholdMs) return
      if (watchdog.judgeInProgress) return

      watchdog.judgeInProgress = true
      try {
        if (watchdog.consecutiveNudges >= watchdog.maxNudges) {
          ctx.abort()
          pi.sendUserMessage(
            '[Watchdog] Agent appears stuck after ' + watchdog.maxNudges +
            ' nudge attempts. Operation cancelled. Please review and decide how to proceed.',
            { deliverAs: 'followUp' },
          )
          watchdog.enabled = false
          ctx.ui.setStatus('watchdog', '[watchdog] stopped — max nudges reached')
          return
        }

        ctx.abort()
        watchdog.consecutiveNudges++
        watchdog.lastActivityTs = Date.now()
        watchdog.lastNudgeTs = Date.now()
        ctx.ui.setStatus('watchdog', `[watchdog] nudge ${watchdog.consecutiveNudges}/${watchdog.maxNudges}`)

        pi.sendUserMessage(
          `[Watchdog] No progress detected for ${Math.round(elapsed / 1000)}s. ` +
          'The blocked operation was cancelled. Try a different approach — ' +
          'if a tool call is hanging, skip it. If stuck in a loop, break out and try an alternative.',
          { deliverAs: 'followUp' },
        )
      } catch { /* swallow — watchdog should never crash the session */ }
      finally { watchdog.judgeInProgress = false }
    }, watchdog.checkIntervalMs)
  })

  pi.on('session_shutdown', async () => {
    if (watchdog.timer) {
      clearInterval(watchdog.timer)
      watchdog.timer = null
    }
  })

  // ── Command: /watchdog ─────────────────────────────────────────

  pi.registerCommand('watchdog', {
    description: 'Toggle watchdog stuck detection (on/off)',
    handler: async (args, ctx) => {
      if (args.trim() === 'off') {
        watchdog.enabled = false
        ctx.ui.setStatus('watchdog', undefined)
        ctx.ui.notify('[Watchdog] Disabled', 'info')
      } else {
        watchdog.enabled = true
        watchdog.consecutiveNudges = 0
        watchdog.lastActivityTs = Date.now()
        ctx.ui.setStatus('watchdog', '[watchdog] active')
        ctx.ui.notify('[Watchdog] Enabled — will nudge after 2min inactivity', 'info')
      }
    },
  })

  // ── Agent end: autonomous loop ─────────────────────────────────

  pi.on('agent_end', async (event, ctx) => {
    // Skip auto-loop if agent just restarted from a watchdog nudge
    if (Date.now() - watchdog.lastNudgeTs < 5000) return

    if (!auto.enabled) {
      // Check CLI flag on first agent_end
      if (pi.getFlag('foreman-auto') === true) {
        auto.enabled = true
        auto.repoPath = ctx.cwd
        auto.phase = 'implementing'
      }
      if (!auto.enabled) return
    }

    auto.iteration++
    if (auto.iteration > auto.maxIterations) {
      ctx.ui.notify(`[Foreman] Max iterations (${auto.maxIterations}) reached. Stopping auto mode.`, 'warning')
      auto.enabled = false
      auto.phase = 'idle'
      return
    }

    const messages = event.messages ?? []
    const lastMsg = messages[messages.length - 1]
    if (!lastMsg) return

    const lastText = extractTextFromMessage(lastMsg as { content?: Array<{ type: string; text?: string }> })

    // If agent asked a question, don't auto-continue
    if (looksLikeQuestion(lastText)) {
      ctx.ui.setStatus('foreman', `[auto] paused — agent asked a question (iter ${auto.iteration})`)
      return
    }

    const repoPath = auto.repoPath ?? ctx.cwd

    // Phase: agent just finished implementing or fixing → run checks
    if (auto.phase === 'implementing' || auto.phase === 'fixing') {
      auto.phase = 'checking'
      ctx.ui.setStatus('foreman', `[auto] running checks (iter ${auto.iteration})...`)

      const checks = detectChecks(repoPath)
      if (checks.length === 0) {
        ctx.ui.setStatus('foreman', `[auto] no checks detected — skipping to review`)
        auto.phase = 'reviewing'
        pi.sendUserMessage(
          'All implementation looks complete. Run /verify or /critical-audit to review the changes, then create a PR if everything passes.',
          { deliverAs: 'followUp' },
        )
        return
      }

      const results: Array<{ cmd: string; ok: boolean; output: string }> = []
      for (const cmd of checks) {
        try {
          const result = await pi.exec('bash', ['-c', cmd], { cwd: repoPath, timeout: 120_000 })
          results.push({ cmd, ok: result.code === 0, output: (result.stdout + '\n' + result.stderr).trim() })
        } catch (e) {
          results.push({ cmd, ok: false, output: String(e) })
        }
      }

      const allPassed = results.every((r) => r.ok)
      const summary = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.cmd}${r.ok ? '' : '\n' + r.output.slice(-500)}`).join('\n\n')

      if (allPassed) {
        ctx.ui.setStatus('foreman', `[auto] checks passed — reviewing (iter ${auto.iteration})`)
        auto.phase = 'reviewing'
        auto.checkFailures = 0
        pi.sendUserMessage(
          `All checks passed:\n\`\`\`\n${summary}\n\`\`\`\n\nReview the changes for correctness and quality. If everything looks good, commit, push, and create a PR.`,
          { deliverAs: 'followUp' },
        )
      } else {
        auto.checkFailures++
        if (auto.checkFailures > 3) {
          ctx.ui.notify(`[Foreman] 3 consecutive check failures. Stopping auto mode.`, 'warning')
          auto.enabled = false
          auto.phase = 'idle'
          return
        }
        ctx.ui.setStatus('foreman', `[auto] checks failed (${auto.checkFailures}/3) — fixing (iter ${auto.iteration})`)
        auto.phase = 'fixing'
        auto.lastCheckOutput = summary
        pi.sendUserMessage(
          `Checks failed:\n\`\`\`\n${summary}\n\`\`\`\n\nFix the failures. Do not skip or disable any checks.`,
          { deliverAs: 'followUp' },
        )
      }
      return
    }

    // Phase: agent finished review → check if it shipped
    if (auto.phase === 'reviewing' || auto.phase === 'shipping') {
      auto.phase = 'shipping'
      // Check if a PR was created or push happened
      try {
        const gitResult = await pi.exec('git', ['status', '--porcelain'], { cwd: repoPath, timeout: 10_000 })
        if (gitResult.stdout.trim() === '') {
          // Clean working tree — likely committed and pushed
          ctx.ui.setStatus('foreman', `[auto] complete (iter ${auto.iteration})`)
          ctx.ui.notify(`[Foreman] Auto loop complete after ${auto.iteration} iterations.`, 'info')
          auto.enabled = false
          auto.phase = 'idle'
          return
        }
      } catch { /* ignore */ }

      // Still has uncommitted changes — nudge
      pi.sendUserMessage(
        'There are still uncommitted changes. Commit, push to a branch, and create a PR to complete the task.',
        { deliverAs: 'followUp' },
      )
      return
    }
  })

  // ── Memory nudge: post-session learning ─────────────────────────

  pi.on('agent_end', async (event, ctx) => {
    // This runs AFTER the auto-loop check (separate handler)
    // Analyze the session for learnable patterns
    const messages = event.messages ?? []
    if (messages.length < 4) return // too short to learn from

    // Extract what happened
    const userMsgs: string[] = []
    const toolNames = new Set<string>()
    let hasError = false

    for (const msg of messages) {
      const m = msg as { role?: string; content?: unknown }
      if (m.role === 'user' && typeof m.content === 'string') {
        userMsgs.push(m.content.slice(0, 200))
      }
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const block of m.content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            toolNames.add(block.name)
          }
        }
      }
      if (m.role === 'tool_result') {
        const tr = m as { content?: unknown; is_error?: boolean }
        if (tr.is_error) hasError = true
      }
    }

    // Nudge conditions:
    // 1. Complex session (5+ tool calls) — may have discovered a pattern
    // 2. Error recovery — fixed something, worth remembering the fix
    // 3. User correction — "no not that, do X instead"
    const isComplex = toolNames.size >= 5
    const hadCorrection = userMsgs.some((m) => {
      const lower = m.toLowerCase()
      return lower.includes('no ') || lower.includes('not that') ||
        lower.includes('instead') || lower.includes('wrong') ||
        lower.includes('don\'t') || lower.includes('stop')
    })

    if ((isComplex || (hasError && messages.length > 6) || hadCorrection) && ctx.hasUI) {
      const nudgeMsg = isComplex
        ? `[Foreman] Complex session (${toolNames.size} tools, ${messages.length} messages). Any patterns or fixes worth remembering for next time?`
        : hadCorrection
          ? `[Foreman] Noted a correction in this session. Should I save this preference for future sessions?`
          : `[Foreman] Session involved error recovery. Should I save the fix as a repair recipe?`

      ctx.ui.setStatus('foreman-nudge', nudgeMsg)
      // Auto-clear after 30s
      setTimeout(() => ctx.ui.setStatus('foreman-nudge', undefined), 30_000)
    }
  })

  // ── Compaction hook: save context before compression ────────────

  pi.on('session_before_compact', async (_event, ctx) => {
    // Before Pi compresses context, save key findings to Foreman memory
    try {
      const entries = ctx.sessionManager.getBranch?.() ?? []
      const recentUser: string[] = []
      const recentTools: string[] = []

      for (const entry of (entries as Array<Record<string, unknown>>).slice(-20)) {
        if (entry.type !== 'message' || !entry.message) continue
        const msg = entry.message as Record<string, unknown>
        if (msg.role === 'user' && typeof msg.content === 'string') {
          recentUser.push(msg.content.slice(0, 200))
        }
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          for (const b of msg.content as Array<Record<string, unknown>>) {
            if (b.type === 'tool_use' && typeof b.name === 'string') {
              recentTools.push(b.name as string)
            }
          }
        }
      }

      // Persist a compaction snapshot for learning
      const snapshotPath = join(FOREMAN_HOME, 'traces', 'compactions')
      const { mkdirSync, writeFileSync } = await import('node:fs')
      try { mkdirSync(snapshotPath, { recursive: true }) } catch {}
      writeFileSync(
        join(snapshotPath, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
        JSON.stringify({
          cwd: ctx.cwd,
          timestamp: new Date().toISOString(),
          recentUserMessages: recentUser.slice(-5),
          recentTools: [...new Set(recentTools)],
          contextTokens: ctx.getContextUsage?.()?.tokens,
        }, null, 2) + '\n',
      )
    } catch { /* non-fatal */ }
  })

  pi.on('session_compact', async (_event, ctx) => {
    // After compaction, inject Foreman context so it's not lost
    const lines: string[] = []

    // Inject operator profile
    try {
      const profilePath = join(FOREMAN_HOME, 'memory', 'user', 'operator.json')
      const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
      if (profile.operatorPatterns?.length) {
        lines.push(`[Foreman post-compact] Operator: ${profile.operatorPatterns.join('. ')}.`)
      }
    } catch {}

    // Inject repo environment facts
    try {
      const repo = ctx.cwd.split('/').pop() ?? ''
      const envPath = join(FOREMAN_HOME, 'memory', 'environment', `${repo}.json`)
      const env = JSON.parse(readFileSync(envPath, 'utf8'))
      if (env.facts?.length) {
        lines.push(`[Foreman post-compact] Repo facts: ${env.facts.join('. ')}.`)
      }
    } catch {}

    if (lines.length > 0) {
      pi.sendMessage({
        customType: 'foreman-post-compact',
        content: lines.join('\n'),
        display: false,
      })
    }
  })

  // ── Command: /qmd ──────────────────────────────────────────────

  pi.registerCommand('qmd', {
    description: 'Generate and show Foreman CLAUDE.md context for current repo',
    handler: async (_args, ctx) => {
      ctx.ui.notify('Generating CLAUDE.md context...', 'info')
      const output = run(
        `node --import tsx packages/surfaces/src/run.ts --repo ${JSON.stringify(ctx.cwd)} --goal "show context only" --dry-run 2>&1 || npx tsx -e "
import { generateClaudeMd } from './packages/surfaces/src/operator-loop.js'
const result = await generateClaudeMd({
  repoPath: ${JSON.stringify(ctx.cwd)},
  session: { id: 'qmd', repoPath: ${JSON.stringify(ctx.cwd)}, branch: 'current', goal: 'generate context', status: 'active', provider: 'claude', priority: 10 },
})
console.log(result)
"`,
        30_000,
      )
      ctx.ui.notify(output.slice(0, 2000), 'info')
    },
  })

  // ── Inject context on session start ──────────────────────────────

  pi.on('before_agent_start', async (event, ctx) => {
    const state = loadState()
    const lines: string[] = []

    if (state) {
      const sessions = (state.sessions ?? []) as Array<Record<string, unknown>>
      const blocked = sessions.filter((s) => s.status === 'blocked')
      const active = sessions.filter((s) => s.status === 'active')
      if (blocked.length > 0 || active.length > 0) {
        lines.push(`[Foreman] ${sessions.length} sessions tracked.${blocked.length > 0 ? ` ⚠ ${blocked.length} blocked.` : ''} ${active.length > 0 ? `${active.length} active.` : ''}`)
      }
    }

    // Suggest relevant skills based on the user's prompt
    const prompt = event.prompt?.toLowerCase() ?? ''
    const skillSuggestions: string[] = []

    if (prompt.includes('fix') || prompt.includes('ci') || prompt.includes('failing') || prompt.includes('broken')) {
      skillSuggestions.push('/converge (iterative CI fix)', '/diagnose (root cause)')
    }
    if (prompt.includes('improve') || prompt.includes('better') || prompt.includes('optimize') || prompt.includes('evolve')) {
      skillSuggestions.push('/evolve (measure→experiment→verify loop)', '/pursue (multi-stream orchestration)')
    }
    if (prompt.includes('review') || prompt.includes('audit') || prompt.includes('quality')) {
      skillSuggestions.push('/critical-audit (parallel reviewers)', '/polish (relentless quality loop)')
    }
    if (prompt.includes('ship') || prompt.includes('deploy') || prompt.includes('push') || prompt.includes('pr')) {
      skillSuggestions.push('/verify (completion check)', '/code-review')
    }
    if (prompt.includes('research') || prompt.includes('investigate') || prompt.includes('explore')) {
      skillSuggestions.push('/research (hypothesis→experiment loop)')
    }

    if (skillSuggestions.length > 0) {
      lines.push(`[Foreman] Relevant skills: ${skillSuggestions.join(', ')}`)
    }

    // Load operator profile for context
    try {
      const profilePath = join(FOREMAN_HOME, 'memory', 'user', 'operator.json')
      const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
      if (profile.operatorPatterns?.length) {
        lines.push(`[Foreman] Operator: ${profile.operatorPatterns.slice(0, 3).join('. ')}.`)
      }
    } catch { /* no profile */ }

    if (lines.length > 0) {
      pi.sendMessage({
        customType: 'foreman-context',
        content: lines.join('\n'),
        display: false,
      })
    }
  });
}
