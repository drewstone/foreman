import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { FilesystemTraceStore, type TraceBundle } from '@drew/foreman-tracing';

import { runSessionReplay, type SessionReplayOptions } from './session-replay.js';

export interface SessionBenchmarkOptions extends Omit<SessionReplayOptions, 'traceId' | 'outputPath' | 'markdownPath'> {
  traceIds?: string[];
  maxCases?: number;
  reportPath?: string;
}

export interface SessionBenchmarkCaseResult {
  sourceTraceId: string;
  sourceTaskId: string;
  replayTraceId?: string;
  sourceOutcomeStatus?: string;
  sourceValidated: boolean;
  replayOutcomeStatus?: string;
  replayValidated: boolean;
  outcomeStatusMatched: boolean;
  validationMatched: boolean;
  sourceFailureClasses: string[];
  replayFailureClasses: string[];
  sourceProvider?: string;
  replayProvider?: string;
}

export interface SessionBenchmarkResult {
  summary: {
    totalCases: number;
    validationMatches: number;
    outcomeMatches: number;
    replayValidatedCases: number;
    providerMatches: number;
  };
  cases: SessionBenchmarkCaseResult[];
}

export async function runSessionBenchmark(
  options: SessionBenchmarkOptions,
): Promise<SessionBenchmarkResult> {
  const sourceTraceRoot = resolve(options.traceRoot);
  const replayTraceRoot = resolve(options.traceOutputRoot ?? join(sourceTraceRoot, '..', 'session-benchmark-traces'));
  await mkdir(replayTraceRoot, { recursive: true });

  const sourceStore = new FilesystemTraceStore(sourceTraceRoot);
  const replayStore = new FilesystemTraceStore(replayTraceRoot);
  const requestedTraceIds = options.traceIds?.length
    ? options.traceIds
    : (await sourceStore.list()).map((item) => item.traceId);

  const selectedTraceIds: string[] = [];
  for (const traceId of requestedTraceIds) {
    const bundle = await sourceStore.get(traceId);
    if (bundle?.metadata?.surface === 'session') {
      selectedTraceIds.push(traceId);
    }
    if (selectedTraceIds.length >= (options.maxCases ?? requestedTraceIds.length)) {
      break;
    }
  }

  const cases: SessionBenchmarkCaseResult[] = [];
  for (const traceId of selectedTraceIds) {
    const sourceBundle = await sourceStore.get(traceId);
    if (!sourceBundle) {
      continue;
    }
    const replay = await runSessionReplay({
      traceRoot: sourceTraceRoot,
      traceId,
      traceOutputRoot: replayTraceRoot,
      approvalMode: options.approvalMode,
      approve: options.approve,
      profileId: options.profileId,
      userId: options.userId,
      profileRoot: options.profileRoot,
      memoryRoot: options.memoryRoot,
    });
    const replayTraceId = replay.replay.traceId;
    const replayBundle = replayTraceId ? await replayStore.get(replayTraceId) : null;
    cases.push(buildSessionBenchmarkCase({
      sourceTraceId: traceId,
      sourceBundle,
      replayTraceId,
      replayBundle,
      replayProvider: replay.replay.provider,
    }));
  }

  const result: SessionBenchmarkResult = {
    summary: {
      totalCases: cases.length,
      validationMatches: cases.filter((item) => item.validationMatched).length,
      outcomeMatches: cases.filter((item) => item.outcomeStatusMatched).length,
      replayValidatedCases: cases.filter((item) => item.replayValidated).length,
      providerMatches: cases.filter((item) => item.sourceProvider === item.replayProvider).length,
    },
    cases,
  };

  if (options.reportPath) {
    const reportPath = resolve(options.reportPath);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  return result;
}

function buildSessionBenchmarkCase(input: {
  sourceTraceId: string;
  sourceBundle: TraceBundle;
  replayTraceId?: string;
  replayBundle: TraceBundle | null;
  replayProvider?: string;
}): SessionBenchmarkCaseResult {
  const sourceFailureClasses = parseStringList(input.sourceBundle.metadata?.failureClasses);
  const replayFailureClasses = parseStringList(input.replayBundle?.metadata?.failureClasses);
  const sourceOutcomeStatus = input.sourceBundle.outcome?.status;
  const replayOutcomeStatus = input.replayBundle?.outcome?.status;
  const sourceValidated = input.sourceBundle.outcome?.validated ?? false;
  const replayValidated = input.replayBundle?.outcome?.validated ?? false;

  return {
    sourceTraceId: input.sourceTraceId,
    sourceTaskId: input.sourceBundle.task.id,
    replayTraceId: input.replayTraceId,
    sourceOutcomeStatus,
    sourceValidated,
    replayOutcomeStatus,
    replayValidated,
    outcomeStatusMatched: sourceOutcomeStatus === replayOutcomeStatus,
    validationMatched: sourceValidated === replayValidated,
    sourceFailureClasses,
    replayFailureClasses,
    sourceProvider: input.sourceBundle.metadata?.provider,
    replayProvider: input.replayProvider,
  };
}

function parseStringList(value: string | undefined): string[] {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}
