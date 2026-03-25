/**
 * Prompt optimizer — template evolution via AxGEPA or identity passthrough.
 * Also: updateLearningsFromOutcome, cross-project confidence transfer.
 */

import {
  OPTIMIZER_STRATEGY,
  getDb, getStmts, getConfidence,
  log, emitEvent,
} from './state.js'

// ─── Outcome-driven learning ─────────────────────────────────────────

export function updateLearningsFromOutcome(
  decisionId: number, skill: string, task: string,
  status: string, outcome: string, learnings: string[],
): void {
  const db = getDb()
  const stmts = getStmts()
  const confidence = getConfidence()

  if (status === 'success' && learnings.length > 0) {
    for (const l of learnings.slice(0, 3)) {
      const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'dispatch_success'`).get(l.slice(0, 200))
      if (!exists) {
        stmts.insertLearning.run('dispatch_success', l.slice(0, 500), `decision:${decisionId}`, null, 1.5)
      }
    }
  }

  if (status === 'failure') {
    const key = `FAIL: ${skill} "${task.slice(0, 80)}" → ${outcome.slice(0, 100)}`
    const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'dead_end'`).get(key.slice(0, 200))
    if (!exists) {
      stmts.insertLearning.run('dead_end', key.slice(0, 500), `decision:${decisionId}`, null, -1.0)
    }
  }

  const templates = stmts.listTemplates.all(10) as Array<{ id: number, version: number }>
  for (const t of templates) {
    const total = (db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE template_version = ? AND status IN ('success','failure')`).get(t.version) as { c: number }).c
    const success = (db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE template_version = ? AND status = 'success'`).get(t.version) as { c: number }).c
    if (total > 0) {
      stmts.updateTemplateScore.run(success / total, total, success, t.id)
    }
  }

  const activeTemplate = stmts.activeTemplate.get() as { id: number, version: number, dispatches: number, score: number | null } | undefined
  if (activeTemplate && activeTemplate.dispatches >= 5 && !gepaRunning) {
    const untestedVariant = db.prepare(`SELECT id FROM prompt_templates WHERE active = 0 AND dispatches < 3`).get()
    if (!untestedVariant) {
      triggerGepaVariant(activeTemplate.version, activeTemplate.score ?? 0).catch(e => log(`GEPA variant failed: ${e}`))
    }
  }

  // Cross-project confidence transfer
  if (status === 'success' && skill) {
    const allEntries = confidence.list()
    const otherProjects = new Set(allEntries.map(e => e.project))
    const thisDecision = db.prepare(`SELECT base_branch, worktree_path FROM decisions WHERE id = ?`).get(decisionId) as { base_branch?: string, worktree_path?: string } | undefined
    const thisProject = thisDecision?.worktree_path?.split('/').pop() ?? ''
    for (const otherProject of otherProjects) {
      if (otherProject === thisProject) continue
      const existing = confidence.getConfidence(skill, otherProject)
      if (existing > 0) {
        confidence.update(skill, otherProject, 'transfer')
      }
    }
  }
}

// ─── Prompt Optimizer Interface ──────────────────────────────────────

interface PromptOptimizerResult {
  variant: string | null
  score?: number
}

interface PromptOptimizer {
  name: string
  optimize(data: {
    currentVersion: number
    currentScore: number
    trainExamples: Array<{ task: string, prompt: string, outcome: string, success: boolean }>
  }): Promise<PromptOptimizerResult>
}

const identityOptimizer: PromptOptimizer = {
  name: 'identity',
  async optimize() { return { variant: null } },
}

