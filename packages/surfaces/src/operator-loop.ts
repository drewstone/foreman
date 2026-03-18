/**
 * Foreman operator loop — the core product.
 *
 * This isn't a task runner. It's an operator automation layer that
 * manages a portfolio of active sessions across repos, resumes them
 * periodically, checks for staleness, and surfaces questions to the user.
 *
 * It mimics how a human operator works:
 * - Has 10+ active sessions across repos/branches
 * - Context-switches by resuming, refreshing mental state
 * - Periodically checks CI, PR status, branch staleness
 * - Notices gaps ("nothing active but there should be")
 * - Asks questions when blocked
 * - Prioritizes what to work on next
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── Types ───────────────────────────────────────────────────────────

export interface ManagedSession {
  id: string;
  repoPath: string;
  branch: string;
  goal: string;
  status: 'active' | 'waiting' | 'blocked' | 'stale' | 'completed';
  provider: 'claude' | 'codex' | 'pi';
  sessionId?: string;
  prNumber?: number;
  lastResumedAt?: string;
  lastCheckedAt?: string;
  ciStatus?: 'pass' | 'fail' | 'pending' | 'unknown';
  blockerReason?: string;
  priority: number;
  metadata?: Record<string, string>;
}

export interface OperatorQuestion {
  id: string;
  sessionId: string;
  question: string;
  context: string;
  options?: string[];
  required: boolean;
  askedAt: string;
  answeredAt?: string;
  answer?: string;
}

export interface OperatorState {
  sessions: ManagedSession[];
  questions: OperatorQuestion[];
  lastHeartbeatAt?: string;
  claudeMdCache: Record<string, string>;
}

export interface HeartbeatResult {
  checked: number;
  resumed: number;
  questionsAsked: number;
  discoveries: string[];
  actions: Array<{
    sessionId: string;
    action: string;
    result: string;
  }>;
}

// ─── Session Registry ────────────────────────────────────────────────

const STATE_FILE = '.foreman/operator-state.json';

export async function loadOperatorState(root: string): Promise<OperatorState> {
  const path = join(root, STATE_FILE);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as OperatorState;
  } catch {
    return { sessions: [], questions: [], claudeMdCache: {} };
  }
}

export async function saveOperatorState(root: string, state: OperatorState): Promise<void> {
  const path = join(root, STATE_FILE);
  await mkdir(join(root, '.foreman'), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ─── Session Discovery ───────────────────────────────────────────────

export async function discoverActiveSessions(repoPaths: string[]): Promise<ManagedSession[]> {
  const sessions: ManagedSession[] = [];

  for (const repoPath of repoPaths) {
    const absPath = resolve(repoPath);

    // Check for active branches with uncommitted work
    const branches = await getBranchesWithWork(absPath);
    for (const branch of branches) {
      sessions.push({
        id: `${absPath}:${branch.name}`,
        repoPath: absPath,
        branch: branch.name,
        goal: branch.inferredGoal || `Work on ${branch.name}`,
        status: branch.hasUncommitted ? 'active' : 'waiting',
        provider: 'claude',
        priority: branch.hasUncommitted ? 8 : 5,
      });
    }

    // Check for open PRs
    const prs = await getOpenPRs(absPath);
    for (const pr of prs) {
      const existing = sessions.find((s) => s.repoPath === absPath && s.branch === pr.branch);
      if (existing) {
        existing.prNumber = pr.number;
        existing.ciStatus = pr.ciStatus;
        if (pr.ciStatus === 'fail') {
          existing.status = 'blocked';
          existing.blockerReason = 'CI failing';
          existing.priority = 9;
        }
      }
    }
  }

  return sessions.sort((a, b) => b.priority - a.priority);
}

async function getBranchesWithWork(repoPath: string): Promise<Array<{
  name: string;
  hasUncommitted: boolean;
  lastCommitDate: string;
  inferredGoal?: string;
}>> {
  try {
    const { stdout: branchOutput } = await execFileAsync(
      'git', ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)|%(committerdate:iso)', 'refs/heads/'],
      { cwd: repoPath },
    );

    const { stdout: statusOutput } = await execFileAsync(
      'git', ['status', '--porcelain'],
      { cwd: repoPath },
    );
    const currentHasUncommitted = statusOutput.trim().length > 0;

    const { stdout: currentBranch } = await execFileAsync(
      'git', ['symbolic-ref', '--short', 'HEAD'],
      { cwd: repoPath },
    ).catch(() => ({ stdout: '' }));

    return branchOutput
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(0, 10)
      .map((line) => {
        const [name, date] = line.split('|');
        const branchName = name?.trim() ?? '';
        const isCurrent = branchName === currentBranch.trim();
        // Infer goal from branch name
        const inferredGoal = branchName
          .replace(/^(feat|fix|chore|refactor|test|docs)\//i, '')
          .replace(/[-_]/g, ' ')
          .trim();
        return {
          name: branchName,
          hasUncommitted: isCurrent && currentHasUncommitted,
          lastCommitDate: date?.trim() ?? '',
          inferredGoal: inferredGoal !== branchName ? inferredGoal : undefined,
        };
      })
      .filter((b) => b.name !== 'main' && b.name !== 'master');
  } catch {
    return [];
  }
}

async function getOpenPRs(repoPath: string): Promise<Array<{
  number: number;
  branch: string;
  title: string;
  ciStatus: 'pass' | 'fail' | 'pending' | 'unknown';
}>> {
  try {
    const { stdout } = await execFileAsync(
      'gh', ['pr', 'list', '--json', 'number,headRefName,title,statusCheckRollup', '--limit', '10'],
      { cwd: repoPath },
    );
    const prs = JSON.parse(stdout) as Array<{
      number: number;
      headRefName: string;
      title: string;
      statusCheckRollup?: Array<{ conclusion: string; status: string }>;
    }>;

    return prs.map((pr) => {
      let ciStatus: 'pass' | 'fail' | 'pending' | 'unknown' = 'unknown';
      if (pr.statusCheckRollup?.length) {
        const hasFailing = pr.statusCheckRollup.some((c) => c.conclusion === 'FAILURE');
        const hasPending = pr.statusCheckRollup.some((c) => c.status === 'IN_PROGRESS' || c.status === 'QUEUED');
        ciStatus = hasFailing ? 'fail' : hasPending ? 'pending' : 'pass';
      }
      return {
        number: pr.number,
        branch: pr.headRefName,
        title: pr.title,
        ciStatus,
      };
    });
  } catch {
    return [];
  }
}

// ─── CLAUDE.md Generation ────────────────────────────────────────────

export async function generateClaudeMd(options: {
  repoPath: string;
  session: ManagedSession;
  memory?: Record<string, unknown>;
  ciFailures?: string[];
}): Promise<string> {
  const { repoPath, session, memory, ciFailures } = options;

  // Read existing CLAUDE.md if present
  let existingClaudeMd = '';
  try {
    existingClaudeMd = await readFile(join(repoPath, 'CLAUDE.md'), 'utf8');
  } catch { /* no existing file */ }

  const sections: string[] = [];

  // Preserve existing CLAUDE.md content
  if (existingClaudeMd.trim()) {
    sections.push(existingClaudeMd.trim());
  }

  // Add Foreman-generated context
  sections.push('');
  sections.push('## Foreman Context (auto-generated, do not edit manually)');
  sections.push('');
  sections.push(`**Current goal:** ${session.goal}`);
  sections.push(`**Branch:** ${session.branch}`);
  sections.push(`**Status:** ${session.status}`);

  if (session.prNumber) {
    sections.push(`**PR:** #${session.prNumber} (CI: ${session.ciStatus ?? 'unknown'})`);
  }

  if (session.blockerReason) {
    sections.push(`**Blocker:** ${session.blockerReason}`);
  }

  // Memory-derived instructions
  const facts = (memory as { facts?: string[] })?.facts ?? [];
  const ciReqs = facts.filter((f: string) => f.startsWith('ci-requirement:'));
  const checkCmds = facts.filter((f: string) => f.startsWith('check-command:'));

  if (checkCmds.length > 0) {
    sections.push('');
    sections.push('### Required checks (from prior runs)');
    for (const cmd of checkCmds) {
      sections.push(`- \`${cmd.replace('check-command: ', '')}\``);
    }
  }

  if (ciReqs.length > 0 || ciFailures?.length) {
    sections.push('');
    sections.push('### CI requirements (learned from failures)');
    for (const req of ciReqs) {
      sections.push(`- ${req.replace('ci-requirement: ', '')}`);
    }
    for (const failure of ciFailures ?? []) {
      sections.push(`- ${failure}`);
    }
  }

  // Quality bar
  sections.push('');
  sections.push('### Completion standard');
  sections.push('- Run ALL check commands before declaring done');
  sections.push('- Push to a branch, never to main directly');
  sections.push('- If CI fails after push, read the logs (`gh run view --log-failed`), fix, and push again');
  sections.push('- Do not declare done until CI is green');
  sections.push('- Self-review your work before finishing');

  return sections.join('\n');
}

