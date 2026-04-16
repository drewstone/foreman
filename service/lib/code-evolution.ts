/**
 * Code Evolution — meta-harness loop implemented as a runTaskLoop provider.
 *
 * Each round = one evolution iteration.
 * Each track = one parallel CC proposer dispatched via spawnSession.
 * Validation = hypothesis discipline + compile check + benchmark.
 *
 * Uses ONLY existing Foreman infrastructure:
 *   - spawnSession (session-manager.ts) for CC dispatch
 *   - createWorktree (prompt-composer.ts) for isolation
 *   - callClaude (claude-runner.ts) for proposer calls
 *   - TraceStore (@drew/foreman-tracing) for trace persistence
 *   - OptimizationSurface registry for surface management
 *   - State (SQLite, log, emit) for all persistence
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'

import type {
  LoopOptions,
  ContextSnapshot,
  Plan,
  Track,
  TrackResult,
  ValidationResult,
  StopDecision,
  ArtifactStore,
  TaskSpec,
} from '@drew/foreman-core'

import { CodeSurface, type CodeSurfaceConfig, type EvolutionEntry } from '../../packages/optimizer/src/code-surface.js'
import { parseHypothesis, validateHypothesis } from '../../packages/optimizer/src/hypothesis.js'
import { callClaude } from './claude-runner.js'
import { createWorktree } from './prompt-composer.js'

// ─── Types ──────────────────────────────────────────────────────────

export interface CodeEvolutionConfig {
  /** Repo path to evolve */
  repoPath: string
  /** Harness file relative to repo */
  harnessRelPath: string
  /** Eval command (run in repo root, must output JSON scores) */
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
  /** Session backend: 'tmux' or 'tangle' */
  backend?: 'tmux' | 'tangle'
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
    stateDir: join(config.repoPath, '.meta-harness'),
  }
  const surface = new CodeSurface(surfaceConfig)

  // Read SKILL.md from foreman's skill dir
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

    async context({ round, loop }): Promise<ContextSnapshot<ProposerContext>> {
      // Seed baseline on first round
      if (round === 1 && surface.getFrontier().entries.length === 0) {
        const baselineScores = await runEval(config, surface.getCurrent())
        surface.seedBaseline(baselineScores)
      }

      return {
        summary: `Round ${round}: ${surface.getFrontierSummary()}`,
        state: { surface, config, skillContent },
        evidence: [{
          kind: 'metric',
          label: 'frontier',
          value: surface.getFrontierSummary(),
        }],
      }
    },

    // ─── plan: create N tracks (one per proposer) ─────────────────

    async plan({ context }): Promise<Plan<{ proposerIndex: number }>> {
      return {
        summary: `Spawn ${config.parallelism} parallel proposers`,
        tracks: Array.from({ length: config.parallelism }, (_, i) => ({
          id: `proposer-${i}`,
          goal: 'Propose a structurally different harness variant',
          input: { proposerIndex: i },
          capability: 'meta-harness-propose',
        })),
      }
    },

    // ─── executeTrack: dispatch CC proposer, collect proposal ──────

    async executeTrack({ track, context, round }): Promise<TrackResult<string>> {
      const { surface: surf, config: cfg, skillContent: skill } = context!.state!
      const idx = track.input!.proposerIndex

      // Create worktree for isolation
      const wt = await createWorktree(cfg.repoPath, `mh-r${round}-p${idx}`)
      if (!wt) {
        return {
          trackId: track.id,
          status: 'failed',
          summary: 'failed to create worktree',
          evidence: [],
        }
      }

      try {
        // Copy meta-harness state into worktree so CC can read it
        const metaSrc = join(cfg.repoPath, '.meta-harness')
        const metaDst = join(wt.path, '.meta-harness')
        if (existsSync(metaSrc)) {
          cpSync(metaSrc, metaDst, { recursive: true })
        }

        // Dispatch CC proposer via callClaude (pipe mode, not tmux session)
        const prompt = buildProposerPrompt(skill, idx, cfg)
        const result = await callClaude({
          prompt,
          model: cfg.model ?? 'opus',
          timeoutMs: 300_000,
          cwd: wt.path,
        })

        // Read pending_eval.json from the worktree
        const pendingPath = join(wt.path, '.meta-harness', 'pending_eval.json')
        if (!existsSync(pendingPath)) {
          return {
            trackId: track.id,
            status: 'failed',
            summary: `proposer ${idx} produced no pending_eval.json`,
            output: result.output,
            evidence: [{ kind: 'log', label: 'cc-output', value: result.output.slice(0, 2000) }],
          }
        }

        const proposal = readFileSync(pendingPath, 'utf8')
        return {
          trackId: track.id,
          status: 'completed',
          summary: `proposer ${idx} produced proposal`,
          output: proposal,
          evidence: [
            { kind: 'artifact', label: 'pending_eval', value: proposal },
            { kind: 'metric', label: 'cost', value: String(result.costUsd) },
          ],
        }
      } finally {
        // Cleanup worktree
        cleanupWorktree(cfg.repoPath, wt.path)
      }
    },

    // ─── validate: hypothesis discipline + compile + benchmark ────

    async validate({ trackResults, context, round }): Promise<ValidationResult> {
      const { surface: surf, config: cfg } = context!.state!
      const findings: ValidationResult['findings'] = []
      let promoted = 0

      for (const tr of trackResults) {
        if (tr.status !== 'completed' || !tr.output) continue

        // Parse hypothesis
        const hyp = parseHypothesis(tr.output, round)
        if (!hyp) {
          findings.push({ severity: 'medium', title: `${tr.trackId}: unparseable proposal`, body: 'pending_eval.json could not be parsed' })
          continue
        }

        // Validate hypothesis discipline
        const hv = validateHypothesis(hyp)
        if (!hv.valid) {
          findings.push({ severity: 'medium', title: `${hyp.name}: rejected`, body: hv.rejectionReason ?? 'unknown' })
          surf.recordEvolution({ iteration: round, name: hyp.name, hypothesis: hyp.hypothesis, baseSystem: hyp.baseSystem, changes: hyp.changes, scores: null, delta: null, outcome: 'rejected', timestamp: new Date().toISOString() })
          continue
        }

        // Read variant code from the proposal artifacts
        const variantCode = readVariantFromProposal(tr, hyp, cfg)
        if (!variantCode) {
          findings.push({ severity: 'medium', title: `${hyp.name}: no code found`, body: `file ${hyp.filePath} not in proposal` })
          continue
        }

        // Compile check
        const compiles = validateCompiles(cfg, variantCode, surf)
        if (!compiles) {
          findings.push({ severity: 'high', title: `${hyp.name}: compile failure`, body: `${cfg.validateCommand} failed` })
          surf.recordEvolution({ iteration: round, name: hyp.name, hypothesis: hyp.hypothesis, baseSystem: hyp.baseSystem, changes: hyp.changes, scores: null, delta: null, outcome: 'failed', timestamp: new Date().toISOString() })
          continue
        }

        // Benchmark
        try {
          const scores = await runEval(cfg, variantCode)
          const onFrontier = surf.tryAddToFrontier(hyp, variantCode, scores)
          surf.writeVariant(hyp.name, variantCode)

          if (onFrontier) promoted++
          const outcome = onFrontier ? 'frontier' as const : 'dominated' as const

          // Compute delta
          const delta: Record<string, number> = {}
          const baseline = surf.getFrontier().entries.find(e => e.id === 'baseline')
          if (baseline) {
            for (const [k, v] of Object.entries(scores)) {
              delta[k] = v - (baseline.scores[k] ?? 0)
            }
          }

          surf.recordEvolution({ iteration: round, name: hyp.name, hypothesis: hyp.hypothesis, baseSystem: hyp.baseSystem, changes: hyp.changes, scores, delta, outcome, timestamp: new Date().toISOString() })
          findings.push({
            severity: onFrontier ? 'low' : 'medium',
            title: `${hyp.name}: ${outcome}`,
            body: `scores=${JSON.stringify(scores)} delta=${JSON.stringify(delta)}`,
          })
        } catch (e) {
          surf.recordEvolution({ iteration: round, name: hyp.name, hypothesis: hyp.hypothesis, baseSystem: hyp.baseSystem, changes: hyp.changes, scores: null, delta: null, outcome: 'failed', timestamp: new Date().toISOString() })
          findings.push({ severity: 'high', title: `${hyp.name}: benchmark failed`, body: e instanceof Error ? e.message : String(e) })
        }
      }

      const status = promoted > 0 ? 'pass' as const : 'warn' as const
      return {
        status,
        recommendation: 'repair', // always continue — more iterations = more frontier entries
        summary: `${promoted} new frontier entries. ${surf.getFrontierSummary()}`,
        findings,
        scores: { promoted, total: trackResults.length },
      }
    },

    // ─── shouldStop: frontier converged or budget exhausted ───────

    async shouldStop({ round, validation }): Promise<StopDecision> {
      if (round >= config.maxRounds) {
        return { done: true, status: 'completed', reason: `${config.maxRounds} iterations completed. ${validation.summary}` }
      }
      return { done: false, status: 'running', reason: 'continuing evolution' }
    },
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function buildProposerPrompt(skill: string, index: number, config: CodeEvolutionConfig): string {
  return [
    skill,
    '',
    `You are proposer #${index}. Read .meta-harness/frontier.json, .meta-harness/evolution.jsonl, and .meta-harness/variants/ to understand what has been tried and what the current frontier looks like.`,
    '',
    `The harness being evolved is: ${config.harnessRelPath}`,
    `Eval command: ${config.evalCommand}`,
    `Dimensions: ${config.dimensions.join(', ')}`,
    '',
    'Write your proposed variant to .meta-harness/variants/<name>.ts',
    'Write your pending_eval.json to .meta-harness/pending_eval.json',
  ].join('\n')
}

