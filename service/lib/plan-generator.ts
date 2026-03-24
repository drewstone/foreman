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

  // For each plan, dispatch Claude to write a FULL implementation brief
  // with real code references, file paths, snippets, and diagrams.
  // Then publish each as its own gist.
  for (const plan of plans) {
    const fullPlan = await generateFullPlanDocument(plan, ctx)
    const gistUrl = await publishSinglePlanGist(plan, fullPlan)
    if (gistUrl) (plan as any).gistUrl = gistUrl
    // Also save locally
    const planDir = join(PLANS_DIR, plan.id)
    writeFileSync(join(planDir, 'PLAN.md'), fullPlan)
  }

  return plans
}

// ─── Full plan document generation ────────────────────────────────────
// Dispatches Claude with codebase access to write a detailed implementation
// plan with real file paths, code snippets, architecture diagrams, and
// step-by-step instructions. This is the ~/.claude/plans/ quality level.

async function generateFullPlanDocument(plan: any, ctx: PlanGeneratorContext): Promise<string> {
  const workspace = plan.proposedGoal?.workspacePath ?? process.cwd()

  const prompt = `You are writing a FULL IMPLEMENTATION PLAN for this feature/improvement. This must be publication-quality — the kind of plan a principal engineer writes before a major project.

## The Plan
Title: ${plan.title}
Type: ${plan.type}
Rank: ${plan.rank}
Overview: ${plan.reasoning}
Motivation: ${plan.motivation || 'See overview'}
Value: ${plan.valueIfDone || 'Significant improvement'}
Cost of inaction: ${plan.costOfInaction || 'Continued current state'}

## Your Task
Write a COMPREHENSIVE implementation plan. This should be 200-400 lines of markdown. Include ALL of these:

### 1. Executive Summary (3-4 sentences)
What, why, and what changes.

### 2. Context & Motivation
- Current state (read actual code to understand)
- Why this matters NOW
- What happens if we don't do this
- Who benefits

### 3. Architecture
- ASCII diagram showing the system before and after
- Mermaid diagram of the data flow or component interaction
- Key interfaces and abstractions
- How this fits into the existing system

### 4. Detailed Implementation Plan
For EACH step:
- Specific file path to create/modify
- Code snippets showing the key changes (actual TypeScript/Python, not pseudocode)
- What to test after each step
- Estimated time

Use checkboxes:
- [ ] Step 1: Create X at path/to/file.ts
  \`\`\`typescript
  // actual code snippet
  \`\`\`

### 5. API Changes (if any)
- New endpoints with request/response shapes
- Changed endpoints with migration path
- Client changes needed

### 6. Alternatives Considered
| Approach | Pros | Cons | Why rejected |
|---|---|---|---|
| ... | ... | ... | ... |

### 7. Quality Scorecard
| Dimension | Score | Bar | Justification |
|---|---|---|---|
| Impact | X/10 | █████░░░░░ | ... |
(all 10 dimensions)

### 8. Risks & Mitigations
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ... | ... | ... | ... |

### 9. Edge Cases & Pitfalls
Specific scenarios that could break, with how to handle each.

### 10. Testing Strategy
- Unit tests needed
- Integration tests needed
- How to verify the feature works end-to-end

### 11. Success Criteria
Measurable outcomes. How do we know this worked?

### 12. Dependencies & Prerequisites
What must exist before starting? What blocks what?

### 13. Effort Estimate
| Phase | Hours | Cost | Notes |
|---|---|---|---|
| Design | X | $0 | ... |
| Implementation | X | $Y | ... |
| Testing | X | $0 | ... |
| **Total** | **X** | **$Y** | ... |

### 14. Rollback Plan
How to undo if it goes wrong.

IMPORTANT:
- Read the actual codebase at ${workspace} to reference real files, functions, and APIs
- Use real code snippets, not pseudocode
- Be specific about file paths
- Include mermaid diagrams where they help
- This should be 200-400 lines minimum
- Write it like a senior staff engineer, not a template`

  try {
    const promptFile = join(FOREMAN_HOME, 'plans', `_fullplan_${Date.now()}.txt`)
    mkdirSync(join(FOREMAN_HOME, 'plans'), { recursive: true })
    writeFileSync(promptFile, prompt)
    // Use bash pipe — execFileAsync with long prompts breaks arg parsing
    const { stdout } = await execFileAsync('bash', [
      '-c', `cd "${workspace}" && cat "${promptFile}" | "${CLAUDE_BIN}" -p --output-format text --model claude-opus-4-6 --dangerously-skip-permissions`,
    ], {
      timeout: 300_000, // 5 minutes for deep Opus plan generation
      env: { ...process.env, PATH: `${homedir()}/.local/bin:${process.env.PATH}` },
    })
    try { require('fs').unlinkSync(promptFile) } catch {}
    return stdout.trim() || renderPlanReview(plan) // fallback to template
  } catch (e) {
    console.log(`Full plan generation failed: ${e instanceof Error ? e.message : String(e)}`)
    return renderPlanReview(plan) // fallback to template rendering
  }
}

