/**
 * Foreman operator CLI — the main entrypoint.
 *
 * Usage:
 *   npm run foreman                  — show status + run heartbeat
 *   npm run foreman -- --heartbeat   — run heartbeat only (for cron)
 *   npm run foreman -- --resume ID   — resume a specific session
 *   npm run foreman -- --fix-ci      — auto-fix all failing CI
 */

import { extractDeepSessionInsights } from './session-insights.js';
import {
  discoverActiveSessions,
  formatSessionSummary,
  generateClaudeMd,
  loadOperatorState,
  rankSessions,
  runHeartbeat,
  saveOperatorState,
  spawnSession,
} from './operator-loop.js';
import { checkCI, readCILogs } from './ci-tools.js';
import { createMemoryStore } from '@drew/foreman-memory';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

// ─── Config ──────────────────────────────────────────────────────────

const FOREMAN_HOME = resolve(process.env.FOREMAN_HOME ?? join(homedir(), '.foreman'));
const REPOS_FILE = join(FOREMAN_HOME, 'repos.json');

async function loadRepoPaths(): Promise<string[]> {
  // Load from ~/.foreman/repos.json or FOREMAN_REPOS env
  const envRepos = process.env.FOREMAN_REPOS;
  if (envRepos) {
    return envRepos.split(':').map((p) => resolve(p)).filter(Boolean);
  }
  try {
    const data = JSON.parse(await readFile(REPOS_FILE, 'utf8'));
    return Array.isArray(data) ? data.map((p: string) => resolve(p)) : [];
  } catch {
    // Auto-discover: scan ~/code for git repos
    const codeDir = join(homedir(), 'code');
    try {
      const entries = await readdir(codeDir, { withFileTypes: true });
      const repos: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const gitDir = join(codeDir, entry.name, '.git');
          try {
            await readFile(join(gitDir, 'HEAD'));
            repos.push(join(codeDir, entry.name));
          } catch { /* not a git repo */ }
        }
      }
      return repos;
    } catch {
      return [];
    }
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────

