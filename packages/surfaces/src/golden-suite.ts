import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { FilesystemTraceStore } from '@drew/foreman-tracing';

import { runBrowserReplay } from './browser-replay.js';
import { runEngineeringReplay } from './engineering-replay.js';
import { runSessionReplay } from './session-replay.js';
import { runSupervisorReplay } from './supervisor-replay.js';

type GoldenSurface = 'engineering' | 'session' | 'browser' | 'supervisor';

interface GoldenReplayPolicy {
  traceOutputRoot?: string;
  artifactsRoot?: string;
  approvalMode?: 'auto' | 'required' | 'never';
  approve?: boolean;
  profileId?: string;
  userId?: string;
  profileRoot?: string;
  memoryRoot?: string;
}

interface GoldenExpectations {
  outcomeStatus?: string;
  validated?: boolean;
  failureClasses?: string[];
  provider?: string;
  childRunCount?: number;
  failedChildRunCount?: number;
  highSeverityFindingCount?: number;
}

export interface GoldenSuiteCase {
  id: string;
  surface: GoldenSurface;
  traceRoot: string;
  traceId: string;
  expected?: GoldenExpectations;
  replay?: GoldenReplayPolicy;
}

export interface GoldenSuiteManifest {
  id: string;
  summary?: string;
  cases: GoldenSuiteCase[];
}

export interface GoldenSuiteCaseResult {
  id: string;
  surface: GoldenSurface;
  sourceTraceId: string;
  replayTraceId?: string;
  expected: GoldenExpectations;
  actual: {
    outcomeStatus?: string;
    validated?: boolean;
    failureClasses: string[];
    provider?: string;
    childRunCount?: number;
    failedChildRunCount?: number;
    highSeverityFindingCount?: number;
  };
  passed: boolean;
  mismatches: string[];
}

export interface GoldenSuiteResult {
  suiteId: string;
  summary: {
    totalCases: number;
    passedCases: number;
    failedCases: number;
  };
  cases: GoldenSuiteCaseResult[];
}

