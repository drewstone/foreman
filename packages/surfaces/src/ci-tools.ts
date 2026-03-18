import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// pushBranch
// ---------------------------------------------------------------------------

export async function pushBranch(options: {
  repoPath: string;
  commitMessage?: string;
  branch?: string;
}): Promise<{ branch: string; remote: string; pushed: boolean; error?: string }> {
  const cwd = options.repoPath;

  try {
    // Resolve branch name
    let branch = options.branch;
    if (!branch) {
      const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
      branch = stdout.trim();
    }

    // Optionally stage + commit
    if (options.commitMessage) {
      await execFile('git', ['add', '-A'], { cwd });
      await execFile('git', ['commit', '-m', options.commitMessage, '--allow-empty'], { cwd });
    }

    // Resolve remote
    let remote = 'origin';
    try {
      const { stdout } = await execFile('git', ['remote'], { cwd });
      const remotes = stdout.trim().split('\n').filter(Boolean);
      if (remotes.length > 0 && !remotes.includes('origin')) {
        remote = remotes[0]!;
      }
    } catch {
      return { branch, remote, pushed: false, error: 'no git remote configured' };
    }

    // Resolve remote URL
    let remoteUrl = remote;
    try {
      const { stdout } = await execFile('git', ['remote', 'get-url', remote], { cwd });
      remoteUrl = stdout.trim();
    } catch {
      // keep the remote name as-is
    }

    // Push
    await execFile('git', ['push', '-u', remote, branch], { cwd });

    return { branch, remote: remoteUrl, pushed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      branch: options.branch ?? 'unknown',
      remote: 'unknown',
      pushed: false,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// createPR
// ---------------------------------------------------------------------------

export async function createPR(options: {
  repoPath: string;
  title: string;
  body: string;
  base?: string;
}): Promise<{ url: string; number: number; error?: string }> {
  const cwd = options.repoPath;
  const base = options.base ?? 'main';

  try {
    const { stdout } = await execFile(
      'gh',
      ['pr', 'create', '--title', options.title, '--body', options.body, '--base', base, '--json', 'url,number'],
      { cwd },
    );

    const parsed = JSON.parse(stdout.trim()) as { url: string; number: number };
    return { url: parsed.url, number: parsed.number };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found') || message.includes('ENOENT')) {
      return { url: '', number: 0, error: 'gh CLI is not installed or not in PATH' };
    }
    return { url: '', number: 0, error: message };
  }
}

// ---------------------------------------------------------------------------
// checkCI
// ---------------------------------------------------------------------------

interface CICheck {
  name: string;
  status: 'pass' | 'fail' | 'pending' | 'skipped';
  durationSeconds?: number;
  url?: string;
}

export async function checkCI(options: {
  repoPath: string;
  pr?: number;
  ref?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<{
  status: 'pass' | 'fail' | 'pending' | 'timeout';
  checks: CICheck[];
  failedLogs?: string;
}> {
  const cwd = options.repoPath;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;

  if (!options.pr && !options.ref) {
    return { status: 'fail', checks: [], failedLogs: 'either pr or ref must be provided' };
  }

  while (Date.now() < deadline) {
    try {
      const args = options.pr
        ? ['pr', 'checks', String(options.pr), '--json', 'name,state,conclusion,detailsUrl,startedAt,completedAt']
        : ['run', 'list', '--branch', options.ref!, '--json', 'name,status,conclusion,databaseId', '--limit', '1'];

      const { stdout } = await execFile('gh', args, { cwd });
      const raw = JSON.parse(stdout.trim()) as Array<Record<string, unknown>>;

      if (raw.length === 0) {
        // No checks registered yet — wait and retry
        if (Date.now() + pollIntervalMs < deadline) {
          await sleep(pollIntervalMs);
          continue;
        }
        return { status: 'pending', checks: [] };
      }

      const checks: CICheck[] = raw.map((entry) => {
        const state = String(entry.state ?? entry.status ?? '').toUpperCase();
        const conclusion = String(entry.conclusion ?? '').toUpperCase();

        let status: CICheck['status'];
        if (state === 'PENDING' || state === 'QUEUED' || state === 'IN_PROGRESS' || state === 'REQUESTED' || state === 'WAITING') {
          status = 'pending';
        } else if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || state === 'SUCCESS') {
          status = 'pass';
        } else if (conclusion === 'SKIPPED') {
          status = 'skipped';
        } else {
          status = 'fail';
        }

        let durationSeconds: number | undefined;
        if (typeof entry.startedAt === 'string' && typeof entry.completedAt === 'string') {
          const start = new Date(entry.startedAt).getTime();
          const end = new Date(entry.completedAt).getTime();
          if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
            durationSeconds = Math.round((end - start) / 1000);
          }
        }

        return {
          name: String(entry.name ?? 'unknown'),
          status,
          durationSeconds,
          url: typeof entry.detailsUrl === 'string' ? entry.detailsUrl : undefined,
        };
      });

      const hasPending = checks.some((check) => check.status === 'pending');
      const hasFailed = checks.some((check) => check.status === 'fail');

      if (hasPending) {
        if (Date.now() + pollIntervalMs < deadline) {
          await sleep(pollIntervalMs);
          continue;
        }
        return { status: 'timeout', checks };
      }

      if (hasFailed) {
        let failedLogs: string | undefined;
        try {
          failedLogs = await collectFailedLogs(cwd, options.pr);
        } catch {
          // best-effort
        }
        return { status: 'fail', checks, failedLogs };
      }

      return { status: 'pass', checks };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('not found') || message.includes('ENOENT')) {
        return { status: 'fail', checks: [], failedLogs: 'gh CLI is not installed or not in PATH' };
      }
      // Transient error — retry if time remains
      if (Date.now() + pollIntervalMs < deadline) {
        await sleep(pollIntervalMs);
        continue;
      }
      return { status: 'fail', checks: [], failedLogs: message };
    }
  }

  return { status: 'timeout', checks: [] };
}

// ---------------------------------------------------------------------------
// readCILogs
// ---------------------------------------------------------------------------

export async function readCILogs(options: {
  repoPath: string;
  runId?: string;
}): Promise<{
  logs: string;
  failedJobs: Array<{ name: string; log: string }>;
}> {
  const cwd = options.repoPath;

  try {
    let runId = options.runId;

    // Find the latest failed run if no runId provided
    if (!runId) {
      const { stdout } = await execFile(
        'gh',
        ['run', 'list', '--status', 'failure', '--json', 'databaseId', '--limit', '1'],
        { cwd },
      );
      const runs = JSON.parse(stdout.trim()) as Array<{ databaseId: number }>;
      if (runs.length === 0) {
        return { logs: '', failedJobs: [] };
      }
      runId = String(runs[0]!.databaseId);
    }

    const { stdout: logOutput } = await execFile(
      'gh',
      ['run', 'view', runId, '--log-failed'],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
    );

    const failedJobs = parseFailedJobLogs(logOutput);

    return { logs: logOutput, failedJobs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found') || message.includes('ENOENT')) {
      return { logs: '', failedJobs: [{ name: 'error', log: 'gh CLI is not installed or not in PATH' }] };
    }
    return { logs: '', failedJobs: [{ name: 'error', log: message }] };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectFailedLogs(cwd: string, pr?: number): Promise<string> {
  // Find the run associated with this PR's latest commit
  const args = pr
    ? ['pr', 'checks', String(pr), '--json', 'name,state,conclusion']
    : ['run', 'list', '--status', 'failure', '--json', 'databaseId', '--limit', '1'];

  if (!pr) {
    const { stdout } = await execFile('gh', args, { cwd });
    const runs = JSON.parse(stdout.trim()) as Array<{ databaseId: number }>;
    if (runs.length === 0) return '';
    const { stdout: logOutput } = await execFile(
      'gh',
      ['run', 'view', String(runs[0]!.databaseId), '--log-failed'],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
    );
    return logOutput;
  }

  // For a PR, find the failed run via the checks
  const { stdout: checksOut } = await execFile(
    'gh',
    ['pr', 'view', String(pr), '--json', 'statusCheckRollup'],
    { cwd },
  );
  const prData = JSON.parse(checksOut.trim()) as {
    statusCheckRollup: Array<{ __typename: string; databaseId?: number; conclusion?: string }>;
  };
  const failedRun = prData.statusCheckRollup?.find(
    (check) => check.__typename === 'CheckRun' && check.conclusion === 'FAILURE' && check.databaseId,
  );
  if (!failedRun?.databaseId) return '';

  const { stdout: logOutput } = await execFile(
    'gh',
    ['run', 'view', String(failedRun.databaseId), '--log-failed'],
    { cwd, maxBuffer: 10 * 1024 * 1024 },
  );
  return logOutput;
}

function parseFailedJobLogs(logOutput: string): Array<{ name: string; log: string }> {
  // gh run view --log-failed outputs lines prefixed with "jobName\tstepName\tlogLine"
  const jobs = new Map<string, string[]>();

  for (const line of logOutput.split('\n')) {
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) continue;
    const jobName = line.slice(0, tabIndex);
    const rest = line.slice(tabIndex + 1);
    if (!jobs.has(jobName)) {
      jobs.set(jobName, []);
    }
    jobs.get(jobName)!.push(rest);
  }

  return Array.from(jobs.entries()).map(([name, lines]) => ({
    name,
    log: lines.join('\n'),
  }));
}
