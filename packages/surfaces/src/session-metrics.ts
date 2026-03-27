/**
 * Session metrics extraction and persistence.
 *
 * Extracts metrics from CLI harness output (claude, codex, pi) and
 * persists them as traces. Every spawned session should produce a
 * SessionMetrics record that feeds the optimizer and daily report.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

function getForemanHome(): string {
  return process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
}

export interface ToolCallStats {
  name: string
  count: number
  errors: number
}

export type TaskCompletion = 'completed' | 'partial' | 'failed' | 'abandoned' | 'unknown'

export interface SessionMetrics {
  sessionId: string
  harness: 'claude' | 'codex' | 'pi' | 'opencode'
  repo: string
  branch?: string
  goal: string
  timestamp: string

  // Outcome
  exitCode: number
  success: boolean
  stopReason?: string
  taskCompletion?: TaskCompletion
  taskCompletionReason?: string

  // Duration
  durationMs: number

  // Cost
  costUsd?: number

  // Tokens
  inputTokens?: number
  outputTokens?: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  totalTokens?: number

  // Turns
  numTurns?: number

  // Model
  modelIds?: string[]

  // Tool usage
  toolCalls?: ToolCallStats[]
  totalToolCalls?: number
  totalToolErrors?: number

  // Artifact versions used (for optimizer attribution)
  artifactVersions?: Record<string, string>
}

/**
 * Parse claude --output-format json stdout into metrics.
 */
export function parseClaudeMetrics(stdout: string, context: {
  repo: string
  goal: string
  durationMs: number
  exitCode: number
}): SessionMetrics {
  const metrics: SessionMetrics = {
    sessionId: 'unknown',
    harness: 'claude',
    repo: context.repo,
    goal: context.goal,
    timestamp: new Date().toISOString(),
    exitCode: context.exitCode,
    success: context.exitCode === 0,
    durationMs: context.durationMs,
  }

  try {
    const parsed = JSON.parse(stdout)
    if (typeof parsed !== 'object' || parsed === null) return metrics

    metrics.sessionId = parsed.session_id ?? 'unknown'
    metrics.stopReason = parsed.stop_reason
    metrics.costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined
    metrics.numTurns = typeof parsed.num_turns === 'number' ? parsed.num_turns : undefined

    const usage = parsed.usage
    if (usage && typeof usage === 'object') {
      metrics.inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
      metrics.outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
      metrics.cacheCreationTokens = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined
      metrics.cacheReadTokens = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined
      if (metrics.inputTokens !== undefined && metrics.outputTokens !== undefined) {
        metrics.totalTokens = metrics.inputTokens + metrics.outputTokens +
          (metrics.cacheCreationTokens ?? 0) + (metrics.cacheReadTokens ?? 0)
      }
    }

    const modelUsage = parsed.modelUsage
    if (modelUsage && typeof modelUsage === 'object') {
      metrics.modelIds = Object.keys(modelUsage)
    }
  } catch { /* not valid JSON — return partial metrics */ }

  return metrics
}

/**
 * Parse codex --json stdout into metrics.
 */
export function parseCodexMetrics(stdout: string, context: {
  repo: string
  goal: string
  durationMs: number
  exitCode: number
}): SessionMetrics {
  const metrics: SessionMetrics = {
    sessionId: 'unknown',
    harness: 'codex',
    repo: context.repo,
    goal: context.goal,
    timestamp: new Date().toISOString(),
    exitCode: context.exitCode,
    success: context.exitCode === 0,
    durationMs: context.durationMs,
  }

  try {
    // Codex JSON format varies — extract what we can
    const parsed = JSON.parse(stdout)
    if (typeof parsed !== 'object' || parsed === null) return metrics

    metrics.sessionId = parsed.session_id ?? 'unknown'

    const usage = parsed.usage
    if (usage && typeof usage === 'object') {
      metrics.inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
      metrics.outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
    }
  } catch { /* not valid JSON */ }

  return metrics
}

