import {
  createBrowserSessionDriver,
  createClaudeSessionDriver,
  createCodexSessionDriver,
  createOpenclawSessionDriver,
  createOpencodeSessionDriver,
  type ProviderSessionSummary,
  type SessionDriver,
} from '@drew/foreman-providers';

export type RegisteredSessionState =
  | 'agent-active'
  | 'human-active'
  | 'idle-resumable'
  | 'stale'
  | 'unknown';

export type SessionSupervisionMode =
  | 'observe'
  | 'recommend'
  | 'continue'
  | 'manual';

export interface RegisteredSession {
  provider: 'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw';
  sessionId: string;
  title: string;
  summary?: string;
  cwd?: string;
  updatedAt?: string;
  createdAt?: string;
  sourcePath?: string;
  state: RegisteredSessionState;
  recommendedMode: SessionSupervisionMode;
  rationale: string;
  metadata?: Record<string, string>;
}

export interface SessionRegistryOptions {
  providers?: Array<'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw'>;
  cwd?: string;
  limitPerProvider?: number;
  maxItems?: number;
  activeWindowMinutes?: number;
  staleAfterHours?: number;
}

export interface SessionRegistryResult {
  generatedAt: string;
  summary: string;
  items: RegisteredSession[];
}

export async function runSessionRegistry(
  options: SessionRegistryOptions = {},
): Promise<SessionRegistryResult> {
  const providers = options.providers ?? ['claude', 'codex', 'opencode', 'openclaw'];
  const limitPerProvider = options.limitPerProvider ?? 25;
  const activeWindowMinutes = options.activeWindowMinutes ?? 30;
  const staleAfterHours = options.staleAfterHours ?? 24;

  const drivers = providers.map((provider) => ({
    provider,
    driver: getDriver(provider),
  }));

  const collected = await Promise.all(
    drivers.map(async ({ provider, driver }) => {
      const sessions = await driver.listRecent({
        cwd: options.cwd,
        limit: limitPerProvider,
      });
      return sessions.map((session) =>
        classifySession(provider, session, {
          activeWindowMinutes,
          staleAfterHours,
        }),
      );
    }),
  );

  const items = collected
    .flat()
    .sort(compareRegisteredSessions)
    .slice(0, options.maxItems ?? 50);

  return {
    generatedAt: new Date().toISOString(),
    summary: buildSessionRegistrySummary(items),
    items,
  };
}

function getDriver(provider: 'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw'): SessionDriver {
  if (provider === 'claude') {
    return createClaudeSessionDriver();
  }
  if (provider === 'browser') {
    return createBrowserSessionDriver();
  }
  if (provider === 'opencode') {
    return createOpencodeSessionDriver();
  }
  if (provider === 'openclaw') {
    return createOpenclawSessionDriver();
  }
  return createCodexSessionDriver();
}

function classifySession(
  provider: 'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw',
  session: ProviderSessionSummary,
  policy: {
    activeWindowMinutes: number;
    staleAfterHours: number;
  },
): RegisteredSession {
  if (provider === 'browser') {
    return classifyBrowserRun(session, policy);
  }
  if (provider === 'openclaw') {
    return classifyOpenclawSession(session, policy);
  }

  const updatedAtMs = session.updatedAt ? new Date(session.updatedAt).getTime() : undefined;
  const now = Date.now();
  const activeThresholdMs = policy.activeWindowMinutes * 60 * 1000;
  const staleThresholdMs = policy.staleAfterHours * 60 * 60 * 1000;

  let state: RegisteredSessionState = 'unknown';
  let recommendedMode: SessionSupervisionMode = 'manual';
  let rationale = 'Session has no reliable timestamp metadata yet.';

  if (updatedAtMs !== undefined && !Number.isNaN(updatedAtMs)) {
    const ageMs = Math.max(0, now - updatedAtMs);
    if (ageMs <= activeThresholdMs) {
      state = 'human-active';
      recommendedMode = 'observe';
      rationale = 'This session was updated recently enough that it may still be under active human control.';
    } else if (ageMs <= staleThresholdMs) {
      state = 'idle-resumable';
      recommendedMode = 'recommend';
      rationale = 'This session appears resumable, but recent enough that Foreman should recommend before continuing automatically.';
    } else {
      state = 'stale';
      recommendedMode = 'continue';
      rationale = 'This session looks stale enough that Foreman can consider continuing it under profile policy.';
    }
  }

  return {
    provider,
    sessionId: session.sessionId,
    title: session.title,
    summary: session.summary,
    cwd: session.cwd,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    sourcePath: session.sourcePath,
    state,
    recommendedMode,
    rationale,
    metadata: session.metadata,
  };
}

