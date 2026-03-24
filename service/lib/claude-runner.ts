/**
 * Claude Runner — unified way to run Claude Code with full tool access.
 *
 * Every LLM call in Foreman goes through this. It spawns a real Claude Code
 * session in tmux with --dangerously-skip-permissions, waits for completion,
 * and returns the output.
 *
 * This replaces all `execFileAsync(claude, ['-p', ...])` calls which:
 * - Have fragile arg parsing (long prompts break)
 * - Don't have tool access without --dangerously-skip-permissions
 * - Can't read/write files in the target directory
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
const CLAUDE_BIN = process.env.CLAUDE_PATH ?? join(homedir(), '.local/bin/claude')
const ENV = { ...process.env, PATH: `${homedir()}/.local/bin:${process.env.PATH}` }

function tmux(args: string[]): string {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000, env: ENV }) as string
  } catch { return '' }
}

function tmuxQuiet(args: string[]): boolean {
  try { execFileSync('tmux', args, { stdio: 'ignore', timeout: 5_000, env: ENV }); return true } catch { return false }
}

export interface ClaudeRunOptions {
  prompt: string
  cwd?: string                    // working directory (default: FOREMAN_HOME)
  model?: string                  // model (default: claude-sonnet-4-6)
  timeoutMs?: number              // max wait time (default: 120_000)
  outputFile?: string             // write output to this file path (Claude writes it)
  label?: string                  // label for the tmux session name
  noTools?: boolean               // if true, omit --dangerously-skip-permissions (text-only output)
}

export interface ClaudeRunResult {
  output: string
  durationMs: number
  success: boolean
}

/**
 * Run Claude Code with full tool access in a tmux session.
 * Captures output via pipe-pane (tmux log capture) — reliable,
 * doesn't depend on Claude following meta-instructions.
 */
export async function callClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const {
    prompt,
    cwd = FOREMAN_HOME,
    model: rawModel = 'claude-sonnet-4-6',
    timeoutMs = 120_000,
    label = 'runner',
  } = opts

  // Validate model name — prevent shell injection via model parameter
  const model = /^[a-zA-Z0-9._-]+$/.test(rawModel) ? rawModel : 'claude-sonnet-4-6'

  const sessionName = `foreman-run-${label}-${Date.now().toString(36)}`
  const logFile = join(FOREMAN_HOME, 'runner-output', `${sessionName}.log`)
  const promptFile = join(FOREMAN_HOME, 'runner-output', `${sessionName}-prompt.txt`)

  mkdirSync(join(FOREMAN_HOME, 'runner-output'), { recursive: true })

  // Write prompt to file — avoids ALL arg parsing issues
  writeFileSync(promptFile, prompt)

  const startMs = Date.now()

  try {
    // Spawn tmux session
    tmuxQuiet(['new-session', '-d', '-s', sessionName, '-c', cwd])

    // Capture ALL pane output to log file
    tmuxQuiet(['pipe-pane', '-t', sessionName, '-o', `cat >> "${logFile}"`])

    // Run claude -p with the prompt piped via bash
    // -p mode outputs text then exits — reliable for text output capture
    const permsFlag = opts.noTools ? '' : ' --dangerously-skip-permissions'
    tmuxQuiet(['send-keys', '-t', sessionName,
      `cat "${promptFile}" | ${CLAUDE_BIN}${permsFlag} --model ${model} -p && exit`,
      'Enter'])

    // Wait for session to exit
    const pollInterval = 3_000
    const maxPolls = Math.ceil(timeoutMs / pollInterval)

    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, pollInterval))
      const alive = tmuxQuiet(['has-session', '-t', sessionName])
      if (!alive) break
    }

    // Kill if still alive (timeout)
    tmuxQuiet(['kill-session', '-t', sessionName])

    // Read captured output from log
    await new Promise(r => setTimeout(r, 500)) // brief pause for file flush
    const rawLog = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''

    // Extract Claude's response from pipe-pane capture.
    // Format: [command echo] ESC[?2004l [Claude's output] ESC[?2004l [shell cleanup]
    // Claude's output is between the FIRST and SECOND [?2004l markers.
    const marker = '\x1b[?2004l'
    const first = rawLog.indexOf(marker)
    const second = rawLog.indexOf(marker, first + 1)

    let output: string
    if (first >= 0 && second > first) {
      output = rawLog.slice(first + marker.length, second)
    } else if (first >= 0) {
      output = rawLog.slice(first + marker.length)
    } else {
      output = rawLog
    }

    // Strip ANSI codes, OSC sequences, and terminal mode sequences
    output = output
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b\[[\?<]\d+[a-z]*/g, '')
      .replace(/\[<u/g, '')                       // mouse mode artifact
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/logout\s*$/i, '')
      .trim()

    // Keep log for debugging — cleanup prompt only
    cleanup(promptFile)
    return { output, durationMs: Date.now() - startMs, success: output.length > 0 }

  } catch (e) {
    tmuxQuiet(['kill-session', '-t', sessionName])
    cleanup(promptFile, logFile)
    return { output: '', durationMs: Date.now() - startMs, success: false }
  }
}

function cleanup(...files: (string | undefined)[]) {
  for (const f of files) {
    if (f) try { unlinkSync(f) } catch {}
  }
}

/**
 * Claude call for JSON generation — always uses tmux session for
 * reliable auth and output capture. Parses JSON from the response.
 */
export async function callClaudeForJSON<T = any>(prompt: string, model = 'claude-sonnet-4-6'): Promise<T | null> {
  const result = await callClaude({
    prompt: prompt + '\n\nRespond with JSON only.',
    model,
    label: 'json',
    timeoutMs: 90_000,
  })

  if (!result.output) return null

  try {
    const match = result.output.match(/[\[{][\s\S]*[}\]]/)
    return match ? JSON.parse(match[0]) : null
  } catch { return null }
}
