/**
 * Claude Runner — runs Claude Code in pipe mode for programmatic LLM calls.
 *
 * Uses `claude -p --output-format json` as a subprocess.
 * Returns structured JSON with result text, cost, token usage.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'

const execFileAsync = promisify(execFile)

const CLAUDE_BIN = process.env.CLAUDE_PATH ?? join(homedir(), '.local/bin/claude')

export interface ClaudeRunResult {
  output: string
  durationMs: number
  costUsd: number
  success: boolean
}

/**
 * Call Claude Code in pipe mode. Returns structured result.
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
    const args = ['-p', '--output-format', 'json', '--model', model, prompt]
    const { stdout } = await execFileAsync(CLAUDE_BIN, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${homedir()}/.local/bin:${process.env.PATH}`,
        HOME: homedir(),
      },
      // Don't pipe stdin — claude -p reads from args
    })

    const parsed = JSON.parse(stdout)
    return {
      output: parsed.result ?? '',
      durationMs: parsed.duration_ms ?? (Date.now() - startMs),
      costUsd: parsed.total_cost_usd ?? 0,
      success: !parsed.is_error && (parsed.result?.length ?? 0) > 0,
    }
  } catch (e: any) {
    // Try to parse partial JSON from stdout
    try {
      if (e.stdout) {
        const parsed = JSON.parse(e.stdout)
        return {
          output: parsed.result ?? '',
          durationMs: Date.now() - startMs,
          costUsd: parsed.total_cost_usd ?? 0,
          success: false,
        }
      }
    } catch {}
    return { output: '', durationMs: Date.now() - startMs, costUsd: 0, success: false }
  }
}

/**
 * Call Claude and parse JSON from the response.
 */
export async function callClaudeForJSON<T = any>(prompt: string, model = 'sonnet'): Promise<T | null> {
  const result = await callClaude({
    prompt: prompt + '\n\nRespond with JSON only. No markdown, no explanation.',
    model,
    timeoutMs: 90_000,
  })

  if (!result.output) return null

  try {
    const match = result.output.match(/[\[{][\s\S]*[}\]]/)
    return match ? JSON.parse(match[0]) : null
  } catch { return null }
}
