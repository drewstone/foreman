/**
 * State snapshot builder.
 *
 * Aggregates all Foreman state into a single context object
 * that the policy LLM can reason about.
 *
 * Primary data source: session index (172K messages, instant SQLite).
 * Secondary: cost monitor, operator memory, skill performance.
 * Fallback: session registry (spawns providers, slow).
 */

import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { checkCosts } from './cost-monitor.js'
import { getActiveProfile } from './user-profiles.js'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export interface ProjectState {
  path: string
  name: string
  activeBranches: string[]
  lastSessionAt: string | null
  ciStatus: 'passing' | 'failing' | 'unknown'
  momentum: 'active' | 'stalled' | 'blocked'
  recentGoals: string[]
  activeSessions: number
  totalSessions: number
  harnesses: string[]
}

export interface ForemanEvent {
  type: 'session-started' | 'session-ended' | 'ci-status-changed' | 'git-push'
      | 'experiment-completed' | 'operator-message' | 'webhook' | 'timer'
      | 'file-changed' | 'approval-received' | 'rejection-received'
  project: string
  timestamp: string
  data: Record<string, string>
}

export interface BudgetState {
  dailyBudgetUsd: number
  spentTodayUsd: number
  utilizationPct: number
  overBudget: boolean
}

export interface ForemanState {
  timestamp: string
  activeProjects: ProjectState[]
  recentEvents: ForemanEvent[]
  operatorPatterns: string[]
  skillPerformance: Array<{ skill: string; invocations: number; successRate: number }>
  confidenceScores: Array<{ actionType: string; project: string; score: number; level: string }>
  budget: BudgetState
  profileName: string | null
  totalActiveSessions: number
  totalManagedProjects: number
  sessionIndexStats: { totalMessages: number; totalSessions: number } | null
  activeTmuxSessions: string[]
}

export interface BuildStateSnapshotOptions {
  confidenceScores?: Array<{ actionType: string; project: string; score: number; level: string }>
  recentEvents?: ForemanEvent[]
  watchedDirs?: string[]
  onlyWatchedDirs?: boolean  // if true, skip session index — only show watchedDirs
}

