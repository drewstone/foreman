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
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
  maxResumes: number;
  minConfidence: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { heartbeat: false, fixCi: false, dryRun: false, verbose: false, maxResumes: 2, minConfidence: 0.7 };
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
      case '--max-resumes':
        args.maxResumes = parseInt(argv[++i] ?? '2', 10);
        break;
      case '--min-confidence':
        args.minConfidence = parseFloat(argv[++i] ?? '0.7');
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
    minConfidence: args.minConfidence,
    maxResumes: args.maxResumes,
    traceRoot: join(FOREMAN_HOME, 'traces'),
    onAction: (sessionId, action) => {
      log(`${sessionId}: ${action}`);
    },
    onQuestion: async (question) => {
      log(`Question: ${question.question}`);
      if (question.options) {
        log(`  Options: ${question.options.join(', ')}`);
      }
      log(`  Context: ${question.context.slice(0, 200)}`);
      return undefined;
    },
    onReview: async ({ recentHeartbeats, sessions }) => {
      // Build a comprehensive review prompt from accumulated state
      const ranked = sessions
        .filter((s) => s.status !== 'completed')
        .sort((a, b) => b.priority - a.priority);

      const blockedSessions = ranked.filter((s) => s.status === 'blocked');
      const activeSessions = ranked.filter((s) => s.status === 'active');
      const staleSessions = ranked.filter((s) => s.status === 'stale');

      const heartbeatSummary = recentHeartbeats.slice(-5).map((hb) => {
        const actions = hb.actions.map((a) => `  ${a.action} → ${a.result}`).join('\n');
        const blocked = hb.blockedSessions.map((b) => `  ${b.repo}/${b.reason} (conf: ${b.confidence})`).join('\n');
        return `[${hb.at}] checked:${hb.checked} resumed:${hb.resumed}\n${actions}\n${blocked}`.trim();
      }).join('\n\n');

      const sessionPortfolio = ranked.slice(0, 15).map((s) => {
        const ci = s.ciStatus ? ` CI:${s.ciStatus}` : '';
        const pr = s.prNumber ? ` PR#${s.prNumber}` : '';
        const age = s.metadata?.daysOld ? ` ${s.metadata.daysOld}d` : '';
        const commit = s.metadata?.lastCommit ? ` "${s.metadata.lastCommit.slice(0, 60)}"` : '';
        return `[${s.status}] ${s.repoPath.split('/').pop()}/${s.branch}${pr}${ci}${age}${commit}`;
      }).join('\n');

      const prompt = [
        'You are Foreman, an autonomous engineering operator reviewing your heartbeat trace history.',
        '',
        'Your job: analyze the accumulated state and decide what matters, what to act on, and what to surface to the operator.',
        '',
        '## Current session portfolio',
        sessionPortfolio,
        '',
        `## Summary: ${ranked.length} total, ${blockedSessions.length} blocked, ${activeSessions.length} active, ${staleSessions.length} stale`,
        '',
        '## Recent heartbeat history',
        heartbeatSummary || '(no prior heartbeats)',
        '',
        '## Your analysis should cover:',
        '1. PERSISTENT BLOCKERS: Any session blocked for multiple heartbeats? Escalate with specific reason.',
        '2. CROSS-REPO PATTERNS: Same failure across repos? Identify the shared root cause.',
        '3. PRIORITY ASSESSMENT: What should the operator focus on RIGHT NOW? Not everything — the top 1-3 items.',
        '4. STALE WORK: Anything abandoned that should be either resumed or closed?',
        '5. OPERATOR FOCUS: Based on recent Claude/Codex session activity, what is the operator actually working on? Is Foreman aligned with that?',
        '6. REPAIR RECIPES: Any CI failure you\'ve seen fixed before? What was the fix? Store as a recipe.',
        '',
        'Return JSON: {"discoveries":["insight1","insight2"],"actions":[{"sessionId":"id","action":"what to do","result":"proposed"}],"recipes":[{"pattern":"failure pattern","fix":"how to fix it"}]}',
        '',
        'Be specific. Be concise. Only surface what matters.',
      ].join('\n');

      if (args.dryRun) {
        log('[review] Would dispatch review agent with:');
        log(`  Sessions: ${ranked.length} (${blockedSessions.length} blocked, ${staleSessions.length} stale)`);
        log(`  Heartbeat history: ${recentHeartbeats.length} entries`);
        return undefined;
      }

      // Dispatch to Claude for review
      try {
        const { stdout, stderr } = await execFileAsync('claude', [
          '--dangerously-skip-permissions',
          '-p',
          '--output-format', 'json',
          '--max-turns', '1',
          prompt,
        ], {
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
        });

        // Parse the response
        try {
          const parsed = JSON.parse(stdout.trim());
          const result = parsed?.result ?? stdout;
          const jsonMatch = String(result).match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const review = JSON.parse(jsonMatch[0]) as {
              discoveries?: string[];
              actions?: Array<{ sessionId: string; action: string; result: string }>;
              recipes?: Array<{ pattern: string; fix: string }>;
            };
            // Store recipes in memory
            if (review.recipes?.length) {
              for (const recipe of review.recipes) {
                log(`[review] Learned recipe: ${recipe.pattern} → ${recipe.fix}`);
              }
            }
            return {
              discoveries: (review.discoveries ?? []).map((d) => `[REVIEW] ${d}`),
              actions: review.actions,
            };
          }
        } catch { /* parse failed, that's ok */ }

        return { discoveries: [`[REVIEW] Agent responded but output was not parseable`] };
      } catch (error) {
        log(`[review] Agent dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
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
