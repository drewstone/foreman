import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { FilesystemTraceStore, type TraceBundle } from '@drew/foreman-tracing';

import { runSupervisorReplay, type SupervisorReplayOptions } from './supervisor-replay.js';

export interface SupervisorBenchmarkOptions extends Omit<SupervisorReplayOptions, 'traceId' | 'outputPath' | 'markdownPath'> {
  traceIds?: string[];
  maxCases?: number;
  reportPath?: string;
}

export interface SupervisorBenchmarkCaseResult {
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
  sourceChildRunCount?: number;
  replayChildRunCount?: number;
  childRunCountMatched: boolean;
  sourceFailedChildRunCount?: number;
  replayFailedChildRunCount?: number;
  failedChildRunCountMatched: boolean;
  sourceHighSeverityFindingCount?: number;
  replayHighSeverityFindingCount?: number;
  highSeverityFindingCountMatched: boolean;
}

export interface SupervisorBenchmarkResult {
  summary: {
    totalCases: number;
    validationMatches: number;
    outcomeMatches: number;
    replayValidatedCases: number;
    childRunCountMatches: number;
    failedChildRunCountMatches: number;
    highSeverityFindingCountMatches: number;
  };
  cases: SupervisorBenchmarkCaseResult[];
}

export async function runSupervisorBenchmark(
  options: SupervisorBenchmarkOptions,
): Promise<SupervisorBenchmarkResult> {
  const sourceTraceRoot = resolve(options.traceRoot);
  const replayTraceRoot = resolve(options.traceOutputRoot ?? join(sourceTraceRoot, '..', 'supervisor-benchmark-traces'));
  await mkdir(replayTraceRoot, { recursive: true });

  const sourceStore = new FilesystemTraceStore(sourceTraceRoot);
  const replayStore = new FilesystemTraceStore(replayTraceRoot);
  const requestedTraceIds = options.traceIds?.length
    ? options.traceIds
    : (await sourceStore.list()).map((item) => item.traceId);

  const selectedTraceIds: string[] = [];
  for (const traceId of requestedTraceIds) {
    const bundle = await sourceStore.get(traceId);
    if (bundle?.metadata?.surface === 'supervisor') {
      selectedTraceIds.push(traceId);
    }
    if (selectedTraceIds.length >= (options.maxCases ?? requestedTraceIds.length)) {
      break;
    }
  }

  const cases: SupervisorBenchmarkCaseResult[] = [];
  for (const traceId of selectedTraceIds) {
    const sourceBundle = await sourceStore.get(traceId);
    if (!sourceBundle) {
      continue;
    }
    const replay = await runSupervisorReplay({
      traceRoot: sourceTraceRoot,
      traceId,
      traceOutputRoot: replayTraceRoot,
      approvalMode: options.approvalMode,
      approve: options.approve,
    });
    const replayTraceId = replay.replay.traceId;
    const replayBundle = replayTraceId ? await replayStore.get(replayTraceId) : null;
    cases.push(buildSupervisorBenchmarkCase({
      sourceTraceId: traceId,
      sourceBundle,
      replayTraceId,
      replayBundle,
    }));
  }

  const result: SupervisorBenchmarkResult = {
    summary: {
      totalCases: cases.length,
      validationMatches: cases.filter((item) => item.validationMatched).length,
      outcomeMatches: cases.filter((item) => item.outcomeStatusMatched).length,
      replayValidatedCases: cases.filter((item) => item.replayValidated).length,
      childRunCountMatches: cases.filter((item) => item.childRunCountMatched).length,
      failedChildRunCountMatches: cases.filter((item) => item.failedChildRunCountMatched).length,
      highSeverityFindingCountMatches: cases.filter((item) => item.highSeverityFindingCountMatched).length,
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

function buildSupervisorBenchmarkCase(input: {
  sourceTraceId: string;
  sourceBundle: TraceBundle;
  replayTraceId?: string;
  replayBundle: TraceBundle | null;
}): SupervisorBenchmarkCaseResult {
  const sourceFailureClasses = parseStringList(input.sourceBundle.metadata?.failureClasses);
  const replayFailureClasses = parseStringList(input.replayBundle?.metadata?.failureClasses);
  const sourceOutcomeStatus = input.sourceBundle.outcome?.status;
  const replayOutcomeStatus = input.replayBundle?.outcome?.status;
  const sourceValidated = input.sourceBundle.outcome?.validated ?? false;
  const replayValidated = input.replayBundle?.outcome?.validated ?? false;
  const sourceChildRunCount = parseOptionalNumber(input.sourceBundle.metadata?.childRunCount);
  const replayChildRunCount = parseOptionalNumber(input.replayBundle?.metadata?.childRunCount);
  const sourceFailedChildRunCount = parseOptionalNumber(input.sourceBundle.metadata?.childRunFailedCount);
  const replayFailedChildRunCount = parseOptionalNumber(input.replayBundle?.metadata?.childRunFailedCount);
  const sourceHighSeverityFindingCount = parseOptionalNumber(input.sourceBundle.metadata?.highSeverityFindingCount);
  const replayHighSeverityFindingCount = parseOptionalNumber(input.replayBundle?.metadata?.highSeverityFindingCount);

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
    sourceChildRunCount,
    replayChildRunCount,
    childRunCountMatched: sourceChildRunCount === replayChildRunCount,
    sourceFailedChildRunCount,
    replayFailedChildRunCount,
    failedChildRunCountMatched: sourceFailedChildRunCount === replayFailedChildRunCount,
    sourceHighSeverityFindingCount,
    replayHighSeverityFindingCount,
    highSeverityFindingCountMatched: sourceHighSeverityFindingCount === replayHighSeverityFindingCount,
  };
}

function parseStringList(value: string | undefined): string[] {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
