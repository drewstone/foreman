import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { classifySessionFailure, type FailureClass } from '@drew/foreman-evals';
import { createMemoryStore, recordWorkerRun } from '@drew/foreman-memory';
import { createTraceStore } from '@drew/foreman-tracing';

import { loadOperatorRuntimeContext, scoreOperatorPreference } from './operator-adaptation.js';
import { runProviderSessionSurface, type ProviderSessionSurfaceOptions } from './provider-session.js';
import { runSessionRegistry } from './session-registry.js';
import { emitSessionRunTelemetry } from './telemetry-client.js';

type SessionProviderName = 'codex' | 'claude' | 'browser' | 'opencode' | 'openclaw';

export interface SessionRunOptions extends Omit<ProviderSessionSurfaceOptions, 'action' | 'provider'> {
  provider: SessionProviderName | 'auto';
  action: 'start' | 'continue' | 'continue-last' | 'fork';
  profileId?: string;
  userId?: string;
  profileRoot?: string;
  memoryRoot?: string;
  approvalMode?: 'auto' | 'required' | 'never';
  approve?: boolean;
  traceRoot?: string;
  taskId?: string;
  outputPath?: string;
  markdownPath?: string;
}

export interface SessionRunResult {
  status: 'completed' | 'failed' | 'needs-approval';
  provider: SessionProviderName;
  requestedProvider: SessionRunOptions['provider'];
  action: SessionRunOptions['action'];
  sessionId?: string;
  summary: string;
  traceId?: string;
  resolutionReasons?: string[];
  detectedFailureReason?: string;
  approvalRequired?: boolean;
  approvalReason?: string;
  failureClasses?: FailureClass[];
  outputPath?: string;
  markdownPath?: string;
  execution?: NonNullable<Awaited<ReturnType<typeof runProviderSessionSurface>>['execution']>;
}

export async function runSessionSurface(
  options: SessionRunOptions,
): Promise<SessionRunResult> {
  const resolved = await resolveSessionProvider(options);
  const approvalReason = await resolveSessionApprovalReason(options, resolved.provider);
  if (approvalReason && !options.approve) {
    const summary = `${resolved.provider} session ${options.action} requires approval: ${approvalReason}`;
    const traceId = options.traceRoot
      ? await writeSessionTrace({
          traceRoot: options.traceRoot,
          provider: resolved.provider,
          requestedProvider: options.provider,
          action: options.action,
          sessionId: options.sessionId,
          taskId: options.taskId,
          prompt: options.prompt,
          cwd: options.cwd,
          targetUrl: options.targetUrl,
          approvalMode: options.approvalMode,
          summary,
          outcomeStatus: 'blocked',
          validated: false,
          resolutionReasons: resolved.reasons,
          failureClasses: ['approval-required'],
          approvalReason,
        })
      : undefined;

    const gatedResult: SessionRunResult = {
      status: 'needs-approval',
      provider: resolved.provider,
      requestedProvider: options.provider,
      action: options.action,
      sessionId: options.sessionId,
      summary,
      traceId,
      resolutionReasons: resolved.reasons,
      approvalRequired: true,
      approvalReason,
      failureClasses: ['approval-required'],
    };

    if (options.outputPath) {
      const outputPath = resolve(options.outputPath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(gatedResult, null, 2)}\n`, 'utf8');
      gatedResult.outputPath = outputPath;
    }

    if (options.markdownPath) {
      const markdownPath = resolve(options.markdownPath);
      await mkdir(dirname(markdownPath), { recursive: true });
      await writeFile(markdownPath, renderSessionRunMarkdown(gatedResult), 'utf8');
      gatedResult.markdownPath = markdownPath;
    }

    return gatedResult;
  }

  const result = await runProviderSessionSurface({
    ...options,
    provider: resolved.provider,
  });
  if (!result.execution) {
    throw new Error('session execution did not return an execution result');
  }

  const execution = result.execution;
  const detectedFailureReason = inferExecutionFailure(execution);
  const completed = execution.exitCode === 0 && !detectedFailureReason;
  const failureClasses = completed
    ? []
    : classifySessionFailure({
        detectedFailureReason,
        stderr: execution.stderr,
        exitCode: execution.exitCode,
      });
  const summary = completed
    ? `${resolved.provider} session ${options.action} completed`
    : `${resolved.provider} session ${options.action} failed${detectedFailureReason ? `: ${detectedFailureReason}` : ` with exit code ${execution.exitCode}`}`;

  const traceId = options.traceRoot
      ? await writeSessionTrace({
        traceRoot: options.traceRoot,
        provider: resolved.provider,
        requestedProvider: options.provider,
        action: options.action,
        sessionId: execution.sessionId,
        taskId: options.taskId,
        prompt: options.prompt,
        cwd: options.cwd,
        targetUrl: options.targetUrl,
        approvalMode: options.approvalMode,
        summary,
        outcomeStatus: completed ? 'completed' : 'failed',
        validated: completed,
        resolutionReasons: resolved.reasons,
        failureClasses,
        detectedFailureReason,
        execution,
      })
    : undefined;

  const sessionRunResult: SessionRunResult = {
    status: completed ? 'completed' : 'failed',
    provider: resolved.provider,
    requestedProvider: options.provider,
    action: options.action,
    sessionId: execution.sessionId,
    summary,
    traceId,
    resolutionReasons: resolved.reasons,
    detectedFailureReason,
    failureClasses,
    execution,
  };

  if (options.memoryRoot) {
    await updateSessionWorkerMemory({
      memoryRoot: options.memoryRoot,
      provider: resolved.provider,
      execution,
      completed,
      failureClasses,
    });
  }

  let outputPath: string | undefined;
  if (options.outputPath) {
    outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(sessionRunResult, null, 2)}\n`, 'utf8');
    sessionRunResult.outputPath = outputPath;
  }

  let markdownPath: string | undefined;
  if (options.markdownPath) {
    markdownPath = resolve(options.markdownPath);
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, renderSessionRunMarkdown(sessionRunResult), 'utf8');
    sessionRunResult.markdownPath = markdownPath;
  }

  await emitSessionRunTelemetry(sessionRunResult, options);

  return sessionRunResult;
}