/**
 * Extract cost data from a Pi JSONL session file.
 * Pi stores per-message costs at message.usage.cost.total
 */
export async function parsePiSessionMetrics(sessionPath: string, context: {
  repo: string
  goal?: string
}): Promise<SessionMetrics> {
  const metrics: SessionMetrics = {
    sessionId: sessionPath.split('/').pop()?.replace('.jsonl', '') ?? 'unknown',
    harness: 'pi',
    repo: context.repo,
    goal: context.goal ?? '',
    timestamp: new Date().toISOString(),
    exitCode: 0,
    success: true,
    durationMs: 0,
    costUsd: 0,
    numTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
  }

  try {
    const { createReadStream } = await import('node:fs')
    const { createInterface } = await import('node:readline')
    const stream = createReadStream(sessionPath, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })

    let firstTs: number | null = null
    let lastTs: number | null = null
    const models = new Set<string>()

    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry.type !== 'message' || !entry.message) continue

        const msg = entry.message
        const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : null
        if (ts) {
          if (firstTs === null) firstTs = ts
          lastTs = ts
        }

        if (msg.role === 'assistant') {
          metrics.numTurns!++
          if (msg.model) models.add(msg.model)

          const usage = msg.usage
          if (usage && typeof usage === 'object') {
            if (typeof usage.cost?.total === 'number') {
              metrics.costUsd! += usage.cost.total
            }
            if (typeof usage.inputTokens === 'number') {
              metrics.inputTokens! += usage.inputTokens
            }
            if (typeof usage.outputTokens === 'number') {
              metrics.outputTokens! += usage.outputTokens
            }
          }
        }
      } catch { continue }
    }

    if (firstTs !== null && lastTs !== null) {
      metrics.durationMs = lastTs - firstTs
    }
    if (models.size > 0) {
      metrics.modelIds = [...models]
    }
    if (metrics.inputTokens! > 0 && metrics.outputTokens! > 0) {
      metrics.totalTokens = metrics.inputTokens! + metrics.outputTokens!
    }
  } catch { /* can't read file */ }

  return metrics
}

/**
 * Scan recent Pi session files and extract metrics.
 */
export async function scanPiSessionMetrics(options?: {
  maxAge?: number
  homeDir?: string
}): Promise<SessionMetrics[]> {
  const { readdir: rd, stat: st } = await import('node:fs/promises')
  const { join: j } = await import('node:path')

  const sessionsDir = j(options?.homeDir ?? homedir(), '.pi', 'agent', 'sessions')
  const maxAge = options?.maxAge ?? 7 * 24 * 3600 * 1000
  const cutoff = Date.now() - maxAge
  const results: SessionMetrics[] = []

  let projectDirs: string[]
  try {
    projectDirs = await rd(sessionsDir)
  } catch {
    return []
  }

  for (const projectDir of projectDirs) {
    const projectPath = j(sessionsDir, projectDir)
    let projectStat
    try {
      projectStat = await st(projectPath)
      if (!projectStat.isDirectory()) continue
    } catch {
      continue
    }

    let files: string[]
    try {
      files = (await rd(projectPath)).filter((file) => file.endsWith('.jsonl'))
    } catch {
      continue
    }

    for (const file of files) {
      const sessionPath = j(projectPath, file)
      let fileStat
      try {
        fileStat = await st(sessionPath)
        if (fileStat.mtimeMs < cutoff) continue
      } catch {
        continue
      }

      const metrics = await parsePiSessionMetrics(sessionPath, { repo: projectDir })
      metrics.timestamp = new Date(fileStat.mtimeMs).toISOString()
      results.push(metrics)
    }
  }

  return results.sort((left, right) => right.timestamp.localeCompare(left.timestamp))
}

/**
 * Extract metrics from an opencode session directory.
 * Opencode stores sessions at ~/.local/share/opencode/storage/
 * with per-message JSON files containing cost, tokens, timing.
 */
