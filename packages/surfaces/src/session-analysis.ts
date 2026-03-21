/**
 * Deep session analysis — nightly cross-session reverse engineering.
 *
 * Dispatches parallel agent sessions to read full transcripts per repo,
 * extract intent chains, then a merge agent finds cross-cutting themes.
 *
 * This is the heavy-lift version of intent extraction. Runs nightly,
 * not on every heartbeat.
 *
 * Output feeds campaign updates and prediction improvements.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { SessionIndex } from '@drew/foreman-memory/session-index'
import { createClaudeProvider, parseJsonOutput, type TextProvider } from '@drew/foreman-providers'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export interface IntentChain {
  repo: string
  /** Sequence: what → why → toward what */
  chain: Array<{
    action: string
    reason: string
    towardGoal: string
  }>
  /** Semantic tags */
  tags: string[]
  /** Connections to other repos */
  connections: Array<{ repo: string; relationship: string }>
  /** What changed semantically during this period */
  pivots: Array<{ from: string; to: string; trigger: string }>
}

export interface CrossSessionAnalysis {
  timestamp: string
  period: string
  repoAnalyses: IntentChain[]
  /** Themes that span multiple repos */
  crossCuttingThemes: Array<{
    theme: string
    repos: string[]
    evidence: string
  }>
  /** Work that was started but dropped */
  interruptedWork: Array<{
    repo: string
    lastAction: string
    likelyReason: string
    shouldResume: boolean
  }>
  /** Dependencies between repos */
  dependencies: Array<{
    from: string
    to: string
    relationship: string
    blocking: boolean
  }>
  /** Strategic assessment */
  operatorFocus: string
  recommendations: string[]
}

/**
 * Run deep analysis across all sessions from the last N hours.
 * Dispatches per-repo analysis agents in parallel.
 */
