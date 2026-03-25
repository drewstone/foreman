/**
 * Claude Runner — runs Claude Code in pipe mode for programmatic LLM calls.
 *
 * Uses `claude -p` as a subprocess (not tmux). This works from systemd
 * services because Claude Code handles its own auth via OAuth keychain.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync, mkdirSync } from 'node:fs'

const execFileAsync = promisify(execFile)

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
const CLAUDE_BIN = process.env.CLAUDE_PATH ?? join(homedir(), '.local/bin/claude')

export interface ClaudeRunResult {
  output: string
  durationMs: number
  success: boolean
}

/**
 * Call Claude Code in pipe mode (-p). Reads prompt from stdin, outputs text.
 * Works as a subprocess — no tmux needed.
 */
export async function callClaude(opts: {
  prompt: string
  model?: string
  timeoutMs?: number
  cwd?: string
}): Promise<ClaudeRunResult> {
  const {
    prompt,
    model = 'claude-sonnet-4-6',
    timeoutMs = 120_000,
    cwd = FOREMAN_HOME,
  } = opts

  const startMs = Date.now()

  // Write prompt to temp file for large prompts
  const promptFile = join(FOREMAN_HOME, 'runner-output', `prompt-${Date.now().toString(36)}.txt`)
  mkdirSync(join(FOREMAN_HOME, 'runner-output'), { recursive: true })
  writeFileSync(promptFile, prompt)

  try {
    const { stdout, stderr } = await execFileAsync(
      'bash',
      ['-c', `cat "${promptFile}" | ${CLAUDE_BIN} --model ${model} -p 2>/dev/null`],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: {
          ...process.env,
          PATH: `${homedir()}/.local/bin:${process.env.PATH}`,
          HOME: homedir(),
        },
      },
    )

    const output = stdout.trim()
    return { output, durationMs: Date.now() - startMs, success: output.length > 0 }
  } catch (e: any) {
    // execFile throws on non-zero exit or timeout
    const output = e.stdout?.trim() ?? ''
    return { output, durationMs: Date.now() - startMs, success: false }
  } finally {
    try { require('node:fs').unlinkSync(promptFile) } catch {}
  }
}

/**
 * Call Claude and parse JSON from the response.
 */
export async function callClaudeForJSON<T = any>(prompt: string, model = 'claude-sonnet-4-6'): Promise<T | null> {
  const result = await callClaude({
    prompt: prompt + '\n\nRespond with JSON only.',
    model,
    timeoutMs: 90_000,
  })

  if (!result.output) return null

  try {
    const match = result.output.match(/[\[{][\s\S]*[}\]]/)
    return match ? JSON.parse(match[0]) : null
  } catch { return null }
}