export async function parseOpencodeSessionMetrics(sessionDir: string, context: {
  repo?: string
}): Promise<SessionMetrics> {
  const sessionId = sessionDir.split('/').pop() ?? 'unknown'
  const metrics: SessionMetrics = {
    sessionId,
    harness: 'opencode',
    repo: context.repo ?? '',
    goal: '',
    timestamp: new Date().toISOString(),
    exitCode: 0,
    success: true,
    durationMs: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    numTurns: 0,
  }

  // Read session metadata
  const { readdir: rd, readFile: rf } = await import('node:fs/promises')
  const { join: j } = await import('node:path')

  // Read session JSON for title/directory
  try {
    const sessionFiles = await rd(sessionDir)
    for (const file of sessionFiles) {
      if (!file.endsWith('.json')) continue
      const raw = await rf(j(sessionDir, file), 'utf8')
      const msg = JSON.parse(raw)

      if (msg.role === 'assistant') {
        metrics.numTurns!++
        if (typeof msg.cost === 'number') metrics.costUsd! += msg.cost
        if (msg.tokens && typeof msg.tokens === 'object') {
          metrics.inputTokens! += msg.tokens.input ?? 0
          metrics.outputTokens! += msg.tokens.output ?? 0
        }
        if (msg.time?.created && msg.time?.completed) {
          const dur = msg.time.completed - msg.time.created
          metrics.durationMs += dur
        }
        if (msg.modelID && !metrics.modelIds) metrics.modelIds = []
        if (msg.modelID && !metrics.modelIds!.includes(msg.modelID)) {
          metrics.modelIds!.push(msg.modelID)
        }
      } else if (msg.role === 'user' && !metrics.goal && msg.system) {
        // First user message often has the goal in the system prompt
        metrics.goal = (typeof msg.summary?.title === 'string' ? msg.summary.title : '').slice(0, 200)
      }
    }
  } catch { /* can't read */ }

  if (metrics.inputTokens! > 0 && metrics.outputTokens! > 0) {
    metrics.totalTokens = metrics.inputTokens! + metrics.outputTokens!
  }

  return metrics
}

/**
 * Scan all opencode sessions and extract metrics.
 */
export async function scanOpencodeSessionMetrics(options?: {
  maxAge?: number
  homeDir?: string
}): Promise<SessionMetrics[]> {
  const { readdir: rd, stat: st } = await import('node:fs/promises')
  const { join: j } = await import('node:path')

  const rootHome = options?.homeDir ?? homedir()
  const messagesDir = j(rootHome, '.local', 'share', 'opencode', 'storage', 'message')
  const sessionsDir = j(rootHome, '.local', 'share', 'opencode', 'storage', 'session', 'global')
  const maxAge = options?.maxAge ?? 7 * 24 * 3600 * 1000
  const cutoff = Date.now() - maxAge

  // Load session metadata for directory/title
  const sessionMeta = new Map<string, { directory?: string; title?: string }>()
  try {
    for (const file of await rd(sessionsDir)) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await (await import('node:fs/promises')).readFile(j(sessionsDir, file), 'utf8')
        const ses = JSON.parse(raw)
        sessionMeta.set(ses.id, { directory: ses.directory, title: ses.title })
      } catch { continue }
    }
  } catch { /* no sessions */ }

  const results: SessionMetrics[] = []
  try {
    const sessionDirs = await rd(messagesDir)
    for (const sesId of sessionDirs) {
      const sesDir = j(messagesDir, sesId)
      try {
        const s = await st(sesDir)
        if (s.mtimeMs < cutoff) continue
      } catch { continue }

      const meta = sessionMeta.get(sesId)
      const repo = meta?.directory?.split('/').pop() ?? ''
      const m = await parseOpencodeSessionMetrics(sesDir, { repo })
      if (!m.goal && meta?.title) {
        m.goal = meta.title
      }
      m.timestamp = new Date((await st(sesDir)).mtimeMs).toISOString()
      results.push(m)
    }
  } catch { /* no messages dir */ }

  return results
}

