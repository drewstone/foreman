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
import { findSessionTranscript, readSessionTranscript, type SessionSummary } from './session-reader.js'
import { removeScopeHook } from './scope-enforcer.js'
import { parseIdeationOutput } from './plan-generator.js'
import { runPostCompletionPipeline } from './post-completion.js'
import { reviewSession } from './session-reviewer.js'
import { updateLearningsFromOutcome } from './prompt-optimizer.js'
import { maybeAutoDispatch } from './auto-dispatch.js'
import telemetry from './telemetry.js'

const { recordTelemetryRun } = telemetry

const execFileAsync = promisify(execFile)

export async function harvestOutcome(sessionName: string, goalId: number, backend: ExecutionBackend): Promise<void> {
  const db = getDb()
  const stmts = getStmts()
  const confidence = getConfidence()

  const decision = db.prepare(`SELECT * FROM decisions WHERE session_name = ? AND status = 'dispatched' ORDER BY created_at DESC LIMIT 1`)
    .get(sessionName) as { id: number, skill: string, task: string, worktree_branch: string | null, base_branch: string | null } | undefined
  if (!decision) return

  const session = stmts.getSession.get(sessionName) as {
    work_dir: string
    status: string
    transcript_path?: string
    backend?: string | null
    model?: string | null
    started_at?: string
  } | undefined
  if (!session) return

  const workDir = session.work_dir
  const repoName = workDir.split('/').pop() ?? ''

  // ── PRIMARY: Read structured data from CC session JSONL ────────────
  // Priority: 1) transcript_path stored by Stop hook (exact, no scanning)
  //           2) findSessionTranscript (filesystem scan, fallback)
  let transcript: SessionSummary | null = null
  let output = ''

  const transcriptPath = session.transcript_path ?? findSessionTranscript(workDir)
  if (transcriptPath) {
    transcript = readSessionTranscript(transcriptPath)
    if (transcript) {
      output = transcript.lastAssistantText
      log(`Harvest: found CC transcript for ${sessionName} (${transcript.turnCount} turns, ${transcript.toolCalls.length} tool calls)`)
    }
  }

  // Fallback: pipe-pane log (unreliable but better than nothing)
  if (!output) {
    const logFile = join(FOREMAN_HOME, 'logs', `session-${sessionName}.log`)
    try {
      if (existsSync(logFile)) {
        const full = readFileSync(logFile, 'utf8')
        output = full.slice(-5000)
      }
    } catch {}
    if (!output && backend.isAlive(sessionName)) {
      output = backend.capture(sessionName, 80)
    }
  }

  // ── Git data (always reliable — reads the actual repo) ─────────────
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

  // ── Test detection from transcript tool calls (structured) or output (fallback) ──
  if (transcript) {
    // Check tool call outputs for test results
    const bashCalls = transcript.toolCalls.filter(t => t.name === 'Bash')
    const testCommands = bashCalls.filter(t => {
      const cmd = JSON.stringify(t.input).toLowerCase()
      return cmd.includes('test') || cmd.includes('pytest') || cmd.includes('vitest') || cmd.includes('jest')
    })
    if (testCommands.length > 0) {
      // If agent ran tests AND committed, tests likely passed
      testsPassed = commits > 0 ? true : null
    }
  }
  // Fallback: regex on output text
  if (testsPassed === null && output) {
    if (output.includes('tests pass') || output.includes('All tests passed') || output.includes('✓ pass')) {
      testsPassed = true
    } else if (output.includes('FAIL') || output.includes('tests fail') || output.includes('✗ fail')) {
      testsPassed = false
    }
  }

  // ── Cost from transcript (structured) or regex (fallback) ──────────
  let costUsd: number | null = null
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let effectiveModel = session.model ?? null
  let provider = 'unknown'
  let harness = session.backend ?? 'tmux'
  if (transcript) {
    // Estimate from token counts + model
    const model = transcript.model?.toLowerCase() ?? ''
    const inTokens = transcript.totalInputTokens
    const outTokens = transcript.totalOutputTokens
    inputTokens = inTokens
    outputTokens = outTokens
    cacheReadTokens = transcript.totalCacheReadTokens
    effectiveModel = transcript.model || effectiveModel
    if (harness === 'tmux') harness = 'claude'
    provider = model.includes('gpt') || model.includes('o1') || model.includes('o3') ? 'openai' : 'anthropic'
    if (model.includes('opus')) {
      costUsd = (inTokens * 15 + outTokens * 75) / 1_000_000
    } else if (model.includes('haiku')) {
      costUsd = (inTokens * 0.25 + outTokens * 1.25) / 1_000_000
    } else {
      // Default to sonnet pricing
      costUsd = (inTokens * 3 + outTokens * 15) / 1_000_000
    }
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

  // Determine success — use structured data when available
  let status: string
  if (deliverableStatus === 'fail') {
    status = 'failure'
  } else if (deliverableStatus === 'pass') {
    status = 'success'
  } else if (transcript) {
    // Structured: did the agent actually DO anything?
    const didWork = transcript.toolCalls.length > 0
    const madeCommits = commits > 0
    status = madeCommits ? 'success' : didWork ? 'success' : 'failure'
  } else {
    // Fallback: old heuristics on pipe-pane output
    const hasErrors = output.includes('Error:') || output.includes('FAIL') || output.includes('fatal:')
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
  if (transcript) outcomeParts.push(`${transcript.toolCalls.length} tool calls, ${transcript.turnCount} turns`)
  if (costUsd) outcomeParts.push(`$${costUsd.toFixed(2)}`)
  const outcomeText = outcomeParts.length > 0 ? outcomeParts.join(', ') : 'session completed'

  recordTelemetryRun(db, {
    eventKey: `session:${sessionName}:decision:${decision.id}`,
    decisionId: decision.id,
    goalId,
    sessionName,
    source: 'harvester',
    harness,
    provider,
    model: effectiveModel,
    skill: decision.skill,
    repo: repoName,
    status,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    costUsd,
    startedAt: session.started_at ?? transcript?.startTime ?? null,
    finishedAt: transcript?.endTime ?? new Date().toISOString(),
    metadata: {
      transcriptSessionId: transcript?.sessionId ?? null,
      toolCalls: transcript?.toolCalls.length ?? null,
      turns: transcript?.turnCount ?? null,
      testsPassed,
      deliverableStatus,
      scopeStatus,
    },
  })

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
    const evolveFile = existsSync(join(workDir, '.evolve', 'progress.md'))
      ? join(workDir, '.evolve', 'progress.md')
      : join(workDir, 'evolve-progress.md')
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
    const prUrl = await ensurePushAndPR(workDir, worktreeBranch, baseBranch, decision.skill, decision.task, decision.id)
    if (prUrl) log(`PR created/found: ${prUrl}`)
  }

  // ── Reviewer: audit the session and recommend next skill ────────────
  // When we have a transcript, use the reviewer (reads JSONL with full Foreman context).
  // Otherwise fall back to the old post-completion pipeline (LLM summary via claude -p).
  let reviewSummary = outcomeText
  let reviewLearnings = learnings
  let reviewQuality = 0
  let nextSkillRecommendation: { skill: string, task: string, reasoning: string } | null = null

  const goalRow = goalId ? stmts.getGoal.get(goalId) as { intent?: string } | undefined : undefined

  if (transcriptPath) {
    try {
      const review = await reviewSession({
        sessionId: sessionName,
        transcriptPath,
        cwd: workDir,
        lastAssistantMessage: output.slice(-3000),
        decisionId: decision.id,
        skill: decision.skill,
        task: decision.task,
        goalIntent: goalRow?.intent ?? decision.task,
        goalId,
      })

      reviewSummary = review.summary || outcomeText
      reviewQuality = review.qualityScore
      reviewLearnings = review.learnings.length > 0 ? review.learnings : learnings
      nextSkillRecommendation = review.nextDispatch

      // Override status with reviewer's assessment if it disagrees
      if (review.status === 'success' && status === 'failure') {
        status = 'success'
        log(`Reviewer overrode failure → success for ${sessionName}`)
      }

      db.prepare(`UPDATE decisions SET outcome = ?, learnings = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(reviewSummary.slice(0, 2000), JSON.stringify(reviewLearnings), decision.id)

      log(`Reviewed ${sessionName}: ${review.status} (${review.qualityScore}/10)${nextSkillRecommendation ? ` → next: ${nextSkillRecommendation.skill}` : ''}`)
    } catch (e) {
      log(`Reviewer failed for ${sessionName}: ${e}, falling back to pipeline`)
    }
  }

  // Fallback: old post-completion pipeline when no transcript
  if (!transcriptPath) {
    const digest = await runPostCompletionPipeline(decision.id, sessionName, decision.skill, decision.task, workDir, output, status, outcomeText)
    if (digest.summary) {
      reviewSummary = digest.summary
      db.prepare(`UPDATE decisions SET outcome = ?, learnings = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(digest.summary.slice(0, 2000), digest.learnings ? JSON.stringify(digest.learnings) : null, decision.id)
    }
    if (digest.nextAction) nextSkillRecommendation = { ...digest.nextAction, reasoning: '' }
    reviewQuality = digest.qualityScore ?? 0
    reviewLearnings = digest.learnings ?? learnings
  }

  sendNotification(`Foreman: ${sessionName}`, `${decision.skill} → ${reviewSummary.slice(0, 200)}`)

  // Update confidence
  let projectName = workDir.split('/').pop() ?? workDir
  if (goalId) {
    if (goalRow?.workspace_path) projectName = (goalRow as any).workspace_path.split('/').pop() ?? projectName
  }
  const confSignal = reviewQuality >= 7 ? 'success' as const
    : status === 'success' ? 'success' as const : 'failure' as const
  confidence.update(decision.skill || 'direct', projectName, confSignal)
  const newLevel = confidence.getLevel(decision.skill || 'direct', projectName)
  log(`Confidence: ${decision.skill || 'direct'}@${projectName} → ${newLevel} (${confSignal})`)

  // Trigger learning
  updateLearningsFromOutcome(decision.id, decision.skill, decision.task, status, reviewSummary, reviewLearnings)

  // Store reviewer's next-skill recommendation
  if (nextSkillRecommendation) {
    stmts.insertLearning.run(
      'session_recommendation',
      `${decision.skill} → ${nextSkillRecommendation.skill}: ${nextSkillRecommendation.task.slice(0, 200)}`,
      `decision:${decision.id}`, null, 2.0,
    )
    log(`Reviewer recommends: ${nextSkillRecommendation.skill} — ${nextSkillRecommendation.task.slice(0, 80)}`)
  }

  // Record outcome for active prompt lab experiments
  try {
    const labRow = db.prepare(
      `SELECT id, surface FROM prompt_lab WHERE status = 'testing' ORDER BY created_at DESC LIMIT 1`
    ).get() as { id: string, surface: string } | undefined
    if (labRow) {
      db.prepare(`UPDATE prompt_lab SET dispatches = dispatches + 1, successes = successes + ? WHERE id = ?`)
        .run(status === 'success' ? 1 : 0, labRow.id)
      log(`Lab experiment ${labRow.id}: recorded ${status} (${labRow.surface})`)
    }
  } catch {}

  // Read next-dispatch recommendation from session (skill chaining)
  let sessionNextDispatch: { skill: string, task: string, reasoning?: string } | null = null
  try {
    const ndPath = join(workDir, '.foreman', 'next-dispatch.json')
    if (existsSync(ndPath)) {
      const ndContent = JSON.parse(readFileSync(ndPath, 'utf8'))
      if (ndContent.skill && ndContent.task) {
        sessionNextDispatch = ndContent
        log(`Session recommends next: ${ndContent.skill} — ${ndContent.task.slice(0, 80)}`)
        // Store as learning for future dispatch decisions
        stmts.insertLearning.run(
          'session_recommendation',
          `${decision.skill} → ${ndContent.skill}: ${ndContent.task.slice(0, 200)}`,
          `decision:${decision.id}`, null, 1.5
        )
      }
    }
  } catch {}

  // Auto-dispatch next — prefer reviewer's recommendation, then session's file, then auto-policy
  const nextAction = nextSkillRecommendation ?? sessionNextDispatch
  if (nextAction) {
    log(`Next dispatch: ${nextAction.skill} — ${nextAction.task.slice(0, 80)} (source: ${nextSkillRecommendation ? 'reviewer' : 'session'})`)
  }
  maybeAutoDispatch(decision.skill, projectName, goalId).catch(e => log(`Auto-dispatch failed: ${e}`))
}

// ─── Ensure push + PR ────────────────────────────────────────────────

async function ensurePushAndPR(
  workDir: string, branch: string, baseBranch: string,
  skill: string, task: string, decisionId?: number, goalIntent?: string,
): Promise<string | null> {
  const db = getDb()
  const confidence = getConfidence()

  // 1. Verify the branch only contains the agent's own commits (not inherited diff)
  let commitCount = 0
  let diffStat = ''
  try {
    const { stdout: mergeBase } = await execFileAsync('git', ['merge-base', baseBranch, branch], { cwd: workDir, timeout: 5_000 })
    const { stdout: logOut } = await execFileAsync('git', ['log', '--oneline', `${mergeBase.trim()}..${branch}`], { cwd: workDir, timeout: 5_000 })
    commitCount = logOut.trim().split('\n').filter(Boolean).length
    const { stdout: statOut } = await execFileAsync('git', ['diff', '--stat', `${mergeBase.trim()}..${branch}`], { cwd: workDir, timeout: 5_000 })
    diffStat = statOut.trim()
  } catch {}

  if (commitCount === 0) {
    log(`No commits on ${branch} — skipping PR`)
    return null
  }

  // 2. Push
  try {
    await execFileAsync('git', ['push', '-u', 'origin', branch], { cwd: workDir, timeout: 30_000 })
  } catch (e) {
    log(`Push failed for ${branch}: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 3. Dedup: check if a PR already exists for this branch OR similar task
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'list', '--head', branch, '--json', 'url', '--limit', '1'], { cwd: workDir, timeout: 10_000 })
    const prs = JSON.parse(stdout)
    if (prs.length > 0) return prs[0].url
  } catch {}

  // Also check for similar PRs by title to avoid duplicates
  try {
    const searchTerm = task.slice(0, 40).replace(/['"]/g, '')
    const { stdout } = await execFileAsync('gh', ['pr', 'list', '--search', searchTerm, '--json', 'url,title', '--limit', '3'], { cwd: workDir, timeout: 10_000 })
    const similar = JSON.parse(stdout)
    if (similar.length > 0) {
      log(`Similar PR already exists: ${similar[0].title} — skipping duplicate`)
      return similar[0].url
    }
  } catch {}

  // 4. Build rich PR body with full provenance
  const projectName = workDir.split('/').pop() ?? ''
  const confLevel = confidence.getLevel(skill || 'direct', projectName)
  const confScore = confidence.getConfidence(skill || 'direct', projectName)

  let goalContext = ''
  if (decisionId) {
    const dec = db.prepare(`SELECT goal_id, reasoning, outcome FROM decisions WHERE id = ?`).get(decisionId) as any
    if (dec?.goal_id) {
      const goal = db.prepare(`SELECT intent FROM goals WHERE id = ?`).get(dec.goal_id) as any
      goalContext = goal?.intent ?? ''
    }
  }

  const title = `${skill || 'fix'}: ${task.slice(0, 70)}`

  const body = [
    `## What`,
    task.slice(0, 500),
    ``,
    goalContext ? `## Why\n${goalContext}\n` : '',
    `## Foreman Context`,
    `- **Skill**: ${skill || 'direct'}`,
    `- **Confidence**: ${confLevel} (${Math.round(confScore * 100)}%)`,
    decisionId ? `- **Decision**: #${decisionId}` : '',
    `- **Branch**: \`${branch}\` → \`${baseBranch}\``,
    `- **Commits**: ${commitCount}`,
    ``,
    diffStat ? `## Changes\n\`\`\`\n${diffStat.slice(0, 500)}\n\`\`\`\n` : '',
    `---`,
    `*Dispatched by [Foreman](http://localhost:7374/). Review before merging.*`,
  ].filter(Boolean).join('\n')

  // 5. Create PR
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'create', '--base', baseBranch, '--head', branch,
      '--title', title.slice(0, 100), '--body', body,
    ], { cwd: workDir, timeout: 15_000 })

    const url = stdout.trim()
    log(`Created PR: ${url}`)

    if (AUTO_MERGE && confLevel === 'autonomous') {
      try {
        await execFileAsync('gh', ['pr', 'merge', url, '--squash', '--auto'], { cwd: workDir, timeout: 15_000 })
        log(`Auto-merged PR: ${url}`)
      } catch (e) {
        log(`Auto-merge failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    return url
  } catch (e) {
    log(`PR creation failed for ${branch}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
