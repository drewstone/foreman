/**
 * Foreman tools and commands for Pi.
 *
 * Thin wrappers that read state files and call Foreman CLI.
 * No heavy computation — just surfaces.
 *
 * Tools: foreman_status, foreman_resume, foreman_harden,
 *        foreman_validate, foreman_insights, foreman_memory
 *
 * Commands: /foreman, /heartbeat, /context
 */

import { Type } from '@mariozechner/pi-ai'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const FOREMAN_DIR = process.env.FOREMAN_DIR ?? join(homedir(), 'code', 'foreman')
const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
const FOREMAN_STATE = join(FOREMAN_HOME, 'operator-state.json')

function run(cmd: string, timeoutMs = 30_000): string {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      cwd: FOREMAN_DIR,
      env: { ...process.env, PATH: process.env.PATH },
    }).trim()
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return err.stdout?.trim() || err.stderr?.trim() || err.message || 'command failed'
  }
}

export function loadState(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(FOREMAN_STATE, 'utf8'))
  } catch {
    return null
  }
}

export function formatSessions(state: Record<string, unknown> | null): string {
  if (!state) return 'No Foreman state found. Run /heartbeat first.'
  const sessions = (state.sessions ?? []) as Array<Record<string, unknown>>
  if (sessions.length === 0) return 'No active sessions discovered.'

  const sorted = [...sessions]
    .filter((s) => s.status !== 'completed')
    .sort((a, b) => (b.priority as number ?? 0) - (a.priority as number ?? 0))

  return sorted.slice(0, 20).map((s, i) => {
    const ci = s.ciStatus ? ` [CI:${s.ciStatus}]` : ''
    const pr = s.prNumber ? ` PR#${s.prNumber}` : ''
    const blocker = s.blockerReason ? ` ⚠ ${s.blockerReason}` : ''
    const repo = String(s.repoPath ?? '').split('/').pop()
    return `${i + 1}. [${s.status}] ${repo}/${s.branch}${pr}${ci}${blocker}\n   ${s.goal}`
  }).join('\n')
}

