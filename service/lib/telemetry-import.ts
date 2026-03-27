import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

import type Database from 'better-sqlite3'
import {
  loadSessionMetrics,
  scanOpencodeSessionMetrics,
  scanPiSessionMetrics,
  type SessionMetrics as SurfaceSessionMetrics,
} from '../../packages/surfaces/src/session-metrics.js'

import telemetry from './telemetry.js'

const { recordTelemetryRun } = telemetry

function getForemanHome(): string {
  return process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
}

export interface TelemetryImportSummary {
  scanned: number
  imported: number
  skipped: number
  sources: {
    sessionMetrics: { scanned: number, imported: number, skipped: number }
    sessionTraces: { scanned: number, imported: number, skipped: number }
    piSessions: { scanned: number, imported: number, skipped: number }
    opencodeSessions: { scanned: number, imported: number, skipped: number }
  }
}

export interface TelemetryImportRunRow {
  id: number
  status: string
  traceRoot: string | null
  maxAgeHours: number | null
  scanned: number
  imported: number
  skipped: number
  summary: TelemetryImportSummary | null
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export function ensureTelemetryImportSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_import_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      trace_root TEXT,
      max_age_hours INTEGER,
      scanned INTEGER NOT NULL DEFAULT 0,
      imported INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_import_runs_started_at
      ON telemetry_import_runs(started_at DESC);
  `)
}

export async function runTelemetryImport(
  db: Database.Database,
  options?: {
    traceRoot?: string
    maxAgeHours?: number
    homeDir?: string
  },
): Promise<TelemetryImportSummary> {
  const startedAt = new Date().toISOString()
  const start = db.prepare(`
    INSERT INTO telemetry_import_runs (status, trace_root, max_age_hours, started_at)
    VALUES ('running', ?, ?, ?)
  `).run(options?.traceRoot ?? null, options?.maxAgeHours ?? null, startedAt)
  const runId = Number(start.lastInsertRowid)

  try {
    const summary = await importTelemetryArtifacts(db, options)
    db.prepare(`
      UPDATE telemetry_import_runs
      SET status = 'success',
          scanned = ?,
          imported = ?,
          skipped = ?,
          summary_json = ?,
          finished_at = ?
      WHERE id = ?
    `).run(
      summary.scanned,
      summary.imported,
      summary.skipped,
      JSON.stringify(summary),
      new Date().toISOString(),
      runId,
    )
    return summary
  } catch (error) {
    db.prepare(`
      UPDATE telemetry_import_runs
      SET status = 'failure',
          error = ?,
          finished_at = ?
      WHERE id = ?
    `).run(
      error instanceof Error ? error.message : String(error),
      new Date().toISOString(),
      runId,
    )
    throw error
  }
}

export function getLatestTelemetryImportRun(db: Database.Database): TelemetryImportRunRow | null {
  const row = db.prepare(`
    SELECT *
    FROM telemetry_import_runs
    ORDER BY datetime(started_at) DESC, id DESC
    LIMIT 1
  `).get() as Record<string, unknown> | undefined
  return row ? hydrateTelemetryImportRun(row) : null
}

export function listTelemetryImportRuns(
  db: Database.Database,
  options?: { limit?: number },
): TelemetryImportRunRow[] {
  const limit = options?.limit ?? 10
  const rows = db.prepare(`
    SELECT *
    FROM telemetry_import_runs
    ORDER BY datetime(started_at) DESC, id DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>
  return rows.map(hydrateTelemetryImportRun)
}

export async function importTelemetryArtifacts(
  db: Database.Database,
  options?: {
    traceRoot?: string
    maxAgeHours?: number
    homeDir?: string
  },
): Promise<TelemetryImportSummary> {
  const traceRoot = options?.traceRoot ?? join(getForemanHome(), 'traces')
  const maxAgeHours = options?.maxAgeHours ?? 24 * 14

  const sessionMetrics = await importSessionMetricFiles(db, maxAgeHours)
  const sessionTraces = await importSessionTraceBundles(db, traceRoot)
  const piSessions = await importScannedSessions(db, await scanPiSessionMetrics({
    maxAge: maxAgeHours * 3600 * 1000,
    homeDir: options?.homeDir,
  }), 'scanner_pi')
  const opencodeSessions = await importScannedSessions(db, await scanOpencodeSessionMetrics({
    maxAge: maxAgeHours * 3600 * 1000,
    homeDir: options?.homeDir,
  }), 'scanner_opencode')

  return {
    scanned: sessionMetrics.scanned + sessionTraces.scanned + piSessions.scanned + opencodeSessions.scanned,
    imported: sessionMetrics.imported + sessionTraces.imported + piSessions.imported + opencodeSessions.imported,
    skipped: sessionMetrics.skipped + sessionTraces.skipped + piSessions.skipped + opencodeSessions.skipped,
    sources: {
      sessionMetrics,
      sessionTraces,
      piSessions,
      opencodeSessions,
    },
  }
}

