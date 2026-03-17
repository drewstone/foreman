import { resolve } from 'node:path';

import { runLearnOperator, type LearnOperatorResult } from './learn-operator.js';

export interface SyncOperatorOptions {
  profileId: string;
  profileName?: string;
  userId?: string;
  profileRoot?: string;
  memoryRoot?: string;
  traceRoots?: string[];
  transcriptRoots?: string[];
  repoPaths?: string[];
  sessionProviders?: Array<'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw'>;
  sessionCwd?: string;
  sessionLimitPerProvider?: number;
  maxTranscriptFiles?: number;
  since?: string;
  lookbackDays?: number;
  provider?: 'codex' | 'claude';
  providerTimeoutMs?: number;
  outputPath?: string;
  markdownPath?: string;
}

export interface SyncOperatorResult extends LearnOperatorResult {
  sessionProviders: Array<'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw'>;
  memoryBackend: 'filesystem' | 'postgres';
}

export async function runSyncOperator(
  options: SyncOperatorOptions,
): Promise<SyncOperatorResult> {
  const profileRoot = resolve(options.profileRoot ?? '.foreman/profiles');
  const memoryRoot = resolve(options.memoryRoot ?? '.foreman/memory');
  const sessionCwd = options.sessionCwd ? resolve(options.sessionCwd) : process.cwd();
  const sessionProviders = options.sessionProviders
    ?? ['claude', 'codex', 'opencode', 'openclaw', 'browser'];

  const result = await runLearnOperator({
    profileId: options.profileId,
    profileName: options.profileName,
    userId: options.userId,
    profileRoot,
    memoryRoot,
    traceRoots: options.traceRoots,
    transcriptRoots: options.transcriptRoots,
    repoPaths: options.repoPaths,
    sessionProviders,
    sessionCwd,
    sessionLimitPerProvider: options.sessionLimitPerProvider,
    maxTranscriptFiles: options.maxTranscriptFiles,
    since: options.since,
    lookbackDays: options.lookbackDays ?? 7,
    provider: options.provider ?? 'claude',
    providerTimeoutMs: options.providerTimeoutMs,
    outputPath: options.outputPath,
    markdownPath: options.markdownPath,
  });

  return {
    ...result,
    sessionProviders,
    memoryBackend: process.env.FOREMAN_MEMORY_DATABASE_URL || process.env.FOREMAN_POSTGRES_URL
      ? 'postgres'
      : 'filesystem',
  };
}