export async function buildStateSnapshot(
  options?: BuildStateSnapshotOptions,
): Promise<ForemanState> {
  const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])

  // Primary: session index (instant SQLite queries) + secondary async loads
  // All in parallel
  const [indexData, costs, profile, operatorPatterns, skillPerformance] = await Promise.all([
    loadSessionIndexData(),
    withTimeout(checkCosts({ hoursBack: 24 }).catch(() => null), 10_000, null),
    withTimeout(getActiveProfile().catch(() => null), 5_000, null),
    loadOperatorPatterns(),
    loadSkillPerformance(),
  ])

  // Build project states
  const activeProjects: ProjectState[] = []

  // If onlyWatchedDirs, skip session index projects entirely
  if (!options?.onlyWatchedDirs) for (const [repo, data] of indexData.projects) {
    // Resolve path from repo name
    const path = resolveRepoPath(repo)

    // Determine momentum from recency
    const hoursSinceLastSession = data.newestTimestamp
      ? (Date.now() - new Date(data.newestTimestamp).getTime()) / (1000 * 60 * 60)
      : Infinity

    const momentum: ProjectState['momentum'] =
      hoursSinceLastSession < 2 ? 'active'
      : hoursSinceLastSession < 48 ? 'stalled'
      : 'blocked'

    activeProjects.push({
      path,
      name: repo,
      activeBranches: [],
      lastSessionAt: data.newestTimestamp,
      ciStatus: 'unknown',
      momentum,
      recentGoals: data.recentGoals,
      activeSessions: momentum === 'active' ? 1 : 0,
      totalSessions: data.sessionCount,
      harnesses: data.harnesses,
    })
  }

  // Check which projects have active tmux sessions
  const activeTmuxSessions = new Set<string>()
  try {
    const { status: scStatus } = await import('./session-controller.js')
    for (const s of scStatus()) {
      if (s.alive) activeTmuxSessions.add(s.name)
    }
  } catch { /* session controller may not be available */ }

  // Add projects from watched git dirs that aren't in session index yet
  if (options?.watchedDirs) {
    for (const dir of options.watchedDirs) {
      const name = dir.split('/').pop() ?? dir
      if (!activeProjects.some((p) => p.name === name)) {
        activeProjects.push({
          path: dir,
          name,
          activeBranches: [],
          lastSessionAt: null,
          ciStatus: 'unknown',
          momentum: 'active', // new projects are active by definition
          recentGoals: ['New project — needs initial exploration and setup'],
          activeSessions: 0,
          totalSessions: 0,
          harnesses: [],
        })
      }
    }
  }

  // Enrich with git/CI data (best effort, 15s timeout)
  await withTimeout(enrichProjectsWithGit(activeProjects), 15_000, undefined)

  // Sort: active first, then by recency
  activeProjects.sort((a, b) => {
    if (a.momentum === 'active' && b.momentum !== 'active') return -1
    if (b.momentum === 'active' && a.momentum !== 'active') return 1
    const aTime = a.lastSessionAt ?? ''
    const bTime = b.lastSessionAt ?? ''
    return bTime.localeCompare(aTime)
  })

  const budget: BudgetState = costs
    ? {
        dailyBudgetUsd: costs.budget.dailyUsd,
        spentTodayUsd: costs.totalCostUsd,
        utilizationPct: costs.utilizationPct,
        overBudget: costs.overBudget,
      }
    : { dailyBudgetUsd: 0, spentTodayUsd: 0, utilizationPct: 0, overBudget: false }

  const totalActiveSessions = activeProjects.filter((p) => p.momentum === 'active').length

  return {
    timestamp: new Date().toISOString(),
    activeProjects,
    recentEvents: options?.recentEvents ?? [],
    operatorPatterns,
    skillPerformance,
    confidenceScores: options?.confidenceScores ?? [],
    budget,
    profileName: profile?.name ?? null,
    totalActiveSessions,
    totalManagedProjects: activeProjects.length,
    sessionIndexStats: indexData.stats,
    activeTmuxSessions: [...activeTmuxSessions],
  }
}

// ─── Session Index queries (instant, synchronous SQLite) ────────────

interface ProjectData {
  sessionCount: number
  messageCount: number
  newestTimestamp: string | null
  harnesses: string[]
  recentGoals: string[]
}

interface IndexData {
  projects: Map<string, ProjectData>
  stats: { totalMessages: number; totalSessions: number } | null
}

async function loadSessionIndexData(): Promise<IndexData> {
  try {
    const { SessionIndex } = await import('@drew/foreman-memory/session-index')
    const idx = new SessionIndex()

    const stats = idx.stats()

    // Get per-repo data
    const projects = new Map<string, ProjectData>()

    // Get per-repo harnesses and newest timestamps via a single query
    const repoDetails = new Map<string, { harnesses: Set<string>; newest: string | null }>()
    try {
      const rows = idx.search({ query: 'the', limit: 200, hoursBack: 168 })
      for (const r of rows) {
        const rRepo = r.message.repo
        if (!rRepo) continue
        const d = repoDetails.get(rRepo) ?? { harnesses: new Set(), newest: null }
        d.harnesses.add(r.message.harness)
        if (!d.newest || r.message.timestamp > d.newest) d.newest = r.message.timestamp
        repoDetails.set(rRepo, d)
      }
    } catch { /* FTS may fail */ }

    for (const [repo, count] of Object.entries(stats.byRepo as Record<string, number>)) {
      if (!repo || repo.length < 2) continue

      const details = repoDetails.get(repo)
      const sessionCount = Math.max(1, Math.ceil(count / 75))

      projects.set(repo, {
        sessionCount,
        messageCount: count,
        newestTimestamp: details?.newest ?? null,
        harnesses: details ? [...details.harnesses] : [],
        recentGoals: [], // populated later if needed
      })
    }

    idx.close()

    return {
      projects,
      stats: { totalMessages: stats.totalMessages, totalSessions: stats.totalSessions },
    }
  } catch {
    return { projects: new Map(), stats: null }
  }
}

