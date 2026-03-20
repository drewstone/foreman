/**
 * CLI for running parallel worktree experiments.
 *
 * Usage:
 *   npx tsx packages/surfaces/src/worktree-experiment-cli.ts \
 *     --repo /path/to/repo \
 *     --goal "Implement feature X" \
 *     --variants 3
 *
 * Each variant gets a different system prompt angle on the same goal.
 * All run in parallel worktrees. Best result wins.
 */

import { resolve } from 'node:path'
import { runExperiments, type Experiment, type Scorer } from './worktree-experiment.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const VARIANT_ANGLES = [
  'Focus on minimal changes. Prefer the simplest approach that works.',
  'Focus on correctness and edge cases. Be thorough.',
  'Focus on performance and efficiency. Minimize allocations and syscalls.',
  'Focus on readability and maintainability. Future developers need to understand this.',
  'Focus on test coverage. Write tests first, then implement.',
]

async function scoreWithChecks(worktreePath: string): Promise<{ score: number; reasons: string[] }> {
  const reasons: string[] = []
  let score = 5

  // Check if there are any changes
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD~1'], { cwd: worktreePath, timeout: 10_000 })
    if (!stdout.trim()) {
      return { score: 0, reasons: ['no changes made'] }
    }
    const files = stdout.trim().split('\n').length - 1
    reasons.push(`${files} files changed`)
    if (files <= 5) score += 1
  } catch {
    return { score: 0, reasons: ['no commits'] }
  }

  // Run checks if available
  try {
    const { stdout: pkgStr } = await execFileAsync('cat', ['package.json'], { cwd: worktreePath, timeout: 5_000 })
    const pkg = JSON.parse(pkgStr)
    const scripts = pkg.scripts ?? {}

    if (scripts.check || scripts['check:types'] || scripts.build) {
      const cmd = scripts.check ? 'check' : scripts['check:types'] ? 'check:types' : 'build'
      try {
        await execFileAsync('npm', ['run', cmd], { cwd: worktreePath, timeout: 120_000 })
        score += 2
        reasons.push(`npm run ${cmd} passed`)
      } catch {
        score -= 2
        reasons.push(`npm run ${cmd} failed`)
      }
    }

    if (scripts.test) {
      try {
        await execFileAsync('npm', ['run', 'test'], { cwd: worktreePath, timeout: 120_000 })
        score += 2
        reasons.push('tests passed')
      } catch {
        score -= 2
        reasons.push('tests failed')
      }
    }
  } catch { /* no package.json */ }

  return { score: Math.max(0, Math.min(10, score)), reasons }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let repoPath = ''
  let goal = ''
  let variants = 3
  let maxParallel = 0

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--repo': repoPath = argv[++i] ?? ''; break
      case '--goal': goal = argv[++i] ?? ''; break
      case '--variants': variants = parseInt(argv[++i] ?? '3', 10); break
      case '--max-parallel': maxParallel = parseInt(argv[++i] ?? '0', 10); break
    }
  }

  if (!repoPath || !goal) {
    console.error('Usage: worktree-experiment-cli --repo PATH --goal "..." [--variants N] [--max-parallel N]')
    process.exit(1)
  }

  const absRepo = resolve(repoPath)
  const experiments: Experiment[] = []

  for (let i = 0; i < Math.min(variants, VARIANT_ANGLES.length); i++) {
    experiments.push({
      name: `v${i + 1}`,
      goal,
      systemPrompt: VARIANT_ANGLES[i],
    })
  }

  console.log(`Running ${experiments.length} experiments on ${absRepo}`)
  console.log(`Goal: ${goal}\n`)

  const result = await runExperiments({
    repoPath: absRepo,
    experiments,
    scorer: scoreWithChecks as Scorer,
    maxParallel: maxParallel || experiments.length,
    onProgress: (msg) => console.log(msg),
  })

  console.log('\n--- Results ---')
  for (const r of result.results) {
    const s = r.score ? `${r.score.score}/10` : 'N/A'
    console.log(`${r.experiment.name}: ${s} (exit ${r.exitCode}, ${(r.durationMs / 1000).toFixed(1)}s)`)
    if (r.score) console.log(`  ${r.score.reasons.join(', ')}`)
  }

  if (result.winner) {
    console.log(`\nWinner: ${result.winner.experiment.name} (${result.winner.score!.score}/10)`)
    console.log(`Promoted: ${result.promoted}`)
  } else {
    console.log('\nNo winner.')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
