/**
 * CLI for Foreman learning loop.
 *
 * Usage:
 *   npx tsx packages/surfaces/src/learning-cli.ts             # dry-run (default)
 *   npx tsx packages/surfaces/src/learning-cli.ts --live       # actually write to memory
 *   npx tsx packages/surfaces/src/learning-cli.ts --hours 168  # look back 7 days
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { learn, type LearningAction, type LearningInput } from '@drew/foreman-memory/learning'
import { SessionIndex } from '@drew/foreman-memory/session-index'
import { extractDeepSessionInsights } from './session-insights.js'

async function learnFromSessions(options?: {
  dryRun?: boolean
  hoursBack?: number
  onAction?: (action: LearningAction) => void
}) {
  const hoursBack = options?.hoursBack ?? 48

  const index = new SessionIndex()
  const stats = index.stats()
  const repos = Object.keys(stats.byRepo).filter((r) => r.length > 2)

  const userMessages = index.recentUserMessages({ limit: 100, hoursBack })
    .filter((m) => m.content.length > 15 && !m.content.startsWith('<'))
    .map((m) => ({ repo: m.repo, text: m.content, timestamp: m.timestamp }))

  index.close()

  const repoPaths = repos
    .map((r) => join(homedir(), 'code', r))
    .filter((p) => { try { statSync(p); return true } catch { return false } })

  let insights
  try {
    insights = await extractDeepSessionInsights({ repoPaths, hoursBack, maxSessionsPerRepo: 5 })
  } catch { /* no insights */ }

  const repoCommands = new Map<string, string[]>()
  const repoFiles = new Map<string, string[]>()
  const crossRepoPatterns: LearningInput['crossRepoPatterns'] = []

  if (insights) {
    for (const repo of insights.repoActivity) {
      repoCommands.set(repo.repo, repo.commonCommands)
      repoFiles.set(repo.repo, repo.commonFiles)
    }
    for (const pattern of insights.recurringPatterns) {
      crossRepoPatterns.push({ pattern: pattern.pattern, repos: pattern.repos, frequency: pattern.frequency })
    }
  }

  return learn({
    repoCommands,
    repoFiles,
    userMessages,
    crossRepoPatterns,
    suggestedRules: insights?.suggestedClaudeMdRules ?? [],
  }, options)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let dryRun = true
  let hoursBack = 48

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--live': dryRun = false; break
      case '--hours': hoursBack = parseInt(argv[++i] ?? '48', 10); break
    }
  }

  console.log(`[learning] mode=${dryRun ? 'DRY RUN' : 'LIVE'}, hoursBack=${hoursBack}`)
  console.log()

  const result = await learnFromSessions({
    dryRun,
    hoursBack,
    onAction: (action) => {
      const prefix = dryRun ? '[dry-run]' : '[WRITE]'
      console.log(`${prefix} ${action.type} → ${action.target}: ${action.description}`)
    },
  })

  console.log()
  console.log(`Results:`)
  console.log(`  Recipes created: ${result.recipesCreated}`)
  console.log(`  Facts learned: ${result.factsLearned}`)
  console.log(`  Profile updates: ${result.profileUpdates}`)
  console.log(`  Total actions: ${result.actions.length}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