async function importSessionMetricFiles(
  db: Database.Database,
  maxAgeHours: number,
): Promise<{ scanned: number, imported: number, skipped: number }> {
  const metrics = await loadSessionMetrics({ hoursBack: maxAgeHours })
  return importScannedSessions(db, metrics, 'session_metrics_trace')
}

async function importScannedSessions(
  db: Database.Database,
  metrics: SurfaceSessionMetrics[],
  source: string,
): Promise<{ scanned: number, imported: number, skipped: number }> {
  let imported = 0
  let skipped = 0

  for (const metric of metrics) {
    const eventKey = buildMetricsEventKey(metric)
    if (hasTelemetryEvent(db, eventKey)) {
      skipped++
      continue
    }

    recordTelemetryRun(db, {
      eventKey,
      sessionName: metric.sessionId,
      source,
      harness: metric.harness,
      provider: inferProvider(metric.harness, metric.modelIds?.[0]),
      model: metric.modelIds?.[0],
      repo: metric.repo || null,
      status: metric.success ? 'success' : 'failure',
      inputTokens: metric.inputTokens,
      outputTokens: metric.outputTokens,
      cacheCreationTokens: metric.cacheCreationTokens,
      cacheReadTokens: metric.cacheReadTokens,
      totalTokens: metric.totalTokens,
      costUsd: metric.costUsd,
      startedAt: deriveStartedAt(metric.timestamp, metric.durationMs),
      finishedAt: metric.timestamp,
      metadata: {
        goal: metric.goal,
        branch: metric.branch ?? null,
        stopReason: metric.stopReason ?? null,
        taskCompletion: metric.taskCompletion ?? null,
        taskCompletionReason: metric.taskCompletionReason ?? null,
        numTurns: metric.numTurns ?? null,
        totalToolCalls: metric.totalToolCalls ?? null,
        totalToolErrors: metric.totalToolErrors ?? null,
        artifactVersions: metric.artifactVersions ?? null,
      },
    })
    imported++
  }

  return { scanned: metrics.length, imported, skipped }
}

