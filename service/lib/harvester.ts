/**
 * Auto-outcome harvester — reads what happened when a session finishes
 * and creates outcome records. Critical link that closes the learning loop.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import {
  type ExecutionBackend,
  FOREMAN_HOME, AUTO_MERGE,
  getDb, getStmts, getConfidence,
  log, emitEvent, sendNotification,
} from './state.js'
import { verifyDeliverable, runTestGate, type DeliverableSpec, type ScopeSpec } from './verify-deliverable.js'
import { removeScopeHook } from './scope-enforcer.js'
import { parseIdeationOutput } from './plan-generator.js'
import { runPostCompletionPipeline } from './post-completion.js'
import { updateLearningsFromOutcome } from './prompt-optimizer.js'
import { maybeAutoDispatch } from './auto-dispatch.js'

const execFileAsync = promisify(execFile)

export async function harvestOutcome(sessionName: string, goalId: number, backend: ExecutionBackend): Promise<void> {
  const db = getDb()
  const stmts = getStmts()
  const confidence = getConfidence()

  const decision = db.prepare(`SELECT * FROM decisions WHERE session_name = ? AND status = 'dispatched' ORDER BY created_at DESC LIMIT 1`)
    .get(sessionName) as { id: number, skill: string, task: string, worktree_branch: string | null, base_branch: string | null } | undefined
  if (!decision) return

  const session = stmts.getSession.get(sessionName) as { work_dir: string, status: string } | undefined
  if (!session) return

  const workDir = session.work_dir

  // Read session output from log file
  const logFile = join(FOREMAN_HOME, 'logs', `session-${sessionName}.log`)
  let output = ''
  try {
    if (existsSync(logFile)) {
      const full = readFileSync(logFile, 'utf8')
      output = full.slice(-5000)
    }
  } catch {}
  if (!output && backend.isAlive(sessionName)) {
    output = backend.capture(sessionName, 80)
  }

  // Count session's commits
  let commits = 0
  let gitLog = ''
  let hasPR = false
  let testsPassed: boolean | null = null

  const baseBranch = decision.base_branch
  const worktreeBranch = decision.worktree_branch

  try {
    if (baseBranch) {
      const { stdout: mergeBase } = await execFileAsync('git', ['merge-base', baseBranch, 'HEAD'], { cwd: workDir, timeout: 5_000 })
      const { stdout } = await execFileAsync('git', ['log', '--oneline', `${mergeBase.trim()}..HEAD`], { cwd: workDir, timeout: 5_000 })
      const lines = stdout.trim().split('\n').filter(Boolean)
      commits = lines.length
      gitLog = lines.slice(0, 5).join('\n')
    } else {
      const { stdout } = await execFileAsync('git', ['log', '--oneline', '-10'], { cwd: workDir, timeout: 5_000 })
      const lines = stdout.trim().split('\n').filter(Boolean)
      commits = lines.length
      gitLog = lines.slice(0, 5).join('\n')
    }
  } catch {}

  if (worktreeBranch) {
    try {
      const { stdout } = await execFileAsync('gh', ['pr', 'list', '--head', worktreeBranch, '--json', 'title,url', '--limit', '1'], { cwd: workDir, timeout: 10_000 })
      const prs = JSON.parse(stdout)
      if (prs.length > 0) hasPR = true
    } catch {}
  }

  if (output.includes('tests pass') || output.includes('✅') || output.includes('All tests passed') || output.includes('✓ pass')) {
    testsPassed = true
  } else if (output.includes('FAIL') || output.includes('❌') || output.includes('tests fail') || output.includes('✗ fail')) {
    testsPassed = false
  }

  // Parse cost
  let costUsd: number | null = null
  const costPatterns = [
    /Total cost:\s*\$(\d+\.?\d*)/i,
    /Cost:\s*\$(\d+\.?\d*)/i,
    /\$(\d+\.\d{2,})\s*total/i,
    /(\d+\.\d{2,})\s*USD/i,
    /(?:cost|spent|billed)[:\s]*\$?(\d+\.?\d*)/i,
  ]
  for (const pattern of costPatterns) {
    const match = output.match(pattern)
    if (match) { costUsd = parseFloat(match[1]); break }
  }

  // Deliverable verification
  let deliverableStatus: 'pass' | 'fail' | 'unchecked' = 'unchecked'
  let scopeStatus: 'clean' | 'violation' | 'unchecked' = 'unchecked'
  let verificationDetails: string[] = []

  const deliverableSpecRaw = (decision as any).deliverable_spec
  const scopeSpecRaw = (decision as any).scope_spec
  if (deliverableSpecRaw || scopeSpecRaw) {
    try {
      const dSpec: DeliverableSpec | null = deliverableSpecRaw ? JSON.parse(deliverableSpecRaw) : null
      const sSpec: ScopeSpec | null = scopeSpecRaw ? JSON.parse(scopeSpecRaw) : null
      const verification = verifyDeliverable(workDir, dSpec, sSpec)
      deliverableStatus = verification.deliverableStatus
      scopeStatus = verification.scopeStatus
      verificationDetails = verification.details
      log(`Verification for ${sessionName}: deliverable=${deliverableStatus} scope=${scopeStatus} ${verificationDetails.join('; ')}`)
    } catch (e) { log(`Verification failed for ${sessionName}: ${e}`) }
  }

  // Test gate for self-improvement
  const isSelfImprovement = workDir.includes('foreman') && (decision.skill === '/pursue' || decision.skill === '/evolve')
  let modifiedTsFiles = false
  try {
    const diff = await execFileAsync('git', ['diff', '--name-only', 'HEAD~1..HEAD'], { cwd: workDir, timeout: 5_000 })
    modifiedTsFiles = diff.stdout.split('\n').some(f => f.endsWith('.ts'))
  } catch {}
  if (isSelfImprovement && commits > 0 && modifiedTsFiles) {
    const gate = runTestGate(workDir)
    if (!gate.passed) {
      deliverableStatus = 'fail'
      verificationDetails.push(`test gate failed: ${gate.output.slice(0, 100)}`)
      log(`Test gate FAILED for self-improvement session ${sessionName}`)
    }
  }

  // Determine success
  const hasErrors = output.includes('Error:') || output.includes('FAIL') || output.includes('fatal:')
  let status: string
  if (deliverableStatus === 'fail') {
    status = 'failure'
  } else if (deliverableStatus === 'pass') {
    status = 'success'
  } else {
    status = commits > 0 && !hasErrors ? 'success'
      : hasErrors ? 'failure'
      : 'success'
  }

  // Generate outcome text
  const outcomeParts: string[] = []
  if (deliverableStatus !== 'unchecked') outcomeParts.push(`deliverable: ${deliverableStatus}`)
  if (scopeStatus === 'violation') outcomeParts.push(`SCOPE VIOLATION`)
  if (commits > 0) outcomeParts.push(`${commits} commits`)
  if (hasPR) outcomeParts.push('PR created')
  if (testsPassed === true) outcomeParts.push('tests passing')
  if (testsPassed === false) outcomeParts.push('tests failing')
  if (hasErrors) outcomeParts.push('errors detected')
  if (costUsd) outcomeParts.push(`$${costUsd.toFixed(2)}`)
  const outcomeText = outcomeParts.length > 0 ? outcomeParts.join(', ') : 'session completed'

  // Extract learnings
  const learnings: string[] = []
  const outputLines = output.split('\n').slice(-40)
  for (const line of outputLines) {
    const clean = line.replace(/[\x00-\x1f\x7f]/g, '').trim()
    if (clean.length < 15 || clean.length > 200) continue
    if (clean.match(/^(feat|fix|chore|refactor|test|docs)(\(.*?\))?:/) ||
        clean.includes('✅') || clean.includes('improved') || clean.includes('fixed')) {
      learnings.push(clean)
    }
  }

  // Snapshot evolve state
  try {
    const evolveFile = join(workDir, 'evolve-progress.md')
    if (existsSync(evolveFile)) {
      const evolveContent = readFileSync(evolveFile, 'utf8')
      const scoreMatch = evolveContent.match(/Score:\s*([\d.]+)\s*→\s*target\s*([\d.]+)/i)
      if (scoreMatch) learnings.push(`evolve-snapshot: score ${scoreMatch[1]} (target ${scoreMatch[2]})`)
      const roundMatch = evolveContent.match(/Round\s*(\d+)/i)
      if (roundMatch) learnings.push(`evolve-snapshot: round ${roundMatch[1]}`)
    }

    const expFile = join(workDir, '.evolve', 'experiments.jsonl')
    if (existsSync(expFile)) {
      const expLines = readFileSync(expFile, 'utf8').trim().split('\n').filter(Boolean)
      for (const line of expLines.slice(-3)) {
        try {
          const exp = JSON.parse(line)
          if (exp.learnings) {
            for (const l of exp.learnings.slice(0, 2)) {
              const key = `exp-learning: ${String(l).slice(0, 150)}`
              if (!learnings.includes(key)) learnings.push(key)
            }
          }
          if (exp.verdict && exp.hypothesis) {
            learnings.push(`exp-result: ${exp.verdict} — ${exp.hypothesis.slice(0, 100)}`)
          }
        } catch {}
      }
    }
  } catch {}

  if (verificationDetails.length > 0) {
    learnings.push(...verificationDetails.map(d => `verify: ${d}`))
  }

  // Store outcome
  stmts.updateDecision.run(
    status, outcomeText,
    learnings.length > 0 ? JSON.stringify(learnings) : null,
    JSON.stringify({ commits, hasPR, testsPassed, gitLog, deliverableStatus, scopeStatus }),
    null, costUsd, decision.id,
  )

  if (deliverableStatus !== 'unchecked') {
    db.prepare(`UPDATE decisions SET deliverable_status = ? WHERE id = ?`).run(deliverableStatus, decision.id)
  }

  log(`Auto-harvested outcome for ${sessionName}: ${outcomeText}`)
  emitEvent('outcome_harvested', sessionName, goalId, { decisionId: decision.id, status, commits, deliverableStatus })

  // Parse plan ideation output
  if (sessionName.includes('plan-ideate')) {
    try {
      const planFiles = readdirSync(join(FOREMAN_HOME, 'plans'), { recursive: true })
        .filter((f: any) => String(f).endsWith('.json') && !String(f).includes('plan.json'))
      for (const f of planFiles) {
        const fullPath = join(FOREMAN_HOME, 'plans', String(f))
        const plans = parseIdeationOutput(fullPath)
        if (plans.length > 0) log(`Parsed ${plans.length} plans from ideation output: ${f}`)
      }
    } catch (e) { log(`Plan ideation parse failed: ${e}`) }
  }

  removeScopeHook(workDir)

  // Ensure push + PR
  if (commits > 0 && worktreeBranch && baseBranch) {
    const prUrl = await ensurePushAndPR(workDir, worktreeBranch, baseBranch, decision.skill, decision.task)
    if (prUrl) log(`PR created/found: ${prUrl}`)
  }

  // Post-completion pipeline
  const digest = await runPostCompletionPipeline(decision.id, sessionName, decision.skill, decision.task, workDir, output, status, outcomeText)

  if (digest.summary) {
    db.prepare(`UPDATE decisions SET outcome = ?, learnings = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(digest.summary.slice(0, 2000), digest.learnings ? JSON.stringify(digest.learnings) : null, decision.id)
  }

  const notifyText = digest.summary ?? outcomeText
  sendNotification(`Foreman: ${sessionName}`, `${decision.skill} → ${notifyText.slice(0, 200)}`)

  // Update confidence
  let projectName = workDir.split('/').pop() ?? workDir
  if (goalId) {
    const goal = stmts.getGoal.get(goalId) as { workspace_path?: string } | undefined
    if (goal?.workspace_path) projectName = goal.workspace_path.split('/').pop() ?? projectName
  }
  const confSignal = (digest.qualityScore ?? 0) >= 7 ? 'success' as const
    : status === 'success' ? 'success' as const : 'failure' as const
  confidence.update(decision.skill || 'direct', projectName, confSignal)
  const newLevel = confidence.getLevel(decision.skill || 'direct', projectName)
  log(`Confidence: ${decision.skill || 'direct'}@${projectName} → ${newLevel} (${confSignal})`)

  // Trigger learning
  const enrichedLearnings = digest.learnings ?? learnings
  updateLearningsFromOutcome(decision.id, decision.skill, decision.task, status, digest.summary ?? outcomeText, enrichedLearnings)

  // Auto-dispatch next
  if (digest.nextAction) {
    log(`Pipeline recommends: ${digest.nextAction.skill} — ${digest.nextAction.task.slice(0, 80)}`)
  }
  maybeAutoDispatch(decision.skill, projectName, goalId).catch(e => log(`Auto-dispatch failed: ${e}`))
}

// ─── Ensure push + PR ────────────────────────────────────────────────

async function ensurePushAndPR(workDir: string, branch: string, baseBranch: string, skill: string, task: string): Promise<string | null> {
  const confidence = getConfidence()

  try {
    await execFileAsync('git', ['push', '-u', 'origin', branch], { cwd: workDir, timeout: 30_000 })
  } catch (e) {
    log(`Push failed for ${branch}: ${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'list', '--head', branch, '--json', 'url', '--limit', '1'], { cwd: workDir, timeout: 10_000 })
    const prs = JSON.parse(stdout)
    if (prs.length > 0) return prs[0].url
  } catch {}

  try {
    const title = `foreman: ${skill || 'work'} — ${task.slice(0, 60)}`
    const body = `Automated Foreman dispatch.\n\nSkill: ${skill || 'direct'}\nTask: ${task.slice(0, 200)}\n\n---\n*This PR was created by Foreman. Review the changes before merging.*`

    const { stdout } = await execFileAsync('gh', [
      'pr', 'create', '--base', baseBranch, '--head', branch,
      '--title', title.slice(0, 100), '--body', body,
    ], { cwd: workDir, timeout: 15_000 })

    const url = stdout.trim()
    log(`Created PR: ${url}`)

    if (AUTO_MERGE) {
      const projectName = workDir.split('/').pop() ?? ''
      const confLevel = confidence.getLevel(skill || 'direct', projectName)
      if (confLevel === 'autonomous') {
        try {
          await execFileAsync('gh', ['pr', 'merge', url, '--squash', '--auto'], { cwd: workDir, timeout: 15_000 })
          log(`Auto-merged PR: ${url} (confidence: autonomous)`)
        } catch (e) {
          log(`Auto-merge failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      } else {
        log(`Auto-merge skipped: confidence is ${confLevel}, need autonomous (0.8+)`)
      }
    }

    return url
  } catch (e) {
    log(`PR creation failed for ${branch}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
