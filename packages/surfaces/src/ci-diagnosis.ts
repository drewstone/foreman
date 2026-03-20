/**
 * CI failure diagnosis.
 *
 * Reads GitHub Actions CI logs for a failing branch, extracts the
 * error, and generates a repair recipe. This is what turns the
 * heartbeat from "SKIP (no known recipe)" to "here's the fix."
 *
 * Pipeline:
 *   1. gh run list --branch X --status failure
 *   2. gh run view <id> --log-failed
 *   3. Parse error from logs
 *   4. Generate repair recipe
 *   5. Write to per-repo strategy memory
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { FilesystemMemoryStore, recordRepairOutcome, type RepairRecipe, type StrategyMemory } from '@drew/foreman-memory'

const execFileAsync = promisify(execFile)

export interface CIDiagnosis {
  branch: string
  runId: string
  runName: string
  failedStep: string
  errorSummary: string
  fullLog: string
  suggestedRecipe: string
  repoType?: string
}

/**
 * Diagnose a CI failure from GitHub Actions logs.
 */
export async function diagnoseCIFailure(repoPath: string, branch: string): Promise<CIDiagnosis | null> {
  const repo = repoPath.split('/').pop() ?? ''

  // Step 1: Find the failing run
  let runId: string
  let runName: string
  try {
    const { stdout } = await execFileAsync('gh', [
      'run', 'list',
      '--branch', branch,
      '--status', 'failure',
      '--limit', '1',
      '--json', 'databaseId,name,headBranch',
    ], { cwd: repoPath, timeout: 15_000 })

    const runs = JSON.parse(stdout)
    if (!runs.length) return null
    runId = String(runs[0].databaseId)
    runName = runs[0].name ?? 'unknown'
  } catch {
    return null
  }

  // Step 2: Get failed logs
  let fullLog: string
  try {
    const { stdout } = await execFileAsync('gh', [
      'run', 'view', runId, '--log-failed',
    ], { cwd: repoPath, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 })
    fullLog = stdout
  } catch (e) {
    const err = e as { stdout?: string }
    fullLog = err.stdout ?? ''
    if (!fullLog) return null
  }

  // Step 3: Parse the error
  const { failedStep, errorSummary } = parseFailedLog(fullLog)

  // Step 4: Detect repo type for recipe context
  let repoType: string | undefined
  try {
    const { readFile } = await import('node:fs/promises')
    try { await readFile(join(repoPath, 'Cargo.toml'), 'utf8'); repoType = 'cargo' } catch {}
    if (!repoType) {
      try { await readFile(join(repoPath, 'package.json'), 'utf8'); repoType = 'npm' } catch {}
    }
  } catch {}

  // Step 5: Generate recipe
  const suggestedRecipe = generateRecipe(errorSummary, repoType)

  return {
    branch,
    runId,
    runName,
    failedStep,
    errorSummary,
    fullLog: fullLog.slice(-3000), // keep last 3K for context
    suggestedRecipe,
    repoType,
  }
}

/**
 * Parse a failed CI log to extract the step name and error summary.
 */