// ─── Tool call extraction from JSONL sessions ──────────────────────

/**
 * Extract tool call stats from a Claude Code JSONL session file.
 * Reads the JSONL, counts tool_use blocks by tool name, counts errors.
 */
export async function extractToolCallsFromClaudeSession(sessionId: string): Promise<ToolCallStats[]> {
  const { createReadStream } = await import('node:fs')
  const { createInterface } = await import('node:readline')
  const { readdir } = await import('node:fs/promises')
  const { join: j } = await import('node:path')
  const { homedir: hd } = await import('node:os')

  const root = j(hd(), '.claude', 'projects')
  const toolCounts = new Map<string, { count: number; errors: number }>()
  const toolCallIdToName = new Map<string, string>()

  // Find the session file across all project dirs
  let sessionPath: string | null = null
  try {
    const dirs = await readdir(root, { withFileTypes: true })
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const candidate = j(root, dir.name, `${sessionId}.jsonl`)
      try {
        await import('node:fs/promises').then((fs) => fs.stat(candidate))
        sessionPath = candidate
        break
      } catch { continue }
    }
  } catch { return [] }

  if (!sessionPath) return []

  try {
    const stream = createReadStream(sessionPath, { encoding: 'utf8', highWaterMark: 64 * 1024 })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })

    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if (entry.type === 'assistant') {
          const msg = entry.message as { content?: unknown[] } | undefined
          if (Array.isArray(msg?.content)) {
            for (const block of msg.content) {
              const b = block as Record<string, unknown>
              if (b.type === 'tool_use' && typeof b.name === 'string') {
                const existing = toolCounts.get(b.name) ?? { count: 0, errors: 0 }
                existing.count++
                toolCounts.set(b.name, existing)
                if (typeof b.id === 'string') {
                  toolCallIdToName.set(b.id, b.name)
                }
              }
            }
          }
        }
        if (entry.type === 'tool_result') {
          const msg = entry.message as { content?: unknown[]; is_error?: boolean; tool_use_id?: string } | undefined
          if (msg?.is_error) {
            // Look up the tool name from tool_use_id
            const toolName = typeof msg.tool_use_id === 'string'
              ? toolCallIdToName.get(msg.tool_use_id)
              : undefined
            if (toolName) {
              const stats = toolCounts.get(toolName)
              if (stats) stats.errors++
            }
          }
        }
      } catch { continue }
    }
  } catch { return [] }

  return [...toolCounts.entries()]
    .map(([name, stats]) => ({ name, count: stats.count, errors: stats.errors }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Classify task completion by examining the session output.
 * Uses heuristic analysis of the session result text.
 */
export function classifyTaskCompletion(metrics: SessionMetrics, resultText?: string): { completion: TaskCompletion; reason: string } {
  // Hard failure
  if (metrics.exitCode !== 0) {
    return { completion: 'failed', reason: `Exit code ${metrics.exitCode}` }
  }

  // Timeout
  if (metrics.stopReason === 'max_tokens' || metrics.stopReason === 'timeout') {
    return { completion: 'abandoned', reason: `Stop reason: ${metrics.stopReason}` }
  }

  // No turns = nothing happened
  if (metrics.numTurns === 0) {
    return { completion: 'failed', reason: 'No turns executed' }
  }

  // Very short sessions are suspicious
  if (metrics.numTurns === 1 && metrics.durationMs < 10_000) {
    return { completion: 'partial', reason: 'Single turn, very short — likely incomplete' }
  }

  // Check result text for completion signals
  if (resultText) {
    const lower = resultText.toLowerCase()

    // Strong completion signals
    if (lower.includes('all tests pass') || lower.includes('ci is green') ||
        lower.includes('pr created') || lower.includes('pushed to') ||
        lower.includes('successfully merged') || lower.includes('all checks pass')) {
      return { completion: 'completed', reason: 'Output indicates successful completion' }
    }

    // Partial signals
    if (lower.includes('partially') || lower.includes('some issues remain') ||
        lower.includes('needs review') || lower.includes('could not') ||
        lower.includes('unable to')) {
      return { completion: 'partial', reason: 'Output indicates partial completion' }
    }

    // Failure signals
    if (lower.includes('error:') || lower.includes('failed to') ||
        lower.includes('compilation error') || lower.includes('test failed')) {
      return { completion: 'failed', reason: 'Output indicates failure' }
    }
  }

  // Default: if it ran and exited cleanly, assume completed
  if (metrics.exitCode === 0 && (metrics.numTurns ?? 0) >= 2) {
    return { completion: 'completed', reason: 'Clean exit with multiple turns' }
  }

  return { completion: 'unknown', reason: 'Unable to determine completion status' }
}

/**
 * Enrich metrics with tool calls and task completion.
 * Call this after initial metrics extraction for a richer picture.
 */
export async function enrichMetrics(metrics: SessionMetrics, resultText?: string): Promise<SessionMetrics> {
  // Extract tool calls from session JSONL (Claude only for now)
  if (metrics.harness === 'claude' && metrics.sessionId !== 'unknown') {
    try {
      const toolCalls = await extractToolCallsFromClaudeSession(metrics.sessionId)
      if (toolCalls.length > 0) {
        metrics.toolCalls = toolCalls
        metrics.totalToolCalls = toolCalls.reduce((s, t) => s + t.count, 0)
        metrics.totalToolErrors = toolCalls.reduce((s, t) => s + t.errors, 0)
      }
    } catch { /* non-fatal */ }
  }

  // Classify task completion
  const { completion, reason } = classifyTaskCompletion(metrics, resultText)
  metrics.taskCompletion = completion
  metrics.taskCompletionReason = reason

  return metrics
}

// ─── Persistence ────────────────────────────────────────────────────

export async function persistSessionMetrics(metrics: SessionMetrics): Promise<string> {
  const dir = join(getForemanHome(), 'traces', 'sessions')
  await mkdir(dir, { recursive: true })
  const filename = `${metrics.timestamp.replace(/[:.]/g, '-')}-${metrics.harness}-${metrics.repo}.json`
  const path = join(dir, filename)
  await writeFile(path, JSON.stringify(metrics, null, 2) + '\n', 'utf8')
  return path
}

/**
 * Load all session metrics within a time range.
 */
export async function loadSessionMetrics(options?: {
  hoursBack?: number
  harness?: string
  repo?: string
}): Promise<SessionMetrics[]> {
  const dir = join(getForemanHome(), 'traces', 'sessions')
  const cutoff = options?.hoursBack
    ? new Date(Date.now() - options.hoursBack * 3600 * 1000).toISOString()
    : undefined

  let files: string[]
  try {
    const { readdir } = await import('node:fs/promises')
    files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return []
  }

  const results: SessionMetrics[] = []
  for (const file of files) {
    try {
      const raw = await readFile(join(dir, file), 'utf8')
      const m = JSON.parse(raw) as SessionMetrics
      if (cutoff && m.timestamp < cutoff) continue
      if (options?.harness && m.harness !== options.harness) continue
      if (options?.repo && m.repo !== options.repo) continue
      results.push(m)
    } catch { continue }
  }
  return results
}

// ─── Aggregation ────────────────────────────────────────────────────

export interface MetricsAggregate {
  totalSessions: number
  successRate: number
  totalCostUsd: number
  totalTokens: number
  totalDurationMs: number
  avgTurns: number
  avgCostPerSession: number
  avgDurationMs: number
  avgTokensPerSession: number
  completionRates: Record<TaskCompletion, number>
  topTools: ToolCallStats[]
  totalToolCalls: number
  totalToolErrors: number
  byHarness: Record<string, { sessions: number; cost: number; tokens: number; successRate: number }>
  byRepo: Record<string, { sessions: number; cost: number; tokens: number; successRate: number }>
  byModel: Record<string, { sessions: number; cost: number; tokens: number }>
}

export function aggregateMetrics(metrics: SessionMetrics[]): MetricsAggregate {
  const total = metrics.length
  if (total === 0) {
    return {
      totalSessions: 0, successRate: 0, totalCostUsd: 0, totalTokens: 0,
      totalDurationMs: 0, avgTurns: 0, avgCostPerSession: 0, avgDurationMs: 0,
      avgTokensPerSession: 0, completionRates: {} as Record<TaskCompletion, number>,
      topTools: [], totalToolCalls: 0, totalToolErrors: 0,
      byHarness: {}, byRepo: {}, byModel: {},
    }
  }

  let totalCost = 0
  let totalTokens = 0
  let totalDuration = 0
  let totalTurns = 0
  let successCount = 0
  let totalToolCallsSum = 0
  let totalToolErrorsSum = 0
  const completionCounts: Record<string, number> = {}
  const toolAgg = new Map<string, { count: number; errors: number }>()
  const byHarness: Record<string, { sessions: number; cost: number; tokens: number; successes: number }> = {}
  const byRepo: Record<string, { sessions: number; cost: number; tokens: number; successes: number }> = {}
  const byModel: Record<string, { sessions: number; cost: number; tokens: number }> = {}

  for (const m of metrics) {
    totalCost += m.costUsd ?? 0
    totalTokens += m.totalTokens ?? (m.inputTokens ?? 0) + (m.outputTokens ?? 0)
    totalDuration += m.durationMs
    totalTurns += m.numTurns ?? 0
    if (m.success) successCount++

    // Completion tracking
    const comp = m.taskCompletion ?? 'unknown'
    completionCounts[comp] = (completionCounts[comp] ?? 0) + 1

    // Tool tracking
    totalToolCallsSum += m.totalToolCalls ?? 0
    totalToolErrorsSum += m.totalToolErrors ?? 0
    for (const tc of m.toolCalls ?? []) {
      const existing = toolAgg.get(tc.name) ?? { count: 0, errors: 0 }
      existing.count += tc.count
      existing.errors += tc.errors
      toolAgg.set(tc.name, existing)
    }

    // By harness
    const h = byHarness[m.harness] ?? { sessions: 0, cost: 0, tokens: 0, successes: 0 }
    h.sessions++
    h.cost += m.costUsd ?? 0
    h.tokens += m.totalTokens ?? 0
    if (m.success) h.successes++
    byHarness[m.harness] = h

    // By repo
    const r = byRepo[m.repo] ?? { sessions: 0, cost: 0, tokens: 0, successes: 0 }
    r.sessions++
    r.cost += m.costUsd ?? 0
    r.tokens += m.totalTokens ?? 0
    if (m.success) r.successes++
    byRepo[m.repo] = r

    // By model
    for (const modelId of m.modelIds ?? []) {
      const md = byModel[modelId] ?? { sessions: 0, cost: 0, tokens: 0 }
      md.sessions++
      md.cost += (m.costUsd ?? 0) / (m.modelIds?.length ?? 1)
      md.tokens += (m.totalTokens ?? 0) / (m.modelIds?.length ?? 1)
      byModel[modelId] = md
    }
  }

  const formatGroup = (g: { sessions: number; cost: number; tokens: number; successes: number }) => ({
    sessions: g.sessions,
    cost: g.cost,
    tokens: g.tokens,
    successRate: g.sessions > 0 ? g.successes / g.sessions : 0,
  })

  const topTools = [...toolAgg.entries()]
    .map(([name, stats]) => ({ name, count: stats.count, errors: stats.errors }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)

  return {
    totalSessions: total,
    successRate: successCount / total,
    totalCostUsd: totalCost,
    totalTokens: totalTokens,
    totalDurationMs: totalDuration,
    avgTurns: totalTurns / total,
    avgCostPerSession: totalCost / total,
    avgDurationMs: totalDuration / total,
    avgTokensPerSession: totalTokens / total,
    completionRates: Object.fromEntries(
      Object.entries(completionCounts).map(([k, v]) => [k, v / total]),
    ) as Record<TaskCompletion, number>,
    topTools,
    totalToolCalls: totalToolCallsSum,
    totalToolErrors: totalToolErrorsSum,
    byHarness: Object.fromEntries(
      Object.entries(byHarness).map(([k, v]) => [k, formatGroup(v)]),
    ),
    byRepo: Object.fromEntries(
      Object.entries(byRepo).map(([k, v]) => [k, formatGroup(v)]),
    ),
    byModel: Object.fromEntries(
      Object.entries(byModel).map(([k, v]) => [k, { sessions: v.sessions, cost: v.cost, tokens: v.tokens }]),
    ),
  }
}

export function renderMetricsAggregate(agg: MetricsAggregate): string {
  const lines: string[] = []
  lines.push(`## Session Metrics`)
  lines.push('')
  lines.push(`**${agg.totalSessions} sessions** | ${(agg.successRate * 100).toFixed(0)}% success | $${agg.totalCostUsd.toFixed(2)} total cost | ${(agg.totalDurationMs / 60000).toFixed(1)}min total`)
  lines.push(`Avg: ${agg.avgTurns.toFixed(1)} turns, $${agg.avgCostPerSession.toFixed(4)}/session, ${(agg.avgDurationMs / 1000).toFixed(0)}s/session, ${Math.round(agg.avgTokensPerSession)} tokens/session`)
  lines.push('')

  if (Object.keys(agg.byHarness).length > 0) {
    lines.push('| Harness | Sessions | Cost | Success | Tokens |')
    lines.push('|---|---|---|---|---|')
    for (const [h, v] of Object.entries(agg.byHarness)) {
      lines.push(`| ${h} | ${v.sessions} | $${v.cost.toFixed(2)} | ${(v.successRate * 100).toFixed(0)}% | ${v.tokens} |`)
    }
    lines.push('')
  }

  if (Object.keys(agg.byRepo).length > 0) {
    const repos = Object.entries(agg.byRepo).sort((a, b) => b[1].cost - a[1].cost).slice(0, 10)
    lines.push('| Repo | Sessions | Cost | Success |')
    lines.push('|---|---|---|---|')
    for (const [r, v] of repos) {
      lines.push(`| ${r} | ${v.sessions} | $${v.cost.toFixed(2)} | ${(v.successRate * 100).toFixed(0)}% |`)
    }
    lines.push('')
  }

  if (Object.keys(agg.byModel).length > 0) {
    lines.push('| Model | Sessions | Cost |')
    lines.push('|---|---|---|')
    for (const [m, v] of Object.entries(agg.byModel).sort((a, b) => b[1].cost - a[1].cost)) {
      lines.push(`| ${m} | ${v.sessions} | $${v.cost.toFixed(2)} |`)
    }
    lines.push('')
  }

  // Task completion rates
  if (Object.keys(agg.completionRates).length > 0) {
    lines.push('**Task completion:** ' + Object.entries(agg.completionRates)
      .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
      .join(' | '))
    lines.push('')
  }

  // Tool usage
  if (agg.topTools.length > 0) {
    const errorRate = agg.totalToolCalls > 0 ? (agg.totalToolErrors / agg.totalToolCalls * 100).toFixed(1) : '0'
    lines.push(`**Tool calls:** ${agg.totalToolCalls} total, ${agg.totalToolErrors} errors (${errorRate}%)`)
    lines.push('')
    lines.push('| Tool | Calls | Errors |')
    lines.push('|---|---|---|')
    for (const t of agg.topTools.slice(0, 10)) {
      lines.push(`| ${t.name} | ${t.count} | ${t.errors} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