export async function analyzeSessionsDeep(options?: {
  hoursBack?: number
  maxRepos?: number
  provider?: TextProvider
  onProgress?: (msg: string) => void
}): Promise<CrossSessionAnalysis> {
  const hoursBack = options?.hoursBack ?? 72
  const maxRepos = options?.maxRepos ?? 8
  const provider = options?.provider ?? createClaudeProvider('session-analyst', { model: 'claude-sonnet-4-6' })
  const log = options?.onProgress ?? (() => {})

  const index = new SessionIndex()
  const repoAnalyses: IntentChain[] = []

  try {
    // Get active repos with enough messages
    const msgs = index.recentUserMessages({ limit: 500, hoursBack })
      .filter((m) => m.content.length > 20 && !m.content.startsWith('<'))

    const repoMsgCount = new Map<string, number>()
    const repoMessages = new Map<string, typeof msgs>()
    for (const m of msgs) {
      if (!m.repo) continue
      repoMsgCount.set(m.repo, (repoMsgCount.get(m.repo) ?? 0) + 1)
      const existing = repoMessages.get(m.repo) ?? []
      existing.push(m)
      repoMessages.set(m.repo, existing)
    }

    // Top repos by activity
    const topRepos = [...repoMsgCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxRepos)
      .map(([repo]) => repo)

    log(`Analyzing ${topRepos.length} repos (${hoursBack}h lookback)...`)

    // Per-repo analysis (could be parallel with Promise.all but sequential is safer for CLI spawning)
    for (const repo of topRepos) {
      const messages = (repoMessages.get(repo) ?? [])
        .map((m) => `[${m.timestamp.slice(0, 16)}] ${m.content.slice(0, 300)}`)
        .slice(0, 30)
        .join('\n')

      const prompt = `Analyze this operator's session in repo "${repo}" over the last ${hoursBack}h. Reverse-engineer their intent.

Session messages:
${messages}

Return ONLY valid JSON:
{
  "chain": [
    { "action": "what they did", "reason": "why", "towardGoal": "the larger objective this serves" }
  ],
  "tags": ["launch", "maintenance", "research", "fix", "feature", "polish", "infrastructure"],
  "connections": [{ "repo": "other-repo", "relationship": "how they're connected" }],
  "pivots": [{ "from": "previous focus", "to": "new focus", "trigger": "what caused the shift" }]
}

Be specific. Trace the INTENT CHAIN: action → reason → larger goal.
A pivot is when the operator semantically shifts what they're working toward.
Only list connections to repos mentioned or clearly implied.`

      try {
        const execution = await provider.run(prompt, { timeoutMs: 30_000 })
        if (execution.exitCode !== 0) continue

        const parsed = parseJsonOutput(execution.stdout) as Partial<IntentChain>
        repoAnalyses.push({
          repo,
          chain: Array.isArray(parsed.chain) ? parsed.chain as IntentChain['chain'] : [],
          tags: Array.isArray(parsed.tags) ? parsed.tags : [],
          connections: Array.isArray(parsed.connections) ? parsed.connections as IntentChain['connections'] : [],
          pivots: Array.isArray(parsed.pivots) ? parsed.pivots as IntentChain['pivots'] : [],
        })

        log(`  ${repo}: ${parsed.chain?.length ?? 0} intent steps, ${parsed.tags?.join(', ') ?? 'no tags'}`)
      } catch { continue }
    }

    // Also get assistant messages for richer context
    const assistantSearch = index.search({ query: 'completed passed merged pushed', role: 'assistant', hoursBack, limit: 20 })
    const completionSignals = assistantSearch
      .map((r) => `[${r.message.repo}] ${r.snippet.slice(0, 100)}`)
      .join('\n')

  } finally {
    index.close()
  }

  // Merge analysis: find cross-cutting themes
  log('Synthesizing cross-session themes...')

  const allRepoDesc = repoAnalyses
    .map((a) => `${a.repo} [${a.tags.join(',')}]: ${a.chain.map((c) => c.towardGoal).join(' → ')}\n  connections: ${a.connections.map((c) => `${c.repo}(${c.relationship})`).join(', ')}\n  pivots: ${a.pivots.map((p) => `${p.from}→${p.to}`).join(', ')}`)
    .join('\n\n')

  let crossAnalysis: Partial<CrossSessionAnalysis> = {}
  try {
    const mergePrompt = `You are synthesizing per-repo session analyses into a cross-session understanding of an operator's work.

Per-repo analyses:
${allRepoDesc}

Return ONLY valid JSON:
{
  "crossCuttingThemes": [
    { "theme": "a theme spanning repos", "repos": ["repo1", "repo2"], "evidence": "why you see this" }
  ],
  "interruptedWork": [
    { "repo": "repo", "lastAction": "what they were doing", "likelyReason": "why they stopped", "shouldResume": true/false }
  ],
  "dependencies": [
    { "from": "repo-a", "to": "repo-b", "relationship": "how", "blocking": true/false }
  ],
  "operatorFocus": "one sentence: what is this person's primary focus right now?",
  "recommendations": ["what should they do next, and why"]
}

Think like a chief of staff who sees all the threads. What's the big picture?`

    const execution = await provider.run(mergePrompt, { timeoutMs: 45_000 })
    if (execution.exitCode === 0) {
      crossAnalysis = parseJsonOutput(execution.stdout) as Partial<CrossSessionAnalysis>
    }
  } catch {}

  const analysis: CrossSessionAnalysis = {
    timestamp: new Date().toISOString(),
    period: `${hoursBack}h`,
    repoAnalyses,
    crossCuttingThemes: Array.isArray(crossAnalysis.crossCuttingThemes) ? crossAnalysis.crossCuttingThemes as CrossSessionAnalysis['crossCuttingThemes'] : [],
    interruptedWork: Array.isArray(crossAnalysis.interruptedWork) ? crossAnalysis.interruptedWork as CrossSessionAnalysis['interruptedWork'] : [],
    dependencies: Array.isArray(crossAnalysis.dependencies) ? crossAnalysis.dependencies as CrossSessionAnalysis['dependencies'] : [],
    operatorFocus: typeof crossAnalysis.operatorFocus === 'string' ? crossAnalysis.operatorFocus : '',
    recommendations: Array.isArray(crossAnalysis.recommendations) ? crossAnalysis.recommendations : [],
  }

  // Persist
  try {
    const dir = join(FOREMAN_HOME, 'traces', 'session-analysis')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
      JSON.stringify(analysis, null, 2) + '\n',
      'utf8',
    )
  } catch {}

  log(`Cross-session: ${analysis.crossCuttingThemes.length} themes, ${analysis.dependencies.length} deps`)
  log(`Focus: ${analysis.operatorFocus}`)

  return analysis
}

export function renderSessionAnalysis(analysis: CrossSessionAnalysis): string {
  const lines: string[] = []

  if (analysis.operatorFocus) {
    lines.push(`## Operator Focus`)
    lines.push('')
    lines.push(`**${analysis.operatorFocus}**`)
    lines.push('')
  }

  if (analysis.crossCuttingThemes.length > 0) {
    lines.push('### Cross-Cutting Themes')
    for (const t of analysis.crossCuttingThemes) {
      lines.push(`- **${t.theme}** (${t.repos.join(', ')}): ${t.evidence}`)
    }
    lines.push('')
  }

  if (analysis.dependencies.length > 0) {
    lines.push('### Repo Dependencies')
    for (const d of analysis.dependencies) {
      const icon = d.blocking ? '🔴' : '→'
      lines.push(`- ${d.from} ${icon} ${d.to}: ${d.relationship}`)
    }
    lines.push('')
  }

  if (analysis.interruptedWork.length > 0) {
    lines.push('### Interrupted Work')
    for (const w of analysis.interruptedWork) {
      const icon = w.shouldResume ? '⏸️' : '❌'
      lines.push(`${icon} **${w.repo}**: ${w.lastAction}`)
      lines.push(`  Likely reason: ${w.likelyReason}`)
    }
    lines.push('')
  }

  if (analysis.recommendations.length > 0) {
    lines.push('### Recommendations')
    for (const r of analysis.recommendations) {
      lines.push(`- ${r}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
