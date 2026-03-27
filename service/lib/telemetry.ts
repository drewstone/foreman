import type Database from 'better-sqlite3'

export interface TelemetryRunInput {
  eventKey: string
  decisionId?: number | null
  goalId?: number | null
  sessionName?: string | null
  source?: string | null
  harness: string
  provider?: string | null
  model?: string | null
  skill?: string | null
  repo?: string | null
  status?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  cacheCreationTokens?: number | null
  cacheReadTokens?: number | null
  totalTokens?: number | null
  costUsd?: number | null
  startedAt?: string | null
  finishedAt?: string | null
  metadata?: Record<string, unknown> | null
}

export interface TelemetryGroupRow {
  key: string
  runs: number
  costUsd: number
  totalTokens: number
}

export interface TelemetrySummary {
  periodHours: number
  runs: number
  totalCostUsd: number
  totalTokens: number
  byHarness: TelemetryGroupRow[]
  byProvider: TelemetryGroupRow[]
  byModel: TelemetryGroupRow[]
  byRepo: TelemetryGroupRow[]
  bySkill: TelemetryGroupRow[]
}

export interface TelemetryCostEstimate {
  costUsd: number
  sampleSize: number
  source: 'repo_skill' | 'skill' | 'repo' | 'global'
}

export function ensureTelemetrySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      decision_id INTEGER REFERENCES decisions(id),
      goal_id INTEGER REFERENCES goals(id),
      session_name TEXT,
      source TEXT NOT NULL DEFAULT 'service',
      harness TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      skill TEXT,
      repo TEXT,
      status TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_creation_tokens INTEGER,
      cache_read_tokens INTEGER,
      total_tokens INTEGER,
      cost_usd REAL,
      started_at TEXT,
      finished_at TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_runs_finished_at ON telemetry_runs(finished_at);
    CREATE INDEX IF NOT EXISTS idx_telemetry_runs_decision ON telemetry_runs(decision_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_runs_session ON telemetry_runs(session_name);
    CREATE INDEX IF NOT EXISTS idx_telemetry_runs_repo ON telemetry_runs(repo);
    CREATE INDEX IF NOT EXISTS idx_telemetry_runs_harness ON telemetry_runs(harness);
  `)
}

export function recordTelemetryRun(db: Database.Database, run: TelemetryRunInput): void {
  const inputTokens = run.inputTokens ?? 0
  const outputTokens = run.outputTokens ?? 0
  const cacheCreationTokens = run.cacheCreationTokens ?? 0
  const cacheReadTokens = run.cacheReadTokens ?? 0
  const totalTokens = run.totalTokens ?? (inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens)

  db.prepare(`
    INSERT INTO telemetry_runs (
      event_key, decision_id, goal_id, session_name, source, harness, provider, model, skill, repo,
      status, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens,
      cost_usd, started_at, finished_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO UPDATE SET
      decision_id = excluded.decision_id,
      goal_id = excluded.goal_id,
      session_name = excluded.session_name,
      source = excluded.source,
      harness = excluded.harness,
      provider = excluded.provider,
      model = excluded.model,
      skill = excluded.skill,
      repo = excluded.repo,
      status = excluded.status,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      total_tokens = excluded.total_tokens,
      cost_usd = excluded.cost_usd,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      metadata = excluded.metadata
  `).run(
    run.eventKey,
    run.decisionId ?? null,
    run.goalId ?? null,
    run.sessionName ?? null,
    run.source ?? 'service',
    run.harness,
    run.provider ?? null,
    run.model ?? null,
    run.skill ?? null,
    run.repo ?? null,
    run.status ?? null,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens,
    run.costUsd ?? null,
    run.startedAt ?? null,
    run.finishedAt ?? null,
    run.metadata ? JSON.stringify(run.metadata) : null,
  )
}

function periodClause(hoursBack: number): { where: string, args: unknown[] } {
  if (hoursBack <= 0) return { where: '', args: [] }
  return {
    where: `WHERE datetime(COALESCE(finished_at, created_at)) >= datetime('now', ?)`,
    args: [`-${hoursBack} hours`],
  }
}

function aggregateGroup(
  db: Database.Database,
  column: 'harness' | 'provider' | 'model' | 'repo' | 'skill',
  hoursBack: number,
  limit = 20,
): TelemetryGroupRow[] {
  const period = periodClause(hoursBack)
  return db.prepare(`
    SELECT COALESCE(${column}, 'unknown') as key,
           COUNT(*) as runs,
           COALESCE(SUM(cost_usd), 0) as costUsd,
           COALESCE(SUM(total_tokens), 0) as totalTokens
    FROM telemetry_runs
    ${period.where}
    GROUP BY COALESCE(${column}, 'unknown')
    ORDER BY costUsd DESC, runs DESC
    LIMIT ?
  `).all(...period.args, limit) as TelemetryGroupRow[]
}

export function summarizeTelemetry(db: Database.Database, hoursBack = 24): TelemetrySummary {
  const period = periodClause(hoursBack)
  const totals = db.prepare(`
    SELECT COUNT(*) as runs,
           COALESCE(SUM(cost_usd), 0) as totalCostUsd,
           COALESCE(SUM(total_tokens), 0) as totalTokens
    FROM telemetry_runs
    ${period.where}
  `).get(...period.args) as { runs: number, totalCostUsd: number, totalTokens: number }

  return {
    periodHours: hoursBack,
    runs: totals.runs,
    totalCostUsd: totals.totalCostUsd,
    totalTokens: totals.totalTokens,
    byHarness: aggregateGroup(db, 'harness', hoursBack),
    byProvider: aggregateGroup(db, 'provider', hoursBack),
    byModel: aggregateGroup(db, 'model', hoursBack),
    byRepo: aggregateGroup(db, 'repo', hoursBack),
    bySkill: aggregateGroup(db, 'skill', hoursBack),
  }
}

export function listTelemetryRuns(
  db: Database.Database,
  options?: { hoursBack?: number, limit?: number },
): Array<Record<string, unknown>> {
  const hoursBack = options?.hoursBack ?? 24
  const limit = options?.limit ?? 50
  const period = periodClause(hoursBack)
  return db.prepare(`
    SELECT *
    FROM telemetry_runs
    ${period.where}
    ORDER BY datetime(COALESCE(finished_at, created_at)) DESC
    LIMIT ?
  `).all(...period.args, limit) as Array<Record<string, unknown>>
}

export function getDailyTelemetryCost(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM telemetry_runs
    WHERE date(COALESCE(finished_at, created_at)) = date('now')
  `).get() as { total: number }
  return row.total
}

