import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface SpawnResult {
  sessionId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  metrics?: import('./session-metrics.js').SessionMetrics;
}

export async function spawnSession(options: {
  repoPath: string;
  goal: string;
  sessionId?: string;
  resume?: boolean;
  claudeMd?: string;
  provider?: 'claude' | 'codex';
  timeoutMs?: number;
}): Promise<SpawnResult> {
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
      const dm = Date.now() - startedAt;
      const { parseClaudeMetrics, enrichMetrics, persistSessionMetrics } = await import('./session-metrics.js');
      let metrics = parseClaudeMetrics(stdout, {
        repo: options.repoPath.split('/').pop() ?? '',
        goal: options.goal,
        durationMs: dm,
        exitCode: 0,
      });
      metrics = await enrichMetrics(metrics, stdout);
      await persistSessionMetrics(metrics).catch(() => {});
      return {
        sessionId: metrics.sessionId !== 'unknown' ? metrics.sessionId : (options.sessionId ?? extractSessionId(stdout) ?? 'unknown'),
        exitCode: 0,
        stdout,
        stderr,
        durationMs: dm,
        metrics,
      };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number };
      const dm = Date.now() - startedAt;
      const exitCode = typeof err.code === 'number' ? err.code : 1;
      try {
        const { parseClaudeMetrics, persistSessionMetrics } = await import('./session-metrics.js');
        const metrics = parseClaudeMetrics(err.stdout ?? '', {
          repo: options.repoPath.split('/').pop() ?? '',
          goal: options.goal,
          durationMs: dm,
          exitCode,
        });
        await persistSessionMetrics(metrics).catch(() => {});
      } catch { /* metrics extraction failed — non-fatal */ }
      return {
        sessionId: options.sessionId ?? 'unknown',
        exitCode,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? String(error),
        durationMs: dm,
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
    const dm = Date.now() - startedAt;
    const { parseCodexMetrics, persistSessionMetrics } = await import('./session-metrics.js');
    const metrics = parseCodexMetrics(stdout, {
      repo: options.repoPath.split('/').pop() ?? '',
      goal: options.goal,
      durationMs: dm,
      exitCode: 0,
    });
    await persistSessionMetrics(metrics).catch(() => {});
    return {
      sessionId: metrics.sessionId !== 'unknown' ? metrics.sessionId : (options.sessionId ?? 'unknown'),
      exitCode: 0,
      stdout,
      stderr,
      durationMs: dm,
      metrics,
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    const dm = Date.now() - startedAt;
    const exitCode = typeof err.code === 'number' ? err.code : 1;
    try {
      const { parseCodexMetrics, persistSessionMetrics } = await import('./session-metrics.js');
      const metrics = parseCodexMetrics(err.stdout ?? '', {
        repo: options.repoPath.split('/').pop() ?? '',
        goal: options.goal,
        durationMs: dm,
        exitCode,
      });
      await persistSessionMetrics(metrics).catch(() => {});
    } catch { /* non-fatal */ }
    return {
      sessionId: options.sessionId ?? 'unknown',
      exitCode,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(error),
      durationMs: dm,
    };
  }
}

function extractSessionId(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output);
    return parsed?.session_id;
  } catch {
    return undefined;
  }
}
