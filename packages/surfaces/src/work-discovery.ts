import {
  discoverWorkFromSources,
  type WorkDiscoveryInput,
  type WorkDiscoveryItem as ProfileWorkDiscoveryItem,
  type WorkDiscoveryResult as ProfileWorkDiscoveryResult,
} from '@drew/foreman-profiles';

import { loadOperatorRuntimeContext, scoreOperatorPreference } from './operator-adaptation.js';
import { runSessionRegistry, type RegisteredSession, type RegisteredSessionState } from './session-registry.js';

export interface WorkDiscoveryRunOptions extends WorkDiscoveryInput {
  userId?: string;
  profileRoot?: string;
  memoryRoot?: string;
  sessionProviders?: Array<'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw'>;
  sessionCwd?: string;
  sessionLimitPerProvider?: number;
}

export interface SessionWorkDiscoveryItem {
  id: string;
  source: 'session';
  title: string;
  summary: string;
  status: 'open' | 'blocked' | 'stale' | 'completed';
  confidence: number;
  updatedAt?: string;
  recommendedAction: string;
  metadata?: Record<string, string>;
}

export interface WorkDiscoveryRunResult extends Omit<ProfileWorkDiscoveryResult, 'items' | 'summary'> {
  items: Array<ProfileWorkDiscoveryItem | SessionWorkDiscoveryItem>;
  summary: string;
  sessionSummary?: string;
}

export async function runWorkDiscovery(
  options: WorkDiscoveryRunOptions,
): Promise<WorkDiscoveryRunResult> {
  const base = await discoverWorkFromSources(options);
  const sessionProviders = options.sessionProviders ?? [];
  const registry = sessionProviders.length > 0
    ? await runSessionRegistry({
        providers: sessionProviders,
        cwd: options.sessionCwd ?? options.traceRoots?.[0] ?? options.transcriptRoots?.[0],
        limitPerProvider: options.sessionLimitPerProvider,
        maxItems: options.maxItems,
      })
    : null;
  const combinedItems = registry
    ? [...base.items, ...registry.items.map(sessionToWorkItem)]
    : [...base.items];
  const operatorContext = await loadOperatorRuntimeContext({
    profileId: options.profileId,
    userId: options.userId,
    profileRoot: options.profileRoot,
    memoryRoot: options.memoryRoot,
    workerIds: collectDiscoveryWorkerIds(combinedItems),
    taskShapes: collectDiscoveryTaskShapes(combinedItems),
  });
  const items = applyOperatorRanking(combinedItems, operatorContext)
    .sort(compareDiscoveryItems)
    .slice(0, options.maxItems ?? 25);

  return {
    profileId: base.profileId,
    generatedAt: base.generatedAt,
    items,
    sessionSummary: registry?.summary,
    summary: buildDiscoverySummary([base.summary, registry?.summary].filter(Boolean).join(' '), operatorContext),
  };
}

function sessionToWorkItem(session: RegisteredSession): SessionWorkDiscoveryItem {
  return {
    id: `session:${session.provider}:${session.sessionId}`,
    source: 'session',
    title: `${session.provider} ${session.title}`,
    summary: session.summary
      ? `${session.summary} ${session.rationale}`.trim()
      : session.rationale,
    status: mapSessionStateToStatus(session.state),
    confidence: scoreSessionConfidence(session.state),
    updatedAt: session.updatedAt,
    recommendedAction: session.recommendedMode,
    metadata: {
      ...(session.metadata ?? {}),
      provider: session.provider,
      sessionId: session.sessionId,
      state: session.state,
      recommendedMode: session.recommendedMode,
      ...(session.cwd ? { cwd: session.cwd } : {}),
    },
  };
}

function mapSessionStateToStatus(state: RegisteredSessionState): SessionWorkDiscoveryItem['status'] {
  switch (state) {
    case 'stale':
      return 'stale';
    case 'agent-active':
    case 'human-active':
    case 'idle-resumable':
    case 'unknown':
    default:
      return 'open';
  }
}

function scoreSessionConfidence(state: RegisteredSessionState): number {
  switch (state) {
    case 'agent-active':
      return 0.95;
    case 'human-active':
      return 0.9;
    case 'idle-resumable':
      return 0.88;
    case 'stale':
      return 0.82;
    case 'unknown':
    default:
      return 0.6;
  }
}

