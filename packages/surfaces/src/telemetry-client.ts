import { basename } from 'node:path'

import type { SessionRunOptions, SessionRunResult } from './session-run.js'

export interface SessionRunTelemetryPayload {
  eventKey: string
  sessionName?: string
  source: string
  harness: string
  provider?: string
  model?: string
  repo?: string
  status: string
  inputTokens?: number
  outputTokens?: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  totalTokens?: number
  costUsd?: number
  startedAt?: string
  finishedAt?: string
  metadata: Record<string, unknown>
}

export function buildSessionRunTelemetryPayload(
  result: SessionRunResult,
  options: SessionRunOptions,
): SessionRunTelemetryPayload | null {
  if (!result.execution) return null

  const metadata = result.execution.metadata ?? {}
  const sessionId = result.execution.sessionId ?? result.sessionId ?? metadata.sessionId
  const repo = options.cwd ? basename(options.cwd) : undefined
  const provider = inferProvider(result.provider, metadata)
  const model = metadata.model
    ?? metadata.upstreamModel
    ?? firstListItem(metadata.modelIds)
    ?? undefined
  const inputTokens = numberValue(metadata.inputTokens)
  const outputTokens = numberValue(metadata.outputTokens)
  const cacheCreationTokens = numberValue(metadata.cacheCreationInputTokens)
  const cacheReadTokens = numberValue(metadata.cacheReadInputTokens) ?? numberValue(metadata.cachedInputTokens)
  const totalTokens = numberValue(metadata.totalTokens)
    ?? sumDefined(inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens)

  return {
    eventKey: `session-run:${result.provider}:${sessionId ?? result.execution.startedAt}:${result.action}`,
    sessionName: sessionId,
    source: 'session-run',
    harness: result.provider,
    provider,
    model,
    repo,
    status: result.status === 'completed' ? 'success' : 'failure',
    inputTokens: inputTokens ?? undefined,
    outputTokens: outputTokens ?? undefined,
    cacheCreationTokens: cacheCreationTokens ?? undefined,
    cacheReadTokens: cacheReadTokens ?? undefined,
    totalTokens: totalTokens ?? undefined,
    costUsd: result.execution.costUsd ?? numberValue(metadata.costUsd) ?? numberValue(metadata.totalCostUsd) ?? undefined,
    startedAt: result.execution.startedAt,
    finishedAt: result.execution.finishedAt,
    metadata: {
      action: result.action,
      requestedProvider: result.requestedProvider,
      traceId: result.traceId ?? null,
      resolutionReasons: result.resolutionReasons ?? [],
      detectedFailureReason: result.detectedFailureReason ?? null,
      failureClasses: result.failureClasses ?? [],
      approvalRequired: result.approvalRequired ?? false,
      cwd: options.cwd ?? null,
      targetUrl: options.targetUrl ?? null,
      ...metadata,
    },
  }
}

export async function emitSessionRunTelemetry(
  result: SessionRunResult,
  options: SessionRunOptions,
): Promise<boolean> {
  const payload = buildSessionRunTelemetryPayload(result, options)
  if (!payload) return false

  const baseUrl = process.env.FOREMAN_TELEMETRY_URL
    ?? process.env.FOREMAN_URL
    ?? 'http://127.0.0.1:7374'

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/telemetry/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3_000),
    })
    return response.ok
  } catch {
    return false
  }
}

function inferProvider(harness: string, metadata: Record<string, string>): string | undefined {
  if (metadata.upstreamProvider) return metadata.upstreamProvider
  if (metadata.provider) return metadata.provider
  if (harness === 'claude') return 'anthropic'
  if (harness === 'codex') return 'openai'
  return harness
}

function firstListItem(value?: string): string | undefined {
  if (!value) return undefined
  return value.split(',').map((item) => item.trim()).find(Boolean)
}

function numberValue(value: string | undefined): number | null {
  if (value == null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function sumDefined(...values: Array<number | null>): number | null {
  const defined = values.filter((value): value is number => value != null)
  if (defined.length === 0) return null
  return defined.reduce((sum, value) => sum + value, 0)
}
