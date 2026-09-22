/**
 * Prompt composer — builds context-loaded prompts for Claude Code sessions.
 * Also: createWorktree for git worktree isolation.
 */

import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import {
  FOREMAN_HOME,
  getDb, getStmts,
} from './state.js'
import {
  DEFAULT_PROMPT_POLICY,
  getContextBudgetForSkill,
  parsePromptPolicy,
  shouldIncludeSkillGuide,
  type PromptPolicy,
} from './prompt-policy.js'

const execFileAsync = promisify(execFile)

function getLabPromptPolicy(): PromptPolicy | null {
  try {
    const db = getDb()
    const testing = db.prepare(
      `SELECT variant FROM prompt_lab WHERE surface = 'prompt_policy' AND status = 'testing' ORDER BY created_at DESC LIMIT 1`
    ).get() as { variant: string } | undefined
    if (testing?.variant) return parsePromptPolicy(testing.variant)

    const promoted = db.prepare(
      `SELECT variant FROM prompt_lab WHERE surface = 'prompt_policy' AND status = 'promoted' ORDER BY promoted_at DESC LIMIT 1`
    ).get() as { variant: string } | undefined
    if (promoted?.variant) return parsePromptPolicy(promoted.variant)
  } catch {}
  return null
}

function getActivePromptPolicy(): PromptPolicy {
  const labPolicy = getLabPromptPolicy()
  if (labPolicy) return labPolicy
  try {
    const stmts = getStmts()
    const activeTemplate = stmts.activeTemplate.get() as { template?: string | null } | undefined
    return parsePromptPolicy(activeTemplate?.template)
  } catch {
    return { ...DEFAULT_PROMPT_POLICY }
  }
}

interface PromptSection {
  name: string
  text: string
  group: 'core' | 'project_history' | 'goal_history' | 'operator' | 'operator_exemplar' | 'risk'
}

function shouldIncludeSection(group: PromptSection['group'], policy: PromptPolicy): boolean {
  switch (group) {
    case 'project_history':
      return policy.includeProjectHistory
    case 'goal_history':
      return policy.includeGoalHistory
    case 'operator':
      return policy.includeOperatorSignals
    case 'operator_exemplar':
      return policy.includeOperatorExemplars
    case 'risk':
      return policy.includeDeadEnds
    case 'core':
    default:
      return true
  }
}

function getStandardsInstruction(policy: PromptPolicy): string {
  if (policy.standardsProfile === 'strict') {
    return [
      'Staff engineer quality. Complete the task fully.',
      'Respect scope strictly. Do not widen the change without evidence.',
      'Commit after each meaningful change and keep the branch reviewable.',
      'Run relevant tests before finishing and repair failures you introduce.',
    ].join('\n- ')
  }

  if (policy.standardsProfile === 'delivery') {
    return [
      'Staff engineer quality. Finish the job decisively.',
      'Prefer concrete implementation over long explanation.',
      'Run the most relevant checks before finishing.',
      'Commit meaningful progress so the result is reviewable.',
    ].join('\n- ')
  }

  return [
    'Staff engineer quality. Complete the task fully.',
    'Commit your work after each meaningful change.',
    'If tests exist, run them. Fix failures before moving on.',
    'Act decisively. Do what the task requires.',
  ].join('\n- ')
}

function appendSection(sections: PromptSection[], section: PromptSection | null): void {
  if (section?.text) sections.push(section)
}

// ─── Git worktree ────────────────────────────────────────────────────

