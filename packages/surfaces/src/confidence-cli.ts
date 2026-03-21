/**
 * CLI for confidence score management and proposal review.
 *
 * Usage:
 *   npm run confidence -- --list                           # all scores
 *   npm run confidence -- --list --project foreman         # filter by project
 *   npm run confidence -- --review                         # pending proposals
 *   npm run confidence -- --approve <timestamp>            # approve a proposal
 *   npm run confidence -- --reject <timestamp>             # reject a proposal
 *   npm run confidence -- --seed <action> <project> <score># bootstrap a score
 *   npm run confidence -- --override <project> <override>  # set override
 *   npm run confidence -- --override <project> --clear     # clear override
 *   npm run confidence -- --history                        # signal log
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  ConfidenceStore,
  type ConfidenceOverride,
} from '@drew/foreman-memory/confidence'
import type { PolicyDecision } from './policy.js'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}

function formatTable(
  headers: string[],
  widths: number[],
  rows: string[][],
): string {
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-')
  const head = headers.map((h, i) => pad(h, widths[i]!)).join(' | ')
  const lines = rows.map((r) => r.map((c, i) => pad(c, widths[i]!)).join(' | '))
  return [head, sep, ...lines].join('\n')
}

async function listScores(project?: string): Promise<void> {
  const store = new ConfidenceStore()
  try {
    const entries = store.list(project)
    if (entries.length === 0) {
      console.log(project ? `No scores for project "${project}".` : 'No confidence scores yet.')
      return
    }
    const headers = ['action_type', 'project', 'score', 'level', 'signals', 'last_updated']
    const widths = [20, 20, 7, 12, 7, 24]
    const rows = entries.map((e) => [
      e.actionType,
      e.project,
      e.score.toFixed(2),
      e.level,
      String(e.totalSignals),
      e.lastUpdated,
    ])
    console.log(formatTable(headers, widths, rows))
  } finally {
    store.close()
  }
}

async function seedScore(actionType: string, project: string, target: number): Promise<void> {
  const store = new ConfidenceStore()
  try {
    const current = store.getConfidence(actionType, project)
    if (Math.abs(current - target) < 0.01) {
      console.log(`Score for ${actionType}/${project} already at ${current.toFixed(2)}.`)
      return
    }

    const signal = target > current ? 'agree' : 'disagree'
    const maxIterations = 200
    let iterations = 0

    while (iterations < maxIterations) {
      const score = store.getConfidence(actionType, project)
      if (signal === 'agree' && score >= target) break
      if (signal === 'disagree' && score <= target) break
      store.update(actionType, project, signal as 'agree' | 'disagree')
      iterations++
    }

    const final = store.getConfidence(actionType, project)
    const level = store.getLevelForScore(final)
    console.log(`Seeded ${actionType}/${project}: ${final.toFixed(2)} (${level}) [${iterations} signals]`)
  } finally {
    store.close()
  }
}

async function setOverride(project: string, override: string | null): Promise<void> {
  const store = new ConfidenceStore()
  try {
    if (override === null) {
      store.setOverride(project, null)
      console.log(`Cleared override for project "${project}".`)
    } else {
      if (override !== 'never-auto' && override !== 'always-auto') {
        console.error(`Invalid override: "${override}". Must be "never-auto" or "always-auto".`)
        process.exit(1)
      }
      store.setOverride(project, override as ConfidenceOverride)
      console.log(`Set override for "${project}": ${override}`)
    }
  } finally {
    store.close()
  }
}

async function showHistory(): Promise<void> {
  const store = new ConfidenceStore()
  try {
    const log = store.getLog(50)
    if (log.length === 0) {
      console.log('No signal history.')
      return
    }
    const headers = ['timestamp', 'action_type', 'project', 'signal', 'old', 'new']
    const widths = [24, 20, 20, 10, 7, 7]
    const rows = log.map((e) => [
      e.timestamp,
      e.actionType,
      e.project,
      e.signal,
      e.oldScore.toFixed(2),
      e.newScore.toFixed(2),
    ])
    console.log(formatTable(headers, widths, rows))
  } finally {
    store.close()
  }
}

async function loadPolicyDecisions(): Promise<Array<{ file: string; decision: PolicyDecision }>> {
  const dir = join(FOREMAN_HOME, 'traces', 'policy')
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json')).sort().reverse()
  const results: Array<{ file: string; decision: PolicyDecision }> = []
  for (const f of jsonFiles.slice(0, 100)) {
    try {
      const raw = await readFile(join(dir, f), 'utf8')
      const decision = JSON.parse(raw) as PolicyDecision
      results.push({ file: f, decision })
    } catch {
      // skip corrupt files
    }
  }
  return results
}

async function reviewProposals(): Promise<void> {
  const all = await loadPolicyDecisions()
  const pending = all.filter(
    (d) =>
      d.decision.action !== null &&
      !d.decision.executed &&
      d.decision.confidenceLevel === 'propose',
  )

  if (pending.length === 0) {
    console.log('No pending proposals.')
    return
  }

  console.log(`${pending.length} pending proposal(s):\n`)

  const headers = ['timestamp', 'action_type', 'project', 'goal', 'score']
  const widths = [24, 20, 20, 40, 7]
  const rows = pending.map((p) => [
    p.decision.timestamp,
    p.decision.action!.type,
    p.decision.action!.project,
    p.decision.action!.goal,
    p.decision.confidenceScore.toFixed(2),
  ])
  console.log(formatTable(headers, widths, rows))

  console.log('\nTo approve: npm run confidence -- --approve <timestamp>')
  console.log('To reject:  npm run confidence -- --reject <timestamp>')
}

async function handleVerdict(timestamp: string, signal: 'agree' | 'disagree'): Promise<void> {
  const all = await loadPolicyDecisions()
  const normalized = timestamp.replace(/[:.]/g, '-')
  const match = all.find((d) => {
    const fileTs = d.file.replace('.json', '')
    return fileTs === normalized || d.decision.timestamp === timestamp
  })

  if (!match) {
    console.error(`No decision found for timestamp "${timestamp}".`)
    process.exit(1)
  }

  const action = match.decision.action
  if (!action) {
    console.error('Decision has no action.')
    process.exit(1)
  }

  const store = new ConfidenceStore()
  try {
    store.update(action.type, action.project, signal)
    const newScore = store.getConfidence(action.type, action.project)
    const level = store.getLevelForScore(newScore)
    const verb = signal === 'agree' ? 'Approved' : 'Rejected'
    console.log(`${verb} ${action.type}/${action.project}: ${newScore.toFixed(2)} (${level})`)
  } finally {
    store.close()
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.includes('--list')) {
    const projIdx = args.indexOf('--project')
    const project = projIdx >= 0 ? args[projIdx + 1] : undefined
    await listScores(project)
    return
  }

  if (args.includes('--seed')) {
    const idx = args.indexOf('--seed')
    const actionType = args[idx + 1]
    const project = args[idx + 2]
    const score = parseFloat(args[idx + 3] ?? '')
    if (!actionType || !project || isNaN(score) || score < 0 || score > 1) {
      console.error('Usage: --seed <actionType> <project> <score 0.0-1.0>')
      process.exit(1)
    }
    await seedScore(actionType, project, score)
    return
  }

  if (args.includes('--override')) {
    const idx = args.indexOf('--override')
    const project = args[idx + 1]
    if (!project) {
      console.error('Usage: --override <project> <never-auto|always-auto|--clear>')
      process.exit(1)
    }
    const nextArg = args[idx + 2]
    if (nextArg === '--clear') {
      await setOverride(project, null)
    } else if (!nextArg) {
      console.error('Usage: --override <project> <never-auto|always-auto|--clear>')
      process.exit(1)
    } else {
      await setOverride(project, nextArg)
    }
    return
  }

  if (args.includes('--history')) {
    await showHistory()
    return
  }

  if (args.includes('--review')) {
    await reviewProposals()
    return
  }

  if (args.includes('--approve')) {
    const idx = args.indexOf('--approve')
    const timestamp = args[idx + 1]
    if (!timestamp) {
      console.error('Usage: --approve <decision-timestamp>')
      process.exit(1)
    }
    await handleVerdict(timestamp, 'agree')
    return
  }

  if (args.includes('--reject')) {
    const idx = args.indexOf('--reject')
    const timestamp = args[idx + 1]
    if (!timestamp) {
      console.error('Usage: --reject <decision-timestamp>')
      process.exit(1)
    }
    await handleVerdict(timestamp, 'disagree')
    return
  }

  console.log(`Usage:
  --list [--project <name>]              Show confidence scores
  --seed <action> <project> <score>      Seed a confidence score
  --override <project> <override>        Set override (never-auto|always-auto)
  --override <project> --clear           Clear override
  --history                              Show signal log
  --review                               List pending proposals
  --approve <timestamp>                  Approve a proposal
  --reject <timestamp>                   Reject a proposal`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
