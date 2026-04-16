/**
 * Code Evolution — meta-harness loop implemented as a runTaskLoop provider.
 *
 * Each round = one evolution iteration.
 * Each track = one parallel CC proposer dispatched via session manager.
 * Validation = hypothesis discipline + compile check + benchmark.
 *
 * Uses ONLY existing Foreman infrastructure:
 *   - spawnSession (session-manager.ts) for CC dispatch (tmux OR tangle backend)
 *   - createWorktree (prompt-composer.ts) for local isolation
 *   - callClaude (claude-runner.ts) for pipe-mode fallback
 *   - TraceStore (@drew/foreman-tracing) for trace persistence
 *   - OptimizationSurface registry for surface management
 *   - State (SQLite, log, emit) for all persistence
 *
 * Eval modes:
 *   - 'local': execSync(evalCommand) — runs eval locally in the repo
 *   - 'router': POST router.tangle.tools/api/eval — inference through Router,
 *     any model, any provider, billed through one account
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'

import type {
  LoopOptions,
  ContextSnapshot,
  Plan,
  TrackResult,
  ValidationResult,
  StopDecision,
  ArtifactStore,
  TaskSpec,
} from '@drew/foreman-core'

import { CodeSurface, type CodeSurfaceConfig } from '../../packages/optimizer/src/code-surface.js'
import { parseHypothesis, validateHypothesis } from '../../packages/optimizer/src/hypothesis.js'
import { callClaude } from './claude-runner.js'
import { createWorktree } from './prompt-composer.js'
import { spawnSession, isTmuxAlive, captureTmux, detectIdle, sessionName } from './session-manager.js'

// ─── Types ──────────────────────────────────────────────────────────

export interface CodeEvolutionConfig {
  /** Repo path to evolve */
  repoPath: string
  /** Harness file relative to repo */
  harnessRelPath: string
  /** Eval command (local mode: run in repo root, must output JSON scores) */
  evalCommand: string
  /** Validate command (compile check) */
  validateCommand: string
  /** Pareto frontier dimensions */
  dimensions: string[]
  /** Parallel proposers per round */
  parallelism: number
  /** Max rounds (iterations) */
  maxRounds: number
  /** Proposer model */
  model?: string
  /** Session backend: 'tmux' (local CC) or 'tangle' (Sandbox container) */
  backend?: 'tmux' | 'tangle'
  /**
   * Eval mode:
   *   'local' — execSync(evalCommand) in the repo (default)
   *   'router' — POST to Router eval API (inference via hosted providers)
   */
  evalMode?: 'local' | 'router'
  /** Router URL (for evalMode: 'router') */
  routerUrl?: string
  /** Router API key (for evalMode: 'router') */
  routerApiKey?: string
  /** Router eval suite ID (for evalMode: 'router') */
  routerSuiteId?: string
  /** Goal ID in Foreman's goals table */
  goalId?: number
}

interface ProposerContext {
  surface: CodeSurface
  config: CodeEvolutionConfig
  skillContent: string
}

// ─── Build LoopOptions from config ──────────────────────────────────