export async function createWorktree(repoPath: string, label: string): Promise<{
  path: string, branch: string, baseBranch: string
} | null> {
  const projectName = repoPath.split('/').pop() ?? 'project'
  const branch = `foreman/${label}`
  const wtPath = join(FOREMAN_HOME, 'worktrees', `${projectName}-${label}`)

  // Detect the correct base branch for this repo.
  // Priority: 1) per-project override from learnings table
  //           2) remote HEAD (what GitHub considers default)
  //           3) operator's current branch
  //           4) fallback to 'main'
  let baseBranch = 'main'

  // Check for per-project override (stored by operator feedback)
  try {
    const db = getDb()
    const override = db.prepare(
      `SELECT content FROM learnings WHERE type = 'project_config' AND project = ? AND content LIKE 'base_branch:%'`
    ).get(projectName) as { content: string } | undefined
    if (override) baseBranch = override.content.replace('base_branch:', '').trim()
  } catch {}

  // If no override, detect from remote HEAD
  if (baseBranch === 'main') {
    try {
      const { stdout } = await execFileAsync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], { cwd: repoPath, timeout: 5_000 })
      const remote = stdout.trim().replace('origin/', '')
      if (remote) baseBranch = remote
    } catch {
      // Fallback: operator's current branch
      try {
        const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoPath, timeout: 5_000 })
        if (stdout.trim()) baseBranch = stdout.trim()
      } catch {}
    }
  }

  // Fetch latest from remote so we branch from what's on GitHub, not local state.
  // This prevents including the operator's unpushed work in Foreman's PRs.
  try {
    await execFileAsync('git', ['fetch', 'origin', baseBranch], { cwd: repoPath, timeout: 15_000 })
  } catch {}

  // Branch from origin/<baseBranch> — clean start, no local noise
  const startPoint = `origin/${baseBranch}`

  if (existsSync(wtPath)) {
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoPath, timeout: 10_000 })
    } catch {}
  }

  try {
    await execFileAsync('git', ['branch', '-D', branch], { cwd: repoPath, timeout: 5_000 })
  } catch {}

  try {
    await execFileAsync('git', ['worktree', 'add', '-b', branch, wtPath, startPoint], { cwd: repoPath, timeout: 15_000 })
    return { path: wtPath, branch, baseBranch }
  } catch (e) {
    // Fallback: try local baseBranch if origin doesn't exist
    try {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, wtPath, baseBranch], { cwd: repoPath, timeout: 15_000 })
      return { path: wtPath, branch, baseBranch }
    } catch { return null }
  }
}

// ─── Prompt composer ─────────────────────────────────────────────────

function readProjectFile(dir: string, name: string, maxLen = 2000): string | null {
  try {
    const fp = join(dir, name)
    if (existsSync(fp)) return readFileSync(fp, 'utf8').slice(0, maxLen)
  } catch {}
  return null
}

