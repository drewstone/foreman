/**
 * Foreman HTTP API server.
 *
 * Exposes Foreman's capabilities as an HTTP service:
 *   GET  /status          — session portfolio
 *   GET  /report/:date    — daily report
 *   GET  /metrics         — session metrics aggregate
 *   GET  /search?q=       — session search
 *   POST /webhook         — receive events (GitHub, CI, custom)
 *   POST /run             — spawn a session
 *   POST /learn           — trigger learning loop
 *   GET  /artifacts       — list versioned artifacts
 *   GET  /health          — health check
 *
 * Start: node --import tsx packages/surfaces/src/api-server.ts [--port 4747]
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { VersionedStore } from '@drew/foreman-core'
import { SessionIndex } from '@drew/foreman-memory/session-index'
import { loadSessionMetrics, aggregateMetrics } from './session-metrics.js'
import { notify } from './notify.js'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data, null, 2))
}

function text(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  try {
    // Health
    if (path === '/health') {
      json(res, { status: 'ok', timestamp: new Date().toISOString() })
      return
    }

    // Status — session portfolio
    if (path === '/status' && method === 'GET') {
      try {
        const state = JSON.parse(await readFile(join(FOREMAN_HOME, 'operator-state.json'), 'utf8'))
        json(res, {
          sessions: state.sessions?.length ?? 0,
          blocked: state.sessions?.filter((s: Record<string, unknown>) => s.status === 'blocked').length ?? 0,
          lastHeartbeat: state.lastHeartbeatAt,
          heartbeatCount: state.heartbeatHistory?.length ?? 0,
        })
      } catch {
        json(res, { sessions: 0, error: 'No operator state' }, 404)
      }
      return
    }

    // Daily report
    if (path.startsWith('/report/') && method === 'GET') {
      const date = path.replace('/report/', '')
      try {
        const report = await readFile(join(FOREMAN_HOME, 'reports', `${date}.md`), 'utf8')
        text(res, report)
      } catch {
        text(res, `No report for ${date}`, 404)
      }
      return
    }

    // Session metrics
    if (path === '/metrics' && method === 'GET') {
      const hours = parseInt(url.searchParams.get('hours') ?? '48', 10)
      const metrics = await loadSessionMetrics({ hoursBack: hours })
      json(res, aggregateMetrics(metrics))
      return
    }

    // Search
    if (path === '/search' && method === 'GET') {
      const q = url.searchParams.get('q')
      if (!q) { json(res, { error: 'Missing ?q= parameter' }, 400); return }
      const index = new SessionIndex()
      try {
        const results = index.search({
          query: q,
          repo: url.searchParams.get('repo') ?? undefined,
          limit: parseInt(url.searchParams.get('limit') ?? '20', 10),
        })
        json(res, results.map((r) => ({
          repo: r.message.repo,
          role: r.message.role,
          timestamp: r.message.timestamp,
          snippet: r.snippet,
        })))
      } finally {
        index.close()
      }
      return
    }

    // Webhook receiver
    if (path === '/webhook' && method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const event = body.event ?? body.action ?? 'unknown'

      // GitHub webhook: CI status change
      if (body.check_suite || body.check_run || body.workflow_run) {
        const repo = body.repository?.full_name ?? 'unknown'
        const status = body.check_suite?.conclusion ?? body.workflow_run?.conclusion ?? 'unknown'
        await notify({
          title: `GitHub: ${repo}`,
          body: `CI ${status}`,
          severity: status === 'failure' ? 'critical' : 'info',
          source: 'github-webhook',
        })
        json(res, { received: true, event: 'ci-status', repo, status })
        return
      }

      // Generic webhook
      await notify({
        title: `Webhook: ${event}`,
        body: JSON.stringify(body).slice(0, 500),
        severity: 'info',
        source: 'webhook',
      })
      json(res, { received: true, event })
      return
    }

    // Spawn a session
    if (path === '/run' && method === 'POST') {
      const body = JSON.parse(await readBody(req))
      if (!body.repo || !body.goal) {
        json(res, { error: 'Missing repo or goal' }, 400)
        return
      }
      const { spawnSession } = await import('./session-spawn.js')
      const result = await spawnSession({
        repoPath: body.repo,
        goal: body.goal,
        provider: body.harness ?? 'claude',
        timeoutMs: body.timeoutMs ?? 10 * 60 * 1000,
      })
      json(res, {
        sessionId: result.sessionId,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        metrics: result.metrics,
      })
      return
    }

    // Trigger learning
    if (path === '/learn' && method === 'POST') {
      const { learn } = await import('@drew/foreman-memory/learning')
      const { extractDeepSessionInsights } = await import('./session-insights.js')
      // Minimal learning run
      const result = await learn({
        repoCommands: new Map(),
        repoFiles: new Map(),
        userMessages: [],
        crossRepoPatterns: [],
        suggestedRules: [],
      }, { dryRun: false })
      json(res, result)
      return
    }

    // Artifacts
    if (path === '/artifacts' && method === 'GET') {
      const store = new VersionedStore()
      const kinds = await store.listKinds()
      const artifacts: Array<{ kind: string; name: string; activeVersion: string | null; versionCount: number }> = []
      for (const kind of kinds) {
        const names = await store.listNames(kind)
        for (const name of names) {
          const manifest = await store.getManifest(kind, name)
          artifacts.push({
            kind,
            name,
            activeVersion: manifest.activeVersionId,
            versionCount: manifest.versions.length,
          })
        }
      }
      json(res, artifacts)
      return
    }

    // 404
    json(res, { error: 'Not found', path }, 404)
  } catch (e) {
    json(res, { error: String(e) }, 500)
  }
}

export function startServer(port = 4747): void {
  const server = createServer(handleRequest)
  server.listen(port, () => {
    console.log(`Foreman API server listening on http://localhost:${port}`)
    console.log('Endpoints: /health /status /report/:date /metrics /search /webhook /run /learn /artifacts')
  })
}

// CLI entry
if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') ?? '')) {
  const port = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--port') ?? '4747', 10)
  startServer(port)
}