export function buildCodeEvolutionLoop(
  config: CodeEvolutionConfig,
  artifacts: ArtifactStore,
): LoopOptions<ProposerContext, { proposerIndex: number }, string> {

  const surfaceConfig: CodeSurfaceConfig = {
    name: `code-${config.harnessRelPath.replace(/[/\\]/g, '-')}`,
    description: `Code evolution of ${config.harnessRelPath}`,
    harnessPath: join(config.repoPath, config.harnessRelPath),
    dimensions: config.dimensions,
    stateDir: join(config.repoPath, '.evolve/meta-harness'),
  }
  const surface = new CodeSurface(surfaceConfig)

  const skillPath = join(__dirname, '../../.claude/skills/meta-harness/SKILL.md')
  const skillContent = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : ''

  const task: TaskSpec = {
    id: `evolve-${surfaceConfig.name}`,
    goal: `Evolve ${config.harnessRelPath} to maximize ${config.dimensions.join(', ')}`,
    successCriteria: [
      'At least one variant on the Pareto frontier beyond baseline',
      'All frontier variants pass compile validation',
    ],
    environment: { kind: 'code', target: config.repoPath },
    policy: {
      maxCostUsd: 50,
      maxRuntimeSec: config.maxRounds * config.parallelism * 300,
    },
  }

  return {
    task,
    maxRounds: config.maxRounds,
    concurrency: config.parallelism,
    artifacts,
    signal: undefined,

    // ─── context: read frontier + evolution state ──────────────────

    async context({ round }): Promise<ContextSnapshot<ProposerContext>> {
      if (round === 1 && surface.getFrontier().entries.length === 0) {
        const baselineScores = await evalVariant(config, surface.getCurrent())
        surface.seedBaseline(baselineScores)
      }
      return {
        summary: `Round ${round}: ${surface.getFrontierSummary()}`,
        state: { surface, config, skillContent },
        evidence: [{ kind: 'metric', label: 'frontier', value: surface.getFrontierSummary() }],
      }
    },

    // ─── plan: create N tracks (one per proposer) ─────────────────

    async plan(): Promise<Plan<{ proposerIndex: number }>> {
      return {
        summary: `Spawn ${config.parallelism} parallel proposers via ${config.backend ?? 'tmux'} backend`,
        tracks: Array.from({ length: config.parallelism }, (_, i) => ({
          id: `proposer-${i}`,
          goal: 'Propose a structurally different harness variant',
          input: { proposerIndex: i },
          capability: 'meta-harness-propose',
        })),
      }
    },

    // ─── executeTrack: dispatch via session manager ────────────────

    async executeTrack({ track, context, round }): Promise<TrackResult<string>> {
      const { config: cfg, skillContent: skill } = context!.state!
      const idx = track.input!.proposerIndex
      const backend = cfg.backend ?? 'tmux'

      if (backend === 'tangle') {
        return dispatchViaTangle(cfg, skill, idx, round, track.id)
      }
      return dispatchViaTmuxOrPipe(cfg, skill, idx, round, track.id)
    },

    // ─── validate: hypothesis discipline + compile + benchmark ────

    async validate({ trackResults, context, round }): Promise<ValidationResult> {
      const { surface: surf, config: cfg } = context!.state!
      const findings: ValidationResult['findings'] = []
      let promoted = 0

      for (const tr of trackResults) {
        if (tr.status !== 'completed' || !tr.output) continue

        const hyp = parseHypothesis(tr.output, round)
        if (!hyp) {
          findings.push({ severity: 'medium', title: `${tr.trackId}: unparseable`, body: 'pending_eval.json could not be parsed' })
          continue
        }

        const hv = validateHypothesis(hyp)
        if (!hv.valid) {
          findings.push({ severity: 'medium', title: `${hyp.name}: rejected`, body: hv.rejectionReason ?? '' })
          surf.recordEvolution({ iteration: round, name: hyp.name, hypothesis: hyp.hypothesis, baseSystem: hyp.baseSystem, changes: hyp.changes, scores: null, delta: null, outcome: 'rejected', timestamp: new Date().toISOString() })
          continue
        }

        const variantCode = readVariantFromProposal(tr, hyp, cfg)
        if (!variantCode) {
          findings.push({ severity: 'medium', title: `${hyp.name}: no code`, body: `file ${hyp.filePath} not found` })
          continue
        }

        if (!compileCheck(cfg, variantCode)) {
          findings.push({ severity: 'high', title: `${hyp.name}: compile failure`, body: cfg.validateCommand })
          surf.recordEvolution({ iteration: round, name: hyp.name, hypothesis: hyp.hypothesis, baseSystem: hyp.baseSystem, changes: hyp.changes, scores: null, delta: null, outcome: 'failed', timestamp: new Date().toISOString() })
          continue
        }

        try {
          const scores = await evalVariant(cfg, variantCode)
          const onFrontier = surf.tryAddToFrontier(hyp, variantCode, scores)
          surf.writeVariant(hyp.name, variantCode)
          if (onFrontier) promoted++

          const baseline = surf.getFrontier().entries.find(e => e.id === 'baseline')
          const delta: Record<string, number> = {}
          if (baseline) {
            for (const [k, v] of Object.entries(scores)) delta[k] = v - (baseline.scores[k] ?? 0)
          }

          surf.recordEvolution({ iteration: round, name: hyp.name, hypothesis: hyp.hypothesis, baseSystem: hyp.baseSystem, changes: hyp.changes, scores, delta, outcome: onFrontier ? 'frontier' : 'dominated', timestamp: new Date().toISOString() })
          findings.push({ severity: onFrontier ? 'low' : 'medium', title: `${hyp.name}: ${onFrontier ? 'frontier' : 'dominated'}`, body: `scores=${JSON.stringify(scores)}` })
        } catch (e) {
          surf.recordEvolution({ iteration: round, name: hyp.name, hypothesis: hyp.hypothesis, baseSystem: hyp.baseSystem, changes: hyp.changes, scores: null, delta: null, outcome: 'failed', timestamp: new Date().toISOString() })
          findings.push({ severity: 'high', title: `${hyp.name}: eval failed`, body: e instanceof Error ? e.message : String(e) })
        }
      }

      return {
        status: promoted > 0 ? 'pass' : 'warn',
        recommendation: 'repair',
        summary: `${promoted} new frontier entries. ${surface.getFrontierSummary()}`,
        findings,
        scores: { promoted, total: trackResults.length },
      }
    },

    async shouldStop({ round, validation }): Promise<StopDecision> {
      if (round >= config.maxRounds) {
        return { done: true, status: 'completed', reason: `${config.maxRounds} iterations done. ${validation.summary}` }
      }
      return { done: false, status: 'running', reason: 'continuing' }
    },
  }
}

