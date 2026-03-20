/**
 * CLI for daily report generation.
 *
 * Usage:
 *   npx tsx packages/surfaces/src/daily-report-cli.ts              # today
 *   npx tsx packages/surfaces/src/daily-report-cli.ts --date 2026-03-20
 *   npx tsx packages/surfaces/src/daily-report-cli.ts --days 7     # last 7 days
 *   npx tsx packages/surfaces/src/daily-report-cli.ts --stdout      # print to stdout instead of file
 */

import { generateDailyReport, generateMultiDayReport } from './daily-report.js'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let date = new Date().toISOString().slice(0, 10)
  let days = 1
  let stdout = false

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--date': date = argv[++i] ?? date; break
      case '--days': days = parseInt(argv[++i] ?? '1', 10); break
      case '--stdout': stdout = true; break
    }
  }

  if (days > 1) {
    const report = await generateMultiDayReport(date, days)
    if (stdout) {
      console.log(report)
    } else {
      const { writeFile, mkdir } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const { homedir } = await import('node:os')
      const dir = join(process.env.FOREMAN_HOME ?? join(homedir(), '.foreman'), 'reports')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${date}-${days}d.md`)
      await writeFile(path, report, 'utf8')
      console.log(path)
    }
  } else {
    if (stdout) {
      const { readFile } = await import('node:fs/promises')
      const path = await generateDailyReport(date)
      console.log(await readFile(path, 'utf8'))
    } else {
      const path = await generateDailyReport(date)
      console.log(path)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
