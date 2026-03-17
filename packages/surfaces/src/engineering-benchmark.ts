import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { FilesystemTraceStore, type TraceBundle } from '@drew/foreman-tracing';

import { runEngineeringReplay, type EngineeringReplayOptions } from './engineering-replay.js';

export interface EngineeringBenchmarkSuiteOptions extends Omit<EngineeringReplayOptions, 'traceId' | 'artifactsRoot'> {
  traceIds?: string[];
  maxCases?: number;
  artifactsRoot?: string;
  reportPath?: string;
}

export interface EngineeringBenchmarkCaseResult {
  sourceTraceId: string;
  sourceTaskId: string;
  replayTraceId: string;
  sourceOutcomeStatus?: string;
  sourceValidated: boolean;
  replayOutcomeStatus?: string;
  replayValidated: boolean;
  outcomeStatusMatched: boolean;
  validationMatched: boolean;
  sourceCheckPassRate?: number;
  replayCheckPassRate?: number;
  sourceDurationMs?: number;
  replayDurationMs?: number;
  promptVariantIds: Record<'hardener' | 'implementer' | 'reviewer', string>;
}

export interface EngineeringBenchmarkSuiteSummary {
  totalCases: number;
  sourceValidatedCases: number;
  replayValidatedCases: number;
  validationMatches: number;
  outcomeMatches: number;
  averageReplayDurationMs?: number;
  averageReplayCheckPassRate?: number;
}

export interface EngineeringBenchmarkSuiteResult {
  summary: EngineeringBenchmarkSuiteSummary;
  cases: EngineeringBenchmarkCaseResult[];
}

export async function runEngineeringBenchmarkSuite(
  options: EngineeringBenchmarkSuiteOptions,
): Promise<EngineeringBenchmarkSuiteResult> {
  const sourceTraceRoot = resolve(options.traceRoot);
  const replayTraceRoot = resolve(options.traceOutputRoot ?? join(sourceTraceRoot, '..', 'benchmark-traces'));
  const artifactsRoot = resolve(options.artifactsRoot ?? join(sourceTraceRoot, '..', 'benchmark-runs'));

  await mkdir(replayTraceRoot, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });

  const sourceStore = new FilesystemTraceStore(sourceTraceRoot);
  const replayStore = new FilesystemTraceStore(replayTraceRoot);
  const requestedTraceIds = options.traceIds && options.traceIds.length > 0
    ? options.traceIds
    : (await sourceStore.list()).map((item) => item.traceId);
  const selectedTraceIds = requestedTraceIds.slice(0, options.maxCases ?? requestedTraceIds.length);

  const cases: EngineeringBenchmarkCaseResult[] = [];

  for (const traceId of selectedTraceIds) {
    const sourceBundle = await sourceStore.get(traceId);
    if (!sourceBundle) {
      throw new Error(`trace ${traceId} not found in ${sourceTraceRoot}`);
    }

    const replay = await runEngineeringReplay({
      ...options,
      traceId,
      artifactsRoot: join(artifactsRoot, traceId),
      traceOutputRoot: replayTraceRoot,
    });
    const replayBundle = await replayStore.get(replay.replay.traceId);

    cases.push(buildBenchmarkCase({
      sourceTraceId: traceId,
      sourceBundle,
      replayBundle,
      replayTraceId: replay.replay.traceId,
      promptVariantIds: replay.replay.promptVariantIds,
    }));
  }

  const result: EngineeringBenchmarkSuiteResult = {
    summary: summarizeEngineeringBenchmarkCases(cases),
    cases,
  };

  if (options.reportPath) {
    const reportPath = resolve(options.reportPath);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  return result;
}

export function summarizeEngineeringBenchmarkCases(
  cases: EngineeringBenchmarkCaseResult[],
): EngineeringBenchmarkSuiteSummary {
  return {
    totalCases: cases.length,
    sourceValidatedCases: cases.filter((item) => item.sourceValidated).length,
    replayValidatedCases: cases.filter((item) => item.replayValidated).length,
    validationMatches: cases.filter((item) => item.validationMatched).length,
    outcomeMatches: cases.filter((item) => item.outcomeStatusMatched).length,
    averageReplayDurationMs: averageNumber(cases.map((item) => item.replayDurationMs)),
    averageReplayCheckPassRate: averageNumber(cases.map((item) => item.replayCheckPassRate)),
  };
}

function buildBenchmarkCase(input: {
  sourceTraceId: string;
  sourceBundle: TraceBundle;
  replayBundle: TraceBundle | null;
  replayTraceId: string;
  promptVariantIds: Record<'hardener' | 'implementer' | 'reviewer', string>;
}): EngineeringBenchmarkCaseResult {
  const sourceCheckPassRate = parseOptionalNumber(input.sourceBundle.metadata?.checkPassRate);
  const replayCheckPassRate = parseOptionalNumber(input.replayBundle?.metadata?.checkPassRate);
  const sourceDurationMs = parseOptionalNumber(input.sourceBundle.metadata?.durationMs);
  const replayDurationMs = parseOptionalNumber(input.replayBundle?.metadata?.durationMs);
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
    sourceCheckPassRate,
    replayCheckPassRate,
    sourceDurationMs,
    replayDurationMs,
    promptVariantIds: input.promptVariantIds,
  };
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function averageNumber(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (present.length === 0) {
    return undefined;
  }
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}