function resolveRepoPath(repo: string): string {
  // Try common locations
  const candidates = [
    join(homedir(), 'code', repo),
    join(homedir(), 'projects', repo),
    join(homedir(), repo),
  ]
  for (const p of candidates) {
    try {
      if (statSync(p).isDirectory()) return p
    } catch { /* not found */ }
  }
  return join(homedir(), 'code', repo) // best guess
}

// ─── Git/CI enrichment ──────────────────────────────────────────────

async function enrichProjectsWithGit(projects: ProjectState[]): Promise<void> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)

  await Promise.all(projects.slice(0, 10).map(async (project) => {
    const cwd = project.path
    try {
      // Current branch
      const { stdout: branch } = await exec('git', ['branch', '--show-current'], { cwd, timeout: 5000 })
      if (branch.trim()) {
        project.activeBranches = [branch.trim()]
      }

      // Recent branches (last 5 active)
      try {
        const { stdout: refs } = await exec('git', ['for-each-ref', '--sort=-committerdate', '--count=5', '--format=%(refname:short)', 'refs/heads/'], { cwd, timeout: 5000 })
        const branches = refs.trim().split('\n').filter(Boolean)
        if (branches.length > 0) {
          project.activeBranches = branches
        }
      } catch { /* git for-each-ref may fail */ }

      // CI status via gh
      try {
        const { stdout: prJson } = await exec('gh', ['pr', 'list', '--json', 'statusCheckRollup,headRefName', '--limit', '1'], { cwd, timeout: 10000 })
        const prs = JSON.parse(prJson)
        if (prs.length > 0 && prs[0].statusCheckRollup) {
          const checks = prs[0].statusCheckRollup as Array<{ conclusion?: string; status?: string }>
          const failing = checks.some((c) => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR')
          const pending = checks.some((c) => c.status === 'IN_PROGRESS' || c.status === 'QUEUED')
          project.ciStatus = failing ? 'failing' : pending ? 'unknown' : 'passing'
        }
      } catch { /* gh not available or no PRs */ }
    } catch {
      // Not a git repo or git not available
    }
  }))
}

// ─── File-based state loaders ───────────────────────────────────────

async function loadOperatorPatterns(): Promise<string[]> {
  try {
    const raw = await readFile(join(FOREMAN_HOME, 'memory', 'user', 'operator.json'), 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data.operatorPatterns) ? data.operatorPatterns : []
  } catch {
    return []
  }
}

async function loadSkillPerformance(): Promise<Array<{ skill: string; invocations: number; successRate: number }>> {
  try {
    const raw = await readFile(join(FOREMAN_HOME, 'memory', 'skills', 'performance.json'), 'utf8')
    const data = JSON.parse(raw)
    if (!Array.isArray(data.skills)) return []
    return data.skills.map((s: Record<string, unknown>) => ({
      skill: String(s.skillName ?? ''),
      invocations: Number(s.totalInvocations ?? 0),
      successRate: Number(s.overallSuccessRate ?? 0),
    }))
  } catch {
    return []
  }
}

// ─── LLM formatting ────────────────────────────────────────────────

const MAX_OUTPUT_CHARS = 3000

