import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { loadOperatorRuntimeContext, scoreOperatorPreference } from './operator-adaptation.js';
import { runProviderSessionSurface } from './provider-session.js';
import { runSessionRegistry } from './session-registry.js';
import { runSessionSurface, type SessionRunResult } from './session-run.js';

export interface BrowserSupervisionOptions {
  cwd?: string;
  profileId?: string;
  userId?: string;
  profileRoot?: string;
  memoryRoot?: string;
  limit?: number;
  activeWindowMinutes?: number;
  staleAfterHours?: number;
  outputPath?: string;
  markdownPath?: string;
  continueTopRun?: boolean;
  forkTopRun?: boolean;
  goal?: string;
  approve?: boolean;
  traceRoot?: string;
}

export interface BrowserSupervisionCandidate {
  runId: string;
  title: string;
  summary?: string;
  state: string;
  recommendedMode: string;
  rationale: string;
  status?: string;
  domain?: string;
  currentUrl?: string;
  finalUrl?: string;
  startUrl?: string;
  sessionThreadId?: string;
  updatedAt?: string;
  memoryScore?: number;
  memoryReasons?: string[];
}

export interface BrowserSupervisionResult {
  summary: string;
  generatedAt: string;
  candidates: BrowserSupervisionCandidate[];
  executedRun?: {
    action: 'continue' | 'fork';
    result: SessionRunResult;
  };
  outputPath?: string;
  markdownPath?: string;
}

export async function runBrowserSupervision(
  options: BrowserSupervisionOptions,
): Promise<BrowserSupervisionResult> {
  const [sessions, registry, operatorContext] = await Promise.all([
    runProviderSessionSurface({
      provider: 'browser',
      action: 'list',
      cwd: options.cwd,
      limit: options.limit ?? 20,
    }),
    runSessionRegistry({
      providers: ['browser'],
      cwd: options.cwd,
      limitPerProvider: options.limit ?? 20,
      maxItems: options.limit ?? 20,
      activeWindowMinutes: options.activeWindowMinutes,
      staleAfterHours: options.staleAfterHours,
    }),
    loadOperatorRuntimeContext({
      profileId: options.profileId,
      userId: options.userId,
      profileRoot: options.profileRoot,
      memoryRoot: options.memoryRoot,
      workerIds: ['browser'],
      taskShapes: ['browser'],
    }),
  ]);

  const sessionById = new Map((sessions.sessions ?? []).map((session) => [session.sessionId, session]));
  const candidates = registry.items
    .map((item) => {
      const session = sessionById.get(item.sessionId);
      const preference = scoreOperatorPreference({
        providerOrWorker: 'browser',
        capability: 'browser',
        taskShape: 'browser',
        environmentHints: [
          session?.metadata?.domain,
          session?.cwd,
          session?.metadata?.currentUrl,
          session?.metadata?.finalUrl,
          session?.metadata?.startUrl,
        ].filter((value): value is string => Boolean(value)),
        text: [
          item.title,
          item.summary,
          session?.summary,
          session?.firstPrompt,
          session?.metadata?.domain,
          session?.metadata?.currentUrl,
          session?.metadata?.finalUrl,
        ].filter(Boolean).join(' '),
      }, operatorContext);

      return {
        runId: item.sessionId,
        title: item.title,
        summary: item.summary ?? session?.summary,
        state: item.state,
        recommendedMode: item.recommendedMode,
        rationale: item.rationale,
        status: session?.metadata?.status,
        domain: session?.metadata?.domain,
        currentUrl: session?.metadata?.currentUrl,
        finalUrl: session?.metadata?.finalUrl,
        startUrl: session?.metadata?.startUrl,
        sessionThreadId: session?.metadata?.sessionId,
        updatedAt: item.updatedAt,
        memoryScore: preference.score > 0 ? preference.score : undefined,
        memoryReasons: preference.reasons.length > 0 ? preference.reasons : undefined,
      } satisfies BrowserSupervisionCandidate;
    })
    .sort((left, right) =>
      (right.memoryScore ?? 0) - (left.memoryScore ?? 0)
      || compareModePriority(left.recommendedMode, right.recommendedMode)
      || compareIsoDates(right.updatedAt, left.updatedAt)
      || left.runId.localeCompare(right.runId),
    );

  let executedRun:
    | {
        action: 'continue' | 'fork';
        result: SessionRunResult;
      }
    | undefined;

  const topCandidate = candidates.find((candidate) => candidate.recommendedMode === 'continue' || candidate.recommendedMode === 'recommend');
  if (topCandidate && (options.continueTopRun || options.forkTopRun)) {
    const action = options.forkTopRun ? 'fork' : 'continue';
    executedRun = {
      action,
      result: await runSessionSurface({
        provider: 'browser',
        action,
        sessionId: topCandidate.runId,
        cwd: options.cwd,
        prompt: options.goal,
        approve: options.approve,
        approvalMode: options.approve ? 'never' : 'auto',
        profileId: options.profileId,
        userId: options.userId,
        profileRoot: options.profileRoot,
        memoryRoot: options.memoryRoot,
        traceRoot: options.traceRoot,
        taskId: `browser-supervision-${topCandidate.runId}`,
      }),
    };
  }

  const result: BrowserSupervisionResult = {
    summary: buildBrowserSupervisionSummary(candidates, executedRun),
    generatedAt: new Date().toISOString(),
    candidates,
    executedRun,
  };

  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    result.outputPath = outputPath;
  }

  if (options.markdownPath) {
    const markdownPath = resolve(options.markdownPath);
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, renderBrowserSupervisionMarkdown(result), 'utf8');
    result.markdownPath = markdownPath;
  }

  return result;
}