function classifyOpenclawSession(
  session: ProviderSessionSummary,
  policy: {
    activeWindowMinutes: number;
    staleAfterHours: number;
  },
): RegisteredSession {
  const updatedAtMs = session.updatedAt ? new Date(session.updatedAt).getTime() : undefined;
  const now = Date.now();
  const activeThresholdMs = policy.activeWindowMinutes * 60 * 1000;
  const staleThresholdMs = policy.staleAfterHours * 60 * 60 * 1000;
  const key = session.metadata?.key ?? '';
  const sessionKey = session.metadata?.sessionKey ?? '';
  const isCronOwned = key.includes(':cron:') || sessionKey.includes(':cron:');
  const status = session.metadata?.status;

  let state: RegisteredSessionState = 'unknown';
  let recommendedMode: SessionSupervisionMode = 'manual';
  let rationale = 'OpenClaw session lacks enough metadata to classify safely.';

  if (status === 'running') {
    state = 'agent-active';
    recommendedMode = 'observe';
    rationale = 'This OpenClaw session is marked running, so Foreman should observe the harness rather than intervene.';
  } else if (updatedAtMs !== undefined && !Number.isNaN(updatedAtMs)) {
    const ageMs = Math.max(0, now - updatedAtMs);
    if (isCronOwned) {
      if (ageMs <= activeThresholdMs) {
        state = 'agent-active';
        recommendedMode = 'observe';
        rationale = 'This OpenClaw session appears harness-owned and recently active, so Foreman should observe rather than take over.';
      } else if (ageMs <= staleThresholdMs) {
        state = 'idle-resumable';
        recommendedMode = 'recommend';
        rationale = 'This OpenClaw session appears harness-owned and resumable; Foreman should recommend continuation with awareness of the underlying cron or trigger context.';
      } else {
        state = 'stale';
        recommendedMode = 'continue';
        rationale = 'This OpenClaw session appears harness-owned and stale enough for Foreman to continue under profile policy.';
      }
    } else if (ageMs <= activeThresholdMs) {
      state = 'human-active';
      recommendedMode = 'observe';
      rationale = 'This OpenClaw session was updated recently and looks user-driven, so Foreman should not take over silently.';
    } else if (ageMs <= staleThresholdMs) {
      state = 'idle-resumable';
      recommendedMode = 'recommend';
      rationale = 'This OpenClaw session looks resumable, but Foreman should recommend before continuing.';
    } else {
      state = 'stale';
      recommendedMode = 'continue';
      rationale = 'This OpenClaw session looks stale enough for Foreman to continue under profile policy.';
    }
  }

  return {
    provider: 'openclaw',
    sessionId: session.sessionId,
    title: session.title,
    summary: session.summary,
    cwd: session.cwd,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    sourcePath: session.sourcePath,
    state,
    recommendedMode,
    rationale,
    metadata: session.metadata,
  };
}

function compareRegisteredSessions(left: RegisteredSession, right: RegisteredSession): number {
  return compareIsoDates(right.updatedAt, left.updatedAt)
    || compareStatePriority(left.state, right.state)
    || left.provider.localeCompare(right.provider)
    || left.sessionId.localeCompare(right.sessionId);
}

function compareStatePriority(left: RegisteredSessionState, right: RegisteredSessionState): number {
  const scores: Record<RegisteredSessionState, number> = {
    'agent-active': 5,
    'human-active': 4,
    'idle-resumable': 3,
    'stale': 2,
    'unknown': 1,
  };
  return scores[right] - scores[left];
}

function compareIsoDates(left?: string, right?: string): number {
  const leftTime = left ? new Date(left).getTime() : 0;
  const rightTime = right ? new Date(right).getTime() : 0;
  return leftTime - rightTime;
}

function buildSessionRegistrySummary(items: RegisteredSession[]): string {
  if (items.length === 0) {
    return 'No provider sessions were found for the current filters.';
  }

  const counts = {
    agentActive: items.filter((item) => item.state === 'agent-active').length,
    humanActive: items.filter((item) => item.state === 'human-active').length,
    idleResumable: items.filter((item) => item.state === 'idle-resumable').length,
    stale: items.filter((item) => item.state === 'stale').length,
    unknown: items.filter((item) => item.state === 'unknown').length,
  };

  return [
    `${items.length} sessions found.`,
    `${counts.agentActive} agent-active`,
    `${counts.humanActive} human-active`,
    `${counts.idleResumable} idle-resumable`,
    `${counts.stale} stale`,
    `${counts.unknown} unknown`,
  ].join(' ');
}

function classifyBrowserRun(
  session: ProviderSessionSummary,
  policy: {
    activeWindowMinutes: number;
    staleAfterHours: number;
  },
): RegisteredSession {
  const updatedAtMs = session.updatedAt ? new Date(session.updatedAt).getTime() : undefined;
  const now = Date.now();
  const activeThresholdMs = policy.activeWindowMinutes * 60 * 1000;
  const staleThresholdMs = policy.staleAfterHours * 60 * 60 * 1000;
  const status = session.metadata?.status;

  let state: RegisteredSessionState = 'unknown';
  let recommendedMode: SessionSupervisionMode = 'manual';
  let rationale = 'Browser run has no reliable run-state metadata yet.';

  if (status === 'running') {
    state = 'agent-active';
    recommendedMode = 'observe';
    rationale = 'This browser run is still marked running, so Foreman should observe instead of taking over.';
  } else if (updatedAtMs !== undefined && !Number.isNaN(updatedAtMs)) {
    const ageMs = Math.max(0, now - updatedAtMs);
    if (ageMs <= activeThresholdMs) {
      state = 'idle-resumable';
      recommendedMode = 'recommend';
      rationale = 'This browser run is recent and resumable, but close enough to active work that Foreman should recommend before continuing.';
    } else if (ageMs <= staleThresholdMs) {
      state = 'idle-resumable';
      recommendedMode = 'recommend';
      rationale = 'This browser run appears resumable and is a reasonable candidate for continuation.';
    } else {
      state = 'stale';
      recommendedMode = 'continue';
      rationale = 'This browser run looks stale enough that Foreman can consider continuing it under profile policy.';
    }
  }

  return {
    provider: 'browser',
    sessionId: session.sessionId,
    title: session.title,
    summary: session.summary,
    cwd: session.cwd,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    sourcePath: session.sourcePath,
    state,
    recommendedMode,
    rationale,
    metadata: session.metadata,
  };
}