function renderSessionRunMarkdown(result: SessionRunResult): string {
  const lines = [
    '# Foreman Session Run',
    '',
    `- Status: ${result.status}`,
    `- Provider: ${result.provider}`,
    `- Requested provider: ${result.requestedProvider}`,
    `- Action: ${result.action}`,
    `- Session id: ${result.sessionId ?? 'n/a'}`,
    `- Trace id: ${result.traceId ?? 'n/a'}`,
    ...(result.approvalReason ? [`- Approval reason: ${result.approvalReason}`] : []),
    ...(result.detectedFailureReason ? [`- Detected failure: ${result.detectedFailureReason}`] : []),
    ...(result.failureClasses?.length ? [`- Failure classes: ${result.failureClasses.join(', ')}`] : []),
    ...(result.resolutionReasons?.length
      ? ['', '## Resolution', ...result.resolutionReasons.map((reason) => `- ${reason}`)]
      : []),
    '',
    result.summary,
  ];
  return `${lines.join('\n')}\n`;
}

async function resolveSessionApprovalReason(
  options: SessionRunOptions,
  provider: SessionProviderName,
): Promise<string | undefined> {
  const approvalMode = options.approvalMode ?? 'auto';
  if (approvalMode === 'never' || options.approve) {
    return undefined;
  }
  if (approvalMode === 'required') {
    return 'explicit approval mode requires confirmation before execution';
  }
  if (!options.sessionId || (options.action !== 'continue' && options.action !== 'fork')) {
    return undefined;
  }

  const registry = await runSessionRegistry({
    providers: [provider],
    cwd: options.cwd,
    limitPerProvider: 100,
    maxItems: 200,
  });
  const matched = registry.items.find((item) => item.sessionId === options.sessionId);
  if (matched?.state === 'human-active') {
    return `session ${options.sessionId} is classified as human-active`;
  }
  return undefined;
}

async function resolveSessionProvider(options: SessionRunOptions): Promise<{
  provider: SessionProviderName;
  reasons: string[];
}> {
  if (options.provider !== 'auto') {
    return {
      provider: options.provider,
      reasons: ['provider specified explicitly'],
    };
  }

  if (options.sessionId) {
    const matchedSession = await findProviderSessionById(options.sessionId, options.cwd);
    if (matchedSession) {
      return {
        provider: matchedSession.provider,
        reasons: [`matched existing ${matchedSession.provider} session ${options.sessionId}`],
      };
    }
  }

  if (options.targetUrl && options.action === 'start') {
    return {
      provider: 'browser',
      reasons: ['browser start selected because targetUrl was provided'],
    };
  }

  const operatorContext = await loadOperatorRuntimeContext({
    profileId: options.profileId,
    userId: options.userId,
    profileRoot: options.profileRoot,
    memoryRoot: options.memoryRoot,
    workerIds: ['codex', 'claude', 'browser', 'opencode', 'openclaw'],
    taskShapes: [options.targetUrl ? 'browser' : 'session'],
  });

  const candidates: SessionProviderName[] = options.action === 'start' && options.targetUrl
    ? ['browser', 'codex', 'claude', 'opencode', 'openclaw']
    : ['codex', 'claude', 'opencode', 'openclaw', 'browser'];
  const ranked = candidates
    .map((provider) => ({
      provider,
      preference: scoreOperatorPreference({
        providerOrWorker: provider,
        capability: provider === 'browser' ? 'browser' : provider === 'openclaw' ? 'hybrid' : 'code',
        taskShape: options.targetUrl ? 'browser' : 'session',
        environmentHints: [options.cwd, options.targetUrl].filter((value): value is string => Boolean(value)),
        text: [options.prompt, options.taskId, options.cwd].filter(Boolean).join(' '),
      }, operatorContext),
    }))
    .sort((left, right) =>
      right.preference.score - left.preference.score
      || providerPriority(right.provider) - providerPriority(left.provider)
      || left.provider.localeCompare(right.provider),
    );

  const winner = ranked[0];
  if (!winner || winner.preference.score <= 0) {
    return {
      provider: 'claude',
      reasons: ['no stored operator preference matched; defaulted to claude'],
    };
  }

  return {
    provider: winner.provider,
    reasons: [
      `selected ${winner.provider} from learned operator memory`,
      ...winner.preference.reasons,
    ],
  };
}