// ─── Dispatch strategies ──────────────────────────────────────────────

/**
 * Dispatch via Tangle Sandbox — CC runs in a remote container.
 * Uses spawnSession with the tangle backend (already in session-manager.ts).
 */
async function dispatchViaTangle(
  cfg: CodeEvolutionConfig,
  skill: string,
  idx: number,
  round: number,
  trackId: string,
): Promise<TrackResult<string>> {
  const name = sessionName(`mh-r${round}-p${idx}`)
  const prompt = buildProposerPrompt(skill, idx, cfg)

  spawnSession({
    name,
    workDir: cfg.repoPath,
    prompt,
    goalId: cfg.goalId ?? 0,
    decisionId: 0,
    backend: 'tangle',
    model: cfg.model ?? 'opus',
  })

  // Poll for completion (tangle backend handles lifecycle)
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    await sleep(5_000)
    // Tangle backend sets status to 'idle' or 'dead' on completion
    // Check via the session manager's capture
    const output = captureTmux(name, 50)
    if (output.includes('idle') || output.includes('dead') || output.includes('completed')) break
  }

  // Read pending_eval.json from the sandbox (via session artifacts or workdir)
  const pendingPath = join(cfg.repoPath, '.evolve/meta-harness', 'pending_eval.json')
  if (existsSync(pendingPath)) {
    const proposal = readFileSync(pendingPath, 'utf8')
    return { trackId, status: 'completed', summary: `tangle proposer ${idx}`, output: proposal, evidence: [{ kind: 'artifact', label: 'pending_eval', value: proposal }] }
  }

  return { trackId, status: 'failed', summary: `tangle proposer ${idx}: no output`, evidence: [] }
}

/**
 * Dispatch via local tmux session or pipe mode.
 * For tmux: spawns a CC session via session manager, waits for idle.
 * For pipe: uses callClaude directly (simpler, synchronous).
 */
