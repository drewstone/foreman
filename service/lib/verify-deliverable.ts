/**
 * Deliverable Verification — the Artisan pattern.
 *
 * Separates the "doer" from the "checker." The dispatch declares what it
 * should produce (DeliverableSpec). After harvest, an independent check
 * verifies the deliverable exists and meets criteria.
 *
 * This closes the 35pp gap between session success (91.5%) and actual
 * deliverable completion (~56%) found in Experiment 5.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export interface DeliverableSpec {
  path: string                // relative to workDir
  minLines?: number           // minimum content length
  mustContain?: string[]      // strings that must appear in content
  mustNotContain?: string[]   // strings that must NOT appear
  testCommand?: string        // shell command that must exit 0
}

export interface ScopeSpec {
  allowedPaths?: string[]     // glob patterns of files that MAY change
  forbiddenPaths?: string[]   // glob patterns that must NOT change
}

export interface VerificationResult {
  deliverableStatus: 'pass' | 'fail' | 'unchecked'
  scopeStatus: 'clean' | 'violation' | 'unchecked'
  details: string[]
  modifiedFiles: string[]
  outOfScopeFiles: string[]
}

export function verifyDeliverable(
  workDir: string,
  spec: DeliverableSpec | null,
  scope: ScopeSpec | null,
): VerificationResult {
  const details: string[] = []
  let deliverableStatus: VerificationResult['deliverableStatus'] = 'unchecked'
  let scopeStatus: VerificationResult['scopeStatus'] = 'unchecked'
  const modifiedFiles: string[] = []
  const outOfScopeFiles: string[] = []

  // ── Deliverable check ──────────────────────────────────────────────
  if (spec) {
    // Absolute paths (e.g. /tmp/foo.txt) are used as-is; relative paths resolve from workDir
    const fullPath = spec.path.startsWith('/') ? spec.path : join(workDir, spec.path)

    if (!existsSync(fullPath)) {
      deliverableStatus = 'fail'
      details.push(`deliverable not found: ${spec.path}`)
    } else {
      const content = readFileSync(fullPath, 'utf8')
      const lines = content.split('\n').length
      let passed = true

      if (spec.minLines && lines < spec.minLines) {
        details.push(`deliverable too short: ${lines} lines < ${spec.minLines} required`)
        passed = false
      }

      if (spec.mustContain) {
        for (const s of spec.mustContain) {
          if (!content.includes(s)) {
            details.push(`deliverable missing required content: "${s.slice(0, 50)}"`)
            passed = false
          }
        }
      }

      if (spec.mustNotContain) {
        for (const s of spec.mustNotContain) {
          if (content.includes(s)) {
            details.push(`deliverable contains forbidden content: "${s.slice(0, 50)}"`)
            passed = false
          }
        }
      }

      if (spec.testCommand) {
        try {
          execFileSync('bash', ['-c', spec.testCommand], {
            cwd: workDir,
            timeout: 60_000,
            stdio: 'pipe',
          })
          details.push(`test command passed: ${spec.testCommand.slice(0, 60)}`)
        } catch {
          details.push(`test command failed: ${spec.testCommand.slice(0, 60)}`)
          passed = false
        }
      }

      deliverableStatus = passed ? 'pass' : 'fail'
      if (passed) details.push(`deliverable verified: ${spec.path} (${lines} lines)`)
    }
  }

  // ── Scope check ────────────────────────────────────────────────────
  try {
    const diffOutput = execFileSync('git', ['diff', '--name-only', 'HEAD~1..HEAD'], {
      cwd: workDir,
      timeout: 5_000,
      encoding: 'utf8',
    }).trim()
    if (diffOutput) {
      modifiedFiles.push(...diffOutput.split('\n').filter(Boolean))
    }
  } catch {
    // No commits or not a git repo — skip scope check
  }

  if (scope && modifiedFiles.length > 0) {
    scopeStatus = 'clean'

    if (scope.allowedPaths?.length) {
      for (const file of modifiedFiles) {
        const allowed = scope.allowedPaths.some(pattern => {
          if (pattern.includes('*')) {
            const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
            return regex.test(file)
          }
          return file.startsWith(pattern)
        })
        if (!allowed) {
          outOfScopeFiles.push(file)
          scopeStatus = 'violation'
        }
      }
    }

    if (scope.forbiddenPaths?.length) {
      for (const file of modifiedFiles) {
        const forbidden = scope.forbiddenPaths.some(pattern => {
          if (pattern.includes('*')) {
            const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
            return regex.test(file)
          }
          return file.startsWith(pattern)
        })
        if (forbidden) {
          outOfScopeFiles.push(file)
          scopeStatus = 'violation'
        }
      }
    }

    if (outOfScopeFiles.length > 0) {
      details.push(`scope violation: ${outOfScopeFiles.length} files modified outside allowlist: ${outOfScopeFiles.slice(0, 3).join(', ')}`)
    } else if (scopeStatus === 'clean') {
      details.push(`scope clean: ${modifiedFiles.length} files, all within allowlist`)
    }
  }

  return { deliverableStatus, scopeStatus, details, modifiedFiles, outOfScopeFiles }
}

/**
 * Run type checker as acceptance gate for self-improvement dispatches.
 */
export function runTestGate(workDir: string): { passed: boolean, output: string } {
  // Try TypeScript first, then generic npm test
  const commands = [
    ['npx', ['tsc', '--noEmit']],
    ['npm', ['test', '--if-present']],
  ] as const

  for (const [cmd, args] of commands) {
    try {
      const result = execFileSync(cmd, [...args], {
        cwd: workDir,
        timeout: 60_000,
        encoding: 'utf8',
        stdio: 'pipe',
      })
      return { passed: true, output: result.slice(-500) }
    } catch (e: any) {
      return { passed: false, output: (e.stderr || e.stdout || String(e)).slice(-500) }
    }
  }
  return { passed: true, output: 'no test commands found' }
}