const axGepaOptimizer: PromptOptimizer = {
  name: 'gepa',
  async optimize(data) {
    const axLib: any = await import('@ax-llm/ax')
    const { ai, ax, AxGEPA } = axLib

    const studentAI = ai({ name: 'anthropic', config: { model: 'claude-sonnet-4-6' as any } })
    const teacherAI = ai({ name: 'anthropic', config: { model: 'claude-opus-4-6' as any } })

    const promptGenerator = ax(
      'task:string, projectContext:string -> composedPrompt:string "A rich, context-loaded prompt for a Claude Code session that will accomplish the task"',
    )
    promptGenerator.setInstruction(
      `You compose dispatch prompts for autonomous coding sessions. Include: task description, quality standards, git workflow, project context, past decisions, learned patterns, and dead ends to avoid. Be specific and actionable.`
    )

    const train = data.trainExamples.slice(0, 8).map(e => ({
      task: e.task.slice(0, 200),
      projectContext: 'project context available',
      composedPrompt: e.prompt.slice(0, 500),
    }))

    const validation = data.trainExamples.slice(8, 12).map(e => ({
      task: e.task.slice(0, 200),
      projectContext: 'project context available',
      composedPrompt: e.prompt.slice(0, 500),
    }))

    if (train.length < 3 || validation.length < 1) {
      log('AxGEPA: not enough data (need 3+ train, 1+ validation)')
      return { variant: null }
    }

    const successMap = new Map(data.trainExamples.map(e => [e.task.slice(0, 200), e.success]))
    const metric = ({ prediction, example }: { prediction: any, example: any }) => {
      const taskSuccess = successMap.get(example.task) ? 1 : 0
      const specificity = typeof prediction?.composedPrompt === 'string'
        ? Math.min(1, prediction.composedPrompt.length / 500)
        : 0
      return { taskSuccess, specificity }
    }

    const optimizer = new AxGEPA({
      studentAI, teacherAI,
      numTrials: 6, minibatch: true, minibatchSize: 3,
      earlyStoppingTrials: 3, sampleCount: 1,
    })

    try {
      const result = await optimizer.compile(promptGenerator, train, metric, {
        validationExamples: validation, maxMetricCalls: 60,
      })

      const prog = result.optimizedProgram as any
      const optimizedInstruction = prog?.instruction
        ?? (prog?.instructionMap ? Object.values(prog.instructionMap)[0] : null)

      if (optimizedInstruction) {
        log(`AxGEPA: optimized instruction (score: ${result.bestScore})`)
        return {
          variant: String(optimizedInstruction),
          score: typeof result.bestScore === 'number' ? result.bestScore : undefined,
        }
      }

      if (result.paretoFront?.length > 0) {
        const best = result.paretoFront[0] as any
        const instruction = best.configuration?.instruction
          ?? (best.configuration?.instructionMap ? Object.values(best.configuration.instructionMap)[0] : null)
        if (instruction) {
          log(`AxGEPA: Pareto front candidate (scores: ${JSON.stringify(best.scores)})`)
          return { variant: String(instruction) }
        }
      }

      return { variant: null }
    } catch (e) {
      log(`AxGEPA optimization failed: ${e instanceof Error ? e.message : String(e)}`)
      return { variant: null }
    }
  },
}

const optimizers: Record<string, PromptOptimizer> = {
  identity: identityOptimizer,
  gepa: axGepaOptimizer,
}

function getOptimizer(): PromptOptimizer {
  return optimizers[OPTIMIZER_STRATEGY] ?? identityOptimizer
}

// ─── Template evolution ──────────────────────────────────────────────

let gepaRunning = false

export async function triggerGepaVariant(currentVersion: number, currentScore: number): Promise<void> {
  if (gepaRunning) return

  const optimizer = getOptimizer()
  if (optimizer.name === 'identity') {
    log(`Optimizer: identity (set FOREMAN_OPTIMIZER=gepa to enable AxGEPA)`)
    return
  }

  gepaRunning = true
  const db = getDb()
  const stmts = getStmts()

  try {
    const examples = db.prepare(`
      SELECT d.task, d.status, d.outcome, s.prompt
      FROM decisions d
      LEFT JOIN sessions s ON s.decision_id = d.id
      WHERE d.status IN ('success', 'failure') AND s.prompt IS NOT NULL
      ORDER BY d.created_at DESC LIMIT 12
    `).all() as Array<{ task: string, status: string, outcome: string | null, prompt: string | null }>

    const trainExamples = examples
      .filter(e => e.prompt)
      .map(e => ({
        task: e.task, prompt: e.prompt!,
        outcome: e.outcome ?? '', success: e.status === 'success',
      }))

    if (trainExamples.length < 4) {
      log(`Optimizer: need 4+ scored dispatches with prompts (have ${trainExamples.length})`)
      gepaRunning = false
      return
    }

    const result = await optimizer.optimize({ currentVersion, currentScore, trainExamples })

    if (result.variant) {
      const newVersion = currentVersion + 1
      stmts.insertTemplate.run(newVersion, result.variant.slice(0, 2000), 0)
      log(`${optimizer.name}: generated template v${newVersion}${result.score ? ` (score: ${result.score})` : ''}`)
      promoteTemplateIfBetter()
    } else {
      log(`${optimizer.name}: no variant generated (insufficient signal or no improvement found)`)
    }
  } catch (e) {
    log(`${optimizer.name} failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    gepaRunning = false
  }
}

export function promoteTemplateIfBetter(): void {
  const db = getDb()
  const stmts = getStmts()

  const templates = stmts.listTemplates.all(10) as Array<{
    id: number, version: number, score: number | null, dispatches: number, active: number
  }>

  const scored = templates.filter(t => t.dispatches >= 3 && t.score !== null)
  if (scored.length < 2) return

  const best = scored.reduce((a, b) => (a.score ?? 0) > (b.score ?? 0) ? a : b)
  const active = templates.find(t => t.active === 1)

  if (active && best.id !== active.id && (best.score ?? 0) > (active.score ?? 0)) {
    db.prepare(`UPDATE prompt_templates SET active = 0`).run()
    db.prepare(`UPDATE prompt_templates SET active = 1 WHERE id = ?`).run(best.id)
    log(`Promoted template v${best.version} (${Math.round((best.score ?? 0) * 100)}%) over v${active.version} (${Math.round((active.score ?? 0) * 100)}%)`)
    emitEvent('template_promoted', null, null, { version: best.version, score: best.score })
  }
}
