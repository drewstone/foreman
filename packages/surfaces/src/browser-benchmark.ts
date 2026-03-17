import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { FilesystemTraceStore, type TraceBundle } from '@drew/foreman-tracing';

import { runBrowserReplay, type BrowserReplayOptions } from './browser-replay.js';

export interface BrowserBenchmarkOptions extends Omit<BrowserReplayOptions, 'traceId' | 'outputPath' | 'markdownPath'> {
  traceIds?: string[];
  maxCases?: number;
  reportPath?: string;
}

export interface BrowserBenchmarkCaseResult {
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
  sourceSessionId?: string;
  replaySessionId?: string;
  sessionIdMatched: boolean;
  sourceTargetUrl?: string;
  replayTargetUrl?: string;
  targetUrlMatched: boolean;
}

export interface BrowserBenchmarkResult {
  summary: {
    totalCases: number;
    validationMatches: number;
    outcomeMatches: number;
    replayValidatedCases: number;
    sessionIdMatches: number;
    targetUrlMatches: number;
  };
  cases: BrowserBenchmarkCaseResult[];
}

export async function runBrowserBenchmark(
  options: BrowserBenchmarkOptions,
): Promise<BrowserBenchmarkResult> {
  const sourceTraceRoot = resolve(options.traceRoot);
  const replayTraceRoot = resolve(options.traceOutputRoot ?? `${sourceTraceRoot}-browser-benchmark`);
  await mkdir(replayTraceRoot, { recursive: true });

  const sourceStore = new FilesystemTraceStore(sourceTraceRoot);
  const replayStore = new FilesystemTraceStore(replayTraceRoot);
  const requestedTraceIds = options.traceIds?.length
    ? options.traceIds
    : (await sourceStore.list()).map((item) => item.traceId);

  const selectedTraceIds: string[] = [];
  for (const traceId of requestedTraceIds) {
    const bundle = await sourceStore.get(traceId);
    if (bundle?.metadata?.surface === 'session' && bundle.metadata?.provider === 'browser') {
      selectedTraceIds.push(traceId);
    }
    if (selectedTraceIds.length >= (options.maxCases ?? requestedTraceIds.length)) {
      break;
    }
  }

  const cases: BrowserBenchmarkCaseResult[] = [];
  for (const traceId of selectedTraceIds) {
    const sourceBundle = await sourceStore.get(traceId);
    if (!sourceBundle) {
      continue;
    }
    const replay = await runBrowserReplay({
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
    cases.push(buildBrowserBenchmarkCase({
      sourceTraceId: traceId,
      sourceBundle,
      replayTraceId,
      replayBundle,
      replaySessionId: replay.replay.sessionId,
    }));
  }

  const result: BrowserBenchmarkResult = {
    summary: {
      totalCases: cases.length,
      validationMatches: cases.filter((item) => item.validationMatched).length,
      outcomeMatches: cases.filter((item) => item.outcomeStatusMatched).length,
      replayValidatedCases: cases.filter((item) => item.replayValidated).length,
      sessionIdMatches: cases.filter((item) => item.sessionIdMatched).length,
      targetUrlMatches: cases.filter((item) => item.targetUrlMatched).length,
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

function buildBrowserBenchmarkCase(input: {
  sourceTraceId: string;
  sourceBundle: TraceBundle;
  replayTraceId?: string;
  replayBundle: TraceBundle | null;
  replaySessionId?: string;
}): BrowserBenchmarkCaseResult {
  const sourceFailureClasses = parseStringList(input.sourceBundle.metadata?.failureClasses);
  const replayFailureClasses = parseStringList(input.replayBundle?.metadata?.failureClasses);
  const sourceOutcomeStatus = input.sourceBundle.outcome?.status;
  const replayOutcomeStatus = input.replayBundle?.outcome?.status;
  const sourceValidated = input.sourceBundle.outcome?.validated ?? false;
  const replayValidated = input.replayBundle?.outcome?.validated ?? false;
  const sourceSessionId = emptyToUndefined(input.sourceBundle.metadata?.sessionId);
  const sourceTargetUrl = emptyToUndefined(input.sourceBundle.metadata?.targetUrl);
  const replayTargetUrl = emptyToUndefined(input.replayBundle?.metadata?.targetUrl);

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
    sourceSessionId,
    replaySessionId: input.replaySessionId,
    sessionIdMatched: sourceSessionId === input.replaySessionId,
    sourceTargetUrl,
    replayTargetUrl,
    targetUrlMatched: sourceTargetUrl === replayTargetUrl,
  };
}

function parseStringList(value: string | undefined): string[] {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}
