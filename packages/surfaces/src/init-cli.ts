/**
 * foreman init — bootstrap a Foreman instance.
 *
 * Creates:
 *   ~/.foreman/soul.md         — operating principles
 *   ~/.foreman/config.json     — managed repos, cron settings
 *   ~/.foreman/operator-state.json — session portfolio (empty)
 *
 * Optionally installs cron heartbeat.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const FOREMAN_HOME = resolve(process.env.FOREMAN_HOME ?? join(homedir(), '.foreman'));

const DEFAULT_SOUL = `# Foreman SOUL

## Default posture: skepticism

Never trust agent self-report. Validate independently.

- "Tests pass" → run the tests yourself
- "Done" → dispatch /verify in a separate session
- "Quality 10/10" → dispatch /critical-audit independently
- Mocked tests don't count. Integration tests or it didn't happen.

## Default behavior: relentless

When an agent stops, say "continue."
When it says done, say "prove it."
When proof has gaps, say "fix these."
Keep going until independently verified or genuinely stuck.

## Escalation

Ask the human only for:
- Strategic decisions (which direction, not how)
- Cost approval above threshold
- Ambiguous tradeoffs requiring human values
- Novel observations worth surfacing

Never ask: "Should I continue?" (yes), "Is this good enough?" (no), "Should I run tests?" (yes).

## Improvement cycles

For every project: is there an autonomous improvement cycle running?
If not, should there be? If yes, build it (/improve) and drive it (/evolve).

DISCOVER → MEASURE → DIAGNOSE → HYPOTHESIZE → IMPLEMENT → TEST → PROMOTE → REPEAT
`;

const DEFAULT_CONFIG = {
  repos: [] as string[],
  heartbeat: {
    intervalMinutes: 15,
    dryRun: true,
    minConfidence: 0.7,
    maxResumes: 2,
  },
  skills: ['/evolve', '/polish', '/verify', '/status', '/critical-audit'],
};

async function main(): Promise<void> {
  const command = process.argv[2];

  const scriptDir = new URL('.', import.meta.url).pathname;
  const repoRoot = resolve(scriptDir, '../../..');

  if (command === 'init') {
    await init();
  } else if (command === 'status') {
    execSync(`node --import tsx packages/surfaces/src/operator-cli.ts`, { stdio: 'inherit', cwd: repoRoot });
  } else if (command === 'heartbeat') {
    execSync(`node --import tsx packages/surfaces/src/operator-cli.ts --heartbeat --dry-run -v`, { stdio: 'inherit', cwd: repoRoot });
  } else if (command === 'resume') {
    const target = process.argv[3] ?? '';
    execSync(`node --import tsx packages/surfaces/src/operator-cli.ts --resume "${target}" -v`, { stdio: 'inherit', cwd: repoRoot });
  } else if (command === 'fix-ci') {
    execSync(`node --import tsx packages/surfaces/src/operator-cli.ts --fix-ci -v`, { stdio: 'inherit', cwd: repoRoot });
  } else {
    console.log(`Foreman — autonomous engineering operator

Commands:
  foreman init              Set up ~/.foreman/ (soul, config, state)
  foreman status            Show session portfolio across repos
  foreman heartbeat         Scan repos, check CI, trace results
  foreman resume <id>       Resume a session with Foreman context
  foreman fix-ci            Auto-fix all sessions with failing CI

Config: ${FOREMAN_HOME}/config.json
Soul:   ${FOREMAN_HOME}/soul.md
`);
  }
}

async function init(): Promise<void> {
  console.log(`Initializing Foreman in ${FOREMAN_HOME}`);

  await mkdir(FOREMAN_HOME, { recursive: true });
  await mkdir(join(FOREMAN_HOME, 'traces', 'heartbeats'), { recursive: true });

  // SOUL
  const soulPath = join(FOREMAN_HOME, 'soul.md');
  if (!existsSync(soulPath)) {
    await writeFile(soulPath, DEFAULT_SOUL, 'utf8');
    console.log(`  Created ${soulPath}`);
  } else {
    console.log(`  Exists: ${soulPath}`);
  }

  // Config
  const configPath = join(FOREMAN_HOME, 'config.json');
  if (!existsSync(configPath)) {
    // Auto-discover repos
    const codeDir = join(homedir(), 'code');
    const repos: string[] = [];
    try {
      const { readdirSync } = await import('node:fs');
      for (const entry of readdirSync(codeDir, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(codeDir, entry.name, '.git'))) {
          repos.push(join(codeDir, entry.name));
        }
      }
    } catch { /* no ~/code */ }

    const config = { ...DEFAULT_CONFIG, repos: repos.slice(0, 20) };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    console.log(`  Created ${configPath} (${repos.length} repos discovered)`);
  } else {
    console.log(`  Exists: ${configPath}`);
  }

  // State
  const statePath = join(FOREMAN_HOME, 'operator-state.json');
  if (!existsSync(statePath)) {
    await writeFile(statePath, JSON.stringify({
      sessions: [],
      questions: [],
      heartbeatHistory: [],
      claudeMdCache: {},
    }, null, 2) + '\n', 'utf8');
    console.log(`  Created ${statePath}`);
  } else {
    console.log(`  Exists: ${statePath}`);
  }

  console.log(`
Done. Next steps:

  1. Edit ${configPath} to add/remove repos
  2. Edit ${soulPath} to customize operating principles
  3. Run: foreman status
  4. Run: foreman heartbeat
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
