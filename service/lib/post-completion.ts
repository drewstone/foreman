/**
 * Post-completion pipeline — sub-agents that analyze completed sessions.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  type PostCompletionDigest, type PostCompletionAgent,
  POST_COMPLETION_STRATEGY, FOREMAN_HOME,
  log,
} from './state.js'
import { callClaudeForJSON } from './claude-runner.js'

const execFileAsync = promisify(execFile)

const identityPostAgent: PostCompletionAgent = {
  name: 'identity',
  async run() { return {} },
}

const digestPostAgent: PostCompletionAgent = {
  name: 'digest',
  async run(ctx) {
    let gitDiff = ''
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD~5..HEAD'], { cwd: ctx.workDir, timeout: 5_000 })
      gitDiff = stdout.trim().slice(0, 1000)
    } catch {}

    const prompt = `You are a post-completion reviewer for an autonomous coding agent session.

Session: ${ctx.sessionName}
Skill: ${ctx.skill}
Task: ${ctx.task}
Status: ${ctx.status}
Outcome: ${ctx.outcomeText}

${gitDiff ? `Git diff stat:\n${gitDiff}\n` : ''}
Session output (last portion):
${ctx.output.slice(-3000)}

Analyze this session and respond with JSON only:
{
  "summary": "2-3 sentence summary of what was accomplished",
  "qualityScore": 1-10,
  "goalAchieved": true/false,
  "learnings": ["specific reusable insight 1", "insight 2"],
  "nextAction": {"skill": "/skill-name", "task": "specific next task"} or null
}`

    try {
      const parsed = await callClaudeForJSON(prompt) as any
      if (!parsed) return {}
      return {
        summary: parsed.summary ?? null,
        qualityScore: typeof parsed.qualityScore === 'number' ? parsed.qualityScore : null,
        goalAchieved: typeof parsed.goalAchieved === 'boolean' ? parsed.goalAchieved : null,
        learnings: Array.isArray(parsed.learnings) ? parsed.learnings.map(String) : null,
        nextAction: parsed.nextAction?.skill ? parsed.nextAction : null,
      }
    } catch (e) {
      log(`Digest agent failed: ${e instanceof Error ? e.message : String(e)}`)
      return {}
    }
  },
}

const fullPostAgent: PostCompletionAgent = {
  name: 'full',
  async run(ctx) {
    const digest = await digestPostAgent.run(ctx)

    let auditFindings: string[] = []
    try {
      const auditPrompt = `Review this completed coding session for quality issues.

Task: ${ctx.task}
Output (last portion):
${ctx.output.slice(-2000)}

List specific issues found (security, correctness, style). Respond with JSON:
{"issues": ["issue 1", "issue 2"]}
If no issues, return {"issues": []}`

      const auditResult = await callClaudeForJSON(auditPrompt) as any
      if (auditResult?.issues) {
        auditFindings = Array.isArray(auditResult.issues) ? auditResult.issues.map(String) : []
      }
    } catch {}

    const adjustedScore = auditFindings.length > 0
      ? Math.max(1, (digest.qualityScore ?? 7) - auditFindings.length)
      : digest.qualityScore

    const enrichedLearnings = [
      ...(digest.learnings ?? []),
      ...auditFindings.map(f => `AUDIT: ${f}`),
    ]

    return {
      ...digest,
      qualityScore: adjustedScore,
      learnings: enrichedLearnings.length > 0 ? enrichedLearnings : null,
      summary: digest.summary
        ? `${digest.summary}${auditFindings.length > 0 ? ` (${auditFindings.length} audit findings)` : ''}`
        : null,
    }
  },
}

const postCompletionAgents: Record<string, PostCompletionAgent> = {
  identity: identityPostAgent,
  digest: digestPostAgent,
  full: fullPostAgent,
}

export async function runPostCompletionPipeline(
  decisionId: number, sessionName: string, skill: string, task: string,
  workDir: string, output: string, status: string, outcomeText: string,
): Promise<PostCompletionDigest> {
  const agent = postCompletionAgents[POST_COMPLETION_STRATEGY] ?? identityPostAgent
  const logPath = join(FOREMAN_HOME, 'logs', `session-${sessionName}.log`)

  if (agent.name === 'identity') {
    return {
      summary: null, qualityScore: null, goalAchieved: null,
      learnings: null, nextAction: null, fullLogPath: existsSync(logPath) ? logPath : null,
    }
  }

  log(`Post-completion: running ${agent.name} agent on ${sessionName}`)
  const startMs = Date.now()

  const result = await agent.run({ decisionId, sessionName, skill, task, workDir, output, status, outcomeText })
  const elapsed = Date.now() - startMs

  log(`Post-completion: ${agent.name} completed in ${(elapsed / 1000).toFixed(1)}s` +
    (result.qualityScore ? ` quality=${result.qualityScore}/10` : '') +
    (result.goalAchieved !== null ? ` goal=${result.goalAchieved}` : ''))

  return {
    summary: result.summary ?? null,
    qualityScore: result.qualityScore ?? null,
    goalAchieved: result.goalAchieved ?? null,
    learnings: result.learnings ?? null,
    nextAction: result.nextAction ?? null,
    fullLogPath: existsSync(logPath) ? logPath : null,
  }
}