function compareDiscoveryItems(
  left: ProfileWorkDiscoveryItem | SessionWorkDiscoveryItem,
  right: ProfileWorkDiscoveryItem | SessionWorkDiscoveryItem,
): number {
  const leftMemoryScore = Number(left.metadata?.memoryScore ?? '0');
  const rightMemoryScore = Number(right.metadata?.memoryScore ?? '0');
  return rightMemoryScore - leftMemoryScore
    || compareStatusPriority(left.status, right.status)
    || compareIsoDates(right.updatedAt, left.updatedAt)
    || right.confidence - left.confidence
    || left.id.localeCompare(right.id);
}

function applyOperatorRanking(
  items: Array<ProfileWorkDiscoveryItem | SessionWorkDiscoveryItem>,
  context: Awaited<ReturnType<typeof loadOperatorRuntimeContext>>,
): Array<ProfileWorkDiscoveryItem | SessionWorkDiscoveryItem> {
  if (!context) {
    return items;
  }

  return items.map((item) => {
    const providerOrWorker = item.source === 'session'
      ? item.metadata?.provider
      : item.metadata?.workerId ?? item.metadata?.provider;
    const capability = inferCapability(item);
    const environmentHints = [
      item.metadata?.repoPath,
      item.metadata?.cwd,
      item.metadata?.path,
      item.title,
    ].filter((value): value is string => Boolean(value));
    const preference = scoreOperatorPreference({
      providerOrWorker,
      capability,
      taskShape: inferTaskShape(item),
      environmentHints,
      text: [item.title, item.summary, item.recommendedAction, item.metadata?.originalGoal].filter(Boolean).join(' '),
    }, context);

    if (preference.score <= 0) {
      return item;
    }

    return {
      ...item,
      metadata: {
        ...item.metadata,
        memoryScore: String(preference.score),
        memoryReasons: preference.reasons.join(' | '),
      },
    };
  });
}

function inferCapability(item: ProfileWorkDiscoveryItem | SessionWorkDiscoveryItem): string | undefined {
  const surface = item.metadata?.surface?.toLowerCase();
  if (surface === 'supervisor') {
    return 'ops';
  }
  if (item.source === 'session') {
    return item.metadata?.provider === 'browser'
      ? 'browser'
      : item.metadata?.provider === 'openclaw'
        ? 'hybrid'
        : 'code';
  }

  const taskShape = item.metadata?.taskShape?.toLowerCase();
  if (taskShape?.includes('review')) {
    return 'review';
  }
  if (taskShape?.includes('browser')) {
    return 'browser';
  }
  if (taskShape?.includes('research')) {
    return 'research';
  }
  if (taskShape?.includes('ops')) {
    return 'ops';
  }
  if (taskShape?.includes('document') || taskShape?.includes('tax')) {
    return 'document';
  }
  return taskShape ? 'code' : undefined;
}

function inferTaskShape(item: ProfileWorkDiscoveryItem | SessionWorkDiscoveryItem): string {
  if (item.source === 'session') {
    return item.metadata?.provider === 'browser'
      ? 'browser'
      : item.metadata?.provider === 'openclaw'
        ? 'hybrid'
        : 'session';
  }
  if (item.metadata?.surface === 'supervisor') {
    return 'supervisor';
  }
  return item.metadata?.taskShape ?? 'general';
}

function collectDiscoveryWorkerIds(
  items: Array<ProfileWorkDiscoveryItem | SessionWorkDiscoveryItem>,
): string[] {
  return [...new Set(items
    .map((item) => item.source === 'session' ? item.metadata?.provider : item.metadata?.workerId ?? item.metadata?.provider)
    .filter((value): value is string => Boolean(value)))];
}

function collectDiscoveryTaskShapes(
  items: Array<ProfileWorkDiscoveryItem | SessionWorkDiscoveryItem>,
): string[] {
  return [...new Set(items.map((item) => inferTaskShape(item)).filter(Boolean))];
}

function buildDiscoverySummary(
  baseSummary: string,
  context: Awaited<ReturnType<typeof loadOperatorRuntimeContext>>,
): string {
  if (!context) {
    return baseSummary;
  }
  return [baseSummary, 'Memory-informed ranking applied from stored profile and user preferences.']
    .filter(Boolean)
    .join(' ');
}

function compareStatusPriority(
  left: 'open' | 'blocked' | 'stale' | 'completed',
  right: 'open' | 'blocked' | 'stale' | 'completed',
): number {
  const scores = {
    blocked: 4,
    open: 3,
    stale: 2,
    completed: 1,
  } satisfies Record<'open' | 'blocked' | 'stale' | 'completed', number>;
  return scores[right] - scores[left];
}

function compareIsoDates(left?: string, right?: string): number {
  const leftTime = left ? new Date(left).getTime() : 0;
  const rightTime = right ? new Date(right).getTime() : 0;
  return leftTime - rightTime;
}
