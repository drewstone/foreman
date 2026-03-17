import { resolve } from 'node:path';

import { FilesystemTraceStore } from '@drew/foreman-tracing';

import { runSupervisorSurface, type SupervisorRunResult } from './supervisor-run.js';

export interface SupervisorReplayOptions {
  traceRoot: string;
  traceId: string;
  traceOutputRoot?: string;
  approvalMode?: 'auto' | 'required' | 'never';
  approve?: boolean;
  outputPath?: string;
  markdownPath?: string;
}

export interface SupervisorReplayResult {
  sourceTraceId: string;
  replay: SupervisorRunResult;
}

export async function runSupervisorReplay(
  options: SupervisorReplayOptions,
): Promise<SupervisorReplayResult> {
  const traceStore = new FilesystemTraceStore(resolve(options.traceRoot));
  const bundle = await traceStore.get(options.traceId);
  if (!bundle) {
    throw new Error(`trace ${options.traceId} not found`);
  }
  if (bundle.metadata?.surface !== 'supervisor') {
    throw new Error(`trace ${options.traceId} is not a supervisor trace`);
  }

  const command = emptyToUndefined(bundle.metadata?.command);
  const url = emptyToUndefined(bundle.metadata?.url);
  if (!command && !url) {
    throw new Error(`trace ${options.traceId} is missing command/url replay metadata`);
  }

  const replay = await runSupervisorSurface({
    command,
    url,
    method: emptyToUndefined(bundle.metadata?.method),
    body: emptyToUndefined(bundle.metadata?.body),
    cwd: emptyToUndefined(bundle.metadata?.cwd),
    label: emptyToUndefined(bundle.metadata?.label) ?? `${bundle.task.id} replay`,
    approvalMode: options.approvalMode ?? normalizeApprovalMode(bundle.metadata?.approvalMode),
    approve: options.approve,
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

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

function normalizeApprovalMode(value: string | undefined): 'auto' | 'required' | 'never' {
  return value === 'auto' || value === 'required' || value === 'never'
    ? value
    : 'auto';
}