function parseFailedLog(log: string): { failedStep: string; errorSummary: string } {
  const lines = log.split('\n')
  let failedStep = 'unknown'
  const errors: string[] = []

  for (const line of lines) {
    // GitHub Actions step headers look like: "##[group]Run npm test"
    const stepMatch = line.match(/##\[group\](.+)/)
    if (stepMatch) {
      failedStep = stepMatch[1].trim()
    }

    // Common error patterns
    if (line.match(/^error(\[E\d+\])?:/i) || // Rust/cargo errors
        line.match(/^Error:/i) ||
        line.match(/error TS\d+:/i) || // TypeScript errors
        line.match(/FAIL /i) || // Jest/test failures
        line.match(/^E\s+/) || // Python pytest errors
        line.match(/panic/i) ||
        line.match(/FAILED/i) ||
        line.match(/npm ERR!/i) ||
        line.match(/exit code [1-9]/i)) {
      errors.push(line.trim().slice(0, 200))
    }
  }

  // Deduplicate and take top errors
  const uniqueErrors = [...new Set(errors)].slice(0, 5)
  const errorSummary = uniqueErrors.length > 0
    ? uniqueErrors.join('\n')
    : lines.slice(-10).join('\n').trim() // fallback: last 10 lines

  return { failedStep, errorSummary }
}

/**
 * Generate a repair recipe from the error summary.
 */
function generateRecipe(errorSummary: string, repoType?: string): string {
  const lower = errorSummary.toLowerCase()

  // TypeScript errors
  if (lower.includes('error ts')) {
    return 'TypeScript compilation error — run `npm run check:types` or `npx tsc --noEmit`, fix the type errors, then re-run'
  }

  // Rust errors
  if (lower.includes('error[e') || lower.includes('cargo') && lower.includes('error')) {
    return 'Cargo build/test error — run `cargo check && cargo test`, fix compilation errors, then re-run'
  }

  // Clippy
  if (lower.includes('clippy')) {
    return 'Clippy lint failure — run `cargo clippy -- -D warnings`, fix the warnings'
  }

  // Rust fmt
  if (lower.includes('cargo fmt') || lower.includes('rustfmt')) {
    return 'Rust formatting failure — run `cargo fmt --all`'
  }

  // ESLint
  if (lower.includes('eslint') || lower.includes('lint')) {
    return 'Lint failure — run `npm run lint -- --fix` or `npx eslint --fix .`'
  }

  // Test failures
  if (lower.includes('test') && (lower.includes('fail') || lower.includes('assert'))) {
    const testCmd = repoType === 'cargo' ? 'cargo test' : 'npm test'
    return `Test failure — run \`${testCmd}\` locally, read the failure output, fix the failing test or the code it tests`
  }

  // npm install / dependency issues
  if (lower.includes('npm err') || lower.includes('enoent') || lower.includes('module not found')) {
    return 'Dependency resolution error — run `npm install` or `npm ci`, check package.json for missing dependencies'
  }

  // Docker / build
  if (lower.includes('docker') || lower.includes('dockerfile')) {
    return 'Docker build failure — check Dockerfile syntax and base image availability'
  }

  // Generic fallback
  return `CI failure in ${repoType ?? 'unknown'} repo — read the CI logs with \`gh run view --log-failed\`, diagnose the root cause, fix it`
}

/**
 * Diagnose and persist a repair recipe for a CI failure.
 * Returns the diagnosis or null if CI logs aren't available.
 */
export async function diagnoseAndPersistRecipe(
  repoPath: string,
  branch: string,
): Promise<CIDiagnosis | null> {
  const diagnosis = await diagnoseCIFailure(repoPath, branch)
  if (!diagnosis) return null

  // Write recipe to per-repo strategy memory
  try {
    const memStore = new FilesystemMemoryStore(join(repoPath, '.foreman', 'memory'))
    const existing = await memStore.getStrategyMemory('engineering') ?? {
      taskShape: 'engineering',
      successfulPatterns: [],
      scoredRecipes: [],
    }

    // Add the recipe if it doesn't already exist
    const recipeKey = `ci-fix: ${diagnosis.errorSummary.slice(0, 80)}`
    const alreadyExists = existing.scoredRecipes?.some((r) =>
      r.pattern.toLowerCase().includes(diagnosis.errorSummary.slice(0, 40).toLowerCase()),
    )

    if (!alreadyExists) {
      existing.scoredRecipes = recordRepairOutcome(
        existing.scoredRecipes ?? [],
        recipeKey,
        false, // not yet proven — confidence starts low
      )
      // Override the initial confidence to 0.5 (speculative but informed)
      const newRecipe = existing.scoredRecipes.find((r) => r.pattern === recipeKey)
      if (newRecipe) {
        newRecipe.confidence = 0.5
        newRecipe.successCount = 0
        newRecipe.failCount = 0
      }

      await memStore.putStrategyMemory(existing)
    }
  } catch { /* non-fatal */ }

  return diagnosis
}