export function composePrompt(opts: {
  skill: string
  task: string
  workDir: string
  goalIntent?: string
  goalId?: number
  worktreeBranch?: string | null
  baseBranch?: string | null
  repoDir?: string | null
}): { text: string, sections: string[], tier: string, policyId: string } {
  const { skill, task, workDir, goalIntent, goalId, worktreeBranch, baseBranch, repoDir } = opts
  const db = getDb()
  const stmts = getStmts()
  const sections: PromptSection[] = []
  const projectName = (repoDir ?? workDir).split('/').pop() ?? 'project'
  const policy = getActivePromptPolicy()

  // Goal context
  if (goalIntent && goalIntent !== task) {
    appendSection(sections, { name: 'Goal', text: `## Goal\n${goalIntent}`, group: 'core' })
  }

  // Project understanding
  const readme = readProjectFile(workDir, 'README.md') ?? readProjectFile(workDir, 'readme.md')
  const claudeMd = readProjectFile(workDir, 'CLAUDE.md')
  const pkg = readProjectFile(workDir, 'package.json', 500)
  const cargo = readProjectFile(workDir, 'Cargo.toml', 500)
  const pyproject = readProjectFile(workDir, 'pyproject.toml', 500)

  if (claudeMd) appendSection(sections, { name: 'Project Instructions (CLAUDE.md)', text: `## Project Instructions (CLAUDE.md)\n${claudeMd}`, group: 'core' })
  if (readme) appendSection(sections, { name: 'What This Project Is', text: `## What This Project Is\n${readme.slice(0, 1200)}`, group: 'core' })
  const manifest = pkg ?? cargo ?? pyproject
  if (manifest) appendSection(sections, { name: 'Manifest', text: `## Manifest\n\`\`\`\n${manifest}\n\`\`\``, group: 'core' })

  // Git log
  try {
    const gitLog = execFileSync('git', ['log', '--oneline', '-8'], { cwd: workDir, encoding: 'utf8', timeout: 5_000 }).trim()
    if (gitLog) appendSection(sections, { name: 'Recent Git History', text: `## Recent Git History\n${gitLog}`, group: 'core' })
  } catch {}

  // Git status
  try {
    const status = execFileSync('git', ['status', '--short'], { cwd: workDir, encoding: 'utf8', timeout: 5_000 }).trim()
    if (status) appendSection(sections, { name: 'Uncommitted Changes', text: `## Uncommitted Changes\n${status}`, group: 'core' })
  } catch {}

  // Evolve state + experiment trajectory
  const evolveProgress = readProjectFile(workDir, '.evolve/progress.md', 1000)
    ?? readProjectFile(workDir, 'evolve-progress.md', 1000)
  const evolveCurrent = readProjectFile(workDir, '.evolve/current.json', 1000)
  const autoresearchMd = readProjectFile(workDir, 'autoresearch.md', 1000)
  if (evolveProgress) appendSection(sections, { name: 'Current Evolve State', text: `## Current Evolve State\n${evolveProgress}`, group: 'core' })
  if (evolveCurrent) appendSection(sections, { name: 'Evolve Pointer', text: `## Evolve Pointer\n${evolveCurrent}`, group: 'core' })
  if (autoresearchMd) appendSection(sections, { name: 'Autoresearch Config', text: `## Autoresearch Config\n${autoresearchMd}`, group: 'core' })

  // Experiment history
  const experimentsPath = join(workDir, '.evolve', 'experiments.jsonl')
  try {
    if (existsSync(experimentsPath)) {
      const expContent = readFileSync(experimentsPath, 'utf8')
      const expLines = expContent.trim().split('\n').filter(Boolean)
      const experiments: Array<{
        hypothesis?: string, category?: string, verdict?: string,
        delta?: number, baseline?: Record<string, number>, result?: Record<string, number>,
        learnings?: string[], round?: number
      }> = []
      for (const line of expLines) {
        try { experiments.push(JSON.parse(line)) } catch {}
      }
      if (experiments.length > 0) {
        const lines = ['## Experiment History (from .evolve/experiments.jsonl)']
        const trajectory = experiments
          .filter(e => e.result && e.round)
          .map(e => `Round ${e.round}: ${e.result ? Object.values(e.result)[0] : '?'}`)
        if (trajectory.length > 0) lines.push(`\nTrajectory: ${trajectory.join(' → ')}`)

        const kept = experiments.filter(e => e.verdict === 'KEEP')
        if (kept.length > 0) {
          lines.push('\nWhat worked:')
          for (const e of kept.slice(-5)) lines.push(`- ✓ ${e.hypothesis ?? '?'} (${e.category ?? '?'}, Δ${e.delta ?? '?'})`)
        }

        const failed = experiments.filter(e => e.verdict === 'ABANDON' || e.verdict === 'REGRESSION')
        if (failed.length > 0) {
          lines.push('\nWhat failed (DO NOT RETRY):')
          for (const f of failed.slice(-3)) {
            lines.push(`- ✗ ${f.hypothesis ?? '?'} (${f.category ?? '?'})`)
            if (f.learnings) for (const l of f.learnings.slice(0, 2)) lines.push(`    ${l.slice(0, 100)}`)
          }
        }

        const allLearnings = experiments.flatMap(e => e.learnings ?? [])
        if (allLearnings.length > 0) {
          const unique = [...new Set(allLearnings)].slice(-5)
          lines.push('\nAccumulated learnings:')
          for (const l of unique) lines.push(`- ${l.slice(0, 120)}`)
        }

        appendSection(sections, { name: 'Experiment History', text: lines.join('\n'), group: 'core' })
      }
    }
  } catch {}

  // Pursue docs
  try {
    const pursueEntries: Array<{ label: string, path: string }> = []
    const pursueDir = join(workDir, '.evolve', 'pursuits')
    if (existsSync(pursueDir)) {
      for (const f of readdirSync(pursueDir).filter(f => f.endsWith('.md')).sort()) {
        pursueEntries.push({ label: f, path: `.evolve/pursuits/${f}` })
      }
    }
    if (pursueEntries.length === 0) {
      for (const f of readdirSync(workDir).filter(f => f.startsWith('pursue-') && f.endsWith('.md')).sort()) {
        pursueEntries.push({ label: f, path: f })
      }
    }

    for (const entry of pursueEntries) {
      const content = readProjectFile(workDir, entry.path, 2000)
      if (!content) continue

      const lines = [`## ${entry.label}`]
      const statusMatch = content.match(/Status:\s*(.+)/i)
      const thesisMatch = content.match(/###?\s*Thesis\n+(.+)/i)
      if (statusMatch) lines.push(`Status: ${statusMatch[1]}`)
      if (thesisMatch) lines.push(`Thesis: ${thesisMatch[1].slice(0, 200)}`)

      const workedMatch = content.match(/###?\s*What Worked\n([\s\S]*?)(?=\n###?\s|\n---|\n$)/i)
      if (workedMatch) lines.push(`What worked: ${workedMatch[1].trim().slice(0, 300)}`)
      const failedMatch = content.match(/###?\s*What Didn't Work\n([\s\S]*?)(?=\n###?\s|\n---|\n$)/i)
      if (failedMatch) lines.push(`What didn't: ${failedMatch[1].trim().slice(0, 200)}`)
      const seedsMatch = content.match(/###?\s*Next Generation Seeds\n([\s\S]*?)(?=\n---|\n$)/i)
      if (seedsMatch) lines.push(`Next seeds: ${seedsMatch[1].trim().slice(0, 200)}`)

      appendSection(sections, { name: entry.label, text: lines.join('\n'), group: 'core' })
    }
  } catch {}

  // Scorecard snapshot
  const scorecardPath = join(workDir, '.evolve', 'scorecard.json')
  try {
    if (existsSync(scorecardPath)) {
      const scorecard = JSON.parse(readFileSync(scorecardPath, 'utf8'))
      if (scorecard.flows) {
        const lines = ['## Product Scorecard']
        for (const flow of scorecard.flows) {
          const icon = flow.status === 'pass' ? '✓' : flow.status === 'fail' ? '✗' : '○'
          lines.push(`${icon} ${flow.name}: ${flow.score ?? 'unmeasured'} (target: ${flow.target})`)
        }
        if (scorecard.aggregate) lines.push(`Aggregate: ${scorecard.aggregate}`)
        appendSection(sections, { name: 'Product Scorecard', text: lines.join('\n'), group: 'core' })
      }
    }
  } catch {}

  // Past decisions on this project
  const pastDecisions = db.prepare(
    `SELECT skill, task, status, outcome, learnings FROM decisions
     WHERE task LIKE ? OR task LIKE ?
     ORDER BY created_at DESC LIMIT 5`
  ).all(`%${projectName}%`, `%${workDir}%`) as Array<{
    skill: string, task: string, status: string, outcome: string | null, learnings: string | null
  }>

  if (pastDecisions.length > 0) {
    const lines = ['## What Foreman Has Tried Before']
    for (const d of pastDecisions) {
      const icon = d.status === 'success' ? '✓' : d.status === 'failure' ? '✗' : '○'
      lines.push(`${icon} [${d.status}] ${d.skill} — ${d.task.slice(0, 100)}`)
      if (d.outcome) lines.push(`  Result: ${d.outcome.slice(0, 120)}`)
      if (d.learnings) {
        try {
          for (const l of JSON.parse(d.learnings)) lines.push(`  Learning: ${String(l).slice(0, 100)}`)
        } catch {}
      }
    }
    appendSection(sections, { name: 'What Foreman Has Tried Before', text: lines.join('\n'), group: 'project_history' })
  }

  // Goal decisions
  if (goalId) {
    const goalDecisions = stmts.goalDecisions.all(goalId) as Array<{
      skill: string, task: string, status: string, outcome: string | null, learnings: string | null
    }>
    const relevant = goalDecisions.filter(d => !pastDecisions.some(pd => pd.task === d.task)).slice(0, 5)
    if (relevant.length > 0) {
      const lines = ['## Other Attempts on This Goal']
      for (const d of relevant) {
        const icon = d.status === 'success' ? '✓' : d.status === 'failure' ? '✗' : '○'
        lines.push(`${icon} [${d.status}] ${d.skill} — ${d.task.slice(0, 100)}`)
        if (d.outcome) lines.push(`  Result: ${d.outcome.slice(0, 120)}`)
      }
      appendSection(sections, { name: 'Other Attempts on This Goal', text: lines.join('\n'), group: 'goal_history' })
    }
  }

  // Taste model
  const tasteSignals = stmts.listTaste.all(10) as Array<{ pattern: string, weight: number }>
  if (tasteSignals.length > 0) {
    const lines = ['## Operator Preferences (learned from feedback)']
    for (const t of tasteSignals) lines.push(`- ${t.pattern}`)
    appendSection(sections, { name: 'Operator Preferences (learned from feedback)', text: lines.join('\n'), group: 'operator' })
  }

  // Dead ends
  const failures = db.prepare(
    `SELECT skill, task, outcome, learnings FROM decisions
     WHERE status = 'failure' AND (task LIKE ? OR task LIKE ?)
     ORDER BY created_at DESC LIMIT 3`
  ).all(`%${projectName}%`, `%${workDir}%`) as Array<{
    skill: string, task: string, outcome: string | null, learnings: string | null
  }>
  if (failures.length > 0) {
    const lines = ['## Dead Ends (DO NOT REPEAT)']
    for (const f of failures) lines.push(`- ${f.skill} "${f.task.slice(0, 80)}" → FAILED: ${(f.outcome ?? 'unknown').slice(0, 100)}`)
    appendSection(sections, { name: 'Dead Ends (DO NOT REPEAT)', text: lines.join('\n'), group: 'risk' })
  }

  // Learned exemplars
  const exemplars = stmts.learningsByProject.all(projectName, 5) as Array<{ content: string, type: string }>
  const promptExemplars = exemplars.filter(e => e.type === 'exemplar')
  if (promptExemplars.length > 0) {
    const lines = ['## How the Operator Writes Tasks (learn from these)']
    for (const e of promptExemplars.slice(0, 3)) lines.push(`> ${e.content.slice(0, 200)}`)
    appendSection(sections, { name: 'How the Operator Writes Tasks (learn from these)', text: lines.join('\n'), group: 'operator_exemplar' })
  }

  // Dispatch success patterns
  const successLearnings = stmts.learningsByType.all('dispatch_success', 5) as Array<{ content: string }>
  if (successLearnings.length > 0) {
    const lines = ['## What Works (from past dispatches)']
    for (const l of successLearnings) lines.push(`- ${l.content.slice(0, 150)}`)
    appendSection(sections, { name: 'What Works (from past dispatches)', text: lines.join('\n'), group: 'operator' })
  }

  // Learned flows
  const flows = stmts.learningsByType.all('flow', 5) as Array<{ content: string }>
  if (flows.length > 0) {
    const lines = ['## Operator Workflows (learned from session analysis)']
    for (const f of flows) lines.push(`- ${f.content.slice(0, 200)}`)
    appendSection(sections, { name: 'Operator Workflows (learned from session analysis)', text: lines.join('\n'), group: 'operator' })
  }

  // Anti-patterns
  const antiPatterns = stmts.learningsByType.all('anti_pattern', 3) as Array<{ content: string }>
  if (antiPatterns.length > 0) {
    const lines = ['## Avoid (learned from operator patterns)']
    for (const ap of antiPatterns) lines.push(`- ${ap.content.slice(0, 150)}`)
    appendSection(sections, { name: 'Avoid (learned from operator patterns)', text: lines.join('\n'), group: 'operator' })
  }

  // Skill preferences
  const skillPrefs = stmts.learningsByType.all('skill_preference', 5) as Array<{ content: string }>
  if (skillPrefs.length > 0) {
    const lines = ['## Skill Selection Guide (learned from operator)']
    for (const sp of skillPrefs) lines.push(`- ${sp.content.slice(0, 150)}`)
    appendSection(sections, { name: 'Skill Selection Guide (learned from operator)', text: lines.join('\n'), group: 'operator' })
  }

  // Project relationships
  const relationships = stmts.learningsByType.all('project_relationship', 3) as Array<{ content: string }>
  if (relationships.length > 0) {
    const lines = ['## Related Projects']
    for (const r of relationships) lines.push(`- ${r.content.slice(0, 150)}`)
    appendSection(sections, { name: 'Related Projects', text: lines.join('\n'), group: 'operator' })
  }

  // Compose final prompt
  let prompt = ''
  prompt += `## Your Task\n${task}\n\n`

  // Standards — data shows: constraints HURT (32% with "ONLY" vs 71% without).
  // Rich context + freedom + post-hoc review beats upfront restriction.
  const standardsInstruction = getStandardsInstruction(policy)
  prompt += `## Standards\n- ${standardsInstruction}\n`

  // Skill chaining: tell the session what skills are available and how to recommend next work
  if (shouldIncludeSkillGuide(skill, policy)) {
    prompt += `\n## Available Skills\n`
    prompt += `You have access to these skills via slash commands:\n`
    prompt += `- /evolve — iterative improvement toward a measurable target\n`
    prompt += `- /pursue — architectural redesign, generational leaps\n`
    prompt += `- /verify — check correctness, run tests, confirm completion\n`
    prompt += `- /polish — relentless quality loop\n`
    prompt += `- /converge — drive CI to green\n`
    prompt += `- /critical-audit — parallel security/quality audit\n`
    prompt += `- /diagnose — analyze failures, triage results\n`
    prompt += `- /research — hypothesis-driven experimentation\n`
    prompt += `- /reflect — meta-analyze sessions and extract patterns\n`
    prompt += `Use them when appropriate during your work.\n`
  }

  // No closing protocol — Foreman reviews the session transcript independently.
  // The agent just does its job. Foreman's reviewer reads the JSONL after.

  if (policy.includeGitWorkflow && worktreeBranch && baseBranch) {
    prompt += `\n## Git Workflow — CRITICAL\n`
    prompt += `You are working in an isolated worktree on branch \`${worktreeBranch}\`.\n`
    prompt += `The operator is working on branch \`${baseBranch}\` — your work must not interfere with theirs.\n\n`
    if (policy.gitWorkflowDetail === 'brief') {
      prompt += `Commit meaningful progress, push \`${worktreeBranch}\`, and open a PR against \`${baseBranch}\` before finishing.\n`
    } else {
      prompt += `**You MUST commit and push before finishing.** Uncommitted work is lost work.\n\n`
      prompt += `During work: commit after each logical change.\n`
      prompt += `When complete:\n`
      prompt += `1. \`git add -A && git status\` — verify all changes are staged\n`
      prompt += `2. \`git commit -m "feat: <what you did>"\` — if anything is uncommitted\n`
      prompt += `3. \`git push -u origin ${worktreeBranch}\`\n`
      prompt += `4. \`gh pr create --base ${baseBranch} --title "foreman: <summary>" --body "<what you did and why>"\`\n\n`
      prompt += `If you skip the commit/push, your work will be lost. The operator reviews PRs, not worktree diffs.\n`
    }
  }
  prompt += '\n'

  const contextBudget = getContextBudgetForSkill(skill, policy)
  const promptTier = contextBudget >= policy.reasoningContextBudget ? 'rich' : 'standard'

  const includedSections: string[] = []
  let remainingBudget = contextBudget
  for (const section of sections) {
    if (!shouldIncludeSection(section.group, policy)) continue
    if (remainingBudget <= 0) break
    const sectionName = section.name
    if (section.text.length <= remainingBudget) {
      prompt += section.text + '\n\n'
      remainingBudget -= section.text.length
      includedSections.push(sectionName)
    } else {
      prompt += section.text.slice(0, remainingBudget) + '\n...(truncated)\n\n'
      remainingBudget = 0
      includedSections.push(sectionName + ' (truncated)')
    }
  }

  const text = skill?.startsWith('/')
    ? `${skill} ${prompt.trim()}`
    : prompt.trim()

  return { text, sections: includedSections, tier: promptTier, policyId: policy.id }
}
