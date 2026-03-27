/**
 * Foreman Service
 *
 * Standalone daemon. Manages state, sessions, and events.
 * Never makes policy decisions — only executes them.
 *
 * Start: tsx service/index.ts
 * Default: http://localhost:7374
 */

import http from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import Database from 'better-sqlite3'

const execFileAsync = promisify(execFile)

// ─── Shared state ────────────────────────────────────────────────────
import {
  PORT, FOREMAN_HOME, MAX_DAILY_COST_USD,
  WATCHER_INTERVAL_MS,
  type Stmts,
  sseClients,
  initState,
  log, emitEvent, sendNotification,
} from './lib/state.js'

// ─── Extracted modules ───────────────────────────────────────────────
import {
  tmux, tmuxQuiet, isTmuxAlive, captureTmux,
  detectIdle, detectClaudeReady, sessionName,
  pendingPrompts, getBackend, spawnSession, selectModel, sendPrompt,
} from './lib/session-manager.js'
import { watcherTick } from './lib/watcher.js'
import { harvestOutcome } from './lib/harvester.js'
import { composePrompt, createWorktree } from './lib/prompt-composer.js'
import { cleanupWorktrees, reapZombieSessions } from './lib/maintenance.js'
import { runLearningLoop, runDeepAnalysis } from './lib/learning-loop.js'

// ─── Existing lib modules ────────────────────────────────────────────
import { createProposal, listProposals, updateProposalStatus, openProposalPR as openSkillPR } from './lib/skill-proposals.js'
import { getDispatchPolicy, getDispatchPolicyByName, initGepaPolicy, listDispatchPolicies, policyRequiresLiveCalls, type DispatchContext } from './lib/dispatch-policy.js'
import { buildIdeationDispatch, buildFullPlanDispatch, parseIdeationOutput, listPlans, updatePlanStatus, getPlan, openProposalPR as openPlanPR, type PlanGeneratorContext } from './lib/plan-generator.js'
import { callClaudeForJSON } from './lib/claude-runner.js'
import { verifyDeliverable, runTestGate, type DeliverableSpec, type ScopeSpec } from './lib/verify-deliverable.js'
import { installScopeHook, removeScopeHook, type ScopeConfig } from './lib/scope-enforcer.js'
import { ConfidenceStore } from '@drew/foreman-memory/confidence'
import { readSessionTranscript, type SessionSummary } from './lib/session-reader.js'
import { reviewSession } from './lib/session-reviewer.js'
import { maybeAutoDispatch } from './lib/auto-dispatch.js'
import { runPromptLabCycle, pullSamples, getActiveExperiment, getDefaultSurfaces } from './lib/prompt-lab.js'
import telemetry from './lib/telemetry.js'
const {
  ensureTelemetrySchema,
  recordTelemetryRun,
  summarizeTelemetry,
  listTelemetryRuns,
  getDailyTelemetryCost,
  summarizeTelemetryCoverage,
  summarizeTelemetrySources,
  summarizeTelemetryHarnessHealth,
} = telemetry
import replay from './lib/replay.js'

const { listReplayExamples, summarizeReplayExamples, exportReplayDataset, evaluateReplayPolicy } = replay
import policyControl from './lib/policy-control.js'
import replayGovernor from './lib/replay-governor.js'
import telemetryImport from './lib/telemetry-import.js'

const {
  ensurePolicyControlSchema,
  getDispatchPolicyControl,
  setDispatchPolicyControl,
  getLatestReplayPolicyEvaluation,
  listReplayPolicyEvaluations,
} = policyControl
const { promoteReplayPolicy, getReplayGovernanceSnapshot } = replayGovernor
const {
  ensureTelemetryImportSchema,
  runTelemetryImport,
  getLatestTelemetryImportRun,
  listTelemetryImportRuns,
} = telemetryImport

// ─── Database ────────────────────────────────────────────────────────

const DB_PATH = join(FOREMAN_HOME, 'foreman.db')

mkdirSync(join(FOREMAN_HOME, 'logs'), { recursive: true })
mkdirSync(join(FOREMAN_HOME, 'worktrees'), { recursive: true })

// ─── Confidence (per-skill, per-project autonomy) ────────────────────

const confidence = new ConfidenceStore(join(FOREMAN_HOME, 'confidence.db'))

// ─── Database ────────────────────────────────────────────────────────

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    workspace_path TEXT,
    workspace_type TEXT NOT NULL DEFAULT 'repo',
    context TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER REFERENCES goals(id),
    skill TEXT NOT NULL,
    task TEXT NOT NULL,
    reasoning TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'dispatched',
    origin TEXT NOT NULL DEFAULT 'operator',
    outcome TEXT,
    learnings TEXT,
    metrics TEXT,
    taste_signal TEXT,
    session_name TEXT,
    worktree_path TEXT,
    worktree_branch TEXT,
    base_branch TEXT,
    template_version INTEGER,
    cost_usd REAL,
    origin TEXT DEFAULT 'operator',
    deliverable_path TEXT,
    deliverable_spec TEXT,
    scope_spec TEXT,
    prompt_sections TEXT,
    deliverable_status TEXT DEFAULT 'unchecked',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    name TEXT PRIMARY KEY,
    goal_id INTEGER REFERENCES goals(id),
    decision_id INTEGER REFERENCES decisions(id),
    work_dir TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting',
    prompt TEXT,
    backend TEXT,
    model TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_checked_at TEXT,
    last_output TEXT
  );

  CREATE TABLE IF NOT EXISTS taste (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,
    source TEXT,
    weight REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    session_name TEXT,
    goal_id INTEGER,
    data TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS operator_sessions (
    id TEXT PRIMARY KEY,
    harness TEXT NOT NULL,
    repo TEXT,
    timestamp TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    user_messages TEXT,
    skills_used TEXT,
    outcome_signals TEXT,
    scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prompt_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL,
    template TEXT NOT NULL,
    score REAL,
    dispatches INTEGER NOT NULL DEFAULT 0,
    successes INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT,
    project TEXT,
    weight REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_decisions_goal ON decisions(goal_id);
  CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
`)
ensureTelemetrySchema(db)
ensureTelemetryImportSchema(db)
ensurePolicyControlSchema(db)

// Migrations for existing databases
try { db.exec(`ALTER TABLE decisions ADD COLUMN origin TEXT NOT NULL DEFAULT 'operator'`) } catch {}
try { db.exec(`ALTER TABLE decisions ADD COLUMN base_branch TEXT`) } catch {}
try { db.exec(`ALTER TABLE decisions ADD COLUMN template_version INTEGER`) } catch {}
try { db.exec(`ALTER TABLE decisions ADD COLUMN deliverable_path TEXT`) } catch {}
try { db.exec(`ALTER TABLE decisions ADD COLUMN deliverable_spec TEXT`) } catch {}
try { db.exec(`ALTER TABLE decisions ADD COLUMN scope_spec TEXT`) } catch {}
try { db.exec(`ALTER TABLE decisions ADD COLUMN prompt_sections TEXT`) } catch {}
try { db.exec(`ALTER TABLE decisions ADD COLUMN deliverable_status TEXT DEFAULT 'unchecked'`) } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN transcript_path TEXT`) } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN backend TEXT`) } catch {}
try { db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT`) } catch {}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_operator_sessions_repo ON operator_sessions(repo);
  CREATE INDEX IF NOT EXISTS idx_learnings_type ON learnings(type);
  CREATE INDEX IF NOT EXISTS idx_prompt_templates_active ON prompt_templates(active);

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '[]',
    env TEXT,
    scope TEXT NOT NULL DEFAULT 'global',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// ─── Prepared statements ─────────────────────────────────────────────

