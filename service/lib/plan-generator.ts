/**
 * Plan Generator — Foreman's Planning Layer
 *
 * ALL plan work is dispatched as regular Foreman sessions:
 * - Plan ideation: Claude Code session reads project state, generates plan ideas
 * - Plan writing: Claude Code session reads codebase, writes full implementation plan
 *
 * No inline LLM calls. No callClaude. No -p mode. Everything goes through
 * the same tmux dispatch → watcher → harvest pipeline as regular work.
 *
 * Exploration/exploitation split: 70% plans extending current work, 30%
 * deliberately outside the operator's pattern. Exploration approvals
 * are worth 3x taste signal.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'

const execFileAsync = promisify(execFile)
const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
const PLANS_DIR = join(FOREMAN_HOME, 'plans')

export type PlanRank = 'critical' | 'high' | 'medium' | 'low'
export type PlanType = 'product' | 'research' | 'engineering' | 'marketing' | 'paper' | 'exploration'
export type PlanStatus = 'proposed' | 'approved' | 'rejected' | 'executing' | 'completed'

export interface Plan {
  id: string
  title: string
  type: PlanType
  rank: PlanRank
  reasoning: string
  evidence: string[]
  proposedGoal: { intent: string, workspacePath?: string, firstSkill?: string }
  risks: string[]
  opportunities: string[]
  status: PlanStatus
  isExploration: boolean
  tasteSignal?: 'approved' | 'rejected'
  createdAt: string
  approvedAt?: string
  goalId?: number
  gistUrl?: string
  dispatchId?: number  // the dispatch that generated the full plan
}

export interface PlanGeneratorContext {
  recentDecisions: Array<{ skill: string, task: string, status: string, outcome: string | null, project: string }>
  learnedFlows: string[]
  skillPreferences: string[]
  tasteSignals: string[]
  deadEnds: string[]
  activeGoals: Array<{ intent: string, workspacePath: string | null }>
  recentProjects: string[]
  sessionCount: number
  learningCount: number
}

// ─── Dispatch-based plan generation ──────────────────────────────────
// Returns dispatch instructions that the SERVICE should execute via its
// own spawnSession(). The plan generator does NOT spawn sessions itself —
// it returns the prompts and the service dispatches them.

export interface PlanDispatch {
  type: 'ideation' | 'full-plan'
  prompt: string
  workspace: string
  outputPath: string  // where Claude should write the result
  planId?: string
}

export function buildIdeationDispatch(ctx: PlanGeneratorContext): PlanDispatch {
  const decisions = ctx.recentDecisions.slice(0, 10)
    .map(d => `${d.skill} on ${d.project}: ${d.status}${d.outcome ? ' — ' + d.outcome.slice(0, 80) : ''}`)
    .join('\n')

  const goals = ctx.activeGoals
    .map(g => `${g.intent}${g.workspacePath ? ' (' + g.workspacePath.split('/').pop() + ')' : ''}`)
    .join('\n')

  const outputPath = join(PLANS_DIR, `_ideation_${Date.now()}.json`)

  const prompt = `You are Foreman's strategic planning agent. Your job is to generate 4-6 strategic plans.

## Current State
Active goals:
${goals || 'None'}

Recent dispatches:
${decisions || 'None'}

Projects: ${ctx.recentProjects.join(', ') || 'None'}
Sessions scanned: ${ctx.sessionCount} | Learnings: ${ctx.learningCount}

Operator taste: ${ctx.tasteSignals.slice(0, 3).join('; ') || 'None'}
Learned flows: ${ctx.learnedFlows.slice(0, 3).join('; ') || 'None'}
Dead ends: ${ctx.deadEnds.slice(0, 3).join('; ') || 'None'}

## Instructions

Generate 4 EXPLOITATION plans (extend current work) and 2 EXPLORATION plans (outside the operator's pattern — cross-pollination, contrarian ideas, moonshots).

Write a JSON array to ${outputPath} using the Write tool. Each element:
{
  "title": "clear title",
  "type": "engineering|product|research|exploration",
  "rank": "critical|high|medium|low",
  "overview": "2-3 sentences: what and why NOW",
  "is_exploration": false,
  "proposed_goal": {"intent": "goal description", "workspace_path": "/path", "first_skill": "/evolve"},
  "risks": ["specific risk"],
  "opportunities": ["what could go surprisingly right"]
}

For EXPLORATION plans: set is_exploration: true, type: "exploration". These should feel SURPRISING — things the operator ISN'T thinking about.

Write the JSON array to ${outputPath}. That file is your ONLY output.`

  return { type: 'ideation', prompt, workspace: FOREMAN_HOME, outputPath }
}

export function buildFullPlanDispatch(plan: Plan, ctx: PlanGeneratorContext): PlanDispatch {
  const workspace = plan.proposedGoal?.workspacePath ?? FOREMAN_HOME
  const outputPath = join(PLANS_DIR, plan.id, 'PLAN.md')

  const prompt = `You are a principal engineer writing a FULL IMPLEMENTATION PLAN. Read the codebase at ${workspace}, research whatever you need, then write a comprehensive plan.

## Plan to Elaborate
Title: ${plan.title}
Rank: ${plan.rank}
Overview: ${plan.reasoning}
Type: ${plan.type}

## Requirements

Write a 200-400 line markdown implementation plan to ${outputPath} using the Write tool.

The plan MUST include ALL of these sections:

1. **Executive Summary** (3-4 sentences)
2. **Context & Motivation** — why this matters NOW, what happens if we don't, who benefits
3. **Architecture** — ASCII diagram of system before/after, Mermaid data flow, key interfaces
4. **Detailed Implementation** — specific file paths, code snippets (real TypeScript/Python), checkboxes:
   - [ ] Step 1: Create/modify file at exact path
     \`\`\`typescript
     // actual code
     \`\`\`
5. **API Changes** — new/changed endpoints with request/response shapes
6. **Alternatives Considered** — table: Approach | Pros | Cons | Why rejected
7. **Quality Scorecard** — 10 dimensions (impact, feasibility, risk, novelty, taste alignment, time-to-value, learning potential, cross-project leverage, defensibility, fun), each scored 1-10 with bar chart (█░) and justification
8. **Risks & Mitigations** — table: Risk | Likelihood | Impact | Mitigation
9. **Edge Cases & Pitfalls** — specific scenarios that could break
10. **Testing Strategy** — unit tests, integration tests, E2E verification
11. **Success Criteria** — measurable outcomes
12. **Dependencies & Prerequisites** — what must exist first
13. **Effort Estimate** — table: Phase | Hours | Cost | Notes
14. **Rollback Plan** — how to undo

Read the actual codebase. Reference real files, real functions, real APIs. No pseudocode. No generic templates. This should feel like it was written by someone who deeply understands the system.

Write the COMPLETE plan to ${outputPath}. Then create a GitHub Gist:
gh gist create --public --desc "Foreman Plan: ${plan.title}" --filename "foreman-plan-${plan.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.md" "${outputPath}"

Print the gist URL as your final output.`

  return { type: 'full-plan', prompt, workspace, outputPath, planId: plan.id }
}

// ─── Plan management (file-based, no inline LLM) ────────────────────

export function parseIdeationOutput(outputPath: string): Plan[] {
  if (!existsSync(outputPath)) return []

  try {
    const raw = JSON.parse(readFileSync(outputPath, 'utf8')) as any[]
    const plans = raw.filter((r: any) => r && (r.title || r.name)).map((r: any) => ({
      id: `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: String(r.title ?? r.name ?? 'Untitled'),
      type: String(r.type ?? 'engineering') as PlanType,
      rank: String(r.rank ?? 'medium') as PlanRank,
      reasoning: String(r.overview ?? r.reasoning ?? ''),
      evidence: Array.isArray(r.evidence) ? r.evidence : [],
      proposedGoal: {
        intent: r.proposed_goal?.intent ?? r.title,
        workspacePath: r.proposed_goal?.workspace_path,
        firstSkill: r.proposed_goal?.first_skill,
      },
      risks: Array.isArray(r.risks) ? r.risks : [],
      opportunities: Array.isArray(r.opportunities) ? r.opportunities : [],
      status: 'proposed' as PlanStatus,
      isExploration: Boolean(r.is_exploration),
      createdAt: new Date().toISOString(),
    }))

    // Save each plan
    mkdirSync(PLANS_DIR, { recursive: true })
    for (const plan of plans) {
      const planDir = join(PLANS_DIR, plan.id)
      mkdirSync(planDir, { recursive: true })
      writeFileSync(join(planDir, 'plan.json'), JSON.stringify(plan, null, 2))
    }

    // Clean up ideation output
    try { unlinkSync(outputPath) } catch {}

    return plans
  } catch {
    return []
  }
}

export function listPlans(status?: string): Plan[] {
  mkdirSync(PLANS_DIR, { recursive: true })
  const plans: Plan[] = []

  for (const dir of readdirSync(PLANS_DIR)) {
    const jsonPath = join(PLANS_DIR, dir, 'plan.json')
    if (!existsSync(jsonPath)) continue
    try {
      const p = JSON.parse(readFileSync(jsonPath, 'utf8')) as Plan
      if (!status || p.status === status) plans.push(p)
    } catch {}
  }

  return plans.sort((a, b) => {
    const rankOrder = { critical: 0, high: 1, medium: 2, low: 3 }
    return (rankOrder[a.rank] ?? 4) - (rankOrder[b.rank] ?? 4)
  })
}

export function updatePlanStatus(id: string, status: PlanStatus, tasteSignal?: 'approved' | 'rejected'): boolean {
  const jsonPath = join(PLANS_DIR, id, 'plan.json')
  if (!existsSync(jsonPath)) return false

  const plan = JSON.parse(readFileSync(jsonPath, 'utf8')) as Plan
  plan.status = status
  if (tasteSignal) plan.tasteSignal = tasteSignal
  if (status === 'approved') plan.approvedAt = new Date().toISOString()
  writeFileSync(jsonPath, JSON.stringify(plan, null, 2))
  return true
}

export function getPlan(id: string): Plan | null {
  const jsonPath = join(PLANS_DIR, id, 'plan.json')
  if (!existsSync(jsonPath)) return null
  return JSON.parse(readFileSync(jsonPath, 'utf8')) as Plan
}

// ─── Draft PR for plan proposals ─────────────────────────────────────

export async function openProposalPR(id: string): Promise<string | null> {
  // Reuse skill-proposals PR logic but for plans
  const plan = getPlan(id)
  if (!plan) return null

  const planMd = join(PLANS_DIR, id, 'PLAN.md')
  if (!existsSync(planMd)) return null

  try {
    const { stdout } = await execFileAsync('gh', [
      'gist', 'create', '--public',
      '--desc', `Foreman Plan: ${plan.title} [${plan.rank}]`,
      '--filename', `foreman-plan-${plan.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.md`,
      planMd,
    ], { timeout: 15_000 })
    const gistUrl = stdout.trim()

    // Update plan with gist URL
    plan.gistUrl = gistUrl
    writeFileSync(join(PLANS_DIR, id, 'plan.json'), JSON.stringify(plan, null, 2))

    return gistUrl
  } catch {
    return null
  }
}
