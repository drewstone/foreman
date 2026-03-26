/**
 * Claude Runner — runs Claude Code in pipe mode for programmatic LLM calls.
 *
 * Uses `claude -p --output-format json` for metadata (cost, session_id),
 * then reads the actual response from the session JSONL transcript.
 * Workaround: result field in JSON output is empty (CC bug), but
 * the session transcript always has the real content.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const execFileAsync = promisify(execFile)

const CLAUDE_BIN = process.env.CLAUDE_PATH ?? join(homedir(), '.local/bin/claude')

export interface ClaudeRunResult {
  output: string
  durationMs: number
  costUsd: number
  success: boolean
  sessionId: string | null
}

/**
 * Call Claude Code in pipe mode. Returns structured result.
 * Reads actual response text from session JSONL (result field is buggy).
 */
export async function callClaude(opts: {
  prompt: string
  model?: string
  timeoutMs?: number
  cwd?: string
}): Promise<ClaudeRunResult> {
  const {
    prompt,
    model = 'sonnet',
    timeoutMs = 120_000,
    cwd,
  } = opts

  const startMs = Date.now()

  try {
    const { stdout } = await execFileAsync(CLAUDE_BIN, [
      '-p', '--output-format', 'json', '--model', model, prompt,
    ], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${homedir()}/.local/bin:${process.env.PATH}`,
        HOME: homedir(),
      },
    })

    const parsed = JSON.parse(stdout)
    const sessionId = parsed.session_id ?? null

    // Read actual response from session JSONL (result field is buggy/empty)
    let output = parsed.result ?? ''
    if (!output && sessionId) {
      output = readResponseFromTranscript(sessionId) ?? ''
    }

    return {
      output,
      durationMs: parsed.duration_ms ?? (Date.now() - startMs),
      costUsd: parsed.total_cost_usd ?? 0,
      success: !parsed.is_error && output.length > 0,
      sessionId,
    }
  } catch (e: any) {
    try {
      if (e.stdout) {
        const parsed = JSON.parse(e.stdout)
        return {
          output: parsed.result ?? '',
          durationMs: Date.now() - startMs,
          costUsd: parsed.total_cost_usd ?? 0,
          success: false,
          sessionId: parsed.session_id ?? null,
        }
      }
    } catch {}
    return { output: '', durationMs: Date.now() - startMs, costUsd: 0, success: false, sessionId: null }
  }
}

/**
 * Read the last assistant text response from a Claude Code session JSONL.
 */
function readResponseFromTranscript(sessionId: string): string | null {
  const projectsDir = join(homedir(), '.claude', 'projects')
  if (!existsSync(projectsDir)) return null

  try {
    for (const dir of readdirSync(projectsDir)) {
      const jsonlPath = join(projectsDir, dir, `${sessionId}.jsonl`)
      if (!existsSync(jsonlPath)) continue

      const content = readFileSync(jsonlPath, 'utf8')
      const lines = content.trim().split('\n')

      // Read backwards for the last assistant message with text
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i])
          if (obj.type === 'assistant') {
            const blocks = obj.message?.content
            if (Array.isArray(blocks)) {
              const texts = blocks
                .filter((b: any) => b.type === 'text' && b.text)
                .map((b: any) => b.text)
              if (texts.length > 0) return texts.join('\n')
            }
          }
        } catch {}
      }
    }
  } catch {}
  return null
}

/**
 * Call Claude and parse JSON from the response.
 */
export async function callClaudeForJSON<T = any>(prompt: string, model = 'sonnet'): Promise<T | null> {
  const result = await callClaude({
    prompt: prompt + '\n\nRespond with JSON only. No markdown fences, no explanation.',
    model,
    timeoutMs: 90_000,
  })

  if (!result.output) return null

  try {
    const match = result.output.match(/[\[{][\s\S]*[}\]]/)
    return match ? JSON.parse(match[0]) : null
  } catch { return null }
}
