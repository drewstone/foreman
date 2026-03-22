#!/usr/bin/env node
/**
 * Foreman daemon CLI.
 *
 * Usage:
 *   npm run foreman:daemon -- --dir /path/to/project          # work on ONE project (dry-run)
 *   npm run foreman:daemon -- --dir /path --live               # work on ONE project (live)
 *   npm run foreman:daemon -- --dir /a --dir /b --dir /c --live  # work on specific projects
 *   npm run foreman:daemon                                     # watch all known projects (dry-run)
 */

import { createDaemon } from './foreman-daemon.js'

const args = process.argv.slice(2)

const dryRun = !args.includes('--live')

const pollIdx = args.indexOf('--poll')
const pollIntervalMs = pollIdx !== -1 && args[pollIdx + 1]
  ? parseInt(args[pollIdx + 1], 10)
  : undefined

// --dir replaces --watch — specifies exactly which projects to work on
const dirs: string[] = []
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--dir' || args[i] === '--watch') && args[i + 1]) {
    dirs.push(args[i + 1])
    i++
  }
}

const daemon = createDaemon({
  dryRun,
  pollIntervalMs,
  watchGitDirs: dirs,
  onlyWatchedDirs: dirs.length > 0, // if dirs specified, ONLY show those to the policy
})

const mode = dryRun ? 'DRY-RUN' : 'LIVE'
if (dirs.length > 0) {
  console.log(`Foreman daemon — ${mode} — ${dirs.length} project(s):`)
  for (const d of dirs) console.log(`  ${d}`)
} else {
  console.log(`Foreman daemon — ${mode} — all known projects`)
}
daemon.start()