export function formatStateForLLM(state: ForemanState): string {
  const sections: Array<{ key: string; priority: number; content: string }> = []

  // Session index stats
  if (state.sessionIndexStats) {
    sections.push({
      key: 'index',
      priority: 0,
      content: `## Session Index\n\n${state.sessionIndexStats.totalMessages.toLocaleString()} messages across ${state.sessionIndexStats.totalSessions.toLocaleString()} sessions indexed`,
    })
  }

  // Projects — only show actionable ones (autonomous/act-notify) to avoid wasting LLM decisions
  if (state.activeProjects.length > 0) {
    const actionableLevels = new Set(['autonomous', 'act-notify'])
    const actionable = state.activeProjects.filter((p) => {
      const conf = state.confidenceScores.find((c) => c.project === p.name && c.actionType === 'spawn-session')
      return conf && actionableLevels.has(conf.level)
    })
    const other = state.activeProjects.filter((p) => !actionable.includes(p))

    if (actionable.length > 0) {
      const lines = ['## Actionable Projects (you CAN act on these)', '']
      for (const p of actionable) {
        const status = p.momentum === 'active' ? '[ACTIVE]'
          : p.momentum === 'stalled' ? '[STALLED]'
          : '[BLOCKED]'
        const harness = p.harnesses.length > 0 ? ` (${p.harnesses.join(', ')})` : ''
        const branch = p.activeBranches.length > 0 ? ` [${p.activeBranches[0]}]` : ''
        const tmuxName = `foreman-${p.name}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40)
        const tmuxActive = state.activeTmuxSessions.includes(tmuxName) ? ' [SESSION RUNNING]' : ' [NO SESSION]'
        lines.push(`- ${status} **${p.name}** (${p.path})${branch}${tmuxActive} — ${p.totalSessions} sessions, CI: ${p.ciStatus}${harness}`)
        if (p.recentGoals.length > 0) {
          lines.push(`  Recent: ${p.recentGoals[0].slice(0, 120)}`)
        }
      }
      sections.push({ key: 'projects', priority: 1, content: lines.join('\n') })
    }

    if (other.length > 0) {
      sections.push({
        key: 'other-projects',
        priority: 5,
        content: `## Other Projects (${other.length} — read-only, do NOT act on these)`,
      })
    }
  }

  // Budget
  {
    const b = state.budget
    const flag = b.overBudget ? 'OVER BUDGET' : `${b.utilizationPct.toFixed(0)}% used`
    sections.push({
      key: 'budget',
      priority: 2,
      content: `## Budget\n\n$${b.spentTodayUsd.toFixed(2)} / $${b.dailyBudgetUsd.toFixed(2)} daily (${flag})`,
    })
  }

  // Confidence scores
  if (state.confidenceScores.length > 0) {
    const lines = ['## Confidence', '']
    for (const c of state.confidenceScores.slice(0, 10)) {
      lines.push(`- ${c.project}/${c.actionType}: ${c.score.toFixed(2)} (${c.level})`)
    }
    sections.push({ key: 'confidence', priority: 3, content: lines.join('\n') })
  }

  // Recent Events
  if (state.recentEvents.length > 0) {
    const lines = ['## Recent Events', '']
    for (const e of state.recentEvents.slice(0, 8)) {
      lines.push(`- [${e.type}] ${e.project} @ ${e.timestamp}`)
    }
    sections.push({ key: 'events', priority: 4, content: lines.join('\n') })
  }

  // Operator Patterns
  if (state.operatorPatterns.length > 0) {
    const lines = ['## Operator Patterns', '']
    for (const p of state.operatorPatterns.slice(0, 6)) {
      lines.push(`- ${p}`)
    }
    sections.push({ key: 'patterns', priority: 5, content: lines.join('\n') })
  }

  // Skill Performance
  if (state.skillPerformance.length > 0) {
    const lines = ['## Skill Performance', '']
    for (const s of state.skillPerformance.slice(0, 8)) {
      lines.push(`- ${s.skill}: ${s.invocations} invocations, ${(s.successRate * 100).toFixed(0)}% success`)
    }
    sections.push({ key: 'skills', priority: 6, content: lines.join('\n') })
  }

  // Header
  const header = [
    `# Foreman State (${state.timestamp})`,
    `Profile: ${state.profileName ?? 'none'} | Active: ${state.totalActiveSessions} | Projects: ${state.totalManagedProjects}`,
    '',
  ].join('\n')

  // Assemble within budget, truncating low-priority sections first
  let output = header
  const sorted = sections.sort((a, b) => a.priority - b.priority)

  for (const section of sorted) {
    const candidate = output + '\n' + section.content + '\n'
    if (candidate.length <= MAX_OUTPUT_CHARS) {
      output = candidate
    } else if (section.priority <= 2) {
      const remaining = MAX_OUTPUT_CHARS - output.length - 10
      if (remaining > 50) {
        output += '\n' + section.content.slice(0, remaining) + '\n'
      }
      break
    } else {
      break
    }
  }

  return output.trim()
}