// ─── Per-plan GitHub Gist ─────────────────────────────────────────────

async function publishSinglePlanGist(plan: any, markdown: string): Promise<string | null> {
  try {
    const slug = (plan.title ?? 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)
    const filename = `foreman-plan-${slug}.md`
    const tmpFile = join(FOREMAN_HOME, 'plans', `_gist_${Date.now()}.md`)
    writeFileSync(tmpFile, markdown)
    const { stdout } = await execFileAsync('gh', [
      'gist', 'create', '--public',
      '--desc', `Foreman Plan: ${plan.title ?? 'untitled'} [${plan.rank ?? '?'}]`,
      '--filename', filename,
      tmpFile,
    ], { timeout: 15_000 })
    try { require('fs').unlinkSync(tmpFile) } catch {}
    return stdout.trim()
  } catch (e) {
    console.log(`Gist failed for ${plan.title}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
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

Respond with a JSON array. Keep each plan concise — the full document will be generated separately.
[{"title":"Plan Title","rank":"critical|high|medium|low","type":"product|research|engineering","overview":"2 sentences","motivation":"why now","proposed_goal":{"intent":"goal description","workspace_path":"/path/if/applicable","first_skill":"/skill"},"risks":["risk"],"opportunities":["opportunity"]}]`
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

Respond with the SAME JSON format as exploitation plans (with overview, motivation, alternatives, checklist, scorecard, pitfalls, etc). Use type: "exploration".`
}

async function callLLMForPlans(prompt: string, isExploration: boolean): Promise<Plan[]> {
  try {
    // Write prompt to file, pipe to claude via bash
    const promptFile = join(FOREMAN_HOME, 'plans', `_prompt_${Date.now()}.txt`)
    mkdirSync(join(FOREMAN_HOME, 'plans'), { recursive: true })
    writeFileSync(promptFile, prompt)
    const { stdout } = await execFileAsync('bash', [
      '-c', `cat "${promptFile}" | "${CLAUDE_BIN}" -p --output-format text --model claude-sonnet-4-6`,
    ], {
      timeout: 90_000,
      env: { ...process.env, PATH: `${homedir()}/.local/bin:${process.env.PATH}` },
    })
    try { require('fs').unlinkSync(promptFile) } catch {}

    const match = stdout.match(/\[[\s\S]*\]/)
    if (!match) return []

    const raw = JSON.parse(match[0]) as any[]

    return raw.filter((r: any) => r && (r.title || r.name)).map((r: any) => ({
      id: `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: String(r.title ?? r.name ?? 'Untitled Plan'),
      type: (isExploration ? 'exploration' : String(r.type ?? 'engineering')) as PlanType,
      rank: String(r.rank ?? 'medium') as PlanRank,
      reasoning: String(r.overview ?? r.reasoning ?? r.description ?? ''),
      motivation: String(r.motivation ?? r.why ?? ''),
      valueIfDone: String(r.value_if_done ?? r.value ?? ''),
      costOfInaction: String(r.cost_of_inaction ?? r.cost_if_not ?? ''),
      approach: r.approach ?? r.technical_approach ?? '',
      alternatives: Array.isArray(r.alternatives) ? r.alternatives : [],
      checklist: Array.isArray(r.checklist) ? r.checklist : Array.isArray(r.steps) ? r.steps : [],
      scorecard: r.scorecard ?? r.scores ?? {},
      pitfalls: Array.isArray(r.pitfalls) ? r.pitfalls : [],
      edgeCases: Array.isArray(r.edge_cases) ? r.edge_cases : [],
      successCriteria: Array.isArray(r.success_criteria) ? r.success_criteria : [],
      effort: r.effort ?? r.estimate ?? {},
      evidence: Array.isArray(r.evidence) ? r.evidence : [],
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

function renderPlanReview(p: any): string {
  const lines: string[] = []
  const rankIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }[String(p.rank ?? 'medium')] ?? '⚪'
  const explorationTag = p.isExploration ? ' 🔭' : ''

  lines.push(`# ${rankIcon} ${p.title}${explorationTag}`)
  lines.push('')
  lines.push(`| | |`)
  lines.push(`|---|---|`)
  lines.push(`| **Rank** | ${String(p.rank ?? 'medium')} |`)
  lines.push(`| **Type** | ${p.type} |`)
  lines.push(`| **Status** | ${p.status} |`)
  if (p.effort?.hours) lines.push(`| **Effort** | ${p.effort.hours}h, ~$${p.effort.cost_usd ?? '?'} |`)
  lines.push(`| **Date** | ${p.createdAt?.slice(0, 10)} |`)
  lines.push('')

  // Overview
  if (p.reasoning) {
    lines.push(`## Overview`)
    lines.push(p.reasoning)
    lines.push('')
  }

  // Motivation
  if (p.motivation) {
    lines.push(`## Motivation`)
    lines.push(p.motivation)
    lines.push('')
  }

  // Value / Cost of inaction
  if (p.valueIfDone || p.costOfInaction) {
    lines.push('## Value Proposition')
    lines.push('')
    lines.push('| | |')
    lines.push('|---|---|')
    if (p.valueIfDone) lines.push(`| **If we do this** | ${p.valueIfDone} |`)
    if (p.costOfInaction) lines.push(`| **If we don't** | ${p.costOfInaction} |`)
    lines.push('')
  }

  // Approach
  if (p.approach) {
    lines.push('## Approach')
    if (typeof p.approach === 'string') lines.push(p.approach)
    else if (Array.isArray(p.approach)) for (const a of p.approach) lines.push(`- ${a}`)
    lines.push('')
  }

  // Alternatives considered
  if (p.alternatives?.length > 0) {
    lines.push('## Alternatives Considered')
    lines.push('')
    lines.push('| Alternative | Pros | Cons | Verdict |')
    lines.push('|---|---|---|---|')
    for (const alt of p.alternatives) {
      lines.push(`| ${alt.name} | ${alt.pros} | ${alt.cons} | ❌ ${alt.rejected_because} |`)
    }
    lines.push('')
  }

  // Implementation checklist
  if (p.checklist?.length > 0) {
    lines.push('## Implementation Checklist')
    for (const step of p.checklist) lines.push(`- [ ] ${step}`)
    lines.push('')
  }

  // Scorecard
  if (p.scorecard && Object.keys(p.scorecard).length > 0) {
    lines.push('## Quality Scorecard')
    lines.push('')
    lines.push('| Dimension | Score | Justification |')
    lines.push('|---|---|---|')
    let total = 0; let count = 0
    for (const [dim, val] of Object.entries(p.scorecard)) {
      const v = val as any
      const score = v?.score ?? v
      const why = v?.why ?? ''
      const bar = typeof score === 'number' ? ('█'.repeat(score) + '░'.repeat(10 - score)) : ''
      lines.push(`| ${dim.replace(/_/g, ' ')} | ${bar} ${score}/10 | ${why} |`)
      if (typeof score === 'number') { total += score; count++ }
    }
    if (count > 0) {
      const composite = (total / count).toFixed(1)
      lines.push(`| **Composite** | **${composite}/10** | |`)
    }
    lines.push('')
  }

  // Pitfalls & edge cases
  if (p.pitfalls?.length > 0 || p.edgeCases?.length > 0) {
    lines.push('## Pitfalls & Edge Cases')
    for (const pit of (p.pitfalls ?? [])) lines.push(`- ⚠️ ${pit}`)
    for (const ec of (p.edgeCases ?? [])) lines.push(`- 🔲 ${ec}`)
    lines.push('')
  }

  // Risks
  if (p.risks?.length > 0) {
    lines.push('## Risks')
    for (const r of p.risks) lines.push(`- ${r}`)
    lines.push('')
  }

  // Opportunities
  if (p.opportunities?.length > 0) {
    lines.push('## What Could Go Surprisingly Right')
    for (const o of p.opportunities) lines.push(`- 🚀 ${o}`)
    lines.push('')
  }

  // Success criteria
  if (p.successCriteria?.length > 0) {
    lines.push('## Success Criteria')
    for (const sc of p.successCriteria) lines.push(`- ✅ ${sc}`)
    lines.push('')
  }

  // Evidence
  if (p.evidence?.length > 0) {
    lines.push('## Evidence')
    for (const e of p.evidence) lines.push(`- ${e}`)
    lines.push('')
  }

  // Proposed goal
  lines.push('## Proposed Goal')
  lines.push(`**Intent:** ${p.proposedGoal?.intent ?? p.title}`)
  if (p.proposedGoal?.workspacePath) lines.push(`**Workspace:** ${p.proposedGoal.workspacePath}`)
  if (p.proposedGoal?.firstSkill) lines.push(`**First skill:** ${p.proposedGoal.firstSkill}`)
  lines.push('')

  if (p.isExploration) {
    lines.push('---')
    lines.push('*🔭 This is an exploration plan — deliberately outside your usual pattern.*')
    lines.push('*Approving it teaches Foreman to think more creatively.*')
    lines.push("that's a signal Foreman found something genuinely new. Approving exploration")
    lines.push('plans trains the system to think more creatively.')
  }

  return lines.join('\n')
}