async function runEval(config: CodeEvolutionConfig, variantCode: string): Promise<Record<string, number>> {
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

    // Parse scores from eval output (JSON or SCORE: lines)
    const scores: Record<string, number> = {}
    for (const line of output.trim().split('\n').reverse()) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.scores) return parsed.scores
      } catch {}
      const match = line.match(/^SCORE:(\w+)=([\d.]+)/)
      if (match) scores[match[1]!] = parseFloat(match[2]!)
    }
    return Object.keys(scores).length > 0 ? scores : { accuracy: 1 }
  } finally {
    writeFileSync(harnessPath, original)
  }
}

function validateCompiles(config: CodeEvolutionConfig, code: string, surface: CodeSurface): boolean {
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
  // The proposal artifacts contain the evidence with the code
  // Try reading from the variants dir in the pending_eval
  const ext = config.harnessRelPath.split('.').pop() ?? 'ts'

  // Check if the eval evidence has the code
  for (const ev of tr.evidence) {
    if (ev.kind === 'artifact' && ev.label !== 'pending_eval' && ev.value.length > 50) {
      return ev.value
    }
  }

  // Try reading from .meta-harness/variants/ in the repo (CC may have written there)
  const variantPath = join(config.repoPath, '.meta-harness', 'variants', `${hyp.name}.${ext}`)
  if (existsSync(variantPath)) return readFileSync(variantPath, 'utf8')

  return null
}

function cleanupWorktree(repoPath: string, wtPath: string): void {
  try {
    execSync(`git -C "${repoPath}" worktree remove --force "${wtPath}"`, { stdio: 'ignore', timeout: 10_000 })
  } catch {}
}