const stmts = {
  insertGoal: db.prepare(`INSERT INTO goals (intent, workspace_path, workspace_type, context, priority) VALUES (?, ?, ?, ?, ?)`),
  updateGoal: db.prepare(`UPDATE goals SET status = ?, updated_at = datetime('now') WHERE id = ?`),
  getGoal: db.prepare(`SELECT * FROM goals WHERE id = ?`),
  listGoals: db.prepare(`SELECT * FROM goals WHERE status = 'active' ORDER BY priority DESC, created_at DESC`),

  insertDecision: db.prepare(`INSERT INTO decisions (goal_id, skill, task, reasoning, session_name, worktree_path, worktree_branch, base_branch, template_version, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateDecision: db.prepare(`UPDATE decisions SET status = ?, outcome = ?, learnings = ?, metrics = ?, taste_signal = ?, cost_usd = ?, updated_at = datetime('now') WHERE id = ?`),
  getDecision: db.prepare(`SELECT * FROM decisions WHERE id = ?`),
  listDecisions: db.prepare(`SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?`),
  searchDecisions: db.prepare(`SELECT * FROM decisions WHERE task LIKE ? OR outcome LIKE ? OR learnings LIKE ? OR skill LIKE ? OR session_name LIKE ? OR reasoning LIKE ? ORDER BY created_at DESC LIMIT ?`),
  goalDecisions: db.prepare(`SELECT * FROM decisions WHERE goal_id = ? ORDER BY created_at DESC`),

  insertSession: db.prepare(`INSERT OR REPLACE INTO sessions (name, goal_id, decision_id, work_dir, status, prompt, backend, model) VALUES (?, ?, ?, ?, 'starting', ?, ?, ?)`),
  updateSession: db.prepare(`UPDATE sessions SET status = ?, last_checked_at = datetime('now'), last_output = ? WHERE name = ?`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE name = ?`),
  listSessions: db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC`),
  activeSessions: db.prepare(`SELECT * FROM sessions WHERE status IN ('starting', 'running', 'idle')`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE name = ?`),

  insertTaste: db.prepare(`INSERT INTO taste (pattern, source, weight) VALUES (?, ?, ?)`),
  listTaste: db.prepare(`SELECT * FROM taste ORDER BY weight DESC, created_at DESC LIMIT ?`),

  insertEvent: db.prepare(`INSERT INTO events (type, session_name, goal_id, data) VALUES (?, ?, ?, ?)`),
  recentEvents: db.prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT ?`),

  // MCP servers
  upsertMcp: db.prepare(`INSERT OR REPLACE INTO mcp_servers (id, name, command, args, env, scope) VALUES (?, ?, ?, ?, ?, ?)`),
  deleteMcp: db.prepare(`DELETE FROM mcp_servers WHERE id = ?`),
  listMcp: db.prepare(`SELECT * FROM mcp_servers ORDER BY name`),
  getMcp: db.prepare(`SELECT * FROM mcp_servers WHERE id = ?`),
  mcpByScope: db.prepare(`SELECT * FROM mcp_servers WHERE scope = ? OR scope = 'global'`),

  // Operator sessions
  upsertOperatorSession: db.prepare(`INSERT OR REPLACE INTO operator_sessions (id, harness, repo, timestamp, message_count, user_messages, skills_used, outcome_signals) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  operatorSessionCount: db.prepare(`SELECT COUNT(*) as count FROM operator_sessions`),
  recentOperatorSessions: db.prepare(`SELECT * FROM operator_sessions WHERE repo = ? ORDER BY timestamp DESC LIMIT ?`),
  latestScanTimestamp: db.prepare(`SELECT MAX(scanned_at) as latest FROM operator_sessions`),

  // Learnings
  insertLearning: db.prepare(`INSERT INTO learnings (type, content, source, project, weight) VALUES (?, ?, ?, ?, ?)`),
  learningsByType: db.prepare(`SELECT * FROM learnings WHERE type = ? ORDER BY weight DESC, created_at DESC LIMIT ?`),
  learningsByProject: db.prepare(`SELECT * FROM learnings WHERE project = ? ORDER BY weight DESC LIMIT ?`),
  allLearnings: db.prepare(`SELECT * FROM learnings ORDER BY weight DESC, created_at DESC LIMIT ?`),

  // Prompt templates
  insertTemplate: db.prepare(`INSERT INTO prompt_templates (version, template, active) VALUES (?, ?, ?)`),
  activeTemplate: db.prepare(`SELECT * FROM prompt_templates WHERE active = 1 ORDER BY version DESC LIMIT 1`),
  updateTemplateScore: db.prepare(`UPDATE prompt_templates SET score = ?, dispatches = ?, successes = ? WHERE id = ?`),
  promoteTemplate: db.prepare(`UPDATE prompt_templates SET active = CASE WHEN id = ? THEN 1 ELSE 0 END`),
  listTemplates: db.prepare(`SELECT * FROM prompt_templates ORDER BY version DESC LIMIT ?`),
}

// Initialize shared state for extracted modules
initState(db, stmts as unknown as Stmts, confidence)

// log imported from ./lib/state.js

// ─── API helpers ─────────────────────────────────────────────────────

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(data))
}

function error(res: http.ServerResponse, msg: string, status = 400): void {
  json(res, { error: msg }, status)
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString())
}

function parseQuery(url: string): URLSearchParams {
  const idx = url.indexOf('?')
  return new URLSearchParams(idx >= 0 ? url.slice(idx + 1) : '')
}