async function importSessionTraceBundles(
  db: Database.Database,
  traceRoot: string,
): Promise<{ scanned: number, imported: number, skipped: number }> {
  let traceDirs: string[]
  try {
    traceDirs = await readdir(traceRoot)
  } catch {
    return { scanned: 0, imported: 0, skipped: 0 }
  }

  let scanned = 0
  let imported = 0
  let skipped = 0

  for (const traceId of traceDirs) {
    if (traceId === 'sessions') continue

    const tracePath = join(traceRoot, traceId, 'trace.json')
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(await readFile(tracePath, 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }

    const metadata = asRecord(parsed.metadata)
    const events = Array.isArray(parsed.events) ? parsed.events.filter(isRecord) : []
    const outcome = asRecord(parsed.outcome)
    const surface = stringValue(metadata.surface)
    const hasSessionEvent = events.some((event) => stringValue(event.kind)?.startsWith('session.'))
    if (surface !== 'session' && !hasSessionEvent) continue

    scanned++

    const harness = stringValue(metadata.provider) ?? stringValue(events[0]?.workerId)
    if (!harness) {
      skipped++
      continue
    }

    const sessionId = stringValue(metadata.sessionId)
    const action = stringValue(metadata.action) ?? 'run'
    const startedAt = stringValue(events[0]?.at)
    const finishedAt = stringValue(events[events.length - 1]?.at) ?? startedAt ?? new Date().toISOString()
    const model = stringValue(metadata.model)
      ?? stringValue(metadata.upstreamModel)
      ?? firstListItem(stringValue(metadata.modelIds))
      ?? undefined
    const eventKey = buildTraceEventKey(harness, sessionId, action, startedAt, traceId)
    if (hasTelemetryEvent(db, eventKey)) {
      skipped++
      continue
    }

    recordTelemetryRun(db, {
      eventKey,
      sessionName: sessionId ?? traceId,
      source: 'session_trace_import',
      harness,
      provider: stringValue(metadata.upstreamProvider) ?? inferProvider(harness, model),
      model,
      repo: inferRepoName(metadata),
      status: mapOutcomeStatus(stringValue(outcome.status) ?? 'unknown'),
      inputTokens: numberValue(metadata.inputTokens),
      outputTokens: numberValue(metadata.outputTokens),
      cacheCreationTokens: numberValue(metadata.cacheCreationInputTokens),
      cacheReadTokens: numberValue(metadata.cacheReadInputTokens) ?? numberValue(metadata.cachedInputTokens),
      totalTokens: numberValue(metadata.totalTokens),
      costUsd: numberValue(metadata.costUsd) ?? numberValue(metadata.totalCostUsd),
      startedAt: startedAt ?? null,
      finishedAt,
      metadata: {
        traceId,
        taskId: stringValue(asRecord(parsed.task).id) ?? null,
        action,
        requestedProvider: stringValue(metadata.requestedProvider) ?? null,
        targetUrl: stringValue(metadata.targetUrl) ?? null,
        approvalMode: stringValue(metadata.approvalMode) ?? null,
        resolutionReasons: stringValue(metadata.resolutionReasons) ?? null,
        detectedFailureReason: stringValue(metadata.detectedFailureReason) ?? null,
        failureClasses: stringValue(metadata.failureClasses) ?? null,
      },
    })
    imported++
  }

  return { scanned, imported, skipped }
}

function buildMetricsEventKey(metric: SurfaceSessionMetrics): string {
  if (metric.sessionId && metric.sessionId !== 'unknown') {
    return `session-metrics:${metric.harness}:${metric.sessionId}`
  }
  return `session-metrics:${metric.harness}:${metric.repo}:${metric.timestamp}`
}

function buildTraceEventKey(
  harness: string,
  sessionId: string | undefined,
  action: string,
  startedAt: string | undefined,
  traceId: string,
): string {
  return `session-run:${harness}:${sessionId ?? startedAt ?? traceId}:${action}`
}

function hasTelemetryEvent(db: Database.Database, eventKey: string): boolean {
  const row = db.prepare(`SELECT 1 FROM telemetry_runs WHERE event_key = ?`).get(eventKey)
  return row != null
}

function deriveStartedAt(timestamp: string, durationMs: number): string | null {
  const finishedAt = Date.parse(timestamp)
  if (!Number.isFinite(finishedAt) || !Number.isFinite(durationMs) || durationMs <= 0) return null
  return new Date(finishedAt - durationMs).toISOString()
}

function inferProvider(harness: string, model?: string): string | null {
  if (model) {
    const lower = model.toLowerCase()
    if (lower.includes('claude')) return 'anthropic'
    if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('codex')) return 'openai'
  }
  if (harness === 'claude' || harness === 'pi') return 'anthropic'
  if (harness === 'codex') return 'openai'
  return harness || null
}

function inferRepoName(metadata: Record<string, unknown>): string | null {
  const explicitRepo = stringValue(metadata.repo)
  if (explicitRepo) return explicitRepo
  const cwd = stringValue(metadata.cwd)
  if (!cwd) return null
  const repo = basename(cwd)
  return repo || null
}

function mapOutcomeStatus(status: string): string {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'failure'
  return status
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function firstListItem(value?: string): string | undefined {
  return value?.split(',').map((item) => item.trim()).find(Boolean)
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export default {
  ensureTelemetryImportSchema,
  importTelemetryArtifacts,
  runTelemetryImport,
  getLatestTelemetryImportRun,
  listTelemetryImportRuns,
}

function hydrateTelemetryImportRun(row: Record<string, unknown>): TelemetryImportRunRow {
  return {
    id: Number(row.id),
    status: String(row.status),
    traceRoot: typeof row.trace_root === 'string' ? row.trace_root : null,
    maxAgeHours: typeof row.max_age_hours === 'number' ? row.max_age_hours : row.max_age_hours == null ? null : Number(row.max_age_hours),
    scanned: Number(row.scanned ?? 0),
    imported: Number(row.imported ?? 0),
    skipped: Number(row.skipped ?? 0),
    summary: typeof row.summary_json === 'string' && row.summary_json
      ? JSON.parse(row.summary_json) as TelemetryImportSummary
      : null,
    error: typeof row.error === 'string' ? row.error : null,
    startedAt: String(row.started_at),
    finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
  }
}
