#!/usr/bin/env node
/**
 * Foreman daemon CLI.
 *
 * Usage:
 *   npm run foreman:daemon                    # start in dry-run (safe default)
 *   npm run foreman:daemon -- --live          # start with actions enabled
 *   npm run foreman:daemon -- --poll 300000   # poll every 5 min
 *   npm run foreman:daemon -- --watch /path   # watch a git repo
 */

import { createDaemon } from './foreman-daemon.js'

const args = process.argv.slice(2)

const dryRun = !args.includes('--live')

const pollIdx = args.indexOf('--poll')
const pollIntervalMs = pollIdx !== -1 && args[pollIdx + 1]
  ? parseInt(args[pollIdx + 1], 10)
  : undefined

const watchGitDirs: string[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--watch' && args[i + 1]) {
    watchGitDirs.push(args[i + 1])
    i++
  }
}

const daemon = createDaemon({
  dryRun,
  pollIntervalMs,
  watchGitDirs,
})

console.log(`Foreman daemon — ${dryRun ? 'DRY-RUN (pass --live to enable actions)' : 'LIVE'}`)
daemon.start()
