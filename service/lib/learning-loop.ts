/**
 * Learning loop — session scanning, pattern extraction, deep analysis.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import {
  getDb, getStmts, log,
} from './state.js'
import { callClaudeForJSON } from './claude-runner.js'

// ─── Session scanner ─────────────────────────────────────────────────

const SESSION_DIRS: Array<{ dir: string, harness: string, flat?: boolean }> = [
  { dir: join(homedir(), '.claude', 'projects'), harness: 'claude' },
  { dir: join(homedir(), '.pi', 'agent', 'sessions'), harness: 'pi' },
  { dir: join(homedir(), '.codex'), harness: 'codex', flat: true },
]

interface ParsedSession {
  id: string
  harness: string
  repo: string
  timestamp: string
  userMessages: string[]
  skillsUsed: string[]
  outcomeSignals: string[]
}

function scanSessionFile(filePath: string, harness: string): ParsedSession | null {
  try {
    const content = readFileSync(filePath, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    if (lines.length < 2) return null

    const userMessages: string[] = []
    const skillsUsed = new Set<string>()
    const outcomeSignals: string[] = []
    let repo = ''
    let timestamp = ''

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)

        if (!timestamp && entry.timestamp) timestamp = entry.timestamp
        if (entry.cwd && !repo) repo = entry.cwd
        if (entry.projectPath && !repo) repo = entry.projectPath

        if (entry.type === 'human' || entry.type === 'user') {
          const msg = entry.message
          const text = typeof msg === 'string' ? msg
            : typeof msg?.content === 'string' ? msg.content
            : Array.isArray(msg?.content) ? msg.content.map((c: { text?: string }) => c.text ?? '').join('')
            : ''
          if (text && text.length > 5 && text.length < 5000) {
            userMessages.push(text)
            const skillMatch = text.match(/^\/(evolve|pursue|polish|verify|research|converge|critical-audit|diagnose|improve|bad)\b/)
            if (skillMatch) skillsUsed.add('/' + skillMatch[1])
          }
        }

        if (entry.role === 'user' && entry.content) {
          const text = typeof entry.content === 'string' ? entry.content
            : Array.isArray(entry.content) ? entry.content.map((c: { text?: string }) => c.text ?? '').join('') : ''
          if (text && text.length > 5 && text.length < 5000) {
            userMessages.push(text)
            const skillMatch = text.match(/^\/(evolve|pursue|polish|verify|research|converge|critical-audit|diagnose|improve|bad)\b/)
            if (skillMatch) skillsUsed.add('/' + skillMatch[1])
          }
        }

        if (entry.type === 'assistant' || entry.role === 'assistant') {
          const text = typeof entry.message === 'string' ? entry.message
            : entry.message?.content?.[0]?.text
            ?? (typeof entry.content === 'string' ? entry.content : '')
          if (text) {
            if (text.includes('✅') || text.includes('tests pass') || text.includes('committed')) outcomeSignals.push('success')
            if (text.includes('❌') || text.includes('FAIL') || text.includes('error')) outcomeSignals.push('failure')
          }
        }
      } catch {}
    }

    if (userMessages.length === 0) return null

    if (!repo) {
      const pathMatch = filePath.match(/projects\/--.*?--(.*?)--/)
      if (pathMatch) repo = pathMatch[1]
    }

    const sessionId = filePath.split('/').pop()?.replace('.jsonl', '') ?? filePath

    return {
      id: sessionId, harness, repo,
      timestamp: timestamp || new Date().toISOString(),
      userMessages, skillsUsed: [...skillsUsed], outcomeSignals,
    }
  } catch { return null }
}

function scanCodexSessions(dir: string): number {
  const db = getDb()
  const stmts = getStmts()
  const historyPath = join(dir, 'history.jsonl')
  if (!existsSync(historyPath)) return 0

  let scanned = 0
  const cutoff = Date.now() / 1000 - 3 * 24 * 60 * 60

  try {
    const content = readFileSync(historyPath, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)

    const sessionMap = new Map<string, { texts: string[], ts: number }>()
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (!entry.session_id || !entry.text) continue
        if (entry.ts && entry.ts < cutoff) continue

        const existing = sessionMap.get(entry.session_id)
        if (existing) { existing.texts.push(entry.text) }
        else { sessionMap.set(entry.session_id, { texts: [entry.text], ts: entry.ts ?? 0 }) }
      } catch {}
    }

    for (const [sessionId, data] of sessionMap) {
      const existing = db.prepare(`SELECT id FROM operator_sessions WHERE id = ?`).get(sessionId)
      if (existing) continue

      const userMessages = data.texts.filter(t => t.length > 10 && t.length < 2000)
      if (userMessages.length === 0) continue

      stmts.upsertOperatorSession.run(
        sessionId, 'codex', '', new Date(data.ts * 1000).toISOString(),
        userMessages.length,
        JSON.stringify(userMessages.slice(0, 20)),
        JSON.stringify([]), JSON.stringify([]),
      )
      scanned++
    }
  } catch {}

  return scanned
}

function scanAllSessions(): number {
  const db = getDb()
  const stmts = getStmts()
  let scanned = 0

  for (const { dir, harness, flat } of SESSION_DIRS) {
    if (!existsSync(dir)) continue

    if (flat) { scanned += scanCodexSessions(dir); continue }

    try {
      const projectDirs = readdirSync(dir)
      for (const projectDir of projectDirs) {
        const projectPath = join(dir, projectDir)
        try { if (!statSync(projectPath).isDirectory()) continue } catch { continue }

        try {
          const entries = readdirSync(projectPath)
          const files = entries.filter(f => f.endsWith('.jsonl'))
          const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000
          let projectScanned = 0
          for (const file of files) {
            if (projectScanned >= 50) break
            const fp = join(projectPath, file)
            try {
              const st = statSync(fp)
              if (!st.isFile() || st.mtimeMs < cutoff) continue
              if (st.size < 500 || st.size > 5 * 1024 * 1024) continue

              const sessionId = file.replace('.jsonl', '')
              const existing = db.prepare(`SELECT id FROM operator_sessions WHERE id = ?`).get(sessionId) as { id: string } | undefined
              if (existing) continue

              const parsed = scanSessionFile(fp, harness)
              if (parsed && parsed.userMessages.length > 0) {
                stmts.upsertOperatorSession.run(
                  parsed.id, parsed.harness, parsed.repo, parsed.timestamp,
                  parsed.userMessages.length,
                  JSON.stringify(parsed.userMessages.slice(0, 20)),
                  JSON.stringify(parsed.skillsUsed),
                  JSON.stringify(parsed.outcomeSignals),
                )
                scanned++
                projectScanned++
              }
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  return scanned
}

// ─── Learning loop ───────────────────────────────────────────────────

export function runLearningLoop(): { scanned: number, extracted: number } {
  const db = getDb()
  const stmts = getStmts()

  const scanned = scanAllSessions()
  if (scanned > 0) log(`Scanned ${scanned} new operator sessions`)

  let extracted = 0

  const allSessions = db.prepare(`
    SELECT user_messages, skills_used, repo, outcome_signals FROM operator_sessions
    WHERE message_count > 1
    ORDER BY timestamp DESC LIMIT 100
  `).all() as Array<{ user_messages: string, skills_used: string, repo: string, outcome_signals: string }>

  for (const s of allSessions) {
    try {
      const messages = JSON.parse(s.user_messages) as string[]
      const skills = JSON.parse(s.skills_used) as string[]

      for (const msg of messages) {
        if (msg.length < 30 || msg.length > 1000) continue
        if (msg.startsWith('/') && msg.length < 80) continue
        if (msg.startsWith('Base directory for this skill:')) continue
        if (msg.includes('## Phase') && msg.includes('## ')) continue
        if (msg.startsWith('{') || msg.startsWith('[')) continue
        if ((msg.match(/\n/g) ?? []).length > 15) continue
        if (msg.startsWith('<task-notification>')) continue
        if (msg.startsWith('<local-command-caveat>')) continue
        if (msg.startsWith('<command-name>')) continue
        if (msg.startsWith('<system-reminder>')) continue
        if (msg.includes('DO NOT respond to these messages')) continue

        const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'exemplar'`).get(msg.slice(0, 200))
        if (exists) continue

        stmts.insertLearning.run('exemplar', msg.slice(0, 500), `session:${s.repo}`, s.repo, 1.0)
        extracted++
      }

      for (const skill of skills) {
        const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND project = ? AND type = 'skill_pattern'`).get(skill, s.repo)
        if (exists) continue
        stmts.insertLearning.run('skill_pattern', skill, `session:${s.repo}`, s.repo, 1.0)
        extracted++
      }
    } catch {}
  }

  // Learn from dispatch outcomes
  const recentDecisions = db.prepare(`
    SELECT d.id, d.skill, d.task, d.status, d.outcome, d.learnings, s.prompt
    FROM decisions d
    LEFT JOIN sessions s ON s.decision_id = d.id
    WHERE d.status IN ('success', 'failure') AND d.updated_at > datetime('now', '-7 days')
    ORDER BY d.updated_at DESC LIMIT 30
  `).all() as Array<{
    id: number, skill: string, task: string, status: string,
    outcome: string | null, learnings: string | null, prompt: string | null
  }>

  for (const d of recentDecisions) {
    if (d.status === 'success' && d.learnings) {
      try {
        const learnings = JSON.parse(d.learnings) as string[]
        for (const l of learnings) {
          const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'dispatch_success'`).get(l.slice(0, 200))
          if (exists) continue
          stmts.insertLearning.run('dispatch_success', l.slice(0, 500), `decision:${d.id}`, null, 1.5)
          extracted++
        }
      } catch {}
    }

    if (d.status === 'failure' && d.outcome) {
      const key = `FAIL: ${d.skill} "${d.task.slice(0, 80)}" → ${d.outcome.slice(0, 100)}`
      const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'dead_end'`).get(key.slice(0, 200))
      if (!exists) {
        stmts.insertLearning.run('dead_end', key.slice(0, 500), `decision:${d.id}`, null, -1.0)
        extracted++
      }
    }
  }

  // Update taste model
  const skillFreq = db.prepare(`
    SELECT skills_used FROM operator_sessions
    WHERE skills_used != '[]'
    ORDER BY timestamp DESC LIMIT 100
  `).all() as Array<{ skills_used: string }>

  const skillCounts = new Map<string, number>()
  for (const s of skillFreq) {
    try {
      for (const skill of JSON.parse(s.skills_used) as string[]) {
        skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1)
      }
    } catch {}
  }

  if (skillCounts.size > 0) {
    const sorted = [...skillCounts.entries()].sort((a, b) => b[1] - a[1])
    const pattern = `Operator skill preferences: ${sorted.map(([s, c]) => `${s}(${c})`).join(', ')}`
    db.prepare(`DELETE FROM taste WHERE pattern LIKE 'Operator skill preferences:%'`).run()
    stmts.insertTaste.run(pattern, 'learning_loop', 1.0)
  }

  // Score templates
  const templates = stmts.listTemplates.all(10) as Array<{ id: number, version: number }>
  for (const t of templates) {
    const total = db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE status != 'dispatched'`).get() as { c: number }
    const success = db.prepare(`SELECT COUNT(*) as c FROM decisions WHERE status = 'success'`).get() as { c: number }
    const score = total.c > 0 ? success.c / total.c : 0
    stmts.updateTemplateScore.run(score, total.c, success.c, t.id)
  }

  if (extracted > 0) log(`Extracted ${extracted} learnings from sessions`)
  return { scanned, extracted }
}

// ─── Deep session analysis (LLM-powered) ─────────────────────────────

export async function runDeepAnalysis(): Promise<{ analyzed: number, flows: number }> {
  const db = getDb()
  const stmts = getStmts()

  const sessions = db.prepare(`
    SELECT id, harness, repo, user_messages, skills_used, outcome_signals, message_count
    FROM operator_sessions
    WHERE message_count >= 3
    AND id NOT IN (SELECT source FROM learnings WHERE type = 'deep_analysis' AND source IS NOT NULL)
    ORDER BY timestamp DESC LIMIT 30
  `).all() as Array<{
    id: string, harness: string, repo: string, user_messages: string,
    skills_used: string, outcome_signals: string, message_count: number
  }>

  if (sessions.length < 3) return { analyzed: 0, flows: 0 }

  const sessionDigest: string[] = []
  for (const s of sessions) {
    try {
      const messages = JSON.parse(s.user_messages) as string[]
      const skills = JSON.parse(s.skills_used) as string[]
      const outcomes = JSON.parse(s.outcome_signals) as string[]
      const repoName = (s.repo || 'unknown').split('/').pop()

      sessionDigest.push([
        `### Session: ${repoName} (${s.harness}, ${s.message_count} messages)`,
        `Skills: ${skills.length > 0 ? skills.join(', ') : 'none'}`,
        `Outcomes: ${outcomes.length > 0 ? outcomes.join(', ') : 'unknown'}`,
        `Operator messages:`,
        ...messages.slice(0, 8).map(m => `> ${m.slice(0, 300).replace(/\n/g, ' ')}`),
      ].join('\n'))
    } catch {}
  }

  if (sessionDigest.length === 0) return { analyzed: 0, flows: 0 }

  const analysisPrompt = `You are analyzing an operator's coding sessions to extract patterns that an autonomous agent (Foreman) can learn from.

Below are ${sessionDigest.length} recent sessions. For each, you see the tools/project, what skills were used, and what the operator actually typed.

Your job: identify FLOWS — recurring patterns of work the operator does that Foreman could automate or assist with.

A flow is: a trigger condition + a sequence of actions + a success criteria.

Examples of flows:
- "When CI fails on a PR, the operator runs /converge to fix it, then re-checks"
- "When starting work on a new project, the operator always reads README, runs tests, then identifies the most broken part"
- "The operator runs /evolve on voice quality metrics, then /verify, then opens a PR"
- "When debugging, the operator checks logs, reproduces the issue, fixes it, writes a test"

Also extract:
- **Taste signals**: what the operator values (speed vs quality, exploration vs exploitation, etc.)
- **Project relationships**: which projects relate to each other, what gets worked on together
- **Anti-patterns**: things the operator avoids or corrects
- **Skill preferences**: which skills get used for what kind of work

Respond with JSON:
{
  "flows": [
    {"trigger": "...", "actions": ["..."], "success": "...", "frequency": "high|medium|low", "projects": ["..."]}
  ],
  "taste": ["..."],
  "project_relationships": [{"a": "...", "b": "...", "relationship": "..."}],
  "anti_patterns": ["..."],
  "skill_preferences": [{"skill": "...", "when": "...", "effectiveness": "high|medium|low"}]
}

## Sessions

${sessionDigest.join('\n\n')}
`

  const analysisJSON = await callClaudeForJSON(analysisPrompt)
  if (!analysisJSON) {
    log('Deep analysis: no response from Claude')
    return { analyzed: 0, flows: 0 }
  }
  const analysisResult = JSON.stringify(analysisJSON)

  let analysis: {
    flows?: Array<{ trigger: string, actions: string[], success: string, frequency: string, projects?: string[] }>
    taste?: string[]
    project_relationships?: Array<{ a: string, b: string, relationship: string }>
    anti_patterns?: string[]
    skill_preferences?: Array<{ skill: string, when: string, effectiveness: string }>
  }

  try {
    const jsonMatch = analysisResult.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      log('Deep analysis: no JSON in response')
      return { analyzed: sessions.length, flows: 0 }
    }
    analysis = JSON.parse(jsonMatch[0])
  } catch {
    log('Deep analysis: failed to parse JSON response')
    return { analyzed: sessions.length, flows: 0 }
  }

  let flows = 0

  if (analysis.flows) {
    for (const flow of analysis.flows) {
      const content = `FLOW: When ${flow.trigger} → ${flow.actions.join(' → ')} → ${flow.success} (${flow.frequency})`
      const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'flow'`).get(content.slice(0, 200))
      if (!exists) {
        const project = flow.projects?.[0] ?? null
        stmts.insertLearning.run('flow', content.slice(0, 500), 'deep_analysis', project, flow.frequency === 'high' ? 2.0 : flow.frequency === 'medium' ? 1.0 : 0.5)
        flows++
      }
    }
  }

  if (analysis.taste) {
    for (const t of analysis.taste) {
      const exists = db.prepare(`SELECT id FROM taste WHERE pattern = ?`).get(t.slice(0, 200))
      if (!exists) stmts.insertTaste.run(t.slice(0, 500), 'deep_analysis', 1.0)
    }
  }

  if (analysis.anti_patterns) {
    for (const ap of analysis.anti_patterns) {
      const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'anti_pattern'`).get(ap.slice(0, 200))
      if (!exists) stmts.insertLearning.run('anti_pattern', ap.slice(0, 500), 'deep_analysis', null, -1.5)
    }
  }

  if (analysis.skill_preferences) {
    for (const sp of analysis.skill_preferences) {
      const content = `${sp.skill}: ${sp.when} (${sp.effectiveness})`
      const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'skill_preference'`).get(content.slice(0, 200))
      if (!exists) stmts.insertLearning.run('skill_preference', content.slice(0, 500), 'deep_analysis', null, sp.effectiveness === 'high' ? 2.0 : 1.0)
    }
  }

  if (analysis.project_relationships) {
    for (const pr of analysis.project_relationships) {
      const content = `${pr.a} ↔ ${pr.b}: ${pr.relationship}`
      const exists = db.prepare(`SELECT id FROM learnings WHERE content = ? AND type = 'project_relationship'`).get(content.slice(0, 200))
      if (!exists) stmts.insertLearning.run('project_relationship', content.slice(0, 500), 'deep_analysis', null, 1.0)
    }
  }

  for (const s of sessions) {
    stmts.insertLearning.run('deep_analysis', `analyzed:${s.id}`, s.id, s.repo, 0)
  }

  log(`Deep analysis: ${sessions.length} sessions → ${flows} flows, ${analysis.taste?.length ?? 0} taste, ${analysis.anti_patterns?.length ?? 0} anti-patterns`)
  return { analyzed: sessions.length, flows }
}
