/**
 * Learned Dispatch Policy
 *
 * Uses AxGEPA to optimize the skill selection decision from outcome data.
 * The generator takes project state + goal + history and outputs the next
 * skill + task. GEPA evolves the instruction from (decision, outcome) pairs.
 *
 * Pluggable: Identity (use post-completion recommendation or heuristic),
 * LLM (single Claude call to reason about next step), GEPA (optimized).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CLAUDE_BIN = process.env.CLAUDE_PATH ?? join(homedir(), '.local/bin/claude')

export interface DispatchDecision {
  skill: string
  task: string
  reasoning: string
}

export interface DispatchContext {
  goalIntent: string
  projectName: string
  recentDecisions: Array<{
    skill: string
    status: string
    outcome: string | null
  }>
  learnedFlows: string[]
  skillPreferences: string[]
  confidenceLevel: string
}

export interface DispatchPolicy {
  name: string
  decide(ctx: DispatchContext): Promise<DispatchDecision>
}

// ─── Identity policy: use heuristic ──────────────────────────────────

export const identityPolicy: DispatchPolicy = {
  name: 'identity',
  async decide(ctx) {
    const last = ctx.recentDecisions[0]
    return {
      skill: last?.skill || '/evolve',
      task: `Continue: ${ctx.goalIntent.slice(0, 200)}`,
      reasoning: 'identity policy — repeat last skill',
    }
  },
}

// ─── LLM policy: Claude reasons about next step ─────────────────────

export const llmPolicy: DispatchPolicy = {
  name: 'llm',
  async decide(ctx) {
    const history = ctx.recentDecisions.slice(0, 5)
      .map(d => `${d.skill} → ${d.status}${d.outcome ? ': ' + d.outcome.slice(0, 80) : ''}`)
      .join('\n')

    const flows = ctx.learnedFlows.slice(0, 3).join('\n')
    const prefs = ctx.skillPreferences.slice(0, 3).join('\n')

    const prompt = `You are Foreman's dispatch policy. Given the project state, decide what skill to dispatch next.

Goal: ${ctx.goalIntent}
Project: ${ctx.projectName}
Confidence: ${ctx.confidenceLevel}

Recent dispatches:
${history || 'None yet'}

Learned operator patterns:
${flows || 'No flows learned yet'}

Operator skill preferences:
${prefs || 'No preferences learned yet'}

Available skills:
- /evolve — iterative metric improvement (run multiple times in a row when metrics are improving)
- /pursue — architectural redesign (use when evolve plateaus or fundamental change needed)
- /polish — quality refinement (use when code works but needs cleanup)
- /verify — correctness check (use after significant changes)
- /converge — CI repair (use when tests/CI are failing)
- /critical-audit — security/quality gate
- /research — hypothesis-driven experiments
- /diagnose — failure analysis

Respond with JSON only:
{"skill": "/evolve", "task": "specific task description", "reasoning": "why this skill now"}`

    try {
      const { stdout } = await execFileAsync(CLAUDE_BIN, [
        '-p', prompt, '--output-format', 'text', '--model', 'claude-haiku-4-5-20251001',
      ], { timeout: 30_000, env: { ...process.env, PATH: `${homedir()}/.local/bin:${process.env.PATH}` } })

      const match = stdout.match(/\{[\s\S]*\}/)
      if (match) {
        const parsed = JSON.parse(match[0])
        return {
          skill: parsed.skill || '/evolve',
          task: parsed.task || `Continue: ${ctx.goalIntent.slice(0, 200)}`,
          reasoning: `llm-policy: ${parsed.reasoning || 'no reasoning'}`,
        }
      }
    } catch {}

    // Fallback
    return identityPolicy.decide(ctx)
  },
}

// ─── GEPA policy: optimized from outcome data ───────────────────────

let gepaPolicy: DispatchPolicy | null = null

export async function initGepaPolicy(
  trainingData: Array<{
    context: DispatchContext
    decision: DispatchDecision
    outcome: 'success' | 'failure'
  }>,
): Promise<DispatchPolicy> {
  if (trainingData.length < 5) {
    console.log('GEPA dispatch policy: not enough data (need 5+, have', trainingData.length, ')')
    return llmPolicy
  }

  try {
    const axLib: any = await import('@ax-llm/ax')
    const { ai, ax, AxGEPA } = axLib

    const studentAI = ai({ name: 'anthropic', config: { model: 'claude-haiku-4-5-20251001' as any } })
    const teacherAI = ai({ name: 'anthropic', config: { model: 'claude-sonnet-4-6' as any } })

    const decider = ax(
      'goalIntent:string, projectName:string, recentHistory:string, learnedFlows:string -> skill:string, task:string'
    )
    decider.setInstruction(
      'You are a dispatch policy for an autonomous portfolio operator. Choose the right skill and task based on the goal, project state, recent history, and learned operator patterns. Prefer repeating a working skill over rotating. Use /evolve for improvement, /pursue for architectural changes, /polish for cleanup, /verify after changes.'
    )

    const train = trainingData.slice(0, Math.floor(trainingData.length * 0.7)).map(d => ({
      goalIntent: d.context.goalIntent.slice(0, 200),
      projectName: d.context.projectName,
      recentHistory: d.context.recentDecisions.slice(0, 3).map(r => `${r.skill}→${r.status}`).join(', '),
      learnedFlows: d.context.learnedFlows.slice(0, 2).join('; '),
      skill: d.decision.skill,
      task: d.decision.task.slice(0, 100),
    }))

    const validation = trainingData.slice(Math.floor(trainingData.length * 0.7)).map(d => ({
      goalIntent: d.context.goalIntent.slice(0, 200),
      projectName: d.context.projectName,
      recentHistory: d.context.recentDecisions.slice(0, 3).map(r => `${r.skill}→${r.status}`).join(', '),
      learnedFlows: d.context.learnedFlows.slice(0, 2).join('; '),
      skill: d.decision.skill,
      task: d.decision.task.slice(0, 100),
    }))

    const metric = ({ prediction, example }: { prediction: any, example: any }) => {
      const skillMatch = prediction?.skill === example?.skill ? 1 : 0
      const taskRelevance = typeof prediction?.task === 'string' && prediction.task.length > 10 ? 1 : 0
      return { skillMatch, taskRelevance }
    }

    const optimizer = new AxGEPA({
      studentAI,
      teacherAI,
      numTrials: 8,
      minibatch: true,
      minibatchSize: 4,
      earlyStoppingTrials: 3,
      sampleCount: 1,
    })

    const result = await optimizer.compile(decider, train, metric, {
      validationExamples: validation,
      maxMetricCalls: 80,
    })

    if (result.optimizedProgram) {
      decider.applyOptimization(result.optimizedProgram)
      console.log(`GEPA dispatch policy: optimized (score: ${result.bestScore})`)
    }

    gepaPolicy = {
      name: 'gepa',
      async decide(ctx) {
        try {
          const result = await decider.forward(studentAI, {
            goalIntent: ctx.goalIntent.slice(0, 200),
            projectName: ctx.projectName,
            recentHistory: ctx.recentDecisions.slice(0, 3).map(r => `${r.skill}→${r.status}`).join(', '),
            learnedFlows: ctx.learnedFlows.slice(0, 2).join('; '),
          })
          return {
            skill: result.skill || '/evolve',
            task: result.task || `Continue: ${ctx.goalIntent.slice(0, 200)}`,
            reasoning: 'gepa-optimized dispatch policy',
          }
        } catch {
          return llmPolicy.decide(ctx)
        }
      },
    }

    return gepaPolicy
  } catch (e) {
    console.log(`GEPA dispatch policy init failed: ${e}`)
    return llmPolicy
  }
}

// ─── Policy registry ─────────────────────────────────────────────────

const DISPATCH_POLICY = process.env.FOREMAN_DISPATCH_POLICY ?? 'llm'

const policies: Record<string, DispatchPolicy> = {
  identity: identityPolicy,
  llm: llmPolicy,
}

export function getDispatchPolicy(): DispatchPolicy {
  if (DISPATCH_POLICY === 'gepa' && gepaPolicy) return gepaPolicy
  return policies[DISPATCH_POLICY] ?? llmPolicy
}