// ─── API routes ──────────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url ?? '/'
  const method = req.method ?? 'GET'
  const path = url.split('?')[0]

  // CORS
  if (method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' })
    res.end()
    return
  }

  try {
    // ── Health ─────────────────────────────────────────────────
    if (path === '/api/health') {
      return json(res, { status: 'ok', uptime: process.uptime() })
    }

    // ── Status (portfolio overview) ───────────────────────────
    if (path === '/api/status' && method === 'GET') {
      const goals = stmts.listGoals.all()
      const sessions = stmts.activeSessions.all() as Array<{ name: string, status: string }>
      const recentDecisions = stmts.listDecisions.all(20)
      const events = stmts.recentEvents.all(10)
      const activePolicy = getDispatchPolicyControl(db)
      const latestReplayEvaluation = getLatestReplayPolicyEvaluation(db)

      // Enrich sessions with live tmux data
      const enriched = sessions.map(s => ({
        ...s,
        alive: isTmuxAlive(s.name),
        idle: detectIdle(s.name),
        lastOutput: captureTmux(s.name, 1).trim().split('\n').pop() ?? '',
      }))

      return json(res, { goals, sessions: enriched, recentDecisions, events, activePolicy, latestReplayEvaluation })
    }

    // ── Goals ─────────────────────────────────────────────────
    if (path === '/api/goals' && method === 'POST') {
      const body = await readBody(req)
      const intent = String(body.intent ?? '')
      if (!intent) return error(res, 'intent required')

      const result = stmts.insertGoal.run(
        intent,
        body.workspace_path ?? null,
        body.workspace_type ?? 'repo',
        body.context ?? null,
        body.priority ?? 0,
      )
      const goal = stmts.getGoal.get(result.lastInsertRowid)
      return json(res, goal, 201)
    }

    if (path === '/api/goals' && method === 'GET') {
      return json(res, stmts.listGoals.all())
    }

    // ── Replay Harness ───────────────────────────────────────
    if (path === '/api/replay/summary' && method === 'GET') {
      const limit = parseInt(parseQuery(url).get('limit') ?? '250', 10)
      const project = parseQuery(url).get('project') ?? undefined
      const skill = parseQuery(url).get('skill') ?? undefined
      const examples = listReplayExamples(db, {
        limit: Number.isFinite(limit) ? limit : 250,
        project,
        skill,
      })
      return json(res, summarizeReplayExamples(examples))
    }

    if (path === '/api/replay/examples' && method === 'GET') {
      const limit = parseInt(parseQuery(url).get('limit') ?? '50', 10)
      const project = parseQuery(url).get('project') ?? undefined
      const skill = parseQuery(url).get('skill') ?? undefined
      return json(res, listReplayExamples(db, {
        limit: Number.isFinite(limit) ? limit : 50,
        project,
        skill,
      }))
    }

    if (path === '/api/replay/export' && method === 'GET') {
      const limit = parseInt(parseQuery(url).get('limit') ?? '250', 10)
      const project = parseQuery(url).get('project') ?? undefined
      const skill = parseQuery(url).get('skill') ?? undefined
      return json(res, exportReplayDataset(db, {
        limit: Number.isFinite(limit) ? limit : 250,
        project,
        skill,
      }))
    }

    if (path === '/api/replay/policies' && method === 'GET') {
      return json(res, listDispatchPolicies())
    }

    if (path === '/api/replay/latest' && method === 'GET') {
      return json(res, getReplayGovernanceSnapshot(db))
    }

    if (path === '/api/replay/history' && method === 'GET') {
      const limit = parseInt(parseQuery(url).get('limit') ?? '10', 10)
      return json(res, listReplayPolicyEvaluations(db, {
        limit: Number.isFinite(limit) ? limit : 10,
      }))
    }

    if (path === '/api/replay/evaluate' && method === 'GET') {
      const policyName = parseQuery(url).get('policy') ?? 'identity'
      const baselineName = parseQuery(url).get('baseline') ?? (policyName === 'identity' ? null : 'identity')
      const allowLive = parseQuery(url).get('allow_live') === 'true'
      const limit = parseInt(parseQuery(url).get('limit') ?? '50', 10)
      const project = parseQuery(url).get('project') ?? undefined
      const skill = parseQuery(url).get('skill') ?? undefined
      const minExamples = parseInt(parseQuery(url).get('min_examples') ?? '', 10)
      const minGoodExamples = parseInt(parseQuery(url).get('min_good_examples') ?? '', 10)
      const minBadExamples = parseInt(parseQuery(url).get('min_bad_examples') ?? '', 10)
      const policy = getDispatchPolicyByName(policyName)
      const baselinePolicy = baselineName ? getDispatchPolicyByName(baselineName) : null

      if (!policy) return error(res, `unknown policy: ${policyName}`, 404)
      if (baselineName && !baselinePolicy) return error(res, `unknown baseline policy: ${baselineName}`, 404)
      if (policyRequiresLiveCalls(policyName) && !allowLive) {
        return error(res, `policy ${policyName} requires live model calls; pass allow_live=true to run it`, 400)
      }
      if (baselineName && policyRequiresLiveCalls(baselineName) && !allowLive) {
        return error(res, `baseline policy ${baselineName} requires live model calls; pass allow_live=true to run it`, 400)
      }

      const examples = listReplayExamples(db, {
        limit: Number.isFinite(limit) ? limit : 50,
        project,
        skill,
      })
      return json(res, await evaluateReplayPolicy(examples, {
        policyName,
        decide: (ctx) => policy.decide(ctx),
        baseline: baselineName && baselinePolicy
          ? {
              policyName: baselineName,
              decide: (ctx) => baselinePolicy.decide(ctx),
            }
          : undefined,
        telemetryDb: db,
        promotionRule: {
          minExamples: Number.isFinite(minExamples) ? minExamples : undefined,
          minGoodExamples: Number.isFinite(minGoodExamples) ? minGoodExamples : undefined,
          minBadExamples: Number.isFinite(minBadExamples) ? minBadExamples : undefined,
        },
      }))
    }

    if (path === '/api/replay/promote' && method === 'POST') {
      const body = await readBody(req)
      const policyName = String(body.policy ?? body.policyName ?? '')
      if (!policyName) return error(res, 'policy required')
      try {
        return json(res, await promoteReplayPolicy(db, {
          policyName,
          baselineName: body.baseline != null ? String(body.baseline) : undefined,
          project: body.project ? String(body.project) : undefined,
          skill: body.skill ? String(body.skill) : undefined,
          limit: body.limit != null ? Number(body.limit) : undefined,
          apply: body.apply === true,
          force: body.force === true,
          allowLive: body.allowLive === true,
          promotionRule: {
            minExamples: body.minExamples != null ? Number(body.minExamples) : undefined,
            minGoodExamples: body.minGoodExamples != null ? Number(body.minGoodExamples) : undefined,
            minBadExamples: body.minBadExamples != null ? Number(body.minBadExamples) : undefined,
          },
        }))
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return error(res, message, message.startsWith('unknown') ? 404 : 400)
      }
    }

    if (path === '/api/policy/dispatch' && method === 'GET') {
      return json(res, {
        active: getDispatchPolicyControl(db),
        policies: listDispatchPolicies(),
        latestReplayEvaluation: getLatestReplayPolicyEvaluation(db),
      })
    }

    if (path === '/api/policy/dispatch' && method === 'POST') {
      const body = await readBody(req)
      const policyName = String(body.policy ?? body.policyName ?? '')
      const source = String(body.source ?? 'manual_override')
      if (!policyName || !getDispatchPolicyByName(policyName)) return error(res, `unknown policy: ${policyName}`, 404)
      return json(res, setDispatchPolicyControl(db, {
        policyName,
        source,
        baselinePolicyName: body.baselinePolicyName ? String(body.baselinePolicyName) : null,
      }))
    }

    // ── Dispatch ──────────────────────────────────────────────
    if (path === '/api/dispatch' && method === 'POST') {
      const body = await readBody(req)
      const goalId = Number(body.goal_id ?? 0)
      const skill = String(body.skill ?? '')
      const task = String(body.task ?? '')
      const reasoning = String(body.reasoning ?? '')
      const workDir = String(body.work_dir ?? '')
      const label = String(body.label ?? '')
      const backendName = String(body.backend ?? 'tmux') // 'tmux' (local), 'tangle' (remote sandbox)
      // Worktree is ON by default for tmux — Foreman never touches the operator's working directory.
      // Tangle backend handles isolation via containers, so worktrees aren't needed.
      const useWorktree = backendName === 'tmux' && body.worktree !== false

      if (!task) return error(res, 'task required')
      if (!workDir && !goalId) return error(res, 'work_dir or goal_id required')
      const dailyCost = getDailyTelemetryCost(db)
      if (dailyCost >= MAX_DAILY_COST_USD) {
        return error(res, `daily cost cap reached: $${dailyCost.toFixed(2)} >= $${MAX_DAILY_COST_USD}`, 429)
      }

      // Resolve work directory (the operator's repo)
      let repoDir = workDir
      let effectiveWorkDir = workDir
      let worktreePath: string | null = null
      let worktreeBranch: string | null = null
      let baseBranch: string | null = null

      if (!repoDir && goalId) {
        const goal = stmts.getGoal.get(goalId) as { workspace_path?: string } | undefined
        repoDir = goal?.workspace_path ?? ''
        effectiveWorkDir = repoDir
      }

      if (!repoDir) return error(res, 'cannot resolve work directory')

      // Gen 9: Sibling deduplication — check if another active session targets the same repo
      const activeSessions = stmts.activeSessions.all() as Array<{ name: string, work_dir: string }>
      const siblingCount = activeSessions.filter(s => s.work_dir.includes(repoDir.split('/').pop()!)).length
      if (siblingCount > 0 && !body.force) {
        log(`Sibling dedup: ${siblingCount} active sessions on ${repoDir}`)
      }

      // Create worktree — Foreman always works in isolation.
      // Branches from the operator's current branch so it builds on their latest work.
      // Auto-generates a label if none provided (skill name + timestamp).
      if (useWorktree) {
        const isGitRepo = existsSync(join(repoDir, '.git'))
        if (isGitRepo) {
          const autoLabel = label || `${(skill.replace(/^\//, '') || 'work').replace(/[^a-z0-9]/gi, '-')}-${Date.now().toString(36)}`
          const wt = await createWorktree(repoDir, autoLabel)
          if (wt) {
            worktreePath = wt.path
            worktreeBranch = wt.branch
            baseBranch = wt.baseBranch
            effectiveWorkDir = wt.path
          } else {
            // Fall back to direct work if worktree fails (non-git, bare repo, etc.)
            log(`Worktree creation failed for ${repoDir}, falling back to direct`)
          }
        }
      }

      // Session name includes label for parallel dispatch support
      const sName = sessionName(label || (effectiveWorkDir.split('/').pop() ?? 'session'))
      // Get active template version for tracking
      const activeTpl = stmts.activeTemplate.get() as { version: number } | undefined
      const tplVersion = activeTpl?.version ?? 1

      // Truncate task for DB storage — full prompt goes in sessions.prompt
      // Deliverable + scope specs (Gen 9: measure achievement, not activity)
      const deliverableSpec = body.deliverable ? JSON.stringify(body.deliverable) : null
      const scopeSpec = body.scope ? JSON.stringify(body.scope) : null
      const deliverablePath = (body.deliverable as Record<string, unknown>)?.path as string ?? null

      const taskTruncated = task.slice(0, 500)
      const result = stmts.insertDecision.run(goalId || null, skill, taskTruncated, reasoning, sName, worktreePath, worktreeBranch, baseBranch, tplVersion, 'operator')
      // Store deliverable/scope specs
      if (deliverableSpec || scopeSpec || deliverablePath) {
        db.prepare(`UPDATE decisions SET deliverable_path = ?, deliverable_spec = ?, scope_spec = ? WHERE id = ?`)
          .run(deliverablePath, deliverableSpec, scopeSpec, Number(result.lastInsertRowid))
      }

      // Gen 10: Install git pre-commit hook for scope enforcement
      const scopeBody = body.scope as Record<string, unknown> | undefined
      if (scopeBody?.allowedPaths && worktreePath) {
        const hookPath = installScopeHook(worktreePath, scopeBody as unknown as ScopeConfig)
        if (hookPath) log(`Scope hook installed in ${worktreePath}: ${(scopeBody.allowedPaths as string[]).join(', ')}`)
      }
      const decisionId = Number(result.lastInsertRowid)

      // Compose prompt (Gen 9: slim for execution, rich for reasoning)
      const goalRow = goalId ? stmts.getGoal.get(goalId) as { intent?: string } | undefined : undefined
      const composed = composePrompt({
        skill,
        task,
        workDir: effectiveWorkDir,
        goalIntent: goalRow?.intent,
        goalId: goalId || undefined,
        worktreeBranch,
        baseBranch,
        repoDir: worktreePath ? repoDir : null,
      })
      // Store prompt sections for ablation analysis
      db.prepare(`UPDATE decisions SET prompt_sections = ? WHERE id = ?`)
        .run(JSON.stringify(composed.sections), decisionId)

      const model = selectModel(skill, task)
      const requestedModel = body.model ? String(body.model) : undefined
      const effectiveModel = requestedModel ?? model ?? undefined

      spawnSession({
        name: sName,
        workDir: effectiveWorkDir,
        prompt: composed.text,
        goalId: goalId || null as unknown as number,
        decisionId,
        backend: backendName,
        model: effectiveModel,
      })

      const decision = stmts.getDecision.get(decisionId)
      // Confidence level for this dispatch
      const dispatchProject = (worktreePath ?? effectiveWorkDir).split('/').pop() ?? ''
      const confidenceLevel = confidence.getLevel(skill || 'direct', dispatchProject)
      const confidenceScore = confidence.getConfidence(skill || 'direct', dispatchProject)

      return json(res, { decision, session: sName, backend: backendName, model: effectiveModel, worktree: worktreePath, branch: worktreeBranch, baseBranch, confidenceLevel, confidenceScore, promptLength: composed.text.length, promptTier: composed.tier, promptSections: composed.sections, promptPreview: composed.text.slice(0, 300) }, 201)
    }

    // ── Sessions ──────────────────────────────────────────────
    if (path === '/api/sessions' && method === 'GET') {
      const sessions = stmts.listSessions.all() as Array<{ name: string }>
      const enriched = sessions.map(s => ({
        ...s,
        alive: isTmuxAlive(s.name),
        idle: detectIdle(s.name),
      }))
      return json(res, enriched)
    }

    if (path.startsWith('/api/sessions/') && method === 'GET') {
      const name = decodeURIComponent(path.slice('/api/sessions/'.length))
      const session = stmts.getSession.get(name) as { name: string } | undefined
      if (!session) return error(res, 'session not found', 404)

      const lines = parseInt(parseQuery(url).get('lines') ?? '30', 10)
      const output = isTmuxAlive(name) ? captureTmux(name, lines) : ''

      // Git stats
      let gitLog = ''
      try {
        const s = session as { work_dir?: string }
        if (s.work_dir) {
          const { stdout } = await execFileAsync('git', ['log', '--oneline', '-5'], { cwd: s.work_dir, timeout: 5_000 })
          gitLog = stdout.trim()
        }
      } catch {}

      return json(res, {
        ...session,
        alive: isTmuxAlive(name),
        idle: detectIdle(name),
        output: output.trim(),
        gitLog,
      })
    }

    if (path.startsWith('/api/sessions/') && method === 'DELETE') {
      const name = decodeURIComponent(path.slice('/api/sessions/'.length))
      tmuxQuiet(['kill-session', '-t', name])
      stmts.updateSession.run('dead', '', name)
      pendingPrompts.delete(name)
      return json(res, { killed: name })
    }

    // ── Outcomes ──────────────────────────────────────────────
    if (path === '/api/outcomes' && method === 'POST') {
      const body = await readBody(req)
      const decisionId = Number(body.decision_id ?? 0)
      if (!decisionId) return error(res, 'decision_id required')

      const status = String(body.status ?? 'success')
      const outcome = String(body.outcome ?? '')
      const learnings = body.learnings ? JSON.stringify(body.learnings) : null
      const metrics = body.metrics ? JSON.stringify(body.metrics) : null
      const tasteSignal = body.taste_signal ? String(body.taste_signal) : null
      const telemetryPayload = body.telemetry && typeof body.telemetry === 'object'
        ? body.telemetry as Record<string, unknown>
        : null
      const telemetryCostUsd = telemetryPayload?.costUsd != null ? Number(telemetryPayload.costUsd) : null
      const costUsd = body.cost_usd != null ? Number(body.cost_usd) : telemetryCostUsd

      stmts.updateDecision.run(status, outcome, learnings, metrics, tasteSignal, costUsd, decisionId)
      if (telemetryPayload) {
        try {
          const decision = stmts.getDecision.get(decisionId) as {
            goal_id?: number | null
            session_name?: string | null
            skill?: string | null
            worktree_path?: string | null
          } | undefined
          recordTelemetryRun(db, {
            eventKey: String(telemetryPayload.eventKey ?? `manual:${decisionId}`),
            decisionId,
            goalId: decision?.goal_id ?? null,
            sessionName: decision?.session_name ?? null,
            source: 'api/outcomes',
            harness: String(telemetryPayload.harness ?? 'unknown'),
            provider: telemetryPayload.provider ? String(telemetryPayload.provider) : null,
            model: telemetryPayload.model ? String(telemetryPayload.model) : null,
            skill: decision?.skill ?? null,
            repo: decision?.worktree_path ? String(decision.worktree_path).split('/').pop() ?? null : null,
            status,
            inputTokens: telemetryPayload.inputTokens != null ? Number(telemetryPayload.inputTokens) : null,
            outputTokens: telemetryPayload.outputTokens != null ? Number(telemetryPayload.outputTokens) : null,
            cacheCreationTokens: telemetryPayload.cacheCreationTokens != null ? Number(telemetryPayload.cacheCreationTokens) : null,
            cacheReadTokens: telemetryPayload.cacheReadTokens != null ? Number(telemetryPayload.cacheReadTokens) : null,
            totalTokens: telemetryPayload.totalTokens != null ? Number(telemetryPayload.totalTokens) : null,
            costUsd,
            startedAt: telemetryPayload.startedAt ? String(telemetryPayload.startedAt) : null,
            finishedAt: telemetryPayload.finishedAt ? String(telemetryPayload.finishedAt) : new Date().toISOString(),
            metadata: telemetryPayload,
          })
        } catch (e) {
          log(`Telemetry ingest failed for decision ${decisionId}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // Record taste if signal provided + update confidence
      if (tasteSignal && tasteSignal !== 'neutral') {
        const decision = stmts.getDecision.get(decisionId) as { skill: string, task: string, worktree_path: string | null } | undefined
        if (decision) {
          const pattern = `${tasteSignal}: ${decision.skill} for "${decision.task.slice(0, 100)}"`
          stmts.insertTaste.run(pattern, `decision:${decisionId}`, tasteSignal === 'approved' ? 1.0 : -1.0)

          // Operator taste → confidence signal
          const projectName = (decision.worktree_path ?? '').split('/').pop() ?? 'unknown'
          const confSignal = tasteSignal === 'approved' ? 'agree' as const : 'disagree' as const
          confidence.update(decision.skill || 'direct', projectName, confSignal)
        }
      }

      emitEvent('outcome_logged', null, null, { decisionId, status })

      return json(res, stmts.getDecision.get(decisionId))
    }

    // ── Decisions search ──────────────────────────────────────
    if (path === '/api/decisions' && method === 'GET') {
      const query = parseQuery(url)
      const q = query.get('q')
      const goalId = query.get('goal_id')
      const limit = parseInt(query.get('limit') ?? '50', 10)

      if (goalId) {
        return json(res, stmts.goalDecisions.all(parseInt(goalId, 10)))
      }
      if (q) {
        const pattern = `%${q}%`
        return json(res, stmts.searchDecisions.all(pattern, pattern, pattern, pattern, pattern, pattern, limit))
      }
      return json(res, stmts.listDecisions.all(limit))
    }

    // ── Taste ─────────────────────────────────────────────────
    if (path === '/api/taste' && method === 'GET') {
      const limit = parseInt(parseQuery(url).get('limit') ?? '20', 10)
      return json(res, stmts.listTaste.all(limit))
    }

    if (path === '/api/taste' && method === 'POST') {
      const body = await readBody(req)
      stmts.insertTaste.run(String(body.pattern ?? ''), body.source ?? null, Number(body.weight ?? 1.0))
      return json(res, { ok: true }, 201)
    }

    // ── Events (SSE) ──────────────────────────────────────────
    if (path === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    // ── Project context (reads filesystem) ────────────────────
    if (path === '/api/context' && method === 'GET') {
      const projectPath = parseQuery(url).get('path')
      if (!projectPath) return error(res, 'path required')

      try {
        if (!statSync(projectPath).isDirectory()) return error(res, 'not a directory')
      } catch { return error(res, 'path does not exist') }

      const context: Record<string, string> = {}

      for (const f of ['README.md', 'readme.md', 'CLAUDE.md', 'package.json', 'Cargo.toml', 'pyproject.toml']) {
        const fp = join(projectPath, f)
        if (existsSync(fp)) {
          try { context[f] = readFileSync(fp, 'utf8').slice(0, 2000) } catch {}
        }
      }

      // Git log
      try {
        const { stdout } = await execFileAsync('git', ['log', '--oneline', '-10'], { cwd: projectPath, timeout: 5_000 })
        context['git_log'] = stdout.trim()
      } catch {}

      // Evolve/autoresearch state
      for (const f of ['.evolve/current.json', '.evolve/progress.md', 'evolve-progress.md', 'autoresearch.md', '.evolve/scorecard.json']) {
        const fp = join(projectPath, f)
        if (existsSync(fp)) {
          try { context[f] = readFileSync(fp, 'utf8').slice(0, 1000) } catch {}
        }
      }

      // Pursue docs
      try {
        const pursueDir = join(projectPath, '.evolve', 'pursuits')
        if (existsSync(pursueDir)) {
          for (const f of readdirSync(pursueDir)) {
            if (f.endsWith('.md')) {
              context[`.evolve/pursuits/${f}`] = readFileSync(join(pursueDir, f), 'utf8').slice(0, 1000)
            }
          }
        } else {
          for (const f of readdirSync(projectPath)) {
            if (f.startsWith('pursue-') && f.endsWith('.md')) {
              context[f] = readFileSync(join(projectPath, f), 'utf8').slice(0, 1000)
            }
          }
        }
      } catch {}

      return json(res, context)
    }

    // ── Learning loop ──────────────────────────────────────────
    if (path === '/api/learn' && method === 'POST') {
      const result = runLearningLoop()
      return json(res, result)
    }

    if (path === '/api/analyze' && method === 'POST') {
      try {
        const result = await runDeepAnalysis()
        return json(res, result)
      } catch (e) {
        return error(res, e instanceof Error ? e.message : String(e), 500)
      }
    }

    if (path === '/api/cleanup' && method === 'POST') {
      try {
        const cleaned = await cleanupWorktrees()
        return json(res, { cleaned })
      } catch (e) {
        return error(res, e instanceof Error ? e.message : String(e), 500)
      }
    }

    // ── Self-improvement (Hyperagents-inspired) ────────────────
    // Dispatches a session on the Foreman repo itself.
    // The session works in a worktree, can modify service code,
    // runs tests, and opens a PR for operator review.
    if (path === '/api/self-improve' && method === 'POST') {
      const body = await readBody(req)
      const task = String(body.task ?? 'Review the Foreman service code and suggest improvements')
      const skill = String(body.skill ?? '/evolve')

      // Foreman's own repo
      const foremanRepo = process.cwd()

      // Create a goal if none exists for self-improvement
      let goalId: number
      const existingGoal = db.prepare(`SELECT id FROM goals WHERE intent LIKE '%foreman%self%' OR intent LIKE '%improve foreman%' LIMIT 1`).get() as { id: number } | undefined
      if (existingGoal) {
        goalId = existingGoal.id
      } else {
        const r = stmts.insertGoal.run('Improve Foreman itself — better prompts, better code, better outcomes', foremanRepo, 'repo', null, 0)
        goalId = Number(r.lastInsertRowid)
      }

      // Dispatch with worktree isolation
      const autoLabel = `self-${skill.replace(/^\//, '')}-${Date.now().toString(36)}`
      const wt = await createWorktree(foremanRepo, autoLabel)
      if (!wt) return error(res, 'Failed to create worktree for self-improvement')

      const sName = sessionName(autoLabel)
      const activeTpl = stmts.activeTemplate.get() as { version: number } | undefined
      const selfTask = `${task.slice(0, 500)}\n\nIMPORTANT: After making changes, run the type checker: ./node_modules/.bin/tsc --noEmit --esModuleInterop --target ES2022 --module nodenext --moduleResolution nodenext --skipLibCheck service/index.ts\nFix any errors before committing.`

      const result = stmts.insertDecision.run(goalId, skill, selfTask.slice(0, 500), 'self-improvement dispatch', sName, wt.path, wt.branch, wt.baseBranch, activeTpl?.version ?? 1, 'auto')
      const decisionId = Number(result.lastInsertRowid)

      const composed = composePrompt({
        skill, task: selfTask, workDir: wt.path, goalIntent: 'Improve Foreman itself',
        goalId, worktreeBranch: wt.branch, baseBranch: wt.baseBranch, repoDir: foremanRepo,
      })
      db.prepare(`UPDATE decisions SET prompt_sections = ? WHERE id = ?`)
        .run(JSON.stringify(composed.sections), decisionId)

      const model = selectModel(skill, selfTask)
      spawnSession({ name: sName, workDir: wt.path, prompt: composed.text, goalId, decisionId, model: model ?? undefined })

      return json(res, { decision: stmts.getDecision.get(decisionId), session: sName, worktree: wt.path, branch: wt.branch }, 201)
    }

    // ── Confidence ─────────────────────────────────────────────
    if (path === '/api/confidence' && method === 'GET') {
      const project = parseQuery(url).get('project') ?? undefined
      const entries = confidence.list(project)
      return json(res, entries)
    }

    if (path === '/api/confidence/override' && method === 'POST') {
      const body = await readBody(req)
      const project = String(body.project ?? '')
      const override = body.override ? String(body.override) : null
      if (!project) return error(res, 'project required')
      confidence.setOverride(project, override as any)
      return json(res, { ok: true, project, override })
    }

    if (path === '/api/confidence/log' && method === 'GET') {
      const limit = parseInt(parseQuery(url).get('limit') ?? '30', 10)
      return json(res, confidence.getLog(limit))
    }

    if (path === '/api/learnings' && method === 'GET') {
      const query = parseQuery(url)
      const type = query.get('type')
      const project = query.get('project')
      const limit = parseInt(query.get('limit') ?? '30', 10)

      if (project) return json(res, stmts.learningsByProject.all(project, limit))
      if (type) return json(res, stmts.learningsByType.all(type, limit))
      return json(res, stmts.allLearnings.all(limit))
    }

    // ── Project config (teach Foreman about a project) ─────────
    if (path === '/api/project-config' && method === 'POST') {
      const body = await readBody(req)
      const project = String(body.project ?? '')
      const key = String(body.key ?? '')
      const value = String(body.value ?? '')
      if (!project || !key || !value) return error(res, 'project, key, and value required')

      stmts.insertLearning.run('project_config', `${key}:${value}`, 'operator', project, 5.0)
      log(`Project config: ${project} → ${key}=${value}`)
      return json(res, { ok: true, project, key, value }, 201)
    }

    if (path === '/api/templates' && method === 'GET') {
      return json(res, stmts.listTemplates.all(10))
    }

    // ── Prompt Lab ──────────────────────────────────────────
    if (path === '/api/lab' && method === 'GET') {
      const samples = pullSamples(100)
      const surfaces = getDefaultSurfaces()
      const experiments = surfaces.map(s => ({
        surface: s.name,
        currentInstruction: s.currentInstruction.slice(0, 200),
        activeExperiment: getActiveExperiment(s.name),
      }))
      const baselineRate = samples.length > 0
        ? Math.round(samples.filter(s => s.success).length / samples.length * 100)
        : 0
      return json(res, { samples: samples.length, baselineRate, surfaces: experiments })
    }

    if (path === '/api/lab/optimize' && method === 'POST') {
      try {
        const result = await runPromptLabCycle()
        return json(res, result)
      } catch (e) {
        return error(res, e instanceof Error ? e.message : String(e), 500)
      }
    }

    if (path === '/api/stats' && method === 'GET') {
      const telemetry24h = summarizeTelemetry(db, 24)
      const telemetryAll = summarizeTelemetry(db, 24 * 365 * 20)
      const telemetryCoverage = summarizeTelemetryCoverage(db)
      const telemetrySources = summarizeTelemetrySources(db, 24 * 7)
      const telemetryHarnessHealth = summarizeTelemetryHarnessHealth(db, 24 * 7)
      const latestTelemetryImport = getLatestTelemetryImportRun(db)
      const todayCost = getDailyTelemetryCost(db)
      const activePolicy = getDispatchPolicyControl(db)
      const latestReplayEvaluation = getLatestReplayPolicyEvaluation(db)
      const sessionCount = (stmts.operatorSessionCount.get() as { count: number }).count
      const decisionCount = (db.prepare(`SELECT COUNT(*) as c FROM decisions`).get() as { c: number }).c
      const learningCount = (db.prepare(`SELECT COUNT(*) as c FROM learnings`).get() as { c: number }).c
      const tasteCount = (db.prepare(`SELECT COUNT(*) as c FROM taste`).get() as { c: number }).c
      const successCount = (db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE status = 'success'`).get() as { c: number }).c
      const successRate = decisionCount > 0 ? successCount / decisionCount : 0

      // Origin breakdown
      const operatorDispatches = (db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE origin = 'operator'`).get() as { c: number }).c
      const autoDispatches = (db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE origin = 'auto'`).get() as { c: number }).c

      // Cost breakdown
      const totalCost = telemetryAll.totalCostUsd
      const costBySkill = db.prepare(`
        SELECT skill, COUNT(*) as dispatches, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as successes,
               COALESCE(SUM(cost_usd), 0) as cost
        FROM decisions GROUP BY skill ORDER BY dispatches DESC
      `).all() as Array<{ skill: string, dispatches: number, successes: number, cost: number }>

      return json(res, {
        operatorSessions: sessionCount,
        decisions: decisionCount,
        operatorDispatches,
        autoDispatches,
        learnings: learningCount,
        tasteSignals: tasteCount,
        successRate: Math.round(successRate * 100),
        cost: {
          total: totalCost,
          today: todayCost,
          budgetBlocked: todayCost >= MAX_DAILY_COST_USD,
          runs24h: telemetry24h.runs,
          tokens24h: telemetry24h.totalTokens,
          coverage: telemetryCoverage,
          byHarness: telemetry24h.byHarness,
          byProvider: telemetry24h.byProvider,
          byModel: telemetry24h.byModel,
          byRepo: telemetry24h.byRepo,
          bySource: telemetrySources,
          harnessHealth: telemetryHarnessHealth,
          latestImport: latestTelemetryImport,
          bySkill: costBySkill,
        },
        policy: {
          active: activePolicy,
          latestReplayEvaluation,
        },
      })
    }

    if (path === '/api/telemetry/summary' && method === 'GET') {
      const hours = parseInt(parseQuery(url).get('hours') ?? '24', 10)
      const summary = summarizeTelemetry(db, Number.isFinite(hours) ? hours : 24)
      const todayCost = getDailyTelemetryCost(db)
      const recentHours = Number.isFinite(hours) ? hours : 24
      return json(res, {
        ...summary,
        coverage: summarizeTelemetryCoverage(db),
        sources: summarizeTelemetrySources(db, recentHours),
        harnessHealth: summarizeTelemetryHarnessHealth(db, Math.max(24, recentHours * 7)),
        latestImport: getLatestTelemetryImportRun(db),
        recentImports: listTelemetryImportRuns(db, { limit: 5 }),
        budget: {
          dailyUsd: MAX_DAILY_COST_USD,
          todayCostUsd: todayCost,
          blocked: todayCost >= MAX_DAILY_COST_USD,
        },
      })
    }

    if (path === '/api/telemetry/runs' && method === 'GET') {
      const hours = parseInt(parseQuery(url).get('hours') ?? '168', 10)
      const limit = parseInt(parseQuery(url).get('limit') ?? '100', 10)
      return json(res, listTelemetryRuns(db, {
        hoursBack: Number.isFinite(hours) ? hours : 168,
        limit: Number.isFinite(limit) ? limit : 100,
      }))
    }

    if (path === '/api/telemetry/runs' && method === 'POST') {
      const body = await readBody(req)
      const eventKey = String(body.eventKey ?? body.event_key ?? '')
      const harness = String(body.harness ?? '')
      if (!eventKey || !harness) return error(res, 'eventKey and harness required')

      recordTelemetryRun(db, {
        eventKey,
        decisionId: body.decisionId != null ? Number(body.decisionId) : null,
        goalId: body.goalId != null ? Number(body.goalId) : null,
        sessionName: body.sessionName ? String(body.sessionName) : null,
        source: body.source ? String(body.source) : 'api/telemetry/runs',
        harness,
        provider: body.provider ? String(body.provider) : null,
        model: body.model ? String(body.model) : null,
        skill: body.skill ? String(body.skill) : null,
        repo: body.repo ? String(body.repo) : null,
        status: body.status ? String(body.status) : null,
        inputTokens: body.inputTokens != null ? Number(body.inputTokens) : null,
        outputTokens: body.outputTokens != null ? Number(body.outputTokens) : null,
        cacheCreationTokens: body.cacheCreationTokens != null ? Number(body.cacheCreationTokens) : null,
        cacheReadTokens: body.cacheReadTokens != null ? Number(body.cacheReadTokens) : null,
        totalTokens: body.totalTokens != null ? Number(body.totalTokens) : null,
        costUsd: body.costUsd != null ? Number(body.costUsd) : null,
        startedAt: body.startedAt ? String(body.startedAt) : null,
        finishedAt: body.finishedAt ? String(body.finishedAt) : new Date().toISOString(),
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : null,
      })
      return json(res, { ok: true }, 201)
    }

    if (path === '/api/telemetry/import' && method === 'POST') {
      const body = await readBody(req)
      const hours = body.maxAgeHours != null ? Number(body.maxAgeHours) : undefined
      const traceRoot = body.traceRoot ? String(body.traceRoot) : undefined
      const result = await runTelemetryImport(db, {
        maxAgeHours: Number.isFinite(hours) ? hours : undefined,
        traceRoot,
      })
      return json(res, result, 200)
    }

    // ── MCP servers ─────────────────────────────────────────
    if (path === '/api/mcp' && method === 'GET') {
      return json(res, stmts.listMcp.all())
    }

    if (path === '/api/mcp' && method === 'POST') {
      const body = await readBody(req)
      const id = String(body.id ?? '')
      const name = String(body.name ?? id)
      const command = String(body.command ?? '')
      const args = body.args ? JSON.stringify(body.args) : '[]'
      const env = body.env ? JSON.stringify(body.env) : null
      const scope = String(body.scope ?? 'global')
      if (!id || !command) return error(res, 'id and command required')
      stmts.upsertMcp.run(id, name, command, args, env, scope)
      return json(res, { ok: true, id }, 201)
    }

    if (path.startsWith('/api/mcp/') && method === 'DELETE') {
      const id = decodeURIComponent(path.slice('/api/mcp/'.length))
      stmts.deleteMcp.run(id)
      return json(res, { ok: true, deleted: id })
    }

    // ── Plans ──────────────────────────────────────────────
    if (path === '/api/plans' && method === 'GET') {
      const status = parseQuery(url).get('status') ?? undefined
      return json(res, listPlans(status))
    }

    if (path === '/api/plans/generate' && method === 'POST') {
      // Build context from current state
      const goals = stmts.listGoals.all() as Array<{ intent: string, workspace_path: string | null }>
      const decisions = db.prepare(`
        SELECT d.skill, d.task, d.status, d.outcome, COALESCE(g.workspace_path, d.worktree_path) as project
        FROM decisions d LEFT JOIN goals g ON g.id = d.goal_id
        WHERE d.status IN ('success', 'failure')
        ORDER BY d.created_at DESC LIMIT 15
      `).all() as Array<{ skill: string, task: string, status: string, outcome: string | null, project: string }>

      const flows = stmts.learningsByType.all('flow', 10) as Array<{ content: string }>
      const prefs = stmts.learningsByType.all('skill_preference', 10) as Array<{ content: string }>
      const taste = stmts.listTaste.all(10) as Array<{ pattern: string }>
      const deadEnds = stmts.learningsByType.all('dead_end', 5) as Array<{ content: string }>

      // Find projects with recent sessions
      const recentProjects = db.prepare(`SELECT DISTINCT repo FROM operator_sessions WHERE repo != '' ORDER BY timestamp DESC LIMIT 10`)
        .all() as Array<{ repo: string }>

      const sessionCount = (stmts.operatorSessionCount.get() as { count: number }).count
      const learningCount = (db.prepare(`SELECT COUNT(*) as c FROM learnings`).get() as { c: number }).c

      const ctx: PlanGeneratorContext = {
        recentDecisions: decisions.map(d => ({
          skill: d.skill.slice(0, 20), task: d.task.slice(0, 100),
          status: d.status, outcome: d.outcome?.slice(0, 100) ?? null,
          project: (d.project ?? '').split('/').pop() ?? 'unknown',
        })),
        learnedFlows: flows.map(f => f.content),
        skillPreferences: prefs.map(p => p.content),
        tasteSignals: taste.map(t => t.pattern),
        deadEnds: deadEnds.map(d => d.content),
        activeGoals: goals.map(g => ({ intent: g.intent, workspacePath: g.workspace_path })),
        recentProjects: recentProjects.map(p => p.repo.split('/').pop() ?? p.repo),
        sessionCount,
        learningCount,
      }

      // Dispatch plan ideation as a regular Foreman session
      const dispatch = buildIdeationDispatch(ctx)
      const autoLabel = `plan-ideate-${Date.now().toString(36)}`
      const wt = await createWorktree(process.cwd(), autoLabel)
      if (!wt) return error(res, 'Failed to create worktree for plan ideation')

      const sName = sessionName(autoLabel)
      const activeTpl = stmts.activeTemplate.get() as { version: number } | undefined
      const result = stmts.insertDecision.run(
        null, '/plan', dispatch.prompt.slice(0, 500), 'plan ideation',
        sName, wt.path, wt.branch, wt.baseBranch, activeTpl?.version ?? 1, 'auto',
      )
      const decisionId = Number(result.lastInsertRowid)

      // Use the ideation prompt directly — it tells Claude to write JSON to a file
      spawnSession({
        name: sName, workDir: wt.path, prompt: dispatch.prompt,
        goalId: null as any, decisionId,
      })

      return json(res, {
        dispatched: true,
        session: sName,
        outputPath: dispatch.outputPath,
        message: 'Plan ideation dispatched. Check session status and parse output when complete.',
      }, 202)
    }

    if (path.startsWith('/api/plans/') && method === 'PATCH') {
      const id = decodeURIComponent(path.slice('/api/plans/'.length))
      const body = await readBody(req)
      const status = String(body.status ?? '')
      const tasteSignal = body.taste_signal ? String(body.taste_signal) as 'approved' | 'rejected' : undefined

      if (status === 'approved') {
        // Convert plan to goal
        const plan = getPlan(id)
        if (plan) {
          const goalResult = stmts.insertGoal.run(
            plan.proposedGoal.intent,
            plan.proposedGoal.workspacePath ?? null,
            'repo', null, 0,
          )
          updatePlanStatus(id, 'approved', 'approved')

          // Record taste — exploration approvals are worth 3x
          const weight = plan.isExploration ? 3.0 : 1.0
          stmts.insertTaste.run(`approved plan: ${plan.title.slice(0, 100)}`, `plan:${id}`, weight)

          return json(res, { ok: true, id, goalId: Number(goalResult.lastInsertRowid) })
        }
      }

      if (status === 'rejected') {
        const plan = getPlan(id)
        updatePlanStatus(id, 'rejected', 'rejected')
        if (plan) {
          const weight = plan.isExploration ? -1.0 : -1.5  // rejecting exploitation is stronger signal
          stmts.insertTaste.run(`rejected plan: ${plan.title.slice(0, 100)}`, `plan:${id}`, weight)
        }
        return json(res, { ok: true, id, status: 'rejected' })
      }

      return error(res, 'status must be approved or rejected')
    }

    // ── Skill proposals ─────────────────────────────────────
    if (path === '/api/proposals' && method === 'GET') {
      const status = parseQuery(url).get('status') ?? undefined
      return json(res, listProposals(status))
    }

    if (path === '/api/proposals' && method === 'POST') {
      const body = await readBody(req)
      const proposal = createProposal({
        skillName: String(body.skillName ?? ''),
        proposedSkillMd: String(body.proposedSkillMd ?? ''),
        evidence: (body.evidence as string[]) ?? [],
        whatImproves: (body.whatImproves as string[]) ?? [],
        whatCouldGoWrong: (body.whatCouldGoWrong as string[]) ?? [],
        whatWouldBeRemoved: (body.whatWouldBeRemoved as string[]) ?? [],
      })
      return json(res, proposal, 201)
    }

    if (path.startsWith('/api/proposals/') && path.endsWith('/pr') && method === 'POST') {
      // Open a draft PR for this proposal against the skill's source repo
      const id = decodeURIComponent(path.slice('/api/proposals/'.length).replace(/\/pr$/, ''))
      try {
        const prUrl = await openSkillPR(id)
        if (!prUrl) return error(res, 'Could not open PR — skill may not be in a git repo', 400)
        return json(res, { ok: true, id, prUrl })
      } catch (e) {
        return error(res, e instanceof Error ? e.message : String(e), 500)
      }
    }

    if (path.startsWith('/api/proposals/') && method === 'PATCH') {
      const id = decodeURIComponent(path.slice('/api/proposals/'.length))
      const body = await readBody(req)
      const status = String(body.status ?? '')
      if (status !== 'approved' && status !== 'rejected') return error(res, 'status must be approved or rejected')
      const ok = updateProposalStatus(id, status)
      if (!ok) return error(res, 'proposal not found', 404)
      return json(res, { ok: true, id, status })
    }

    // ── Session search (FTS5 index) ─────────────────────────
    if (path === '/api/search' && method === 'GET') {
      const q = parseQuery(url).get('q') ?? ''
      const limit = parseInt(parseQuery(url).get('limit') ?? '20', 10)
      if (!q) return error(res, 'q required')

      try {
        const { SessionIndex } = await import('@drew/foreman-memory/session-index')
        const idx = new SessionIndex()
        const results = idx.search({ query: q, limit })
        const formatted = results.map((r: any) => ({
          text: r.message?.text?.slice(0, 300),
          repo: r.message?.repo,
          harness: r.message?.harness,
          timestamp: r.message?.timestamp,
          role: r.message?.role,
        }))
        idx.close()
        return json(res, formatted)
      } catch (e) {
        // Session index may not be built yet
        return json(res, [])
      }
    }

    // ── Session complete (from Claude Code Stop hook) ──────────
    // The hook fires when any CC session in this project ends.
    // Foreman reads the full transcript and dispatches a reviewer
    // to decide what happened and what to do next.
    if (path === '/api/session-complete' && method === 'POST') {
      const body = await readBody(req)
      const sessionId = String(body.session_id ?? '')
      const transcriptPath = String(body.transcript_path ?? '')
      const sessionCwd = String(body.cwd ?? '')
      const lastMessage = String(body.last_assistant_message ?? '')

      if (!sessionId) return error(res, 'session_id required')

      // Read transcript for basic stats + get the REAL cwd from the JSONL
      const summary = transcriptPath ? readSessionTranscript(transcriptPath) : null
      const realCwd = summary?.cwd || sessionCwd

      // Store transcript_path on matching session record (for watcher to use later)
      if (transcriptPath) {
        // Try exact cwd match, then LIKE match (worktree paths vary)
        const updated = db.prepare(`UPDATE sessions SET transcript_path = ? WHERE work_dir = ? AND status != 'dead'`)
          .run(transcriptPath, realCwd)
        if (updated.changes === 0) {
          // Fallback: match any active session whose work_dir is in the transcript's cwd
          db.prepare(`UPDATE sessions SET transcript_path = ? WHERE status != 'dead' AND ? LIKE '%' || REPLACE(SUBSTR(work_dir, -30), '/', '%') || '%'`)
            .run(transcriptPath, realCwd)
        }
      }

      // Find matching Foreman decision — use the REAL cwd from transcript
      const foremanSession = (
        db.prepare(
          `SELECT d.id, d.skill, d.task, d.goal_id, d.session_name, d.worktree_path,
                  d.worktree_branch, d.base_branch, g.intent as goal_intent
           FROM decisions d
           JOIN sessions s ON s.decision_id = d.id
           LEFT JOIN goals g ON g.id = d.goal_id
           WHERE d.status = 'dispatched' AND s.work_dir = ?
           ORDER BY d.created_at DESC LIMIT 1`
        ).get(realCwd) ??
        db.prepare(
          `SELECT d.id, d.skill, d.task, d.goal_id, d.session_name, d.worktree_path,
                  d.worktree_branch, d.base_branch, g.intent as goal_intent
           FROM decisions d
           JOIN sessions s ON s.decision_id = d.id
           LEFT JOIN goals g ON g.id = d.goal_id
           WHERE d.status = 'dispatched'
           AND s.work_dir LIKE ?
           ORDER BY d.created_at DESC LIMIT 1`
        ).get(`%${realCwd}%`)
      ) as {
        id: number, skill: string, task: string, goal_id: number | null,
        session_name: string, worktree_path: string | null,
        worktree_branch: string | null, base_branch: string | null,
        goal_intent: string | null,
      } | undefined

      const result: Record<string, unknown> = {
        sessionId, transcriptPath, cwd: sessionCwd,
        turnCount: summary?.turnCount,
        toolCallCount: summary?.toolCalls?.length,
        model: summary?.model,
        inputTokens: summary?.totalInputTokens,
        outputTokens: summary?.totalOutputTokens,
        matchedDecision: foremanSession?.id,
      }

      if (foremanSession && transcriptPath) {
        // Dispatch the reviewer asynchronously — don't block the hook response
        reviewSession({
          sessionId,
          transcriptPath,
          cwd: sessionCwd,
          lastAssistantMessage: lastMessage,
          decisionId: foremanSession.id,
          skill: foremanSession.skill,
          task: foremanSession.task,
          goalIntent: foremanSession.goal_intent ?? foremanSession.task,
          goalId: foremanSession.goal_id,
        }).then(review => {
          // Update decision with reviewer's assessment
          stmts.updateDecision.run(
            review.status, review.summary.slice(0, 500),
            review.learnings.length > 0 ? JSON.stringify(review.learnings) : null,
            JSON.stringify({
              turnCount: summary?.turnCount,
              toolCalls: summary?.toolCalls.length,
              inputTokens: summary?.totalInputTokens,
              outputTokens: summary?.totalOutputTokens,
              qualityScore: review.qualityScore,
              deliverablesMet: review.deliverablesMet,
            }),
            null, null, foremanSession.id,
          )

          // Update confidence
          const projectName = (foremanSession.worktree_path ?? sessionCwd).split('/').pop() ?? ''
          const confSignal = review.qualityScore >= 7 ? 'success' as const : review.status === 'success' ? 'success' as const : 'failure' as const
          confidence.update(foremanSession.skill || 'direct', projectName, confSignal)

          // Store learnings
          for (const l of review.learnings.slice(0, 5)) {
            stmts.insertLearning.run('session_review', l.slice(0, 500), `decision:${foremanSession.id}`, null, 1.5)
          }

          // Record outcome for active prompt lab experiment
          try {
            const labRow = db.prepare(
              `SELECT id, surface FROM prompt_lab WHERE status = 'testing' ORDER BY created_at DESC LIMIT 1`
            ).get() as { id: string, surface: string } | undefined
            if (labRow) {
              db.prepare(`UPDATE prompt_lab SET dispatches = dispatches + 1, successes = successes + ? WHERE id = ?`)
                .run(review.status === 'success' ? 1 : 0, labRow.id)
            }
          } catch {}

          // Store next-dispatch recommendation
          if (review.nextDispatch) {
            stmts.insertLearning.run(
              'session_recommendation',
              `${foremanSession.skill} → ${review.nextDispatch.skill}: ${review.nextDispatch.task.slice(0, 200)}`,
              `decision:${foremanSession.id}`, null, 2.0,
            )
            log(`Reviewer recommends: ${review.nextDispatch.skill} — ${review.nextDispatch.task.slice(0, 80)}`)
          }

          emitEvent('session_reviewed', foremanSession.session_name, foremanSession.goal_id, {
            decisionId: foremanSession.id,
            status: review.status,
            qualityScore: review.qualityScore,
            shouldContinue: review.shouldContinue,
            nextSkill: review.nextDispatch?.skill,
          })

          sendNotification(
            `Foreman: ${foremanSession.session_name}`,
            `${review.status} (${review.qualityScore}/10) — ${review.summary.slice(0, 100)}`,
          )

          log(`Session reviewed: ${sessionId} → ${review.status} (${review.qualityScore}/10)${review.nextDispatch ? ` → next: ${review.nextDispatch.skill}` : ''}`)

          // Auto-dispatch if reviewer says to continue
          if (review.shouldContinue && review.nextDispatch && foremanSession.goal_id) {
            maybeAutoDispatch(foremanSession.skill, projectName, foremanSession.goal_id)
              .catch(e => log(`Auto-dispatch after review failed: ${e}`))
          }
        }).catch(e => {
          log(`Session review failed for ${sessionId}: ${e}`)
        })

        result.reviewing = true
        log(`Session complete via hook: ${sessionId} → decision ${foremanSession.id} (reviewing...)`)
      } else {
        // Not a Foreman dispatch — log for operator session scanner
        emitEvent('external_session_complete', null, null, {
          sessionId, cwd: sessionCwd, turnCount: summary?.turnCount,
        })
        log(`External session complete: ${sessionId} in ${sessionCwd}`)
      }

      return json(res, result, 200)
    }

    // ── Dashboard ──────────────────────────────────────────────
    if (path === '/' || path === '/dashboard') {
      try {
        // tsx sets __dirname; use process.argv[1] as fallback
        const serviceDir = typeof __dirname !== 'undefined' ? __dirname : join(process.argv[1], '..')
        const dashboardPath = join(serviceDir, 'dashboard.html')
        const html = readFileSync(dashboardPath, 'utf8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
        return
      } catch {
        error(res, 'Dashboard not found', 500)
        return
      }
    }

    // ── 404 ───────────────────────────────────────────────────
    error(res, `Not found: ${path}`, 404)

  } catch (e) {
    error(res, e instanceof Error ? e.message : String(e), 500)
  }
}

// ─── Server ──────────────────────────────────────────────────────────

const server = http.createServer(handleRequest)

server.listen(PORT, '0.0.0.0', () => {
  log(`Foreman service listening on http://0.0.0.0:${PORT}`)
  log(`Database: ${DB_PATH}`)
  log(`Home: ${FOREMAN_HOME}`)

  // Start session watcher
  setInterval(watcherTick, WATCHER_INTERVAL_MS)
  log(`Session watcher running (${WATCHER_INTERVAL_MS / 1000}s interval)`)

  // Zombie session reaper — every 5 minutes
  setInterval(async () => {
    const reaped = await reapZombieSessions()
    if (reaped > 0) log(`Reaped ${reaped} zombie sessions`)
  }, 5 * 60 * 1000)

  // Run initial learning loop (fast pattern extraction), then every hour
  setTimeout(async () => {
    try {
      const result = await runTelemetryImport(db)
      if (result.imported > 0 || result.skipped > 0) {
        log(`Telemetry import: imported ${result.imported}, skipped ${result.skipped}, scanned ${result.scanned}`)
      }
    } catch (e) {
      log(`Initial telemetry import failed: ${e}`)
    }
  }, 10_000)
  setInterval(async () => {
    try {
      const result = await runTelemetryImport(db)
      if (result.imported > 0) {
        log(`Telemetry import: imported ${result.imported}, skipped ${result.skipped}, scanned ${result.scanned}`)
      }
    } catch (e) {
      log(`Telemetry import failed: ${e}`)
    }
  }, 15 * 60 * 1000)

  // Run initial learning loop (fast pattern extraction), then every hour
  setTimeout(() => {
    const result = runLearningLoop()
    log(`Initial learning: scanned ${result.scanned} sessions, extracted ${result.extracted} learnings`)
  }, 5_000)
  setInterval(() => {
    const result = runLearningLoop()
    if (result.scanned > 0 || result.extracted > 0) {
      log(`Learning loop: scanned ${result.scanned}, extracted ${result.extracted}`)
    }
  }, 60 * 60 * 1000) // every hour

  // Deep analysis (LLM-powered) — runs every 6 hours, dispatches Claude
  // to analyze operator sessions and extract workflows, taste, anti-patterns.
  // First run after 2 minutes (let fast learning finish first).
  setTimeout(async () => {
    try {
      const result = await runDeepAnalysis()
      if (result.flows > 0) log(`Deep analysis: ${result.analyzed} sessions → ${result.flows} new flows`)
    } catch (e) { log(`Deep analysis failed: ${e}`) }
  }, 2 * 60 * 1000)
  setInterval(async () => {
    try {
      const result = await runDeepAnalysis()
      if (result.flows > 0) log(`Deep analysis: ${result.analyzed} sessions → ${result.flows} new flows`)
    } catch (e) { log(`Deep analysis failed: ${e}`) }
  }, 6 * 60 * 60 * 1000) // DEEP_ANALYSIS_INTERVAL_MS = 6 hours

  // Worktree cleanup — every 6 hours
  setInterval(async () => {
    const cleaned = await cleanupWorktrees()
    if (cleaned > 0) log(`Cleaned ${cleaned} stale worktrees`)
  }, 6 * 60 * 60 * 1000)

  // Prompt Lab — DISABLED auto-cycle. 4 variants tested, all worse than baseline.
  // Data shows constraints hurt (32% with ONLY vs 71% without). The lab optimized
  // the wrong surface. Keep manual trigger via POST /api/lab/optimize.
  // Re-enable when: 500+ samples AND the reviewer-based harvest is proven reliable.
  /*
  setTimeout(async () => {
    try {
      const result = await runPromptLabCycle()
      log(`Prompt Lab: ${result.action} (${result.samples} samples)`)
    } catch (e) { log(`Prompt Lab failed: ${e}`) }
  }, 10 * 60 * 1000)
  setInterval(async () => {
    try {
      const result = await runPromptLabCycle()
      log(`Prompt Lab: ${result.action} (${result.samples} samples)`)
    } catch (e) { log(`Prompt Lab failed: ${e}`) }
  }, 2 * 60 * 60 * 1000)
  */

  // GEPA dispatch policy — retrain every 6 hours from accumulated decisions
  if (process.env.FOREMAN_DISPATCH_POLICY === 'gepa') {
    const trainGepaPolicy = async () => {
      const decisions = db.prepare(`
        SELECT d.skill, d.task, d.status, d.outcome, d.goal_id,
               g.intent as goal_intent, g.workspace_path
        FROM decisions d
        LEFT JOIN goals g ON g.id = d.goal_id
        WHERE d.status IN ('success', 'failure') AND d.skill != ''
        ORDER BY d.created_at DESC LIMIT 50
      `).all() as Array<{
        skill: string, task: string, status: string, outcome: string | null,
        goal_id: number | null, goal_intent: string | null, workspace_path: string | null
      }>

      if (decisions.length < 5) { log('GEPA policy: need 5+ decisions'); return }

      const flows = stmts.learningsByType.all('flow', 10) as Array<{ content: string }>
      const prefs = stmts.learningsByType.all('skill_preference', 10) as Array<{ content: string }>

      const trainingData = decisions.map(d => ({
        context: {
          goalIntent: d.goal_intent ?? d.task.slice(0, 100),
          projectName: (d.workspace_path ?? '').split('/').pop() ?? 'unknown',
          recentDecisions: [{ skill: d.skill, status: d.status, outcome: d.outcome }],
          learnedFlows: flows.map(f => f.content),
          skillPreferences: prefs.map(p => p.content),
          confidenceLevel: 'dry-run',
        },
        decision: { skill: d.skill, task: d.task.slice(0, 200), reasoning: '' },
        outcome: d.status as 'success' | 'failure',
      }))

      await initGepaPolicy(trainingData)
    }

    // Initial training after 30 seconds
    setTimeout(() => trainGepaPolicy().catch(e => log(`GEPA policy train failed: ${e}`)), 30_000)
    // Retrain every 6 hours
    setInterval(() => trainGepaPolicy().catch(e => log(`GEPA policy retrain failed: ${e}`)), 6 * 60 * 60 * 1000)
  }

  // Helper to build plan context from current state
  const buildPlanContext = (): PlanGeneratorContext => {
    const goals = stmts.listGoals.all() as Array<{ intent: string, workspace_path: string | null }>
    const decisions = db.prepare(`SELECT d.skill, d.task, d.status, d.outcome, COALESCE(g.workspace_path, d.worktree_path) as project FROM decisions d LEFT JOIN goals g ON g.id = d.goal_id WHERE d.status IN ('success','failure') ORDER BY d.created_at DESC LIMIT 15`).all() as any[]
    const flows = stmts.learningsByType.all('flow', 10) as any[]
    const prefs = stmts.learningsByType.all('skill_preference', 10) as any[]
    const taste = stmts.listTaste.all(10) as any[]
    const deadEnds = stmts.learningsByType.all('dead_end', 5) as any[]
    const recentProjects = db.prepare(`SELECT DISTINCT repo FROM operator_sessions WHERE repo != '' ORDER BY timestamp DESC LIMIT 10`).all() as any[]
    const sessionCount = (stmts.operatorSessionCount.get() as { count: number }).count
    const learningCount = (db.prepare(`SELECT COUNT(*) as c FROM learnings`).get() as { c: number }).c
    return {
      recentDecisions: decisions.map((d: any) => ({ skill: (d.skill??'').slice(0,20), task: (d.task??'').slice(0,100), status: d.status, outcome: d.outcome?.slice(0,100)??null, project: (d.project??'').split('/').pop()??'?' })),
      learnedFlows: flows.map((f: any) => f.content), skillPreferences: prefs.map((p: any) => p.content),
      tasteSignals: taste.map((t: any) => t.pattern), deadEnds: deadEnds.map((d: any) => d.content),
      activeGoals: goals.map(g => ({ intent: g.intent, workspacePath: g.workspace_path })),
      recentProjects: recentProjects.map((p: any) => (p.repo??'').split('/').pop() ?? ''),
      sessionCount, learningCount,
    }
  }

  // Plan generation — dispatched as regular Foreman sessions every 12 hours
  // Uses the same dispatch pipeline as all other work
  const dispatchPlanIdeation = async () => {
    const pending = listPlans('proposed')
    if (pending.length >= 5) return
    log('Dispatching plan ideation session...')
    // Build context and dispatch
    const ctx = buildPlanContext()
    const dispatch = buildIdeationDispatch(ctx)
    const autoLabel = `plan-ideate-${Date.now().toString(36)}`
    const sName = sessionName(autoLabel)
    const activeTpl = stmts.activeTemplate.get() as { version: number } | undefined
    const result = stmts.insertDecision.run(
      null, '/plan', dispatch.prompt.slice(0, 500), 'auto plan ideation',
      sName, null, null, null, activeTpl?.version ?? 1, 'auto',
    )
    spawnSession({
      name: sName, workDir: dispatch.workspace, prompt: dispatch.prompt,
      goalId: null as any, decisionId: Number(result.lastInsertRowid),
    })
    log(`Plan ideation dispatched: ${sName}`)
  }
  setTimeout(() => dispatchPlanIdeation().catch(e => log(`Plan ideation failed: ${e}`)), 5 * 60 * 1000)
  setInterval(() => dispatchPlanIdeation().catch(e => log(`Plan ideation failed: ${e}`)), 12 * 60 * 60 * 1000)

  // Bootstrap prompt template if none exists
  const hasTemplate = stmts.activeTemplate.get()
  if (!hasTemplate) {
    stmts.insertTemplate.run(1, 'v1-default', 1)
    log('Bootstrapped prompt template v1')
  }
})

// Graceful shutdown
process.on('SIGTERM', () => { log('Shutting down'); confidence.close(); db.close(); server.close(); process.exit(0) })
process.on('SIGINT', () => { log('Shutting down'); confidence.close(); db.close(); server.close(); process.exit(0) })
