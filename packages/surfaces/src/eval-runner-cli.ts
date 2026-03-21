#!/usr/bin/env node
/**
 * CLI entry point for the unified eval runner.
 *
 * Usage:
 *   npm run eval                          # all envs
 *   npm run eval -- --env terminal-tasks  # single env
 *   npm run eval -- --all --optimize      # all + nightly optimization
 *   npm run eval -- --dry-run             # preview
 *   npm run eval -- --list                # list available envs
 *   npm run eval -- --max-tasks 3         # limit per env
 */

import { runEvals, listEnvNames } from './eval-runner.js'

const args = process.argv.slice(2)

if (args.includes('--list')) {
  console.log('Available eval environments:')
  for (const name of listEnvNames()) {
    console.log(`  ${name}`)
  }
  process.exit(0)
}

const envIdx = args.indexOf('--env')
const envNames = envIdx !== -1 && args[envIdx + 1] ? [args[envIdx + 1]] : undefined

const maxIdx = args.indexOf('--max-tasks')
const maxTasks = maxIdx !== -1 && args[maxIdx + 1] ? parseInt(args[maxIdx + 1], 10) : undefined

const dryRun = args.includes('--dry-run')
const optimize = args.includes('--optimize')

const result = await runEvals({
  envNames,
  maxTasks,
  dryRun,
  optimize,
})

console.log(`\nDone. ${result.totalCompleted}/${result.totalTasks} tasks completed.`)
process.exit(result.totalCompleted === result.totalTasks && result.totalTasks > 0 ? 0 : 1)
