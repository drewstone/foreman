/**
 * Generic LLM judge harness.
 *
 * Takes any directive + artifact + rubric and returns structured scores.
 * Dispatches to any TextProvider (claude, codex, or custom).
 * Reusable across daily reports, heartbeat decisions, skill quality,
 * PR reviews, or any artifact that needs judgment.
 *
 * Usage:
 *   const judge = createLLMJudge({ provider, directive, rubric })
 *   const result = await judge.evaluate(artifact)
 *
 * Parallel usage:
 *   const results = await evaluateParallel(judges, artifact)
 */

import type { TextProvider } from '@drew/foreman-providers'
import { parseJsonOutput } from '@drew/foreman-providers'

export interface JudgeRubricDimension {
  name: string
  description: string
  maxScore: number
  criteria: string[]
}

export interface JudgeDimensionScore {
  name: string
  score: number
  maxScore: number
  reasons: string[]
}

export interface LLMJudgment {
  timestamp: string
  judgeId: string
  providerId: string
  artifactType: string
  dimensions: JudgeDimensionScore[]
  overallScore: number
  maxScore: number
  summary: string
  recommendations: string[]
  rawResponse?: string
}

export interface LLMJudgeConfig {
  /** Unique ID for this judge instance */
  id: string
  /** The provider to dispatch to (claude, codex, etc.) */
  provider: TextProvider
  /** System directive — who is this judge and what's its stance? */
  directive: string
  /** Rubric dimensions to score against */
  rubric: JudgeRubricDimension[]
  /** Artifact type label (e.g. 'daily-report', 'heartbeat-decision') */
  artifactType: string
  /** Timeout in ms (default 120s) */
  timeoutMs?: number
}

export interface LLMJudge {
  id: string
  config: LLMJudgeConfig
  evaluate(artifact: string, context?: string): Promise<LLMJudgment>
}

function buildJudgePrompt(config: LLMJudgeConfig, artifact: string, context?: string): string {
  const rubricText = config.rubric.map((d) =>
    `### ${d.name} (0-${d.maxScore})\n${d.description}\nCriteria:\n${d.criteria.map((c) => `- ${c}`).join('\n')}`,
  ).join('\n\n')

  return `${config.directive}

## Rubric

${rubricText}

${context ? `## Context\n\n${context}\n` : ''}
## Artifact to evaluate

\`\`\`
${artifact}
\`\`\`

## Instructions

Score each rubric dimension. Return ONLY valid JSON matching this schema:
{
  "dimensions": [
    { "name": "dimension_name", "score": <number>, "maxScore": <number>, "reasons": ["reason1", "reason2"] }
  ],
  "summary": "one paragraph overall assessment",
  "recommendations": ["specific improvement 1", "specific improvement 2"]
}

Be critical. A 10/10 means world-class. Most artifacts should score 5-8. Only give 9-10 if genuinely excellent. Give 0-3 if fundamentally broken.`
}

function parseJudgment(raw: string, config: LLMJudgeConfig): LLMJudgment {
  const parsed = parseJsonOutput(raw) as {
    dimensions?: Array<{ name?: string; score?: number; maxScore?: number; reasons?: string[] }>
    summary?: string
    recommendations?: string[]
  }

  const dimensions: JudgeDimensionScore[] = config.rubric.map((rubricDim) => {
    const match = (parsed.dimensions ?? []).find((d) =>
      d.name?.toLowerCase() === rubricDim.name.toLowerCase(),
    )
    return {
      name: rubricDim.name,
      score: Math.min(
        typeof match?.score === 'number' ? match.score : 0,
        rubricDim.maxScore,
      ),
      maxScore: rubricDim.maxScore,
      reasons: Array.isArray(match?.reasons) ? match.reasons.filter((r): r is string => typeof r === 'string') : [],
    }
  })

  const overallScore = dimensions.reduce((sum, d) => sum + d.score, 0)
  const maxScore = dimensions.reduce((sum, d) => sum + d.maxScore, 0)

  return {
    timestamp: new Date().toISOString(),
    judgeId: config.id,
    providerId: config.provider.id,
    artifactType: config.artifactType,
    dimensions,
    overallScore,
    maxScore,
    summary: typeof parsed.summary === 'string' ? parsed.summary : 'No summary.',
    recommendations: Array.isArray(parsed.recommendations)
      ? parsed.recommendations.filter((r): r is string => typeof r === 'string')
      : [],
    rawResponse: raw,
  }
}

