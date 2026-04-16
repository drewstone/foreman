#!/usr/bin/env tsx
/**
 * Meta-Harness CLI — run code evolution from the command line.
 *
 * Usage:
 *   tsx service/lib/meta-harness-cli.ts \
 *     --repo ~/webb/tax-agent \
 *     --harness lib/agent-scaffold.ts \
 *     --eval "pnpm test:eval" \
 *     --iterations 10 \
 *     --parallel 2 \
 *     --dimensions accuracy,efficiency,speed
 */

import { resolve, join } from 'node:path'
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { runMetaHarness, type MetaHarnessConfig } from './meta-harness.js'
import type { TraceInjectionSource } from './trace-injector.js'

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('--') && i + 1 < argv.length) {
      args[arg.slice(2)] = argv[++i]!
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)
  const repo = resolve(args.repo ?? '.')
  const harness = args.harness ?? 'lib/agent-scaffold.ts'
  const evalCmd = args.eval ?? 'pnpm test:eval'
  const iterations = parseInt(args.iterations ?? '10', 10)
  const parallel = parseInt(args.parallel ?? '2', 10)
  const dimensions = (args.dimensions ?? 'accuracy,efficiency').split(',')
  const model = args.model ?? 'opus'
  const validateCmd = args.validate ?? 'npx tsc --noEmit'

  const harnessPath = resolve(repo, harness)
  if (!existsSync(harnessPath)) {
    console.error(`harness not found: ${harnessPath}`)
    process.exit(1)
  }

  const metaDir = join(repo, '.meta-harness')
  const skillPath = resolve(__dirname, '../../.claude/skills/meta-harness/SKILL.md')

  if (!existsSync(skillPath)) {
    console.error(`SKILL.md not found: ${skillPath}`)
    process.exit(1)
  }

  console.log(`meta-harness: evolving ${harnessPath}`)
  console.log(`  repo: ${repo}`)
  console.log(`  eval: ${evalCmd}`)
  console.log(`  iterations: ${iterations}, parallel: ${parallel}`)
  console.log(`  dimensions: ${dimensions.join(', ')}`)
  console.log(`  model: ${model}`)
  console.log('')

  const config: MetaHarnessConfig = {
    surface: {
      name: `code-${harness.replace(/[/\\]/g, '-')}`,
      description: `Code evolution of ${harness}`,
      harnessPath,
      variantsDir: join(metaDir, 'variants'),
      tracesDir: join(metaDir, 'traces'),
      frontierPath: join(metaDir, 'frontier.json'),
      evolutionPath: join(metaDir, 'evolution.jsonl'),
      validateCommand: validateCmd,
      benchmarkCommand: evalCmd,
      dimensions,
      cwd: repo,
    },
    repoPath: repo,
    skillPath,
    parallelism: parallel,
    maxIterations: iterations,
    proposerModel: model,
    runBenchmark: async (variantPath, cwd) => {
      // Copy variant into place, run eval, collect results
      const originalCode = readFileSync(harnessPath, 'utf8')
      try {
        // Swap in the variant
        if (variantPath !== harnessPath) {
          const variantCode = readFileSync(variantPath, 'utf8')
          const { writeFileSync } = await import('node:fs')
          writeFileSync(harnessPath, variantCode)
        }

        // Run eval command
        const output = execSync(evalCmd, {
          cwd,
          timeout: 600_000,
          encoding: 'utf8',
          env: { ...process.env, META_HARNESS: '1' },
        })

        // Try to parse scores from eval output
        // Convention: eval outputs JSON with {scores: {...}, passed: bool}
        // or lines like SCORE:accuracy=0.85
        const scores: Record<string, number> = {}
        let passed = true

        // Try JSON parse of last line
        const lines = output.trim().split('\n')
        for (const line of lines.reverse()) {
          try {
            const parsed = JSON.parse(line)
            if (parsed.scores) {
              Object.assign(scores, parsed.scores)
              passed = parsed.passed !== false
              break
            }
          } catch {}
          // Try SCORE: pattern
          const match = line.match(/^SCORE:(\w+)=([\d.]+)/)
          if (match) {
            scores[match[1]!] = parseFloat(match[2]!)
          }
        }

        if (Object.keys(scores).length === 0) {
          // Default: treat exit 0 as passed with score 1
          scores.accuracy = 1
        }

        const variant = variantPath.split('/').pop()?.replace(/\.\w+$/, '') ?? 'unknown'
        const traces: TraceInjectionSource[] = [{
          variant,
          scenario: 'full-suite',
          output,
          scores,
          passed,
        }]

        return { scores, traces, passed }
      } catch (e: any) {
        const variant = variantPath.split('/').pop()?.replace(/\.\w+$/, '') ?? 'unknown'
        return {
          scores: Object.fromEntries(dimensions.map(d => [d, 0])),
          traces: [{
            variant,
            scenario: 'full-suite',
            output: e.stdout ?? e.message ?? String(e),
            scores: Object.fromEntries(dimensions.map(d => [d, 0])),
            passed: false,
            error: e.message ?? String(e),
          }],
          passed: false,
        }
      } finally {
        // Restore original harness
        const { writeFileSync } = await import('node:fs')
        writeFileSync(harnessPath, originalCode)
      }
    },
  }

  const result = await runMetaHarness(config)

  console.log('\n=== Meta-Harness Complete ===')
  console.log(`Iterations: ${result.iterations}`)
  console.log(`Proposed: ${result.totalProposed}`)
  console.log(`Validated: ${result.totalValidated}`)
  console.log(`On frontier: ${result.totalFrontier}`)
  console.log(`Frontier entries: ${result.frontier.entries.length}`)
  for (const entry of result.frontier.entries) {
    console.log(`  ${entry.id}: ${JSON.stringify(entry.scores)} — "${entry.hypothesis}"`)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
