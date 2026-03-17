import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { FilesystemTraceStore, type TraceBundle } from '@drew/foreman-tracing';

export interface TraceBenchmarkOptions {
  traceRoot: string;
  surface?: 'session' | 'supervisor' | 'engineering';
  provider?: string;
  maxCases?: number;
  reportPath?: string;
}

export interface TraceBenchmarkCase {
  traceId: string;
  taskId: string;
  surface?: string;
  provider?: string;
  outcomeStatus?: string;
  validated: boolean;
  durationMs?: number;
  failureClasses: string[];
  approvalRequired: boolean;
  childRunCount?: number;
  failedChildRunCount?: number;
  highSeverityFindingCount?: number;
}

export interface TraceBenchmarkResult {
  summary: {
    totalCases: number;
    completedCases: number;
    failedCases: number;
    blockedCases: number;
    validatedCases: number;
    approvalRequiredCases: number;
    averageDurationMs?: number;
    failureClassCounts: Record<string, number>;
    providerCounts: Record<string, number>;
  };
  cases: TraceBenchmarkCase[];
}

export async function runTraceBenchmark(
  options: TraceBenchmarkOptions,
): Promise<TraceBenchmarkResult> {
  const store = new FilesystemTraceStore(resolve(options.traceRoot));
  const refs = await store.list();
  const cases: TraceBenchmarkCase[] = [];

  for (const ref of refs) {
    const bundle = await store.get(ref.traceId);
    if (!bundle) {
      continue;
    }
    const benchmarkCase = toTraceBenchmarkCase(ref.traceId, bundle);
    if (options.surface && benchmarkCase.surface !== options.surface) {
      continue;
    }
    if (options.provider && benchmarkCase.provider !== options.provider) {
      continue;
    }
    cases.push(benchmarkCase);
  }

  const selectedCases = cases.slice(0, options.maxCases ?? cases.length);
  const result: TraceBenchmarkResult = {
    summary: summarizeTraceCases(selectedCases),
    cases: selectedCases,
  };

  if (options.reportPath) {
    const reportPath = resolve(options.reportPath);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  return result;
}

function toTraceBenchmarkCase(traceId: string, bundle: TraceBundle): TraceBenchmarkCase {
  const metadata = bundle.metadata ?? {};
  const surface = metadata.surface;
  const provider = metadata.provider;
  const failureClasses = parseStringList(metadata.failureClasses);
  const approvalRequired = failureClasses.includes('approval-required')
    || Boolean(metadata.approvalReason);

  return {
    traceId,
    taskId: bundle.task.id,
    surface,
    provider,
    outcomeStatus: bundle.outcome?.status,
    validated: bundle.outcome?.validated ?? false,
    durationMs: parseOptionalNumber(metadata.durationMs),
    failureClasses,
    approvalRequired,
    childRunCount: parseOptionalNumber(metadata.childRunCount),
    failedChildRunCount: parseOptionalNumber(metadata.childRunFailedCount),
    highSeverityFindingCount: parseOptionalNumber(metadata.highSeverityFindingCount),
  };
}

function summarizeTraceCases(cases: TraceBenchmarkCase[]): TraceBenchmarkResult['summary'] {
  const failureClassCounts: Record<string, number> = {};
  const providerCounts: Record<string, number> = {};

  for (const benchmarkCase of cases) {
    for (const failureClass of benchmarkCase.failureClasses) {
      failureClassCounts[failureClass] = (failureClassCounts[failureClass] ?? 0) + 1;
    }
    if (benchmarkCase.provider) {
      providerCounts[benchmarkCase.provider] = (providerCounts[benchmarkCase.provider] ?? 0) + 1;
    }
  }

  return {
    totalCases: cases.length,
    completedCases: cases.filter((item) => item.outcomeStatus === 'completed').length,
    failedCases: cases.filter((item) => item.outcomeStatus === 'failed').length,
    blockedCases: cases.filter((item) => item.outcomeStatus === 'blocked').length,
    validatedCases: cases.filter((item) => item.validated).length,
    approvalRequiredCases: cases.filter((item) => item.approvalRequired).length,
    averageDurationMs: averageNumber(cases.map((item) => item.durationMs)),
    failureClassCounts,
    providerCounts,
  };
}

function parseStringList(value: string | undefined): string[] {
  return value
    ? value.split(',').map((item) => item.trim()).filter(Boolean)
    : [];
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