export async function runGoldenSuite(input: {
  manifestPath: string;
  traceOutputRoot?: string;
  outputPath?: string;
}): Promise<GoldenSuiteResult> {
  const manifest = await loadGoldenSuiteManifest(input.manifestPath);
  const cases: GoldenSuiteCaseResult[] = [];

  for (const suiteCase of manifest.cases) {
    cases.push(await runGoldenSuiteCase(suiteCase, input.traceOutputRoot));
  }

  const result: GoldenSuiteResult = {
    suiteId: manifest.id,
    summary: {
      totalCases: cases.length,
      passedCases: cases.filter((item) => item.passed).length,
      failedCases: cases.filter((item) => !item.passed).length,
    },
    cases,
  };

  if (input.outputPath) {
    const outputPath = resolve(input.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  return result;
}

async function runGoldenSuiteCase(
  suiteCase: GoldenSuiteCase,
  traceOutputRoot?: string,
): Promise<GoldenSuiteCaseResult> {
  const resolvedTraceRoot = resolve(suiteCase.traceRoot);
  const replayTraceRoot = resolve(
    suiteCase.replay?.traceOutputRoot
      ?? traceOutputRoot
      ?? join(resolvedTraceRoot, '..', `${suiteCase.surface}-golden-replays`),
  );

  let replayTraceId: string | undefined;
  if (suiteCase.surface === 'engineering') {
    const replay = await runEngineeringReplay({
      traceRoot: resolvedTraceRoot,
      traceId: suiteCase.traceId,
      traceOutputRoot: replayTraceRoot,
      artifactsRoot: suiteCase.replay?.artifactsRoot
        ? resolve(suiteCase.replay.artifactsRoot)
        : join(replayTraceRoot, 'artifacts', suiteCase.id),
    });
    replayTraceId = replay.replay.traceId;
  } else if (suiteCase.surface === 'session') {
    const replay = await runSessionReplay({
      traceRoot: resolvedTraceRoot,
      traceId: suiteCase.traceId,
      traceOutputRoot: replayTraceRoot,
      approvalMode: suiteCase.replay?.approvalMode,
      approve: suiteCase.replay?.approve,
      profileId: suiteCase.replay?.profileId,
      userId: suiteCase.replay?.userId,
      profileRoot: suiteCase.replay?.profileRoot,
      memoryRoot: suiteCase.replay?.memoryRoot,
    });
    replayTraceId = replay.replay.traceId;
  } else if (suiteCase.surface === 'browser') {
    const replay = await runBrowserReplay({
      traceRoot: resolvedTraceRoot,
      traceId: suiteCase.traceId,
      traceOutputRoot: replayTraceRoot,
      approvalMode: suiteCase.replay?.approvalMode,
      approve: suiteCase.replay?.approve,
      profileId: suiteCase.replay?.profileId,
      userId: suiteCase.replay?.userId,
      profileRoot: suiteCase.replay?.profileRoot,
      memoryRoot: suiteCase.replay?.memoryRoot,
    });
    replayTraceId = replay.replay.traceId;
  } else {
    const replay = await runSupervisorReplay({
      traceRoot: resolvedTraceRoot,
      traceId: suiteCase.traceId,
      traceOutputRoot: replayTraceRoot,
      approvalMode: suiteCase.replay?.approvalMode,
      approve: suiteCase.replay?.approve,
    });
    replayTraceId = replay.replay.traceId;
  }

  const replayStore = new FilesystemTraceStore(replayTraceRoot);
  const replayBundle = replayTraceId ? await replayStore.get(replayTraceId) : null;
  if (!replayBundle) {
    throw new Error(`replay trace missing for suite case ${suiteCase.id}`);
  }

  const actual = {
    outcomeStatus: replayBundle.outcome?.status,
    validated: replayBundle.outcome?.validated,
    failureClasses: splitList(replayBundle.metadata?.failureClasses),
    provider: replayBundle.metadata?.provider,
    childRunCount: parseOptionalNumber(replayBundle.metadata?.childRunCount),
    failedChildRunCount: parseOptionalNumber(replayBundle.metadata?.childRunFailedCount),
    highSeverityFindingCount: parseOptionalNumber(replayBundle.metadata?.highSeverityFindingCount),
  };
  const expected = suiteCase.expected ?? {};
  const mismatches = compareGoldenExpectations(expected, actual);

  return {
    id: suiteCase.id,
    surface: suiteCase.surface,
    sourceTraceId: suiteCase.traceId,
    replayTraceId,
    expected,
    actual,
    passed: mismatches.length === 0,
    mismatches,
  };
}

function compareGoldenExpectations(
  expected: GoldenExpectations,
  actual: GoldenSuiteCaseResult['actual'],
): string[] {
  const mismatches: string[] = [];
  if (expected.outcomeStatus !== undefined && expected.outcomeStatus !== actual.outcomeStatus) {
    mismatches.push(`expected outcomeStatus=${expected.outcomeStatus} but got ${actual.outcomeStatus ?? 'undefined'}`);
  }
  if (expected.validated !== undefined && expected.validated !== actual.validated) {
    mismatches.push(`expected validated=${expected.validated} but got ${String(actual.validated)}`);
  }
  if (expected.provider !== undefined && expected.provider !== actual.provider) {
    mismatches.push(`expected provider=${expected.provider} but got ${actual.provider ?? 'undefined'}`);
  }
  if (expected.childRunCount !== undefined && expected.childRunCount !== actual.childRunCount) {
    mismatches.push(`expected childRunCount=${expected.childRunCount} but got ${String(actual.childRunCount)}`);
  }
  if (expected.failedChildRunCount !== undefined && expected.failedChildRunCount !== actual.failedChildRunCount) {
    mismatches.push(`expected failedChildRunCount=${expected.failedChildRunCount} but got ${String(actual.failedChildRunCount)}`);
  }
  if (expected.highSeverityFindingCount !== undefined && expected.highSeverityFindingCount !== actual.highSeverityFindingCount) {
    mismatches.push(`expected highSeverityFindingCount=${expected.highSeverityFindingCount} but got ${String(actual.highSeverityFindingCount)}`);
  }
  if (expected.failureClasses && !sameStringSet(expected.failureClasses, actual.failureClasses)) {
    mismatches.push(`expected failureClasses=${expected.failureClasses.join(',')} but got ${actual.failureClasses.join(',')}`);
  }
  return mismatches;
}

async function loadGoldenSuiteManifest(path: string): Promise<GoldenSuiteManifest> {
  const manifestPath = resolve(path);
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as GoldenSuiteManifest;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cases)) {
    throw new Error(`invalid golden suite manifest: ${manifestPath}`);
  }
  return parsed;
}

function splitList(value: string | undefined): string[] {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
