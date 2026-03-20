/**
 * Report Quality evaluation environment.
 *
 * Evaluates daily report quality over time. Each task is a date's
 * heartbeat traces. The run generates the report with the current
 * versioned artifacts (judge directive, CLAUDE.md template). The
 * score comes from the LLM judge.
 *
 * This is the environment that optimizes the daily report itself.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  ForemanEvalEnv,
  rewardFromJudge,
  type EvalTask,
  type EvalRunResult,
  type EvalScoreResult,
  type EvalSessionMetrics,
} from '@drew/foreman-evals/eval-env'
import type { RewardSignal } from '@drew/foreman-tracing'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export class ReportQualityEnv extends ForemanEvalEnv {
  readonly name = 'report-quality'

  async loadTasks(): Promise<EvalTask[]> {
    // Each date with heartbeat traces is a task
    const tracesDir = join(FOREMAN_HOME, 'traces', 'heartbeats')
    const tasks: EvalTask[] = []

    try {
      const files = await readdir(tracesDir)
      const dates = new Set(files.map((f) => f.slice(0, 10)).filter((d) => d.match(/^\d{4}-\d{2}-\d{2}$/)))

      for (const date of [...dates].sort().slice(-7)) { // last 7 days
        tasks.push({
          id: `report:${date}`,
          goal: `Generate and evaluate daily report for ${date}`,
          environmentKind: 'report-quality',
          metadata: { date },
        })
      }
    } catch { /* no traces */ }

    return tasks
  }

  async resolveArtifacts() {
    const artifacts: Record<string, { kind: string; name: string; versionId: string; content: string }> = {}

    const directive = await this.store.getActive('judge-directive', 'daily-report')
    if (directive) {
      artifacts['judge-directive'] = {
        kind: 'judge-directive',
        name: 'daily-report',
        versionId: directive.version.id,
        content: directive.content,
      }
    }

    return artifacts
  }

  async run(task: EvalTask, artifacts: Record<string, { kind: string; name: string; versionId: string; content: string }>): Promise<EvalRunResult> {
    const date = task.metadata?.date ?? new Date().toISOString().slice(0, 10)

    // Generate the report
    const { generateDailyReport } = await import('./daily-report.js')
    const startMs = Date.now()
    const reportPath = await generateDailyReport(date)
    const durationMs = Date.now() - startMs
    const reportContent = await readFile(reportPath, 'utf8')

    const metrics: EvalSessionMetrics = {
      sessionId: `report:${date}`,
      harness: 'claude',
      repo: 'foreman',
      goal: task.goal,
      timestamp: new Date().toISOString(),
      exitCode: 0,
      success: true,
      durationMs,
    }

    return {
      task,
      metrics,
      resultText: reportContent,
      artifacts: Object.fromEntries(
        Object.entries(artifacts).map(([k, v]) => [k, { kind: v.kind, name: v.name, versionId: v.versionId }]),
      ),
    }
  }

  async score(result: EvalRunResult): Promise<EvalScoreResult> {
    const rewards: RewardSignal[] = []

    // The report already has judge scores embedded — extract them
    const reportText = result.resultText

    // Extract deterministic judge score
    const detMatch = reportText.match(/Judge Score: (\d+)\/(\d+)/)
    if (detMatch) {
      rewards.push({
        name: 'deterministic_judge',
        value: parseInt(detMatch[1], 10) / parseInt(detMatch[2], 10),
        source: 'deterministic',
        metadata: { rawScore: detMatch[1], maxScore: detMatch[2] },
      })
    }

    // Extract LLM judge score
    const llmMatch = reportText.match(/LLM Judge: ([\d.]+)\/([\d.]+)/)
    if (llmMatch) {
      rewards.push(rewardFromJudge({
        overallScore: parseFloat(llmMatch[1]),
        maxScore: parseFloat(llmMatch[2]),
        judgeId: 'foreman-daily-report-judge',
      }))
    }

    // Report completeness (how many sections present)
    const sections = [
      'Proposed Actions', 'Discoveries', 'Session Activity',
      'What You Said', 'Stale Repos', 'Portfolio Snapshot',
      'Session Metrics', 'Review Checklist',
    ]
    const present = sections.filter((s) => reportText.includes(s)).length
    rewards.push({
      name: 'completeness',
      value: present / sections.length,
      source: 'deterministic',
      metadata: { present: String(present), total: String(sections.length) },
    })

    // Report length (too short is bad, too long is bad)
    const lines = reportText.split('\n').length
    const lengthScore = lines < 50 ? 0.3 : lines > 500 ? 0.7 : 1.0
    rewards.push({
      name: 'length_quality',
      value: lengthScore,
      source: 'derived',
      metadata: { lines: String(lines) },
    })

    const avgScore = rewards.length > 0
      ? rewards.reduce((s, r) => s + r.value, 0) / rewards.length
      : 0

    return {
      rewards,
      taskCompletion: avgScore > 0.5 ? 'completed' : 'partial',
      summary: `${rewards.length} signals, avg ${avgScore.toFixed(3)}`,
    }
  }
}
