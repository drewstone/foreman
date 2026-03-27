import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSessionRunTelemetryPayload } from './telemetry-client.js'

test('buildSessionRunTelemetryPayload normalizes session-run execution metadata', () => {
  const payload = buildSessionRunTelemetryPayload({
    status: 'completed',
    provider: 'claude',
    requestedProvider: 'auto',
    action: 'start',
    sessionId: 'ses_123',
    summary: 'done',
    traceId: 'trace-1',
    resolutionReasons: ['matched claude'],
    execution: {
      command: ['claude'],
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      startedAt: '2026-03-27T00:00:00.000Z',
      finishedAt: '2026-03-27T00:05:00.000Z',
      durationMs: 300000,
      costUsd: 0.42,
      metadata: {
        modelIds: 'claude-sonnet-4-6',
        inputTokens: '1200',
        outputTokens: '400',
        cacheReadInputTokens: '50',
      },
      sessionId: 'ses_123',
    },
  }, {
    provider: 'claude',
    action: 'start',
    prompt: 'Fix auth',
    cwd: '/tmp/foreman',
  })

  assert.ok(payload)
  assert.equal(payload?.eventKey, 'session-run:claude:ses_123:start')
  assert.equal(payload?.provider, 'anthropic')
  assert.equal(payload?.model, 'claude-sonnet-4-6')
  assert.equal(payload?.repo, 'foreman')
  assert.equal(payload?.totalTokens, 1650)
  assert.equal(payload?.costUsd, 0.42)
  assert.equal(payload?.status, 'success')
})
