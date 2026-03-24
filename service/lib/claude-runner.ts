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
}

export interface ClaudeRunResult {
  output: string
  durationMs: number
  success: boolean
}

/**
 * Run Claude Code with full tool access in a tmux session.
 * Waits for completion and returns the captured output.
 */
export async function callClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const {
    prompt,
    cwd = FOREMAN_HOME,
    model = 'claude-sonnet-4-6',
    timeoutMs = 120_000,
    label = 'runner',
  } = opts

  const sessionName = `foreman-run-${label}-${Date.now().toString(36)}`
  const outputFile = opts.outputFile ?? join(FOREMAN_HOME, 'runner-output', `${sessionName}.txt`)
  const promptFile = join(FOREMAN_HOME, 'runner-output', `${sessionName}-prompt.txt`)

  mkdirSync(join(FOREMAN_HOME, 'runner-output'), { recursive: true })

  // Write prompt to file — avoids ALL arg parsing issues
  writeFileSync(promptFile, prompt)

  // The prompt tells Claude to write its response to the output file
  const wrappedPrompt = `Read the instructions from ${promptFile} and execute them. When done, write your COMPLETE response to ${outputFile}. Use the Write tool to create that file with your full output.`

  const startMs = Date.now()

  try {
    // Spawn tmux session
    tmuxQuiet(['new-session', '-d', '-s', sessionName, '-c', cwd])

    // Start Claude with full tool access
    tmuxQuiet(['send-keys', '-t', sessionName, `${CLAUDE_BIN} --dangerously-skip-permissions --model ${model} -p "${wrappedPrompt.replace(/"/g, '\\"')}"`, 'Enter'])

    // Wait for completion — poll for output file or session exit
    const pollInterval = 3_000
    const maxPolls = Math.ceil(timeoutMs / pollInterval)

    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, pollInterval))

      // Check if output file was written
      if (existsSync(outputFile)) {
        const output = readFileSync(outputFile, 'utf8')
        if (output.length > 0) {
          // Claude wrote the output — we're done
          tmuxQuiet(['kill-session', '-t', sessionName])
          cleanup(promptFile, outputFile)
          return { output, durationMs: Date.now() - startMs, success: true }
        }
      }

      // Check if tmux session is still alive
      const alive = tmuxQuiet(['has-session', '-t', sessionName])
      if (!alive) {
        // Session ended — check if output was written
        if (existsSync(outputFile)) {
          const output = readFileSync(outputFile, 'utf8')
          cleanup(promptFile, outputFile)
          return { output, durationMs: Date.now() - startMs, success: output.length > 0 }
        }
        // Session died without output
        cleanup(promptFile)
        return { output: '', durationMs: Date.now() - startMs, success: false }
      }
    }

    // Timeout — kill session, capture whatever we got
    tmuxQuiet(['kill-session', '-t', sessionName])
    const output = existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : ''
    cleanup(promptFile, outputFile)
    return { output, durationMs: Date.now() - startMs, success: false }

  } catch (e) {
    tmuxQuiet(['kill-session', '-t', sessionName])
    cleanup(promptFile, outputFile)
    return { output: '', durationMs: Date.now() - startMs, success: false }
  }
}

function cleanup(...files: (string | undefined)[]) {
  for (const f of files) {
    if (f) try { unlinkSync(f) } catch {}
  }
}

/**
 * Quick Claude call for JSON generation — uses claude -p with pipe.
 * For prompts under 4K chars that just need a JSON response.
 * Falls back to callClaude() for longer prompts.
 */
export async function callClaudeForJSON<T = any>(prompt: string, model = 'claude-sonnet-4-6'): Promise<T | null> {
  if (prompt.length > 3500) {
    // Long prompt — use full tmux session
    const result = await callClaude({
      prompt: prompt + '\n\nRespond with JSON only. Write the JSON to the output file.',
      model,
      label: 'json',
      timeoutMs: 90_000,
    })
    try {
      const match = result.output.match(/[\[{][\s\S]*[}\]]/)
      return match ? JSON.parse(match[0]) : null
    } catch { return null }
  }

  // Short prompt — use bash pipe (fast, no tmux overhead)
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)

  const promptFile = join(FOREMAN_HOME, 'runner-output', `_json_${Date.now()}.txt`)
  mkdirSync(join(FOREMAN_HOME, 'runner-output'), { recursive: true })
  writeFileSync(promptFile, prompt)

  try {
    const { stdout } = await execFileAsync('bash', [
      '-c', `cat "${promptFile}" | "${CLAUDE_BIN}" -p --output-format text --model ${model}`,
    ], { timeout: 60_000, env: ENV })
    cleanup(promptFile)

    const match = stdout.match(/[\[{][\s\S]*[}\]]/)
    return match ? JSON.parse(match[0]) : null
  } catch {
    cleanup(promptFile)
    return null
  }
}
