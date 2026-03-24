/**
 * Plan Generator — Foreman's Planning Layer
 *
 * Generates strategic plans from session analysis, project state, and
 * learned operator patterns. Plans are ranked by predicted value and
 * split between exploitation (match taste) and exploration (find gaps).
 *
 * The exploration/exploitation split is the key insight: taste learning
 * converges on what the operator already likes. Exploration plans are
 * deliberately outside the pattern — adjacent fields, contrarian
 * approaches, connections between unrelated projects. If an exploration
 * plan gets approved, that signal is worth 3x because it means Foreman
 * found something genuinely new.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'

const execFileAsync = promisify(execFile)
const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
const PLANS_DIR = join(FOREMAN_HOME, 'plans')
const CLAUDE_BIN = process.env.CLAUDE_PATH ?? join(homedir(), '.local/bin/claude')

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
  proposedGoal: {
    intent: string
    workspacePath?: string
    firstSkill?: string
  }
  risks: string[]
  opportunities: string[]       // what could go RIGHT that we're not seeing
  status: PlanStatus
  isExploration: boolean        // explicitly outside operator's usual pattern
  tasteSignal?: 'approved' | 'rejected'
  createdAt: string
  approvedAt?: string
  goalId?: number               // if converted to a goal
}

export interface PlanGeneratorContext {
  // From decisions table
  recentDecisions: Array<{
    skill: string
    task: string
    status: string
    outcome: string | null
    project: string
  }>
  // From learnings
  learnedFlows: string[]
  skillPreferences: string[]
  tasteSignals: string[]
  deadEnds: string[]
  // From goals
  activeGoals: Array<{ intent: string, workspacePath: string | null }>
  // From session scanning
  recentProjects: string[]       // repos with recent session activity
  sessionCount: number
  learningCount: number
}

// ─── Plan generation ─────────────────────────────────────────────────

export async function generatePlans(ctx: PlanGeneratorContext): Promise<Plan[]> {
  const exploitationPrompt = buildExploitationPrompt(ctx)
  const explorationPrompt = buildExplorationPrompt(ctx)

  // Generate both in parallel
  const [exploitationPlans, explorationPlans] = await Promise.all([
    callLLMForPlans(exploitationPrompt, false),
    callLLMForPlans(explorationPrompt, true),
  ])

  const plans = [...exploitationPlans, ...explorationPlans]

  // Save each plan
  mkdirSync(PLANS_DIR, { recursive: true })
  for (const plan of plans) {
    const planDir = join(PLANS_DIR, plan.id)
    mkdirSync(planDir, { recursive: true })
    writeFileSync(join(planDir, 'plan.json'), JSON.stringify(plan, null, 2))
    writeFileSync(join(planDir, 'REVIEW.md'), renderPlanReview(plan))
  }

  return plans
}

function buildExploitationPrompt(ctx: PlanGeneratorContext): string {
  const decisions = ctx.recentDecisions.slice(0, 10)
    .map(d => `${d.skill} on ${d.project}: ${d.status}${d.outcome ? ' — ' + d.outcome.slice(0, 80) : ''}`)
    .join('\n')

  const goals = ctx.activeGoals
    .map(g => `${g.intent}${g.workspacePath ? ' (' + g.workspacePath.split('/').pop() + ')' : ''}`)
    .join('\n')

  const taste = ctx.tasteSignals.slice(0, 5).join('\n')
  const flows = ctx.learnedFlows.slice(0, 5).join('\n')
  const deadEnds = ctx.deadEnds.slice(0, 3).join('\n')

  return `You are Foreman's strategic planning agent. Generate 3-4 plans that extend the operator's current work in high-value directions.

## Current State
Active goals:
${goals || 'None'}

Recent dispatches (${ctx.recentDecisions.length} total):
${decisions || 'None'}

Projects with recent activity: ${ctx.recentProjects.join(', ') || 'None'}
Sessions scanned: ${ctx.sessionCount} | Learnings: ${ctx.learningCount}

## Operator Taste
${taste || 'No taste signals yet'}

## Learned Workflows
${flows || 'No flows learned yet'}

## Dead Ends (don't repeat)
${deadEnds || 'None'}

## Your Job
Generate 3-4 plans that:
1. Build on what's working (extend successful dispatches)
2. Address gaps in the portfolio (stalled goals, missing coverage)
3. Have clear reasoning tied to evidence from the data above
4. Are ranked: critical (must do), high (should do), medium (nice to have), low (consider)

Each plan needs: title, type (product/research/engineering/marketing/paper), rank, reasoning (2-3 sentences with evidence), evidence (specific decision IDs or patterns), proposed_goal (intent + workspace if applicable + first_skill), risks, opportunities (what could go surprisingly right).

Respond with JSON array:
[{"title":"...","type":"...","rank":"...","reasoning":"...","evidence":["..."],"proposed_goal":{"intent":"...","workspace_path":"...","first_skill":"/evolve"},"risks":["..."],"opportunities":["..."]}]`
}

function buildExplorationPrompt(ctx: PlanGeneratorContext): string {
  const projects = ctx.recentProjects.join(', ')
  const taste = ctx.tasteSignals.slice(0, 3).join('\n')

  return `You are Foreman's exploration agent. Your job is to propose plans the operator ISN'T thinking about — connections they're missing, adjacent opportunities, contrarian approaches.

## What the Operator Is Doing
Projects: ${projects || 'Unknown'}
Active goals: ${ctx.activeGoals.map(g => g.intent).join('; ') || 'None'}
Taste: ${taste || 'No signals yet'}

## Your Job — Think OUTSIDE the Operator's Pattern
Generate 1-2 exploration plans that:

1. **Cross-pollinate**: connect two unrelated projects or domains the operator works in. "What if technique X from project A could transform project B?"

2. **Contrarian**: challenge an assumption the operator seems to hold. "You've been optimizing X, but what if Y is the actual bottleneck?"

3. **Adjacent opportunity**: something just outside the operator's current scope that their skills/infrastructure uniquely position them for. "You have session scanning across 1900+ sessions — that's a dataset for a paper on human-AI collaboration patterns."

4. **Moonshot**: a high-risk, high-reward idea that wouldn't come from incremental thinking. "What if Foreman could operate across multiple operators, learning organizational taste?"

These plans should feel SURPRISING. If the operator would have thought of it themselves, it's not exploration — it's exploitation.

Rank them honestly. Most exploration ideas are medium or low value. That's fine — the 1 in 10 that's critical is worth the other 9.

Respond with JSON array:
[{"title":"...","type":"exploration","rank":"...","reasoning":"...","evidence":["operator pattern: ..."],"proposed_goal":{"intent":"..."},"risks":["..."],"opportunities":["..."]}]`
}

async function callLLMForPlans(prompt: string, isExploration: boolean): Promise<Plan[]> {
  try {
    const { stdout } = await execFileAsync(CLAUDE_BIN, [
      '-p', prompt, '--output-format', 'text', '--model', 'claude-sonnet-4-6',
    ], {
      timeout: 90_000,
      env: { ...process.env, PATH: `${homedir()}/.local/bin:${process.env.PATH}` },
    })

    const match = stdout.match(/\[[\s\S]*\]/)
    if (!match) return []

    const raw = JSON.parse(match[0]) as Array<{
      title: string, type: string, rank: string, reasoning: string,
      evidence: string[], proposed_goal: { intent: string, workspace_path?: string, first_skill?: string },
      risks: string[], opportunities: string[],
    }>

    return raw.map(r => ({
      id: `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: r.title,
      type: (isExploration ? 'exploration' : r.type) as PlanType,
      rank: r.rank as PlanRank,
      reasoning: r.reasoning,
      evidence: r.evidence ?? [],
      proposedGoal: {
        intent: r.proposed_goal?.intent ?? r.title,
        workspacePath: r.proposed_goal?.workspace_path,
        firstSkill: r.proposed_goal?.first_skill,
      },
      risks: r.risks ?? [],
      opportunities: r.opportunities ?? [],
      status: 'proposed' as PlanStatus,
      isExploration,
      createdAt: new Date().toISOString(),
    }))
  } catch (e) {
    console.log(`Plan generation failed: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

// ─── Plan management ─────────────────────────────────────────────────

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

// ─── Render human-readable review ────────────────────────────────────

function renderPlanReview(p: Plan): string {
  const lines: string[] = []
  const explorationTag = p.isExploration ? ' 🔭 EXPLORATION' : ''

  lines.push(`# Plan: ${p.title}${explorationTag}`)
  lines.push(`Type: ${p.type} | Rank: ${p.rank} | Status: ${p.status}`)
  lines.push(`Date: ${p.createdAt}`)
  lines.push('')

  lines.push('## Reasoning')
  lines.push(p.reasoning)
  lines.push('')

  if (p.opportunities.length > 0) {
    lines.push('## What Could Go Surprisingly Right')
    for (const o of p.opportunities) lines.push(`- 🚀 ${o}`)
    lines.push('')
  }

  if (p.risks.length > 0) {
    lines.push('## Risks')
    for (const r of p.risks) lines.push(`- ⚠️ ${r}`)
    lines.push('')
  }

  lines.push('## Proposed Goal')
  lines.push(`Intent: ${p.proposedGoal.intent}`)
  if (p.proposedGoal.workspacePath) lines.push(`Workspace: ${p.proposedGoal.workspacePath}`)
  if (p.proposedGoal.firstSkill) lines.push(`First skill: ${p.proposedGoal.firstSkill}`)
  lines.push('')

  if (p.evidence.length > 0) {
    lines.push('## Evidence')
    for (const e of p.evidence) lines.push(`- ${e}`)
    lines.push('')
  }

  if (p.isExploration) {
    lines.push('## Why This Is An Exploration Plan')
    lines.push('This plan is deliberately outside your usual pattern. If it resonates,')
    lines.push("that's a signal Foreman found something genuinely new. Approving exploration")
    lines.push('plans trains the system to think more creatively.')
  }

  return lines.join('\n')
}