async function findProviderSessionById(
  sessionId: string,
  cwd?: string,
): Promise<Awaited<ReturnType<typeof runSessionRegistry>>['items'][number] | undefined> {
  const hintedProviders = inferSessionIdProviderOrder(sessionId);
  for (const provider of hintedProviders) {
    const registry = await runSessionRegistry({
      providers: [provider],
      cwd,
      limitPerProvider: 100,
      maxItems: 200,
    });
    const matched = registry.items.find((item) => item.sessionId === sessionId);
    if (matched) {
      return matched;
    }
  }
  return undefined;
}

function inferSessionIdProviderOrder(sessionId: string): SessionProviderName[] {
  if (sessionId.startsWith('ses_')) {
    return ['opencode'];
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return ['openclaw', 'claude', 'browser', 'codex', 'opencode'];
  }
  return ['codex', 'claude', 'browser', 'opencode', 'openclaw'];
}

function providerPriority(provider: SessionProviderName): number {
  switch (provider) {
    case 'codex':
      return 4;
    case 'claude':
      return 3;
    case 'browser':
      return 2;
    case 'openclaw':
      return 1.5;
    case 'opencode':
    default:
      return 1;
  }
}

async function updateSessionWorkerMemory(input: {
  memoryRoot: string;
  provider: SessionProviderName;
  execution: NonNullable<SessionRunResult['execution']>;
  completed: boolean;
  failureClasses: FailureClass[];
}): Promise<void> {
  const memoryStore = await createMemoryStore({
    rootDir: resolve(input.memoryRoot),
  });
  const existing = await memoryStore.getWorkerMemory(input.provider);
  const updated = recordWorkerRun(
    existing ? { ...existing, workerId: input.provider } : { workerId: input.provider },
    {
      succeeded: input.completed,
      durationMs: input.execution.durationMs,
      costUsd: input.execution.costUsd,
      failureClasses: input.failureClasses,
    },
  );
  updated.workerId = input.provider;
  await memoryStore.putWorkerMemory(updated);
}