export function createLLMJudge(config: LLMJudgeConfig): LLMJudge {
  return {
    id: config.id,
    config,
    async evaluate(artifact: string, context?: string): Promise<LLMJudgment> {
      const prompt = buildJudgePrompt(config, artifact, context)
      const execution = await config.provider.run(prompt, {
        timeoutMs: config.timeoutMs ?? 120_000,
      })

      if (execution.exitCode !== 0) {
        return {
          timestamp: new Date().toISOString(),
          judgeId: config.id,
          providerId: config.provider.id,
          artifactType: config.artifactType,
          dimensions: config.rubric.map((d) => ({
            name: d.name,
            score: 0,
            maxScore: d.maxScore,
            reasons: [`Judge failed: exit ${execution.exitCode}`],
          })),
          overallScore: 0,
          maxScore: config.rubric.reduce((s, d) => s + d.maxScore, 0),
          summary: `Judge execution failed with exit code ${execution.exitCode}`,
          recommendations: [],
          rawResponse: execution.stderr || execution.stdout,
        }
      }

      return parseJudgment(execution.stdout, config)
    },
  }
}

// ─── Parallel evaluation ────────────────────────────────────────────

export async function evaluateParallel(
  judges: LLMJudge[],
  artifact: string,
  context?: string,
): Promise<LLMJudgment[]> {
  return Promise.all(judges.map((j) => j.evaluate(artifact, context)))
}

export function mergeJudgments(judgments: LLMJudgment[]): LLMJudgment {
  if (judgments.length === 0) throw new Error('no judgments to merge')
  if (judgments.length === 1) return judgments[0]

  // Average scores across judges per dimension
  const dimNames = [...new Set(judgments.flatMap((j) => j.dimensions.map((d) => d.name)))]
  const dimensions: JudgeDimensionScore[] = dimNames.map((name) => {
    const matches = judgments.flatMap((j) => j.dimensions.filter((d) => d.name === name))
    const avgScore = matches.reduce((s, d) => s + d.score, 0) / matches.length
    const maxScore = matches[0]?.maxScore ?? 10
    const allReasons = matches.flatMap((d) => d.reasons)
    // Deduplicate reasons
    const uniqueReasons = [...new Set(allReasons)]
    return { name, score: Math.round(avgScore * 10) / 10, maxScore, reasons: uniqueReasons.slice(0, 10) }
  })

  const overallScore = dimensions.reduce((s, d) => s + d.score, 0)
  const maxScore = dimensions.reduce((s, d) => s + d.maxScore, 0)

  return {
    timestamp: new Date().toISOString(),
    judgeId: `merged(${judgments.map((j) => j.judgeId).join(',')})`,
    providerId: `merged(${[...new Set(judgments.map((j) => j.providerId))].join(',')})`,
    artifactType: judgments[0].artifactType,
    dimensions,
    overallScore,
    maxScore,
    summary: judgments.map((j) => j.summary).join(' | '),
    recommendations: [...new Set(judgments.flatMap((j) => j.recommendations))].slice(0, 10),
  }
}

// ─── Rendering ──────────────────────────────────────────────────────

