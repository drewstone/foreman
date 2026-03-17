import { resolve } from 'node:path';

import { FilesystemTraceStore } from '@drew/foreman-tracing';

import { runSessionSurface, type SessionRunResult } from './session-run.js';

export interface SessionReplayOptions {
  traceRoot: string;
  traceId: string;
  traceOutputRoot?: string;
  approvalMode?: 'auto' | 'required' | 'never';
  approve?: boolean;
  profileId?: string;
  userId?: string;
  profileRoot?: string;
  memoryRoot?: string;
  outputPath?: string;
  markdownPath?: string;
}

export interface SessionReplayResult {
  sourceTraceId: string;
  replay: SessionRunResult;
}

export async function runSessionReplay(
  options: SessionReplayOptions,
): Promise<SessionReplayResult> {
  const traceStore = new FilesystemTraceStore(resolve(options.traceRoot));
  const bundle = await traceStore.get(options.traceId);
  if (!bundle) {
    throw new Error(`trace ${options.traceId} not found`);
  }
  if (bundle.metadata?.surface !== 'session') {
    throw new Error(`trace ${options.traceId} is not a session trace`);
  }

  const provider = normalizeProvider(bundle.metadata?.provider);
  const action = normalizeAction(bundle.metadata?.action);
  if (!provider || !action) {
    throw new Error(`trace ${options.traceId} is missing session replay metadata`);
  }

  const replay = await runSessionSurface({
    provider,
    action,
    sessionId: emptyToUndefined(bundle.metadata?.sessionId),
    cwd: emptyToUndefined(bundle.metadata?.cwd),
    targetUrl: emptyToUndefined(bundle.metadata?.targetUrl),
    prompt: emptyToUndefined(bundle.metadata?.prompt) ?? bundle.task.goal,
    approvalMode: options.approvalMode ?? normalizeApprovalMode(bundle.metadata?.approvalMode),
    approve: options.approve,
    profileId: options.profileId,
    userId: options.userId,
    profileRoot: options.profileRoot,
    memoryRoot: options.memoryRoot,
    traceRoot: options.traceOutputRoot,
    taskId: `${bundle.task.id}-replay`,
    outputPath: options.outputPath,
    markdownPath: options.markdownPath,
  });

  return {
    sourceTraceId: options.traceId,
    replay,
  };
}

function normalizeProvider(value: string | undefined): 'codex' | 'claude' | 'browser' | 'opencode' | 'openclaw' | undefined {
  return value === 'codex' || value === 'claude' || value === 'browser' || value === 'opencode' || value === 'openclaw'
    ? value
    : undefined;
}

function normalizeAction(value: string | undefined): 'start' | 'continue' | 'continue-last' | 'fork' | undefined {
  return value === 'start' || value === 'continue' || value === 'continue-last' || value === 'fork'
    ? value
    : undefined;
}

function normalizeApprovalMode(value: string | undefined): 'auto' | 'required' | 'never' {
  return value === 'auto' || value === 'required' || value === 'never'
    ? value
    : 'auto';
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}