interface CliArgs {
  heartbeat: boolean;
  fixCi: boolean;
  dryRun: boolean;
  resume?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { heartbeat: false, fixCi: false, dryRun: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--heartbeat':
        args.heartbeat = true;
        break;
      case '--fix-ci':
        args.fixCi = true;
        break;
      case '--resume':
        args.resume = argv[++i];
        break;
      case '--verbose':
      case '-v':
        args.verbose = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Foreman — autonomous operator loop

Usage:
  npm run foreman                      Show status + interactive heartbeat
  npm run foreman -- --heartbeat       Run heartbeat (for cron)
  npm run foreman -- --fix-ci          Auto-resume all sessions with failing CI
  npm run foreman -- --resume <id>     Resume a specific session
  npm run foreman -- -v                Verbose output

Config:
  FOREMAN_REPOS=/path1:/path2   Repos to manage (colon-separated)
  ~/.foreman/repos.json         Alternative: JSON array of repo paths
  Falls back to scanning ~/code/ for git repos
`);
}

function log(msg: string): void {
  console.error(`[foreman] ${msg}`);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoPaths = await loadRepoPaths();

  if (repoPaths.length === 0) {
    log('No repos configured. Set FOREMAN_REPOS or create ~/.foreman/repos.json');
    process.exit(1);
  }

  if (args.verbose) {
    log(`Managing ${repoPaths.length} repo(s): ${repoPaths.map((p) => p.split('/').pop()).join(', ')}`);
  }

  const state = await loadOperatorState(FOREMAN_HOME);

  // ── Resume a specific session ────────────────────────────────────

  if (args.resume) {
    const session = state.sessions.find((s) => s.id.includes(args.resume!));
    if (!session) {
      log(`Session not found: ${args.resume}`);
      log('Active sessions:');
      log(await formatSessionSummary(state.sessions));
      process.exit(1);
    }

    log(`Resuming: ${session.repoPath} (${session.branch})`);

    const memory = await createMemoryStore({ rootDir: join(session.repoPath, '.foreman', 'memory') })
      .then((s) => s.getEnvironmentMemory(session.repoPath))
      .catch(() => null);

    // Extract session insights for this repo
    const insights = await extractDeepSessionInsights({
      repoPaths: [session.repoPath],
      hoursBack: 168, // 7 days
      maxSessionsPerRepo: 5,
    });
    const repoInsight = insights.repoActivity.find(
      (a) => session.repoPath.endsWith(a.repo),
    );

    const claudeMd = await generateClaudeMd({
      repoPath: session.repoPath,
      session,
      memory: memory as unknown as Record<string, unknown> | undefined,
      sessionInsights: repoInsight ? {
        commonCommands: repoInsight.commonCommands,
        commonFiles: repoInsight.commonFiles,
        suggestedRules: insights.suggestedClaudeMdRules,
        recentGoals: repoInsight.inferredGoals,
      } : undefined,
    });

    if (args.verbose) {
      log(`Generated CLAUDE.md context (${claudeMd.length} chars)`);
    }

    const result = await spawnSession({
      repoPath: session.repoPath,
      goal: session.goal,
      sessionId: session.sessionId,
      resume: Boolean(session.sessionId),
      provider: session.provider as 'claude' | 'codex',
    });

    session.lastResumedAt = new Date().toISOString();
    session.sessionId = result.sessionId;
    await saveOperatorState(FOREMAN_HOME, state);

    log(`Session ${result.exitCode === 0 ? 'completed' : 'exited'} (${result.durationMs}ms)`);
    console.log(result.stdout);
    return;
  }

  // ── Fix CI on all blocked sessions ───────────────────────────────

  if (args.fixCi) {
    let blocked = state.sessions.filter((s) => s.ciStatus === 'fail' && s.prNumber);
    if (blocked.length === 0) {
      // Discover fresh and merge into state so mutations persist
      const discovered = await discoverActiveSessions(repoPaths);
      const freshBlocked = discovered.filter((s) => s.ciStatus === 'fail');
      if (freshBlocked.length === 0) {
        log('No sessions with failing CI found.');
        return;
      }
      for (const s of freshBlocked) {
        if (!state.sessions.find((existing) => existing.id === s.id)) {
          state.sessions.push(s);
        }
      }
      blocked = state.sessions.filter((s) => s.ciStatus === 'fail' && s.prNumber);
    }

    log(`${blocked.length} session(s) with failing CI`);

    for (const session of blocked) {
      log(`Fixing: ${session.repoPath} (${session.branch}) PR #${session.prNumber}`);

      // Read CI failure logs (gh may not be available)
      let failureSummary = '';
      try {
        const logs = await readCILogs({ repoPath: session.repoPath });
        failureSummary = logs.failedJobs.map((j) => `${j.name}: ${j.log.slice(0, 500)}`).join('\n\n');
      } catch {
        log('  (could not read CI logs — gh CLI may not be available)');
      }

      const goal = [
        `CI is failing on this branch. Fix all failures and push.`,
        '',
        'Failed jobs:',
        failureSummary || '(could not read logs — run `gh run view --log-failed`)',
      ].join('\n');

      const result = await spawnSession({
        repoPath: session.repoPath,
        goal,
        sessionId: session.sessionId,
        resume: Boolean(session.sessionId),
        provider: session.provider as 'claude' | 'codex',
      });

      session.lastResumedAt = new Date().toISOString();
      session.sessionId = result.sessionId;
      log(`  → ${result.exitCode === 0 ? 'done' : 'exited with errors'} (${result.durationMs}ms)`);
    }

    await saveOperatorState(FOREMAN_HOME, state);
    return;
  }

  // ── Heartbeat (default) ──────────────────────────────────────────

  const result = await runHeartbeat({
    state,
    repoPaths,
    autoResume: args.heartbeat,
    dryRun: args.dryRun,
    minConfidence: 0.7,
    maxResumes: 2,
    traceRoot: join(FOREMAN_HOME, 'traces'),
    onAction: (sessionId, action) => {
      log(`${sessionId}: ${action}`);
    },
    onQuestion: async (question) => {
      // In heartbeat mode, log questions but don't block
      log(`Question: ${question.question}`);
      if (question.options) {
        log(`  Options: ${question.options.join(', ')}`);
      }
      log(`  Context: ${question.context.slice(0, 200)}`);
      return undefined;
    },
  });

  await saveOperatorState(FOREMAN_HOME, state);

  // Display status
  console.log('');
  console.log('─── Foreman Status ───');
  console.log('');
  console.log(await formatSessionSummary(state.sessions, { includeMemory: true }));
  console.log('');

  if (result.discoveries.length > 0) {
    console.log('Discoveries:');
    for (const d of result.discoveries) {
      console.log(`  ${d}`);
    }
    console.log('');
  }

  console.log(`Checked: ${result.checked} | Resumed: ${result.resumed} | Questions: ${result.questionsAsked}`);

  if (result.actions.length > 0) {
    console.log('');
    console.log('Actions taken:');
    for (const a of result.actions) {
      console.log(`  ${a.sessionId}: ${a.action} → ${a.result}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
