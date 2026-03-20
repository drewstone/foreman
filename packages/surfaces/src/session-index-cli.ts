/**
 * CLI for session search index.
 *
 * Usage:
 *   npx tsx packages/surfaces/src/session-index-cli.ts index          # build/update index
 *   npx tsx packages/surfaces/src/session-index-cli.ts search "query" # search sessions
 *   npx tsx packages/surfaces/src/session-index-cli.ts stats          # show index stats
 *   npx tsx packages/surfaces/src/session-index-cli.ts recent         # recent user messages
 */

import { SessionIndex, indexAllSessions } from '@drew/foreman-memory/session-index'

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2)

  switch (cmd) {
    case 'index': {
      const { stats } = await indexAllSessions({
        maxAge: 30 * 24 * 3600 * 1000,
        onProgress: (msg) => console.log(msg),
      })
      console.log('\nIndex stats:')
      console.log(`  Messages: ${stats.totalMessages}`)
      console.log(`  Sessions: ${stats.totalSessions}`)
      console.log(`  By harness:`, stats.byHarness)
      console.log(`  By repo:`, stats.byRepo)
      break
    }

    case 'search': {
      const query = args.join(' ')
      if (!query) { console.error('Usage: session-index search "query"'); process.exit(1) }

      const index = new SessionIndex()
      let repo: string | undefined
      let role: 'user' | 'assistant' | 'tool' | undefined
      let hoursBack: number | undefined

      // Parse flags
      const queryParts: string[] = []
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--repo') { repo = args[++i]; continue }
        if (args[i] === '--role') { role = args[++i] as typeof role; continue }
        if (args[i] === '--hours') { hoursBack = parseInt(args[++i], 10); continue }
        queryParts.push(args[i])
      }

      const results = index.search({
        query: queryParts.join(' '),
        repo,
        role,
        hoursBack,
        limit: 15,
      })

      if (results.length === 0) {
        console.log('No results.')
      } else {
        for (const r of results) {
          const m = r.message
          console.log(`[${m.harness}] ${m.repo || m.project} | ${m.role} | ${m.timestamp.slice(0, 16)}`)
          console.log(`  ${r.snippet.replace(/\n/g, '\n  ')}`)
          console.log()
        }
      }
      index.close()
      break
    }

    case 'stats': {
      const index = new SessionIndex()
      const s = index.stats()
      console.log(`Messages: ${s.totalMessages}`)
      console.log(`Sessions: ${s.totalSessions}`)
      console.log(`Oldest: ${s.oldestTimestamp}`)
      console.log(`Newest: ${s.newestTimestamp}`)
      console.log('By harness:', s.byHarness)
      console.log('By repo:', s.byRepo)
      index.close()
      break
    }

    case 'recent': {
      const index = new SessionIndex()
      const repo = args[0]
      const messages = index.recentUserMessages({ repo, limit: 20, hoursBack: 168 })
      for (const m of messages) {
        console.log(`[${m.harness}] ${m.repo || m.project} | ${m.timestamp.slice(0, 16)}`)
        console.log(`  ${m.content.slice(0, 200).replace(/\n/g, '\n  ')}`)
        console.log()
      }
      index.close()
      break
    }

    default:
      console.error('Usage: session-index [index|search|stats|recent] [args]')
      process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
