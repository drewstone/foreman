/**
 * foreman run — spawn a harness session with generated context.
 *
 * This is the core product: generate the right --append-system-prompt
 * from memory + project context + session insights + SOUL, then spawn
 * the best harness (claude, codex, opencode) to execute.
 *
 * Usage:
 *   node --import tsx packages/surfaces/src/run.ts \
 *     --repo /path/to/repo --goal "Build X" [--harness claude|codex]
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { generateClaudeMd } from './claudemd-generator.js';
import { extractDeepSessionInsights } from './session-insights.js';

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let repoPath = '';
  let goal = '';
  let harness = 'claude';
  let sessionId: string | undefined;
  let resume = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--repo': repoPath = argv[++i] ?? ''; break;
      case '--goal': goal = argv[++i] ?? ''; break;
      case '--harness': harness = argv[++i] ?? 'claude'; break;
      case '--session-id': sessionId = argv[++i]; break;
      case '--resume': resume = true; break;
    }
  }

  if (!repoPath || !goal) {
    console.error('Usage: foreman run --repo PATH --goal "..." [--harness claude|codex] [--resume]');
    process.exit(1);
  }

  const absRepo = resolve(repoPath);

  // Load SOUL
  const soulPath = join(process.env.FOREMAN_HOME ?? join(homedir(), '.foreman'), 'soul.md');
  let soul = '';
  try { soul = await readFile(soulPath, 'utf8'); } catch { /* no soul */ }

  // Extract session insights for this repo
  let insights: Awaited<ReturnType<typeof extractDeepSessionInsights>> | undefined;
  try {
    insights = await extractDeepSessionInsights({
      repoPaths: [absRepo],
      hoursBack: 168,
      maxSessionsPerRepo: 3,
    });
  } catch { /* best effort */ }

  const repoInsight = insights?.repoActivity.find((a) => absRepo.endsWith(a.repo));

  // Generate context via CLAUDE.md generator
  const foremanContext = await generateClaudeMd({
    repoPath: absRepo,
    session: {
      id: `run:${absRepo}`,
      repoPath: absRepo,
      branch: 'current',
      goal,
      status: 'active',
      provider: harness as 'claude' | 'codex' | 'pi',
      priority: 10,
    },
    sessionInsights: repoInsight ? {
      commonCommands: repoInsight.commonCommands,
      commonFiles: repoInsight.commonFiles,
      suggestedRules: insights?.suggestedClaudeMdRules,
      recentGoals: repoInsight.inferredGoals,
    } : undefined,
  });

  // Build the system prompt from SOUL + generated context
  const systemPrompt = [soul, foremanContext].filter(Boolean).join('\n\n');

  process.stderr.write(`[foreman] Repo: ${absRepo}\n`);
  process.stderr.write(`[foreman] Goal: ${goal.slice(0, 100)}\n`);
  process.stderr.write(`[foreman] Harness: ${harness}\n`);
  process.stderr.write(`[foreman] Context: ${systemPrompt.length} chars\n\n`);

  // Spawn the harness
  if (harness === 'codex') {
    const args = ['exec', '--full-auto', '-C', absRepo, goal];
    process.stderr.write(`[foreman] codex ${args.slice(0, 3).join(' ')} ...\n`);
    const { stdout } = await execFileAsync('codex', args, {
      timeout: 30 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    console.log(stdout);
  } else {
    // Claude (default)
    const args = [
      '--dangerously-skip-permissions', '-p',
      '--append-system-prompt', systemPrompt,
      '--output-format', 'json',
    ];
    if (resume && sessionId) {
      args.push('--resume', sessionId);
    } else if (sessionId) {
      args.push('--session-id', sessionId);
    }
    args.push(goal);

    process.stderr.write(`[foreman] claude -p --append-system-prompt (${systemPrompt.length} chars) ...\n`);
    const { stdout } = await execFileAsync('claude', args, {
      cwd: absRepo,
      timeout: 30 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    console.log(stdout);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
