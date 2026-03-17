import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { runProfileBootstrap, type ProfileBootstrapRunResult } from './profile-bootstrap.js';
import { runSessionReview, type SessionReviewResult } from './session-review.js';
import { runWorkContinuation, type WorkContinuationResult } from './work-continuation.js';

export interface LearnOperatorOptions {
  profileId: string;
  profileName?: string;
  userId?: string;
  profileRoot: string;
  memoryRoot: string;
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

export interface LearnOperatorResult {
  profileId: string;
  summary: string;
  bootstrap: ProfileBootstrapRunResult;
  review: SessionReviewResult;
  continuation: WorkContinuationResult;
  outputPath?: string;
  markdownPath?: string;
}

export async function runLearnOperator(
  options: LearnOperatorOptions,
): Promise<LearnOperatorResult> {
  const sessionProviders = options.sessionProviders
    ?? inferDefaultSessionProviders(options.sessionCwd);

  const bootstrap = await runProfileBootstrap({
    profileId: options.profileId,
    profileName: options.profileName,
    userId: options.userId,
    profileRoot: options.profileRoot,
    memoryRoot: options.memoryRoot,
    traceRoots: options.traceRoots ?? [],
    transcriptRoots: options.transcriptRoots ?? [],
    repoPaths: options.repoPaths ?? [],
    maxTranscriptFiles: options.maxTranscriptFiles,
  });

  const review = await runSessionReview({
    profileId: options.profileId,
    userId: options.userId,
    profileRoot: options.profileRoot,
    memoryRoot: options.memoryRoot,
    traceRoots: options.traceRoots,
    transcriptRoots: options.transcriptRoots,
    sessionProviders,
    sessionCwd: options.sessionCwd,
    sessionLimitPerProvider: options.sessionLimitPerProvider,
    repoPaths: options.repoPaths,
    provider: options.provider,
    providerTimeoutMs: options.providerTimeoutMs,
    maxTranscriptFiles: options.maxTranscriptFiles,
    since: options.since,
    lookbackDays: options.lookbackDays,
    applyMemoryUpdates: true,
  });

  const continuation = await runWorkContinuation({
    profileId: options.profileId,
    userId: options.userId,
    profileRoot: options.profileRoot,
    memoryRoot: options.memoryRoot,
    traceRoots: options.traceRoots,
    transcriptRoots: options.transcriptRoots,
    sessionProviders,
    sessionCwd: options.sessionCwd,
    sessionLimitPerProvider: options.sessionLimitPerProvider,
    repoPaths: options.repoPaths,
    provider: options.provider,
    providerTimeoutMs: options.providerTimeoutMs,
    sessionReviewProvider: options.provider,
    sessionReviewTimeoutMs: options.providerTimeoutMs,
    maxTranscriptFiles: options.maxTranscriptFiles,
    since: options.since,
    lookbackDays: options.lookbackDays,
    applyMemoryUpdates: true,
  });

  const result: LearnOperatorResult = {
    profileId: options.profileId,
    summary: [
      bootstrap.summary,
      review.summary,
      continuation.summary,
    ].filter(Boolean).join(' '),
    bootstrap,
    review,
    continuation,
  };

  let outputPath: string | undefined;
  if (options.outputPath) {
    outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    result.outputPath = outputPath;
  }

  let markdownPath: string | undefined;
  if (options.markdownPath) {
    markdownPath = resolve(options.markdownPath);
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, renderLearnOperatorMarkdown(result, sessionProviders), 'utf8');
    result.markdownPath = markdownPath;
  }

  return result;
}

function inferDefaultSessionProviders(
  sessionCwd?: string,
): Array<'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw'> {
  return sessionCwd
    ? ['claude', 'codex', 'opencode', 'openclaw', 'browser']
    : ['claude', 'codex', 'opencode', 'openclaw'];
}

function renderLearnOperatorMarkdown(
  result: LearnOperatorResult,
  sessionProviders: Array<'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw'>,
): string {
  const lines: string[] = [
    '# Foreman Operator Learning',
    '',
    `- Profile: ${result.profileId}`,
    `- Session providers: ${sessionProviders.join(', ') || 'none'}`,
    '',
    result.summary,
    '',
    '## Bootstrap',
    '',
    result.bootstrap.summary,
    '',
    '## Session Review',
    '',
    result.review.summary,
    '',
    '## Continuation',
    '',
    result.continuation.summary,
    '',
    '## Recommended Next Runs',
  ];

  if (result.continuation.plan.proposals.length === 0) {
    lines.push('- None');
  } else {
    for (const proposal of result.continuation.plan.proposals) {
      lines.push(`- [${proposal.priority}] ${proposal.title}`);
      lines.push(`  Surface: ${proposal.surface}`);
      lines.push(`  Goal: ${proposal.goal}`);
      lines.push(`  Next step: ${proposal.nextStep}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
