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

const execFileAsync = promisify(execFile)

// ─── Git worktree ────────────────────────────────────────────────────

export async function createWorktree(repoPath: string, label: string): Promise<{
  path: string, branch: string, baseBranch: string
} | null> {
  const projectName = repoPath.split('/').pop() ?? 'project'
  const branch = `foreman/${label}`
  const wtPath = join(FOREMAN_HOME, 'worktrees', `${projectName}-${label}`)

  let baseBranch = 'main'
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoPath, timeout: 5_000 })
    if (stdout.trim()) baseBranch = stdout.trim()
  } catch {}

  if (existsSync(wtPath)) {
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoPath, timeout: 10_000 })
    } catch {}
  }

  try {
    await execFileAsync('git', ['branch', '-D', branch], { cwd: repoPath, timeout: 5_000 })
  } catch {}

  try {
    await execFileAsync('git', ['worktree', 'add', '-b', branch, wtPath, baseBranch], { cwd: repoPath, timeout: 15_000 })
    return { path: wtPath, branch, baseBranch }
  } catch (e) {
    try {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, wtPath], { cwd: repoPath, timeout: 15_000 })
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
}): { text: string, sections: string[], tier: string } {
  const { skill, task, workDir, goalIntent, goalId, worktreeBranch, baseBranch, repoDir } = opts
  const db = getDb()
  const stmts = getStmts()
  const sections: string[] = []
  const projectName = (repoDir ?? workDir).split('/').pop() ?? 'project'

  // Goal context
  if (goalIntent && goalIntent !== task) {
    sections.push(`## Goal\n${goalIntent}`)
  }

  // Project understanding
  const readme = readProjectFile(workDir, 'README.md') ?? readProjectFile(workDir, 'readme.md')
  const claudeMd = readProjectFile(workDir, 'CLAUDE.md')
  const pkg = readProjectFile(workDir, 'package.json', 500)
  const cargo = readProjectFile(workDir, 'Cargo.toml', 500)
  const pyproject = readProjectFile(workDir, 'pyproject.toml', 500)

  if (claudeMd) sections.push(`## Project Instructions (CLAUDE.md)\n${claudeMd}`)
  if (readme) sections.push(`## What This Project Is\n${readme.slice(0, 1200)}`)
  const manifest = pkg ?? cargo ?? pyproject
  if (manifest) sections.push(`## Manifest\n\`\`\`\n${manifest}\n\`\`\``)

  // Git log
  try {
    const gitLog = execFileSync('git', ['log', '--oneline', '-8'], { cwd: workDir, encoding: 'utf8', timeout: 5_000 }).trim()
    if (gitLog) sections.push(`## Recent Git History\n${gitLog}`)
  } catch {}

  // Git status
  try {
    const status = execFileSync('git', ['status', '--short'], { cwd: workDir, encoding: 'utf8', timeout: 5_000 }).trim()
    if (status) sections.push(`## Uncommitted Changes\n${status}`)
  } catch {}

  // Evolve state + experiment trajectory
  const evolveProgress = readProjectFile(workDir, 'evolve-progress.md', 1000)
  const autoresearchMd = readProjectFile(workDir, 'autoresearch.md', 1000)
  if (evolveProgress) sections.push(`## Current Evolve State\n${evolveProgress}`)
  if (autoresearchMd) sections.push(`## Autoresearch Config\n${autoresearchMd}`)

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

        sections.push(lines.join('\n'))
      }
    }
  } catch {}

  // Pursue docs
  try {
    const pursueFiles = readdirSync(workDir).filter(f => f.startsWith('pursue-') && f.endsWith('.md'))
    for (const f of pursueFiles) {
      const content = readProjectFile(workDir, f, 2000)
      if (!content) continue

      const lines = [`## ${f}`]
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

      sections.push(lines.join('\n'))
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
        sections.push(lines.join('\n'))
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
    sections.push(lines.join('\n'))
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
      sections.push(lines.join('\n'))
    }
  }

  // Taste model
  const tasteSignals = stmts.listTaste.all(10) as Array<{ pattern: string, weight: number }>
  if (tasteSignals.length > 0) {
    const lines = ['## Operator Preferences (learned from feedback)']
    for (const t of tasteSignals) lines.push(`- ${t.pattern}`)
    sections.push(lines.join('\n'))
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
    sections.push(lines.join('\n'))
  }

  // Learned exemplars
  const exemplars = stmts.learningsByProject.all(projectName, 5) as Array<{ content: string, type: string }>
  const promptExemplars = exemplars.filter(e => e.type === 'exemplar')
  if (promptExemplars.length > 0) {
    const lines = ['## How the Operator Writes Tasks (learn from these)']
    for (const e of promptExemplars.slice(0, 3)) lines.push(`> ${e.content.slice(0, 200)}`)
    sections.push(lines.join('\n'))
  }

  // Dispatch success patterns
  const successLearnings = stmts.learningsByType.all('dispatch_success', 5) as Array<{ content: string }>
  if (successLearnings.length > 0) {
    const lines = ['## What Works (from past dispatches)']
    for (const l of successLearnings) lines.push(`- ${l.content.slice(0, 150)}`)
    sections.push(lines.join('\n'))
  }

  // Learned flows
  const flows = stmts.learningsByType.all('flow', 5) as Array<{ content: string }>
  if (flows.length > 0) {
    const lines = ['## Operator Workflows (learned from session analysis)']
    for (const f of flows) lines.push(`- ${f.content.slice(0, 200)}`)
    sections.push(lines.join('\n'))
  }

  // Anti-patterns
  const antiPatterns = stmts.learningsByType.all('anti_pattern', 3) as Array<{ content: string }>
  if (antiPatterns.length > 0) {
    const lines = ['## Avoid (learned from operator patterns)']
    for (const ap of antiPatterns) lines.push(`- ${ap.content.slice(0, 150)}`)
    sections.push(lines.join('\n'))
  }

  // Skill preferences
  const skillPrefs = stmts.learningsByType.all('skill_preference', 5) as Array<{ content: string }>
  if (skillPrefs.length > 0) {
    const lines = ['## Skill Selection Guide (learned from operator)']
    for (const sp of skillPrefs) lines.push(`- ${sp.content.slice(0, 150)}`)
    sections.push(lines.join('\n'))
  }

  // Project relationships
  const relationships = stmts.learningsByType.all('project_relationship', 3) as Array<{ content: string }>
  if (relationships.length > 0) {
    const lines = ['## Related Projects']
    for (const r of relationships) lines.push(`- ${r.content.slice(0, 150)}`)
    sections.push(lines.join('\n'))
  }

  // Compose final prompt
  let prompt = ''
  prompt += `## Your Task\n${task}\n\n`
  prompt += `## Standards\n`
  prompt += `- L7/L8 staff engineer quality. Zero tolerance for slop.\n`
  prompt += `- Complete everything fully. No TODOs, no stubs.\n`
  prompt += `- ONLY create or modify the files specified in your task. Do NOT create dashboards, CLIs, hooks, or other files unless your task explicitly asks for them.\n`
  prompt += `- ALWAYS commit your work. After every meaningful change: git add <specific-file> && git commit -m "feat/fix: description".\n`
  prompt += `- Do NOT use "git add -A" or "git add .". Add files by name.\n`
  prompt += `- If your commit is rejected by a scope hook, run: git reset HEAD . && git add <your-allowed-file> && git commit. Do NOT create files outside your allowed scope.\n`
  prompt += `- If tests exist, run them. Fix failures before moving on.\n`
  prompt += `- Never ask for permission. Act.\n`

  // Skill chaining: tell the session what skills are available and how to recommend next work
  const reasoningSkillsSet = new Set(['/pursue', '/plan', '/research', '/reflect'])
  if (reasoningSkillsSet.has(skill) || !skill) {
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

  if (worktreeBranch && baseBranch) {
    prompt += `\n## Git Workflow — CRITICAL\n`
    prompt += `You are working in an isolated worktree on branch \`${worktreeBranch}\`.\n`
    prompt += `The operator is working on branch \`${baseBranch}\` — your work must not interfere with theirs.\n\n`
    prompt += `**You MUST commit and push before finishing.** Uncommitted work is lost work.\n\n`
    prompt += `During work: commit after each logical change.\n`
    prompt += `When complete:\n`
    prompt += `1. \`git add -A && git status\` — verify all changes are staged\n`
    prompt += `2. \`git commit -m "feat: <what you did>"\` — if anything is uncommitted\n`
    prompt += `3. \`git push -u origin ${worktreeBranch}\`\n`
    prompt += `4. \`gh pr create --base ${baseBranch} --title "foreman: <summary>" --body "<what you did and why>"\`\n\n`
    prompt += `If you skip the commit/push, your work will be lost. The operator reviews PRs, not worktree diffs.\n`
  }
  prompt += '\n'

  // Context budget by task type
  const executionSkills = new Set(['/verify', '/converge', '/polish'])
  const reasoningSkills = new Set(['/pursue', '/plan', '/research', '/reflect'])
  const isExecution = executionSkills.has(skill) || (!skill && task.split(/\s+/).length < 15)
  const isReasoning = reasoningSkills.has(skill)

  let contextBudget: number
  let promptTier: string
  if (isExecution) {
    contextBudget = 1500
    promptTier = 'slim'
  } else if (isReasoning) {
    contextBudget = 6000
    promptTier = 'rich'
  } else {
    contextBudget = 3000
    promptTier = 'medium'
  }

  const includedSections: string[] = []
  for (const section of sections) {
    if (contextBudget <= 0) break
    const sectionName = section.match(/^## (.+)/m)?.[1] ?? section.slice(0, 30)
    if (section.length <= contextBudget) {
      prompt += section + '\n\n'
      contextBudget -= section.length
      includedSections.push(sectionName)
    } else {
      prompt += section.slice(0, contextBudget) + '\n...(truncated)\n\n'
      contextBudget = 0
      includedSections.push(sectionName + ' (truncated)')
    }
  }

  const text = skill?.startsWith('/')
    ? `${skill} ${prompt.trim()}`
    : prompt.trim()

  return { text, sections: includedSections, tier: promptTier }
}