async function dispatchViaTmuxOrPipe(
  cfg: CodeEvolutionConfig,
  skill: string,
  idx: number,
  round: number,
  trackId: string,
): Promise<TrackResult<string>> {
  // Create worktree for isolation
  const wt = await createWorktree(cfg.repoPath, `mh-r${round}-p${idx}`)
  if (!wt) {
    return { trackId, status: 'failed', summary: 'worktree creation failed', evidence: [] }
  }

  try {
    // Copy meta-harness state into worktree
    const metaSrc = join(cfg.repoPath, '.evolve/meta-harness')
    const metaDst = join(wt.path, '.evolve/meta-harness')
    if (existsSync(metaSrc)) cpSync(metaSrc, metaDst, { recursive: true })

    // Use callClaude pipe mode — simpler, returns when done
    const prompt = buildProposerPrompt(skill, idx, cfg)
    const result = await callClaude({
      prompt,
      model: cfg.model ?? 'opus',
      timeoutMs: 300_000,
      cwd: wt.path,
    })

    const pendingPath = join(wt.path, '.evolve/meta-harness', 'pending_eval.json')
    if (!existsSync(pendingPath)) {
      return { trackId, status: 'failed', summary: `proposer ${idx}: no pending_eval.json`, output: result.output, evidence: [{ kind: 'log', label: 'cc-output', value: result.output.slice(0, 2000) }] }
    }

    const proposal = readFileSync(pendingPath, 'utf8')

    // Copy any variant files from worktree back to main repo's .evolve/meta-harness/variants/
    const wtVariants = join(wt.path, '.evolve/meta-harness', 'variants')
    const mainVariants = join(cfg.repoPath, '.evolve/meta-harness', 'variants')
    if (existsSync(wtVariants)) {
      mkdirSync(mainVariants, { recursive: true })
      cpSync(wtVariants, mainVariants, { recursive: true })
    }

    return {
      trackId,
      status: 'completed',
      summary: `proposer ${idx} produced proposal`,
      output: proposal,
      evidence: [
        { kind: 'artifact', label: 'pending_eval', value: proposal },
        { kind: 'metric', label: 'cost', value: String(result.costUsd) },
      ],
    }
  } finally {
    cleanupWorktree(cfg.repoPath, wt.path)
  }
}

// ─── Eval strategies ──────────────────────────────────────────────────

/**
 * Evaluate a variant. Two modes:
 *   'local' — execSync the eval command in the repo
 *   'router' — POST to Router's /api/eval endpoint (inference via hosted providers)
 */
async function evalVariant(config: CodeEvolutionConfig, variantCode: string): Promise<Record<string, number>> {
  if (config.evalMode === 'router') {
    return evalViaRouter(config, variantCode)
  }
  return evalLocal(config, variantCode)
}

/** Local eval: swap harness, run command, parse scores, restore. */
function evalLocal(config: CodeEvolutionConfig, variantCode: string): Record<string, number> {
  const harnessPath = join(config.repoPath, config.harnessRelPath)
  const original = readFileSync(harnessPath, 'utf8')
  try {
    writeFileSync(harnessPath, variantCode)
    const output = execSync(config.evalCommand, {
      cwd: config.repoPath,
      timeout: 600_000,
      encoding: 'utf8',
      env: { ...process.env, META_HARNESS: '1' },
    })
    return parseScores(output, config.dimensions)
  } finally {
    writeFileSync(harnessPath, original)
  }
}

/**
 * Router eval: POST the variant's eval request to Router's /api/eval.
 * Inference runs through hosted providers (Anthropic, OpenAI, etc.)
 * billed through one Router account. No local GPU needed.
 */