async function writeSessionTrace(input: {
  traceRoot: string;
  provider: SessionProviderName;
  requestedProvider: SessionRunOptions['provider'];
  action: SessionRunOptions['action'];
  sessionId?: string;
  taskId?: string;
  prompt?: string;
  cwd?: string;
  targetUrl?: string;
  approvalMode?: 'auto' | 'required' | 'never';
  summary: string;
  outcomeStatus: 'completed' | 'failed' | 'blocked';
  validated: boolean;
  resolutionReasons: string[];
  failureClasses?: FailureClass[];
  approvalReason?: string;
  detectedFailureReason?: string;
  execution?: NonNullable<Awaited<ReturnType<typeof runProviderSessionSurface>>['execution']>;
}): Promise<string> {
  const store = await createTraceStore({
    rootDir: resolve(input.traceRoot),
  });
  return store.put({
    task: {
      id: input.taskId ?? `${input.provider}-${input.action}-${input.execution?.sessionId ?? 'session'}`,
      goal: input.prompt ?? 'Continue session work',
      environmentKind: input.provider === 'browser' ? 'browser' : 'hybrid',
    },
    events: input.execution ? [
      {
        at: input.execution.startedAt,
        kind: 'session.started',
        workerId: input.provider,
        summary: `${input.provider} ${input.action} started`,
        metadata: {
          surface: 'session',
          action: input.action,
          sessionId: input.execution.sessionId ?? '',
          cwd: input.cwd ?? '',
          targetUrl: input.targetUrl ?? '',
          approvalMode: input.approvalMode ?? 'auto',
          requestedProvider: input.requestedProvider,
          resolutionReasons: input.resolutionReasons.join(' | '),
        },
      },
      {
        at: input.execution.finishedAt,
        kind: input.outcomeStatus === 'completed' ? 'session.completed' : 'session.failed',
        workerId: input.provider,
        summary: input.summary,
        metadata: {
          surface: 'session',
          action: input.action,
          sessionId: input.execution.sessionId ?? '',
          durationMs: String(input.execution.durationMs),
          exitCode: String(input.execution.exitCode),
          requestedProvider: input.requestedProvider,
          targetUrl: input.targetUrl ?? '',
          approvalMode: input.approvalMode ?? 'auto',
          resolutionReasons: input.resolutionReasons.join(' | '),
          detectedFailureReason: input.detectedFailureReason ?? '',
          failureClasses: (input.failureClasses ?? []).join(','),
          ...(input.execution.costUsd !== undefined ? { costUsd: String(input.execution.costUsd) } : {}),
          ...(input.execution.metadata ?? {}),
        },
      },
    ] : [
      {
        at: new Date().toISOString(),
        kind: 'session.blocked',
        workerId: input.provider,
        summary: input.summary,
        metadata: {
          surface: 'session',
          action: input.action,
          sessionId: input.sessionId ?? '',
          cwd: input.cwd ?? '',
          targetUrl: input.targetUrl ?? '',
          approvalMode: input.approvalMode ?? 'auto',
          requestedProvider: input.requestedProvider,
          resolutionReasons: input.resolutionReasons.join(' | '),
          approvalReason: input.approvalReason ?? '',
          failureClasses: (input.failureClasses ?? []).join(','),
        },
      },
    ],
    evidence: input.execution ? [
      {
        kind: 'log',
        label: 'stdout',
        value: (input.execution.rawStdout ?? input.execution.stdout).trim(),
        metadata: {
          surface: 'session',
          provider: input.provider,
          action: input.action,
          sessionId: input.execution.sessionId ?? '',
          durationMs: String(input.execution.durationMs),
          exitCode: String(input.execution.exitCode),
          requestedProvider: input.requestedProvider,
          targetUrl: input.targetUrl ?? '',
          approvalMode: input.approvalMode ?? 'auto',
          resolutionReasons: input.resolutionReasons.join(' | '),
          detectedFailureReason: input.detectedFailureReason ?? '',
          failureClasses: (input.failureClasses ?? []).join(','),
          ...(input.execution.costUsd !== undefined ? { costUsd: String(input.execution.costUsd) } : {}),
          ...(input.execution.metadata ?? {}),
        },
      },
      {
        kind: 'log',
        label: 'stderr',
        value: input.execution.stderr.trim(),
        metadata: {
          surface: 'session',
          provider: input.provider,
          action: input.action,
          targetUrl: input.targetUrl ?? '',
          approvalMode: input.approvalMode ?? 'auto',
          sessionId: input.execution.sessionId ?? '',
          durationMs: String(input.execution.durationMs),
          exitCode: String(input.execution.exitCode),
          failureClasses: (input.failureClasses ?? []).join(','),
        },
      },
    ] : [
      {
        kind: 'note',
        label: 'approval',
        value: input.approvalReason ?? 'approval required before execution',
        metadata: {
          surface: 'session',
          provider: input.provider,
          action: input.action,
          targetUrl: input.targetUrl ?? '',
          approvalMode: input.approvalMode ?? 'auto',
          requestedProvider: input.requestedProvider,
          failureClasses: (input.failureClasses ?? []).join(','),
        },
      },
    ],
    outcome: {
      status: input.outcomeStatus,
      summary: input.summary,
      validated: input.validated,
    },
    metadata: {
      surface: 'session',
      provider: input.provider,
      requestedProvider: input.requestedProvider,
      action: input.action,
      sessionId: input.execution?.sessionId ?? input.sessionId ?? '',
      cwd: input.cwd ?? '',
      targetUrl: input.targetUrl ?? '',
      approvalMode: input.approvalMode ?? 'auto',
      prompt: input.prompt ?? '',
      resolutionReasons: input.resolutionReasons.join(' | '),
      detectedFailureReason: input.detectedFailureReason ?? '',
      approvalReason: input.approvalReason ?? '',
      failureClasses: (input.failureClasses ?? []).join(','),
      ...(input.execution?.costUsd !== undefined ? { costUsd: String(input.execution.costUsd) } : {}),
      ...(input.execution?.metadata ?? {}),
    },
  });
}

function inferExecutionFailure(
  execution: NonNullable<Awaited<ReturnType<typeof runProviderSessionSurface>>['execution']>,
): string | undefined {
  const stderr = execution.stderr.trim();
  if (!stderr) {
    return undefined;
  }

  if (/ProviderModelNotFoundError|ModelNotFoundError|provider not found|model not found/i.test(stderr)) {
    return 'provider or model resolution failed inside the session runtime';
  }

  if (/timed out|timeout/i.test(stderr) && execution.stdout.trim().length === 0) {
    return 'session runtime reported a timeout';
  }

  return undefined;
}