export function renderLLMJudgment(j: LLMJudgment): string {
  const lines: string[] = []
  const pct = j.maxScore > 0 ? ((j.overallScore / j.maxScore) * 100).toFixed(0) : '0'
  lines.push(`## LLM Judge: ${j.overallScore}/${j.maxScore} (${pct}%) — ${j.judgeId} via ${j.providerId}`)
  lines.push('')

  for (const d of j.dimensions) {
    const filled = Math.round(d.score)
    const empty = d.maxScore - filled
    const bar = '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty))
    lines.push(`**${d.name}** ${bar} ${d.score}/${d.maxScore}`)
    for (const r of d.reasons) {
      lines.push(`  - ${r}`)
    }
    lines.push('')
  }

  lines.push(`**Summary:** ${j.summary}`)
  lines.push('')

  if (j.recommendations.length > 0) {
    lines.push('**Recommendations:**')
    for (const r of j.recommendations) {
      lines.push(`- ${r}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ─── Judge factory ──────────────────────────────────────────────────

/**
 * Create an ensemble of judges from multiple providers.
 * Each runs the same rubric but with different models/providers.
 * Results are merged by averaging scores per dimension.
 */
export function createJudgeEnsemble(config: {
  id: string
  providers: TextProvider[]
  directive: string
  rubric: JudgeRubricDimension[]
  artifactType: string
  timeoutMs?: number
}): {
  judges: LLMJudge[]
  evaluate(artifact: string, context?: string): Promise<LLMJudgment>
} {
  const judges = config.providers.map((provider, i) =>
    createLLMJudge({
      ...config,
      id: `${config.id}-${provider.id}`,
      provider,
    }),
  )

  return {
    judges,
    async evaluate(artifact: string, context?: string): Promise<LLMJudgment> {
      const results = await evaluateParallel(judges, artifact, context)
      return mergeJudgments(results)
    },
  }
}

// ─── Pre-built rubrics ──────────────────────────────────────────────

export const FOREMAN_DAILY_REPORT_RUBRIC: JudgeRubricDimension[] = [
  {
    name: 'awareness',
    description: 'Does the report show what matters across the operator\'s entire portfolio?',
    maxScore: 10,
    criteria: [
      'All repos with active work are represented',
      'CI failures are detected and surfaced prominently',
      'User\'s actual words and goals from recent sessions are shown',
      'Stale or forgotten branches are flagged',
      'Cross-repo patterns and themes are identified',
    ],
  },
  {
    name: 'prioritization',
    description: 'Are the priorities correct — matching what the operator would actually work on?',
    maxScore: 10,
    criteria: [
      'Blocked work (CI failures, merge conflicts) gets highest priority',
      'Work the user is actively talking about ranks high',
      'Old branches without PRs or recent commits are deprioritized',
      'Priority order matches what a senior operator would choose',
      'Nothing important is buried or missing',
    ],
  },
  {
    name: 'action_quality',
    description: 'Are the proposed actions specific, correct, and actionable?',
    maxScore: 10,
    criteria: [
      'Each proposed action describes exactly what to do, not vague "fix it"',
      'Actions for CI failures include reading logs and diagnosing root cause',
      'Resume decisions match the actual blocker, not generic retry',
      'Dry-run decisions correctly identify when to act vs skip',
      'Actions respect skepticism — never trust agent self-report',
    ],
  },
  {
    name: 'operator_modeling',
    description: 'Does the report demonstrate understanding of how this operator works?',
    maxScore: 10,
    criteria: [
      'Surfaces the operator\'s recent messages — what they said, not just metadata',
      'Recognizes patterns in operator behavior (quality bar, shipping pace, verification habits)',
      'Identifies what the operator would prioritize today based on session activity',
      'Generates rules/suggestions that match observed operator preferences',
      'Distinguishes between active focus areas and background maintenance',
    ],
  },
  {
    name: 'actionability',
    description: 'Would this report actually change what the operator does today?',
    maxScore: 10,
    criteria: [
      'Contains at least one non-obvious insight the operator didn\'t already know',
      'Identifies something the operator forgot about or would have missed',
      'Proposed next actions are concrete enough to act on immediately',
      'Report is concise enough to scan in 2 minutes',
      'The review checklist prompts meaningful reflection, not rubber-stamping',
    ],
  },
]

export const FOREMAN_DAILY_REPORT_DIRECTIVE = `You are a skeptical senior engineering manager reviewing the output of an autonomous operator system called Foreman.

Foreman monitors an engineer's active work across multiple repos, reads their session transcripts, detects CI failures, and generates daily reports with proposed actions.

Your job is to evaluate whether Foreman's daily report demonstrates genuine operator-level understanding or is just surface-level metadata regurgitation.

Key principles:
- A report full of branch names and commit messages is NOT useful — that's "git log" with formatting
- A useful report tells the operator what they should do TODAY that they wouldn't have known otherwise
- The operator works across 10-20 repos simultaneously and loses track of things — Foreman should catch what falls through the cracks
- "No actions proposed" when there are blocked sessions is a FAILURE, not a neutral outcome
- The operator demands world-class quality and hates mocked tests — the report should reflect this stance`