async function evalViaRouter(config: CodeEvolutionConfig, variantCode: string): Promise<Record<string, number>> {
  const url = config.routerUrl ?? process.env.TANGLE_ROUTER_URL ?? 'https://router.tangle.tools'
  const apiKey = config.routerApiKey ?? process.env.TANGLE_API_KEY
  if (!apiKey) throw new Error('TANGLE_API_KEY required for router eval mode')

  // If a suite ID is configured, run the full suite
  if (config.routerSuiteId) {
    const res = await fetch(`${url}/api/eval/suites/${config.routerSuiteId}/runs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        concurrency: 5,
        metadata: { source: 'meta-harness', variantCode: variantCode.slice(0, 500) },
      }),
    })
    if (!res.ok) throw new Error(`Router eval failed: ${res.status} ${await res.text()}`)
    const result = await res.json() as any

    // Extract scores from eval run result
    const scores: Record<string, number> = {}
    if (result.scores) return result.scores
    if (result.results) {
      const passed = result.results.filter((r: any) => r.status === 'pass').length
      scores.accuracy = passed / Math.max(result.results.length, 1)
    }
    return Object.keys(scores).length > 0 ? scores : { accuracy: 0 }
  }

  // Quick eval mode (no suite): single prompt eval
  const res = await fetch(`${url}/api/eval`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: 'Evaluate the quality of this code variant.',
      context: variantCode.slice(0, 4000),
      judge: 'llm',
    }),
  })
  if (!res.ok) throw new Error(`Router eval failed: ${res.status}`)
  const result = await res.json() as any
  return result.scores ?? { accuracy: result.score ?? 0 }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function buildProposerPrompt(skill: string, index: number, config: CodeEvolutionConfig): string {
  return [
    skill,
    '',
    `You are proposer #${index}. Read .evolve/meta-harness/frontier.json, .evolve/meta-harness/evolution.jsonl, and .evolve/meta-harness/variants/ to understand what has been tried.`,
    '',
    `The harness being evolved is: ${config.harnessRelPath}`,
    `Eval command: ${config.evalCommand}`,
    `Dimensions: ${config.dimensions.join(', ')}`,
    '',
    'Write your proposed variant to .evolve/meta-harness/variants/<name>.ts (or matching extension)',
    'Write your pending_eval.json to .evolve/meta-harness/pending_eval.json',
  ].join('\n')
}

function parseScores(output: string, dimensions: string[]): Record<string, number> {
  const scores: Record<string, number> = {}
  for (const line of output.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line)
      if (parsed.scores) return parsed.scores
    } catch {}
    const match = line.match(/^SCORE:(\w+)=([\d.]+)/)
    if (match) scores[match[1]!] = parseFloat(match[2]!)
  }
  return Object.keys(scores).length > 0 ? scores : Object.fromEntries(dimensions.map(d => [d, 1]))
}

function compileCheck(config: CodeEvolutionConfig, code: string): boolean {
  const harnessPath = join(config.repoPath, config.harnessRelPath)
  const original = readFileSync(harnessPath, 'utf8')
  try {
    writeFileSync(harnessPath, code)
    execSync(config.validateCommand, { cwd: config.repoPath, timeout: 60_000, stdio: 'ignore' })
    return true
  } catch {
    return false
  } finally {
    writeFileSync(harnessPath, original)
  }
}

function readVariantFromProposal(tr: TrackResult<string>, hyp: ReturnType<typeof parseHypothesis>, config: CodeEvolutionConfig): string | null {
  if (!hyp) return null
  const ext = config.harnessRelPath.split('.').pop() ?? 'ts'
  for (const ev of tr.evidence) {
    if (ev.kind === 'artifact' && ev.label !== 'pending_eval' && ev.value.length > 50) return ev.value
  }
  const variantPath = join(config.repoPath, '.evolve/meta-harness', 'variants', `${hyp.name}.${ext}`)
  if (existsSync(variantPath)) return readFileSync(variantPath, 'utf8')
  return null
}

function cleanupWorktree(repoPath: string, wtPath: string): void {
  try { execSync(`git -C "${repoPath}" worktree remove --force "${wtPath}"`, { stdio: 'ignore', timeout: 10_000 }) } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