// ─── Session Spawning ────────────────────────────────────────────────

export async function spawnSession(options: {
  repoPath: string;
  goal: string;
  sessionId?: string;
  resume?: boolean;
  claudeMd?: string;
  provider?: 'claude' | 'codex';
  timeoutMs?: number;
}): Promise<{
  sessionId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}> {
  const provider = options.provider ?? 'claude';
  const startedAt = Date.now();

  if (provider === 'claude') {
    const args = [
      '--dangerously-skip-permissions',
      '-p',
      '--output-format', 'json',
    ];
    if (options.resume && options.sessionId) {
      args.push('--resume', options.sessionId);
    } else if (options.sessionId) {
      args.push('--session-id', options.sessionId);
    }
    args.push(options.goal);

    try {
      const { stdout, stderr } = await execFileAsync('claude', args, {
        cwd: options.repoPath,
        timeout: options.timeoutMs ?? 15 * 60 * 1000,
        env: process.env,
      });
      return {
        sessionId: options.sessionId ?? extractSessionId(stdout) ?? 'unknown',
        exitCode: 0,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number };
      return {
        sessionId: options.sessionId ?? 'unknown',
        exitCode: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? String(error),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  // Codex
  const args = ['exec', '--full-auto', '--json'];
  if (options.repoPath) {
    args.push('-C', options.repoPath);
  }
  args.push(options.goal);

  try {
    const { stdout, stderr } = await execFileAsync('codex', args, {
      timeout: options.timeoutMs ?? 15 * 60 * 1000,
      env: process.env,
    });
    return {
      sessionId: options.sessionId ?? 'unknown',
      exitCode: 0,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      sessionId: options.sessionId ?? 'unknown',
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

// ─── Session Insight Extraction ──────────────────────────────────────

async function extractRecentSessionInsights(repoPaths: string[]): Promise<string[]> {
  const insights: string[] = [];
  const repoSet = new Set(repoPaths.map((p) => resolve(p)));

  // Scan Claude Code sessions from the last 24 hours
  const claudeSessions = await scanRecentClaudeSessions(24);
  for (const session of claudeSessions) {
    if (session.cwd && repoSet.has(resolve(session.cwd))) {
      insights.push(`Recent Claude session on ${session.cwd.split('/').pop()}: ${session.summary ?? session.title}`);
    }
  }

  // Scan Codex sessions
  const codexSessions = await scanRecentCodexSessions(24);
  for (const session of codexSessions) {
    insights.push(`Recent Codex session: ${session.summary ?? session.title}`);
  }

  return insights;
}

interface SessionScanResult {
  sessionId: string;
  title: string;
  summary?: string;
  cwd?: string;
  updatedAt?: string;
}

async function scanRecentClaudeSessions(hoursBack: number): Promise<SessionScanResult[]> {
  const { homedir: getHomedir } = await import('node:os');
  const root = join(getHomedir(), '.claude', 'projects');
  const cutoff = Date.now() - (hoursBack * 60 * 60 * 1000);
  const results: SessionScanResult[] = [];

  let projectDirs: string[] = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
  } catch {
    return [];
  }

  for (const dir of projectDirs) {
    try {
      const indexPath = join(dir, 'sessions-index.json');
      const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as {
        entries?: Array<{
          sessionId?: string;
          summary?: string;
          projectPath?: string;
          modified?: string;
          fileMtime?: number;
        }>;
      };

      for (const entry of parsed.entries ?? []) {
        const mtime = entry.fileMtime ?? (entry.modified ? new Date(entry.modified).getTime() : 0);
        if (mtime > cutoff && entry.sessionId) {
          results.push({
            sessionId: entry.sessionId,
            title: entry.summary ?? 'Claude session',
            summary: entry.summary,
            cwd: entry.projectPath,
            updatedAt: entry.modified ?? new Date(mtime).toISOString(),
          });
        }
      }
    } catch {
      continue;
    }
  }

  return results.sort((a, b) => {
    const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bTime - aTime;
  });
}

async function scanRecentCodexSessions(hoursBack: number): Promise<SessionScanResult[]> {
  const { homedir: getHomedir } = await import('node:os');
  const historyPath = join(getHomedir(), '.codex', 'history.jsonl');
  const cutoff = Date.now() - (hoursBack * 60 * 60 * 1000);
  const results: SessionScanResult[] = [];

  let raw = '';
  try {
    raw = await readFile(historyPath, 'utf8');
  } catch {
    return [];
  }

  const bySession = new Map<string, { text?: string; ts?: number }>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { session_id?: string; text?: string; ts?: number };
      if (!parsed.session_id) continue;
      const existing = bySession.get(parsed.session_id) ?? {};
      if (parsed.text) existing.text = parsed.text;
      if (parsed.ts) existing.ts = Math.max(existing.ts ?? 0, parsed.ts);
      bySession.set(parsed.session_id, existing);
    } catch {
      continue;
    }
  }

  for (const [sessionId, entry] of bySession) {
    const ts = (entry.ts ?? 0) * 1000;
    if (ts > cutoff) {
      results.push({
        sessionId,
        title: entry.text?.slice(0, 120) ?? 'Codex session',
        summary: entry.text?.slice(0, 200),
        updatedAt: new Date(ts).toISOString(),
      });
    }
  }

  return results.sort((a, b) => {
    const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bTime - aTime;
  });
}

function extractSessionId(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output);
    return parsed?.session_id;
  } catch {
    return undefined;
  }
}

// ─── Heartbeat ───────────────────────────────────────────────────────

export async function runHeartbeat(options: {
  state: OperatorState;
  repoPaths: string[];
  onQuestion?: (question: OperatorQuestion) => Promise<string | undefined>;
  onAction?: (sessionId: string, action: string) => void;
  autoResume?: boolean;
  maxResumes?: number;
  extractSessionInsights?: boolean;
}): Promise<HeartbeatResult> {
  const result: HeartbeatResult = {
    checked: 0,
    resumed: 0,
    questionsAsked: 0,
    discoveries: [],
    actions: [],
  };

  // ── Extract insights from recent harness sessions ────────────────
  if (options.extractSessionInsights !== false) {
    const insights = await extractRecentSessionInsights(options.repoPaths);
    result.discoveries.push(...insights);
  }

  // Discover what's active across all repos
  const discovered = await discoverActiveSessions(options.repoPaths);
  result.checked = discovered.length;

  // Merge discoveries with existing state
  for (const session of discovered) {
    const existing = options.state.sessions.find((s) => s.id === session.id);
    if (!existing) {
      options.state.sessions.push(session);
      result.discoveries.push(`New session: ${session.repoPath} (${session.branch}): ${session.goal}`);
    } else {
      // Update status from fresh discovery
      existing.ciStatus = session.ciStatus ?? existing.ciStatus;
      existing.lastCheckedAt = new Date().toISOString();
      if (session.status === 'blocked' && existing.status !== 'blocked') {
        existing.status = 'blocked';
        existing.blockerReason = session.blockerReason;
        existing.priority = Math.max(existing.priority, 9);
        result.discoveries.push(`Blocked: ${existing.repoPath} (${existing.branch}): ${session.blockerReason}`);
      }
    }
  }

  // Check for stale sessions
  const now = Date.now();
  for (const session of options.state.sessions) {
    if (session.status === 'completed') continue;
    const lastActivity = session.lastResumedAt ?? session.lastCheckedAt;
    if (lastActivity) {
      const ageMs = now - new Date(lastActivity).getTime();
      if (ageMs > 24 * 60 * 60 * 1000 && session.status !== 'stale') {
        session.status = 'stale';
        session.priority = Math.max(session.priority, 3);
        result.discoveries.push(`Stale: ${session.repoPath} (${session.branch}) — no activity in 24h`);
      }
    }
  }

  // Auto-resume blocked sessions (CI failures)
  if (options.autoResume) {
    const toResume = options.state.sessions
      .filter((s) => s.status === 'blocked' && s.ciStatus === 'fail')
      .slice(0, options.maxResumes ?? 3);

    for (const session of toResume) {
      options.onAction?.(session.id, `Resuming to fix CI: ${session.blockerReason}`);

      const spawnResult = await spawnSession({
        repoPath: session.repoPath,
        goal: `CI is failing on PR #${session.prNumber}. Read the CI logs with \`gh run view --log-failed\` and fix the failures. Push the fix.`,
        sessionId: session.sessionId,
        resume: Boolean(session.sessionId),
        provider: session.provider as 'claude' | 'codex',
      });

      session.lastResumedAt = new Date().toISOString();
      result.resumed++;
      result.actions.push({
        sessionId: session.id,
        action: 'resume-ci-fix',
        result: spawnResult.exitCode === 0 ? 'success' : 'failed',
      });
    }
  }

  // Surface questions for ambiguous situations
  if (options.onQuestion) {
    const stale = options.state.sessions.filter((s) => s.status === 'stale');
    if (stale.length > 0) {
      const question: OperatorQuestion = {
        id: `stale-${now}`,
        sessionId: 'operator',
        question: `${stale.length} session(s) are stale (no activity in 24h). What should I do?`,
        context: stale.map((s) => `- ${s.repoPath} (${s.branch}): ${s.goal}`).join('\n'),
        options: ['Resume the highest priority one', 'Show me the list', 'Ignore for now', 'Close them all'],
        required: false,
        askedAt: new Date().toISOString(),
      };
      options.state.questions.push(question);
      const answer = await options.onQuestion(question);
      if (answer) {
        question.answer = answer;
        question.answeredAt = new Date().toISOString();
      }
      result.questionsAsked++;
    }
  }

  options.state.lastHeartbeatAt = new Date().toISOString();
  return result;
}

// ─── Priority Ranking ────────────────────────────────────────────────

export function rankSessions(sessions: ManagedSession[]): ManagedSession[] {
  return [...sessions]
    .filter((s) => s.status !== 'completed')
    .sort((a, b) => {
      // Blocked CI > active work > waiting > stale
      const statusOrder: Record<string, number> = {
        blocked: 10,
        active: 7,
        waiting: 4,
        stale: 2,
        completed: 0,
      };
      const statusDiff = (statusOrder[b.status] ?? 0) - (statusOrder[a.status] ?? 0);
      if (statusDiff !== 0) return statusDiff;
      return b.priority - a.priority;
    });
}

// ─── Summary for display ─────────────────────────────────────────────

export function formatSessionSummary(sessions: ManagedSession[]): string {
  const ranked = rankSessions(sessions);
  if (ranked.length === 0) return 'No active sessions.';

  return ranked.map((s, i) => {
    const ci = s.ciStatus ? ` [CI: ${s.ciStatus}]` : '';
    const pr = s.prNumber ? ` PR #${s.prNumber}` : '';
    const blocker = s.blockerReason ? ` ⚠ ${s.blockerReason}` : '';
    return `${i + 1}. [${s.status}] ${s.repoPath.split('/').pop()}/${s.branch}${pr}${ci}${blocker}\n   ${s.goal}`;
  }).join('\n');
}
