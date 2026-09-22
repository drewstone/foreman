/**
 * Prompt optimizer — template evolution via AxGEPA or identity passthrough.
 * Also: updateLearningsFromOutcome, cross-project confidence transfer.
 */

import {
  OPTIMIZER_STRATEGY,
  getDb, getStmts, getConfidence,
  log, emitEvent,
} from './state.js'
import {
  buildPromptPolicyCandidates,
  chooseHeuristicPromptPolicy,
  classifyPromptTaskShape,
  classifyTaskLengthBucket,
  inferRecommendedPromptPolicyId,
  parsePromptPolicy,
  serializePromptPolicy,
  type PromptPolicy,
  type PromptPolicyTrainingExample,
} from './prompt-policy.js'

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
  policy: PromptPolicy | null
  score?: number
  source: 'heuristic' | 'gepa'
}

interface PromptOptimizer {
  name: string
  optimize(data: {
    currentVersion: number
    currentScore: number
    currentPolicy: PromptPolicy
    trainExamples: PromptPolicyTrainingExample[]
  }): Promise<PromptOptimizerResult>
}

const identityOptimizer: PromptOptimizer = {
  name: 'identity',
  async optimize() { return { policy: null, source: 'heuristic' } },
}

const axGepaOptimizer: PromptOptimizer = {
  name: 'gepa',
  async optimize(data) {
    const candidates = buildPromptPolicyCandidates(data.currentPolicy)
    const candidateIds = candidates.map(candidate => candidate.id)
    const heuristicPolicy = chooseHeuristicPromptPolicy(data.currentPolicy, data.trainExamples)

    const labeled = data.trainExamples.map(example => ({
      skill: example.skill,
      taskShape: example.taskShape,
      taskLengthBucket: example.taskLengthBucket,
      hasScope: example.hasScope ? 'true' : 'false',
      hasDeliverable: example.hasDeliverable ? 'true' : 'false',
      variantId: candidateIds.includes(example.variantId)
        ? example.variantId
        : inferRecommendedPromptPolicyId(example, data.currentPolicy.id),
    }))

    const labelCount = new Set(labeled.map(item => item.variantId)).size
    const splitIndex = Math.max(1, Math.floor(labeled.length * 0.8))
    const train = labeled.slice(0, splitIndex)
    const validation = labeled.slice(splitIndex)

    if (train.length < 4 || validation.length < 1 || labelCount < 2) {
      return { policy: heuristicPolicy.id === data.currentPolicy.id ? null : heuristicPolicy, source: 'heuristic' }
    }

    try {
      const axLib: any = await import('@ax-llm/ax')
      const { ai, ax, AxGEPA } = axLib

      const studentAI = ai({ name: 'anthropic', config: { model: 'claude-sonnet-4-6' as any } })
      const teacherAI = ai({ name: 'anthropic', config: { model: 'claude-opus-4-6' as any } })

      const selector = ax(
        `skill:string, taskShape:string, taskLengthBucket:string, hasScope:string, hasDeliverable:string -> variantId:class "${candidateIds.join(', ')}"`
      )
      selector.setInstruction(
        'Choose the best global prompt policy variant for Foreman dispatches. Prefer stricter variants when scope control is important, lean variants for verification and recovery work, and richer variants for redesign or research-heavy work.'
      )

      const metric = ({ prediction, example }: { prediction: any, example: any }) =>
        prediction?.variantId === example?.variantId ? 1 : 0

      const optimizer = new AxGEPA({
        studentAI, teacherAI,
        numTrials: 6, minibatch: true, minibatchSize: 3,
        earlyStoppingTrials: 3, sampleCount: 1,
      })

      const result = await optimizer.compile(selector, train, metric, {
        validationExamples: validation,
        maxMetricCalls: 60,
      })
      if (result.optimizedProgram) selector.applyOptimization(result.optimizedProgram)

      const tallies = new Map<string, number>()
      for (const example of data.trainExamples.slice(0, 12)) {
        const prediction = await selector.forward(studentAI, {
          skill: example.skill,
          taskShape: example.taskShape,
          taskLengthBucket: example.taskLengthBucket,
          hasScope: example.hasScope ? 'true' : 'false',
          hasDeliverable: example.hasDeliverable ? 'true' : 'false',
        })
        const variantId = typeof prediction?.variantId === 'string' ? prediction.variantId : heuristicPolicy.id
        const weight = example.success ? 1 : 1.5
        tallies.set(variantId, (tallies.get(variantId) ?? 0) + weight)
      }

      const chosenId = [...tallies.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
      const chosenPolicy = candidates.find(candidate => candidate.id === chosenId) ?? heuristicPolicy
      return {
        policy: chosenPolicy.id === data.currentPolicy.id ? null : chosenPolicy,
        score: typeof result.bestScore === 'number' ? result.bestScore : undefined,
        source: 'gepa',
      }
    } catch (e) {
      log(`AxGEPA policy optimization failed: ${e instanceof Error ? e.message : String(e)}`)
      return { policy: heuristicPolicy.id === data.currentPolicy.id ? null : heuristicPolicy, source: 'heuristic' }
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

function parseMetrics(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function buildPromptPolicyExamples(rows: Array<{
  skill: string
  task: string
  status: string
  outcome: string | null
  metrics: string | null
  scope_spec: string | null
  deliverable_spec: string | null
  deliverable_status: string | null
  prompt_policy_id: string | null
  template: string | null
}>): PromptPolicyTrainingExample[] {
  return rows.map(row => {
    const metrics = parseMetrics(row.metrics)
    const templatePolicy = parsePromptPolicy(row.template)
    const variantId = row.prompt_policy_id || templatePolicy.id
    const scopeViolation = metrics.scopeStatus === 'violation' || (row.outcome ?? '').includes('SCOPE VIOLATION')
    return {
      skill: row.skill || 'direct',
      task: row.task,
      taskShape: classifyPromptTaskShape(row.skill, row.task),
      taskLengthBucket: classifyTaskLengthBucket(row.task),
      hasScope: !!row.scope_spec,
      hasDeliverable: !!row.deliverable_spec,
      success: row.status === 'success',
      scopeViolation,
      deliverableStatus: row.deliverable_status === 'pass' || row.deliverable_status === 'fail'
        ? row.deliverable_status
        : 'unchecked',
      variantId,
    }
  })
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
    const activeTemplate = stmts.activeTemplate.get() as { template?: string | null } | undefined
    const currentPolicy = parsePromptPolicy(activeTemplate?.template)
    const examples = db.prepare(`
      SELECT d.skill, d.task, d.status, d.outcome, d.metrics, d.scope_spec, d.deliverable_spec,
             d.deliverable_status, d.prompt_policy_id, pt.template
      FROM decisions d
      LEFT JOIN prompt_templates pt ON pt.version = d.template_version
      WHERE d.status IN ('success', 'failure')
      ORDER BY d.created_at DESC LIMIT 24
    `).all() as Array<{
      skill: string
      task: string
      status: string
      outcome: string | null
      metrics: string | null
      scope_spec: string | null
      deliverable_spec: string | null
      deliverable_status: string | null
      prompt_policy_id: string | null
      template: string | null
    }>

    const trainExamples = buildPromptPolicyExamples(examples)

    if (trainExamples.length < 6) {
      log(`Optimizer: need 6+ scored dispatches with prompt policy metadata (have ${trainExamples.length})`)
      gepaRunning = false
      return
    }

    const result = await optimizer.optimize({ currentVersion, currentScore, currentPolicy, trainExamples })

    if (result.policy) {
      const newVersion = currentVersion + 1
      stmts.insertTemplate.run(newVersion, serializePromptPolicy(result.policy).trim().slice(0, 2000), 0)
      log(`${optimizer.name}: generated prompt policy v${newVersion} (${result.policy.id})${result.score ? ` (score: ${result.score})` : ''}`)
      promoteTemplateIfBetter()
    } else {
      log(`${optimizer.name}: no prompt policy variant generated (insufficient signal or no improvement found)`)
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