export function registerForemanTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'foreman_status',
    label: 'Foreman: Session Status',
    description: 'Show the current session portfolio across all managed repos.',
    promptSnippet: 'foreman_status — show all active sessions across repos with CI status',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, onUpdate) {
      const state = loadState()
      const text = formatSessions(state)
      const lastHeartbeat = state?.lastHeartbeatAt ? `Last heartbeat: ${state.lastHeartbeatAt}` : ''
      const result = [text, '', lastHeartbeat].filter(Boolean).join('\n')
      onUpdate?.({ content: [{ type: 'text', text: result }] })
      return { content: [{ type: 'text', text: result }] }
    },
  })

  pi.registerTool({
    name: 'foreman_resume',
    label: 'Foreman: Resume Session',
    description: 'Resume a discovered session by ID. Spawns a Claude session with Foreman context.',
    promptSnippet: 'foreman_resume — resume a session with full Foreman context',
    parameters: Type.Object({
      sessionId: Type.String({ description: 'Session ID (repo/branch) or partial match' }),
      goal: Type.Optional(Type.String({ description: 'Override the session goal' })),
    }),
    async execute(_id, params, _signal, onUpdate) {
      const { sessionId, goal } = params as { sessionId: string; goal?: string }
      onUpdate?.({ content: [{ type: 'text', text: `Resuming session: ${sessionId}...` }] })
      const goalFlag = goal ? `--goal ${JSON.stringify(goal)}` : ''
      const output = run(`npx tsx packages/surfaces/src/operator-cli.ts --resume ${JSON.stringify(sessionId)} ${goalFlag} -v`, 5 * 60_000)
      return { content: [{ type: 'text', text: output }] }
    },
  })

  pi.registerTool({
    name: 'foreman_validate',
    label: 'Foreman: Validate Work',
    description: 'Run CI checks + LLM review. Returns pass/warn/fail with findings.',
    promptSnippet: 'foreman_validate — run CI checks + LLM review on current repo',
    parameters: Type.Object({
      repoPath: Type.String({ description: 'Absolute path to the repo' }),
      goal: Type.String({ description: 'What was being implemented' }),
    }),
    async execute(_id, params, _signal, onUpdate) {
      const { repoPath, goal } = params as { repoPath: string; goal: string }
      onUpdate?.({ content: [{ type: 'text', text: 'Running validation pipeline...' }] })
      const output = run(`npx tsx packages/surfaces/src/cli.ts --repo ${JSON.stringify(repoPath)} --goal ${JSON.stringify(goal)} --max-rounds 1`, 10 * 60_000)
      try {
        const parsed = JSON.parse(output)
        const v = parsed.validation
        if (v) {
          const findings = (v.findings ?? []).map((f: Record<string, string>) => `- [${f.severity}] ${f.title}`).join('\n')
          return { content: [{ type: 'text', text: `**${v.status}** | ${v.recommendation}\n${v.summary}\n${findings}` }], details: v }
        }
      } catch {}
      return { content: [{ type: 'text', text: output.slice(0, 2000) }] }
    },
  })

  pi.registerTool({
    name: 'foreman_memory',
    label: 'Foreman: Read Memory',
    description: 'Read what Foreman knows about a repo — facts, recipes, patterns.',
    promptSnippet: 'foreman_memory — read what Foreman remembers about a repo',
    parameters: Type.Object({
      repoPath: Type.String({ description: 'Absolute path to the repo' }),
    }),
    async execute(_id, params) {
      const { repoPath } = params as { repoPath: string }
      // Check both per-repo and global memory
      const sources = [
        join(repoPath, '.foreman', 'memory'),
        join(FOREMAN_HOME, 'memory'),
      ]
      const parts: string[] = []
      for (const memDir of sources) {
        if (!existsSync(memDir)) continue
        for (const type of ['environment', 'worker', 'strategy', 'profile', 'user']) {
          const typeDir = join(memDir, type)
          try {
            for (const file of readdirSync(typeDir)) {
              if (!file.endsWith('.json')) continue
              try {
                const data = readFileSync(join(typeDir, file), 'utf8')
                parts.push(`### ${type}/${file}\n\`\`\`json\n${data.trim()}\n\`\`\``)
              } catch { continue }
            }
          } catch { continue }
        }
      }
      return { content: [{ type: 'text', text: parts.length > 0 ? parts.join('\n\n') : 'No Foreman memory found.' }] }
    },
  })

  // Commands
  pi.registerCommand('foreman', {
    description: 'Show Foreman session portfolio',
    handler: async (_args, ctx) => { ctx.ui.notify(formatSessions(loadState()), 'info') },
  })

  pi.registerCommand('heartbeat', {
    description: 'Run Foreman heartbeat scan now',
    handler: async (_args, ctx) => {
      ctx.ui.notify('Running heartbeat...', 'info')
      const output = run('npx tsx packages/surfaces/src/operator-cli.ts --heartbeat --max-resumes 1 --min-confidence 0.5 -v', 60_000)
      ctx.ui.notify(output.slice(0, 1000), 'info')
    },
  })

  pi.registerCommand('context', {
    description: 'Show Foreman context for current repo (memory, facts, recipes)',
    handler: async (_args, ctx) => {
      const parts: string[] = []
      const repo = ctx.cwd.split('/').pop() ?? ''

      // Operator profile
      try {
        const profile = JSON.parse(readFileSync(join(FOREMAN_HOME, 'memory', 'user', 'operator.json'), 'utf8'))
        if (profile.operatorPatterns?.length) parts.push(`**Operator:** ${profile.operatorPatterns.join('. ')}`)
      } catch {}

      // Repo facts
      try {
        const env = JSON.parse(readFileSync(join(FOREMAN_HOME, 'memory', 'environment', `${repo}.json`), 'utf8'))
        if (env.facts?.length) parts.push(`**Repo facts:** ${env.facts.join('; ')}`)
      } catch {}

      // Recipes
      try {
        const strategy = JSON.parse(readFileSync(join(ctx.cwd, '.foreman', 'memory', 'strategy', 'engineering.json'), 'utf8'))
        const recipes = (strategy.scoredRecipes ?? []).filter((r: { confidence: number }) => r.confidence >= 0.5)
        if (recipes.length > 0) parts.push(`**Recipes:** ${recipes.map((r: { pattern: string; confidence: number }) => `${r.pattern} (${(r.confidence * 100).toFixed(0)}%)`).join('; ')}`)
      } catch {}

      // Campaigns
      try {
        const campaigns = JSON.parse(readFileSync(join(FOREMAN_HOME, 'campaigns.json'), 'utf8'))
        const active = campaigns.filter((c: { status: string; repos: string[] }) => c.status === 'active' && c.repos.includes(repo))
        if (active.length > 0) parts.push(`**Campaigns:** ${active.map((c: { name: string; progress: number }) => `${c.name} (${(c.progress * 100).toFixed(0)}%)`).join(', ')}`)
      } catch {}

      ctx.ui.notify(parts.length > 0 ? parts.join('\n\n') : `No Foreman context for ${repo}`, 'info')
    },
  })
}