function buildBrowserSupervisionSummary(
  candidates: BrowserSupervisionCandidate[],
  executedRun?: {
    action: 'continue' | 'fork';
    result: SessionRunResult;
  },
): string {
  if (candidates.length === 0) {
    return 'No browser runs were found for the current filters.';
  }
  const continueCandidates = candidates.filter((candidate) => candidate.recommendedMode === 'continue').length;
  const recommendCandidates = candidates.filter((candidate) => candidate.recommendedMode === 'recommend').length;
  return [
    `Supervised ${candidates.length} browser run(s): ${continueCandidates} continue-ready, ${recommendCandidates} recommend-before-continue.`,
    executedRun ? `Executed browser ${executedRun.action} for ${executedRun.result.sessionId ?? 'unknown run'}.` : '',
  ].filter(Boolean).join(' ');
}

function renderBrowserSupervisionMarkdown(result: BrowserSupervisionResult): string {
  const lines: string[] = [
    '# Foreman Browser Supervision',
    '',
    result.summary,
    '',
    '## Candidates',
  ];

  if (result.candidates.length === 0) {
    lines.push('- None');
  } else {
    for (const candidate of result.candidates) {
      lines.push(`- ${candidate.title}`);
      lines.push(`  Run id: ${candidate.runId}`);
      lines.push(`  State: ${candidate.state}`);
      lines.push(`  Mode: ${candidate.recommendedMode}`);
      if (candidate.status) {
        lines.push(`  Run status: ${candidate.status}`);
      }
      if (candidate.domain) {
        lines.push(`  Domain: ${candidate.domain}`);
      }
      if (candidate.currentUrl) {
        lines.push(`  Current URL: ${candidate.currentUrl}`);
      }
      if (candidate.finalUrl) {
        lines.push(`  Final URL: ${candidate.finalUrl}`);
      }
      if (candidate.summary) {
        lines.push(`  Summary: ${candidate.summary}`);
      }
      lines.push(`  Rationale: ${candidate.rationale}`);
      if (candidate.memoryScore) {
        lines.push(`  Memory score: ${candidate.memoryScore}`);
      }
      if (candidate.memoryReasons?.length) {
        lines.push(`  Memory reasons: ${candidate.memoryReasons.join(' | ')}`);
      }
    }
  }

  if (result.executedRun) {
    lines.push('', '## Executed Run');
    lines.push(`- Action: ${result.executedRun.action}`);
    lines.push(`- Status: ${result.executedRun.result.status}`);
    lines.push(`- Session id: ${result.executedRun.result.sessionId ?? 'n/a'}`);
    lines.push(`- Trace id: ${result.executedRun.result.traceId ?? 'n/a'}`);
  }

  return `${lines.join('\n')}\n`;
}

function compareModePriority(left: string, right: string): number {
  const scores: Record<string, number> = {
    continue: 3,
    recommend: 2,
    observe: 1,
    manual: 0,
  };
  return (scores[right] ?? 0) - (scores[left] ?? 0);
}

function compareIsoDates(left?: string, right?: string): number {
  const leftTime = left ? new Date(left).getTime() : 0;
  const rightTime = right ? new Date(right).getTime() : 0;
  return leftTime - rightTime;
}
