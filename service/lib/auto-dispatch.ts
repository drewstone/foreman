/**
 * Confidence-gated auto-dispatch — automatically dispatches next work when confidence is high.
 */

import {
  MAX_DAILY_COST_USD, MAX_CONCURRENT_SESSIONS,
  getDb, getStmts, getConfidence,
  log, emitEvent, sendNotification,
} from './state.js'
import { getDispatchPolicy, type DispatchContext } from './dispatch-policy.js'
import { sessionName, spawnSession, selectModel } from './session-manager.js'
import { composePrompt, createWorktree } from './prompt-composer.js'

export async function maybeAutoDispatch(skill: string, project: string, goalId: number): Promise<void> {
  const db = getDb()
  const stmts = getStmts()
  const confidence = getConfidence()

  const level = confidence.getLevel(skill || 'direct', project)
  if (level === 'dry-run' || level === 'propose') return

  const today = new Date().toISOString().slice(0, 10)
  const dailyCost = (db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) as total FROM decisions WHERE date(created_at) = ?`).get(today) as { total: number }).total
  if (dailyCost >= MAX_DAILY_COST_USD) {
    log(`Auto-dispatch blocked: daily cost $${dailyCost.toFixed(2)} >= $${MAX_DAILY_COST_USD} cap`)
    return
  }

  const activeSessions = stmts.activeSessions.all() as Array<{ name: string }>
  if (activeSessions.length >= MAX_CONCURRENT_SESSIONS) {
    log(`Auto-dispatch blocked: ${activeSessions.length} sessions >= ${MAX_CONCURRENT_SESSIONS} cap`)
    return
  }

  const goal = goalId ? stmts.getGoal.get(goalId) as { id: number, intent: string, workspace_path: string | null } | undefined : undefined
  if (!goal?.workspace_path) return

  const lastDecisions = stmts.goalDecisions.all(goal.id) as Array<{ skill: string, status: string, outcome: string | null }>
  if (!lastDecisions.some(d => d.status === 'success')) return

  const flows = stmts.learningsByType.all('flow', 10) as Array<{ content: string }>
  const skillPrefs = stmts.learningsByType.all('skill_preference', 10) as Array<{ content: string }>

  const ctx: DispatchContext = {
    goalIntent: goal.intent,
    projectName: project,
    recentDecisions: lastDecisions.slice(0, 5).map(d => ({
      skill: d.skill, status: d.status, outcome: d.outcome,
    })),
    learnedFlows: flows.map(f => f.content),
    skillPreferences: skillPrefs.map(p => p.content),
    confidenceLevel: level,
  }

  const policy = getDispatchPolicy()
  const decision = await policy.decide(ctx)
  const nextSkill = decision.skill
  const nextTask = decision.task

  log(`Dispatch policy (${policy.name}): ${nextSkill} — ${decision.reasoning.slice(0, 80)}`)
  log(`Auto-dispatching: ${nextSkill} on ${project} (confidence: ${level})`)
  sendNotification('Foreman: Auto-dispatch', `${nextSkill} on ${project} (${level})`)

  const repoDir = goal.workspace_path
  const autoLabel = `auto-${nextSkill.replace(/^\//, '')}-${Date.now().toString(36)}`
  const wt = await createWorktree(repoDir, autoLabel)
  if (!wt) return

  const sName = sessionName(autoLabel)
  const activeTpl = stmts.activeTemplate.get() as { version: number } | undefined
  const result = stmts.insertDecision.run(
    goal.id, nextSkill, nextTask, `auto-dispatch: confidence ${level}`,
    sName, wt.path, wt.branch, wt.baseBranch, activeTpl?.version ?? 1, 'auto',
  )
  const decisionId = Number(result.lastInsertRowid)

  const composed = composePrompt({
    skill: nextSkill, task: nextTask, workDir: wt.path,
    goalIntent: goal.intent, goalId: goal.id,
    worktreeBranch: wt.branch, baseBranch: wt.baseBranch, repoDir,
  })
  db.prepare(`UPDATE decisions SET prompt_sections = ? WHERE id = ?`)
    .run(JSON.stringify(composed.sections), decisionId)

  const model = selectModel(nextSkill, nextTask)
  spawnSession({ name: sName, workDir: wt.path, prompt: composed.text, goalId: goal.id, decisionId, model: model ?? undefined })

  emitEvent('auto_dispatched', sName, goal.id, { skill: nextSkill, confidence: level })
}