export function estimateTelemetryCost(
  db: Database.Database,
  input: { repo?: string | null, skill?: string | null },
): TelemetryCostEstimate | null {
  const scopes: Array<{
    source: TelemetryCostEstimate['source']
    where: string
    args: unknown[]
  }> = []

  if (input.repo && input.skill) {
    scopes.push({
      source: 'repo_skill',
      where: `WHERE repo = ? AND skill = ? AND cost_usd IS NOT NULL`,
      args: [input.repo, input.skill],
    })
  }
  if (input.skill) {
    scopes.push({
      source: 'skill',
      where: `WHERE skill = ? AND cost_usd IS NOT NULL`,
      args: [input.skill],
    })
  }
  if (input.repo) {
    scopes.push({
      source: 'repo',
      where: `WHERE repo = ? AND cost_usd IS NOT NULL`,
      args: [input.repo],
    })
  }
  scopes.push({
    source: 'global',
    where: `WHERE cost_usd IS NOT NULL`,
    args: [],
  })

  for (const scope of scopes) {
    const row = db.prepare(`
      SELECT COUNT(*) as runs, AVG(cost_usd) as avgCostUsd
      FROM telemetry_runs
      ${scope.where}
    `).get(...scope.args) as { runs: number, avgCostUsd: number | null }

    if (row.runs > 0 && row.avgCostUsd != null) {
      return {
        costUsd: row.avgCostUsd,
        sampleSize: row.runs,
        source: scope.source,
      }
    }
  }

  return null
}

export default {
  ensureTelemetrySchema,
  recordTelemetryRun,
  summarizeTelemetry,
  listTelemetryRuns,
  getDailyTelemetryCost,
  estimateTelemetryCost,
}
