import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  createMemoryStore,
  type MemoryStore,
  type ProfileMemory,
  type UserMemory,
} from '@drew/foreman-memory';
import {
  bootstrapProfileFromSources,
  discoverWorkFromSources,
  FilesystemProfileStore,
  type StoredForemanProfile,
} from '@drew/foreman-profiles';
import {
  createClaudeProvider,
  createCodexProvider,
  parseJsonOutput,
  type TextProvider,
} from '@drew/foreman-providers';
import { FilesystemTraceStore, type TraceBundle } from '@drew/foreman-tracing';
import type { WorkerCapability } from '@drew/foreman-workers';
import { runProviderSessionSurface } from './provider-session.js';

export interface SessionReviewOptions {
  profileId: string;
  userId?: string;
  traceRoots?: string[];
  transcriptRoots?: string[];
  sessionProviders?: Array<'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw'>;
  sessionCwd?: string;
  sessionLimitPerProvider?: number;
  repoPaths?: string[];
  profileRoot: string;
  memoryRoot: string;
  outputPath?: string;
  markdownPath?: string;
  provider?: 'codex' | 'claude';
  providerTimeoutMs?: number;
  maxTranscriptFiles?: number;
  maxTranscriptSnippets?: number;
  maxTraceSummaries?: number;
  since?: string;
  lookbackDays?: number;
  applyMemoryUpdates?: boolean;
}

export interface SessionReviewResult {
  profileId: string;
  providerId: string;
  summary: string;
  report: SessionReviewReport;
  outputPath?: string;
  markdownPath?: string;
  reviewedTraceCount: number;
  reviewedTranscriptCount: number;
  reviewedSessionCount: number;
}

export interface SessionReviewReport {
  summary: string;
  operatorPatterns: string[];
  goalPatterns: string[];
  workflowImprovements: string[];
  skillOrToolingImprovements: string[];
  memoryUpdates: {
    userPreferences?: string[];
    favoredWorkers?: string[];
    recurringEnvironments?: string[];
    escalationHabits?: string[];
    profileWorkerPreferences?: string[];
    profilePreferredCapabilities?: WorkerCapability[];
    evaluationStyle?: string[];
  };
  completionRecommendations: Array<{
    title: string;
    rationale: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    goal?: string;
    repoPath?: string;
    source?: string;
  }>;
  openQuestions?: string[];
}

interface TranscriptSnippet {
  path: string;
  updatedAt?: string;
  excerpt: string;
}

interface SessionSnippet {
  provider: 'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw';
  sessionId: string;
  title: string;
  updatedAt?: string;
  cwd?: string;
  summary?: string;
  firstPrompt?: string;
  metadata?: Record<string, string>;
}

export async function runSessionReview(
  options: SessionReviewOptions,
): Promise<SessionReviewResult> {
  const providers = {
    codex: createCodexProvider(),
    claude: createClaudeProvider(),
  } satisfies Record<'codex' | 'claude', TextProvider>;
  const provider = providers[options.provider ?? 'claude'];

  const profileRoot = resolve(options.profileRoot);
  const memoryRoot = resolve(options.memoryRoot);
  await mkdir(profileRoot, { recursive: true });
  await mkdir(memoryRoot, { recursive: true });

  const profileStore = new FilesystemProfileStore(profileRoot);
  const memoryStore = await createMemoryStore({
    rootDir: memoryRoot,
  });

  const existingProfile = await profileStore.get(options.profileId);
  const existingProfileMemory = await memoryStore.getProfileMemory(options.profileId);
  const existingUserMemory = options.userId
    ? await memoryStore.getUserMemory(options.userId)
    : null;
  const bootstrap = await bootstrapProfileFromSources({
    profileId: options.profileId,
    traceRoots: options.traceRoots,
    transcriptRoots: options.transcriptRoots,
    repoPaths: options.repoPaths,
    userId: options.userId,
    maxTranscriptFiles: options.maxTranscriptFiles,
  });
  const discovery = await discoverWorkFromSources({
    profileId: options.profileId,
    traceRoots: options.traceRoots,
    transcriptRoots: options.transcriptRoots,
    maxTranscriptFiles: options.maxTranscriptFiles,
    maxItems: 12,
  });
  const traceSummaries = await collectTraceSummaries(
    options.traceRoots ?? [],
    options.maxTraceSummaries ?? 12,
    resolveSinceDate(options),
  );
  const transcriptSnippets = await collectTranscriptSnippets(
    options.transcriptRoots ?? [],
    options.maxTranscriptFiles ?? 200,
    options.maxTranscriptSnippets ?? 16,
    resolveSinceDate(options),
  );
  const sessionSnippets = await collectSessionSnippets({
    providers: options.sessionProviders ?? [],
    cwd: options.sessionCwd,
    limitPerProvider: options.sessionLimitPerProvider ?? 8,
    since: resolveSinceDate(options),
  });

  const prompt = buildSessionReviewPrompt({
    profileId: options.profileId,
    userId: options.userId,
    existingProfile,
    existingProfileMemory,
    existingUserMemory,
    bootstrapSummary: bootstrap.summary,
    discoverySummary: discovery.summary,
    discoveryItems: discovery.items,
    traceSummaries,
    transcriptSnippets,
    sessionSnippets,
  });
  const execution = await provider.run(prompt, {
    timeoutMs: options.providerTimeoutMs ?? 20 * 60 * 1000,
  });
  const report = normalizeSessionReviewReport(parseJsonOutput(execution.stdout));

  if (options.applyMemoryUpdates ?? true) {
    await applySessionReviewMemoryUpdates({
      memoryStore,
      profileStore,
      profileId: options.profileId,
      userId: options.userId,
      existingProfile: existingProfile ?? bootstrap.profileRecord,
      bootstrapProfile: bootstrap.profileRecord,
      report,
    });
  }

  let outputPath: string | undefined;
  if (options.outputPath) {
    outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  let markdownPath: string | undefined;
  if (options.markdownPath) {
    markdownPath = resolve(options.markdownPath);
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, renderSessionReviewMarkdown(report), 'utf8');
  }

  return {
    profileId: options.profileId,
    providerId: provider.id,
    summary: report.summary,
    report,
    outputPath,
    markdownPath,
    reviewedTraceCount: traceSummaries.length,
    reviewedTranscriptCount: transcriptSnippets.length,
    reviewedSessionCount: sessionSnippets.length,
  };
}

async function collectSessionSnippets(input: {
  providers: Array<'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw'>;
  cwd?: string;
  limitPerProvider: number;
  since?: Date;
}): Promise<SessionSnippet[]> {
  const items: SessionSnippet[] = [];
  for (const provider of input.providers) {
    const result = await runProviderSessionSurface({
      provider,
      action: 'list',
      cwd: input.cwd,
      limit: input.limitPerProvider,
    });
    for (const session of result.sessions ?? []) {
      if (input.since && session.updatedAt && new Date(session.updatedAt).getTime() < input.since.getTime()) {
        continue;
      }
      items.push({
        provider,
        sessionId: session.sessionId,
        title: session.title,
        updatedAt: session.updatedAt,
        cwd: session.cwd,
        summary: session.summary,
        firstPrompt: session.firstPrompt,
        metadata: session.metadata,
      });
    }
  }
  return items
    .sort((a, b) => compareIsoDates(b.updatedAt, a.updatedAt))
    .slice(0, input.providers.length * input.limitPerProvider);
}

async function collectTraceSummaries(
  traceRoots: string[],
  maxItems: number,
  since?: Date,
): Promise<Array<{
  traceId: string;
  taskId: string;
  goal: string;
  updatedAt?: string;
  outcomeStatus?: string;
  validated: boolean;
  repoPath?: string;
  taskShape?: string;
  summary: string;
}>> {
  const summaries: Array<{
    traceId: string;
    taskId: string;
    goal: string;
    updatedAt?: string;
    outcomeStatus?: string;
    validated: boolean;
    repoPath?: string;
    taskShape?: string;
    summary: string;
  }> = [];

  for (const root of traceRoots) {
    const store = new FilesystemTraceStore(root);
    const refs = await store.list();
    for (const ref of refs) {
      const bundle = await store.get(ref.traceId);
      if (!bundle) {
        continue;
      }
      const updatedAt = latestTraceTimestamp(bundle);
      if (since && updatedAt && new Date(updatedAt).getTime() < since.getTime()) {
        continue;
      }
      summaries.push({
        traceId: ref.traceId,
        taskId: bundle.task.id,
        goal: bundle.metadata?.originalGoal ?? bundle.task.goal,
        updatedAt,
        outcomeStatus: bundle.outcome?.status,
        validated: bundle.outcome?.validated ?? false,
        repoPath: bundle.metadata?.repoPath,
        taskShape: bundle.metadata?.taskShape,
        summary: trimText(
          bundle.outcome?.summary ?? bundle.events.at(-1)?.summary ?? 'No summary available.',
          400,
        ),
      });
    }
  }

  return summaries
    .sort((a, b) => compareIsoDates(b.updatedAt, a.updatedAt))
    .slice(0, maxItems);
}

async function collectTranscriptSnippets(
  roots: string[],
  maxFiles: number,
  maxItems: number,
  since?: Date,
): Promise<TranscriptSnippet[]> {
  const files: Array<{ path: string; updatedAt?: string; excerpt: string }> = [];
  for (const root of roots) {
    await walkTranscriptSnippets(resolve(root), files, maxFiles, maxItems, since);
    if (files.length >= maxItems) {
      break;
    }
  }
  return files
    .sort((a, b) => compareIsoDates(b.updatedAt, a.updatedAt))
    .slice(0, maxItems);
}

async function walkTranscriptSnippets(
  root: string,
  out: TranscriptSnippet[],
  maxFiles: number,
  maxItems: number,
  since?: Date,
): Promise<void> {
  if (out.length >= maxItems) {
    return;
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= maxItems || out.length >= maxFiles) {
      return;
    }
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkTranscriptSnippets(fullPath, out, maxFiles, maxItems, since);
      continue;
    }
    if (!entry.isFile() || !/\.(json|jsonl|md|txt)$/i.test(entry.name)) {
      continue;
    }
    try {
      const info = await stat(fullPath);
      const updatedAt = info.mtime.toISOString();
      if (since && info.mtime.getTime() < since.getTime()) {
        continue;
      }
      const content = await readFile(fullPath, 'utf8');
      const excerpt = extractTranscriptExcerpt(content);
      if (!excerpt) {
        continue;
      }
      out.push({
        path: fullPath,
        updatedAt,
        excerpt,
      });
    } catch {
      // Ignore unreadable transcripts.
    }
  }
}

function extractTranscriptExcerpt(content: string): string {
  const normalized = content.replace(/\r/g, '').trim();
  if (!normalized) {
    return '';
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return '';
  }
  const combined = lines.length <= 18
    ? lines.join('\n')
    : [
        ...lines.slice(0, 6),
        '...',
        ...lines.slice(-12),
      ].join('\n');

  return trimText(combined, 2200);
}

function buildSessionReviewPrompt(input: {
  profileId: string;
  userId?: string;
  existingProfile: StoredForemanProfile | null;
  existingProfileMemory: ProfileMemory | null;
  existingUserMemory: UserMemory | null;
  bootstrapSummary: string;
  discoverySummary: string;
  discoveryItems: Array<{
    title: string;
    summary: string;
    status: string;
    confidence: number;
    recommendedAction: string;
    metadata?: Record<string, string>;
  }>;
  traceSummaries: Array<{
    traceId: string;
    taskId: string;
    goal: string;
    updatedAt?: string;
    outcomeStatus?: string;
    validated: boolean;
    repoPath?: string;
    taskShape?: string;
    summary: string;
  }>;
  transcriptSnippets: TranscriptSnippet[];
  sessionSnippets: SessionSnippet[];
}): string {
  const profileBlock = input.existingProfile
    ? JSON.stringify(input.existingProfile, null, 2)
    : 'No prior stored profile.';
  const profileMemoryBlock = input.existingProfileMemory
    ? JSON.stringify(input.existingProfileMemory, null, 2)
    : 'No prior profile memory.';
  const userMemoryBlock = input.existingUserMemory
    ? JSON.stringify(input.existingUserMemory, null, 2)
    : 'No prior user memory.';
  const discoveryBlock = input.discoveryItems.length > 0
    ? input.discoveryItems.map((item, index) => [
        `${index + 1}. ${item.title}`,
        `status=${item.status} confidence=${item.confidence.toFixed(2)}`,
        item.summary,
        `next=${item.recommendedAction}`,
      ].join('\n')).join('\n\n')
    : 'No discovered work items.';
  const tracesBlock = input.traceSummaries.length > 0
    ? input.traceSummaries.map((item, index) => [
        `${index + 1}. ${item.goal}`,
        `taskId=${item.taskId} traceId=${item.traceId} status=${item.outcomeStatus ?? 'unknown'} validated=${item.validated}`,
        item.updatedAt ? `updatedAt=${item.updatedAt}` : '',
        item.repoPath ? `repo=${item.repoPath}` : '',
        item.summary,
      ].filter(Boolean).join('\n')).join('\n\n')
    : 'No trace summaries available.';
  const transcriptBlock = input.transcriptSnippets.length > 0
    ? input.transcriptSnippets.map((item, index) => [
        `${index + 1}. ${item.path}`,
        item.updatedAt ? `updatedAt=${item.updatedAt}` : '',
        item.excerpt,
      ].join('\n')).join('\n\n')
    : 'No transcript snippets available.';
  const sessionBlock = input.sessionSnippets.length > 0
    ? input.sessionSnippets.map((item, index) => [
        `${index + 1}. [${item.provider}] ${item.title}`,
        `sessionId=${item.sessionId}`,
        item.updatedAt ? `updatedAt=${item.updatedAt}` : '',
        item.cwd ? `cwd=${item.cwd}` : '',
        item.summary ? `summary=${item.summary}` : '',
        item.firstPrompt ? `firstPrompt=${item.firstPrompt}` : '',
      ].filter(Boolean).join('\n')).join('\n\n')
    : 'No provider session summaries available.';

  return [
    'You are Foreman session reviewer, a world-class operator analyzing prior agent work to improve future execution.',
    '',
    'Your job is to infer how this user works, what they are trying to achieve, what should be improved, and what should likely be resumed next.',
    'Be concrete, strategic, and operator-level. Avoid generic advice, shallow summaries, or keyword-driven speculation.',
    'Ground recommendations in the provided traces, stored memory, provider session summaries, and session excerpts.',
    'Infer the operator intent behind the sessions, not just what files or repos were touched.',
    'Pay attention to user-originated prompts and follow-up directions. Learn how the user steers agents, what they correct, what they prioritize, and what they repeatedly ask for.',
    'Treat this as an agentic review pass over prior work, not a templated report.',
    '',
    'Return JSON only with this exact schema:',
    '{"summary":"...","operatorPatterns":["..."],"goalPatterns":["..."],"workflowImprovements":["..."],"skillOrToolingImprovements":["..."],"memoryUpdates":{"userPreferences":["..."],"favoredWorkers":["..."],"recurringEnvironments":["..."],"escalationHabits":["..."],"profileWorkerPreferences":["..."],"profilePreferredCapabilities":["code|browser|review|research|ops|document|hybrid"],"evaluationStyle":["..."]},"completionRecommendations":[{"title":"...","rationale":"...","priority":"low|medium|high|critical","goal":"...","repoPath":"...","source":"..."}],"openQuestions":["..."]}',
    '',
    `Profile id: ${input.profileId}`,
    input.userId ? `User id: ${input.userId}` : '',
    '',
    'Existing profile:',
    profileBlock,
    '',
    'Existing profile memory:',
    profileMemoryBlock,
    '',
    'Existing user memory:',
    userMemoryBlock,
    '',
    'Bootstrap summary:',
    input.bootstrapSummary,
    '',
    'Work discovery summary:',
    input.discoverySummary,
    '',
    'Discovered work items:',
    discoveryBlock,
    '',
    'Trace summaries:',
    tracesBlock,
    '',
    'Provider session summaries:',
    sessionBlock,
    '',
    'Transcript excerpts:',
    transcriptBlock,
  ].filter(Boolean).join('\n');
}

function normalizeSessionReviewReport(value: unknown): SessionReviewReport {
  const record = isRecord(value) ? value : {};
  return {
    summary: stringValue(record.summary, 'Session review completed.'),
    operatorPatterns: stringArray(record.operatorPatterns),
    goalPatterns: stringArray(record.goalPatterns),
    workflowImprovements: stringArray(record.workflowImprovements),
    skillOrToolingImprovements: stringArray(record.skillOrToolingImprovements),
    memoryUpdates: {
      userPreferences: stringArray(getNested(record, 'memoryUpdates', 'userPreferences')),
      favoredWorkers: stringArray(getNested(record, 'memoryUpdates', 'favoredWorkers')),
      recurringEnvironments: stringArray(getNested(record, 'memoryUpdates', 'recurringEnvironments')),
      escalationHabits: stringArray(getNested(record, 'memoryUpdates', 'escalationHabits')),
      profileWorkerPreferences: stringArray(getNested(record, 'memoryUpdates', 'profileWorkerPreferences')),
      profilePreferredCapabilities: capabilityArray(getNested(record, 'memoryUpdates', 'profilePreferredCapabilities')),
      evaluationStyle: stringArray(getNested(record, 'memoryUpdates', 'evaluationStyle')),
    },
    completionRecommendations: Array.isArray(record.completionRecommendations)
      ? record.completionRecommendations
          .filter(isRecord)
          .map((item) => ({
            title: stringValue(item.title, 'Recommended work'),
            rationale: stringValue(item.rationale, 'No rationale provided.'),
            priority: normalizePriority(item.priority),
            goal: optionalString(item.goal),
            repoPath: optionalString(item.repoPath),
            source: optionalString(item.source),
          }))
      : [],
    openQuestions: stringArray(record.openQuestions),
  };
}

async function applySessionReviewMemoryUpdates(input: {
  memoryStore: MemoryStore;
  profileStore: FilesystemProfileStore;
  profileId: string;
  userId?: string;
  existingProfile: StoredForemanProfile;
  bootstrapProfile: StoredForemanProfile;
  report: SessionReviewReport;
}): Promise<void> {
  const existingProfileMemory = await input.memoryStore.getProfileMemory(input.profileId);
  const mergedProfileMemory: ProfileMemory = {
    profileId: input.profileId,
    workerPreferences: mergeFreshStrings(
      existingProfileMemory?.workerPreferences,
      [
        ...(input.report.memoryUpdates.profileWorkerPreferences ?? []),
        ...(input.bootstrapProfile.profile.preferredWorkers ?? []),
      ],
      12,
    ),
    evaluationStyle: mergeFreshStrings(
      existingProfileMemory?.evaluationStyle,
      input.report.memoryUpdates.evaluationStyle,
      12,
    ),
    memoryScopes: dedupe([
      ...(existingProfileMemory?.memoryScopes ?? []),
      'profile',
      'project',
      'environment',
    ]),
    operatorPatterns: mergeFreshStrings(existingProfileMemory?.operatorPatterns, input.report.operatorPatterns, 16),
    goalPatterns: mergeFreshStrings(existingProfileMemory?.goalPatterns, input.report.goalPatterns, 16),
    workflowImprovements: mergeFreshStrings(existingProfileMemory?.workflowImprovements, input.report.workflowImprovements, 12),
    skillOrToolingImprovements: mergeFreshStrings(existingProfileMemory?.skillOrToolingImprovements, input.report.skillOrToolingImprovements, 12),
  };
  await input.memoryStore.putProfileMemory(mergedProfileMemory);

  const mergedProfile: StoredForemanProfile = {
    ...input.existingProfile,
    profile: {
      ...input.existingProfile.profile,
      preferredWorkers: mergeFreshStrings(
        input.existingProfile.profile.preferredWorkers,
        input.report.memoryUpdates.profileWorkerPreferences,
        8,
      ),
      preferredCapabilities: mergeFreshCapabilities(
        input.existingProfile.profile.preferredCapabilities,
        input.report.memoryUpdates.profilePreferredCapabilities,
        6,
      ),
    },
    summary: input.report.summary,
    updatedAt: new Date().toISOString(),
  };
  await input.profileStore.put(mergedProfile);

  if (input.userId) {
    const existingUserMemory = await input.memoryStore.getUserMemory(input.userId);
    const mergedUserMemory: UserMemory = {
      userId: input.userId,
      preferences: mergeFreshStrings(existingUserMemory?.preferences, input.report.memoryUpdates.userPreferences, 16),
      favoredWorkers: mergeFreshStrings(
        existingUserMemory?.favoredWorkers,
        [
          ...(input.report.memoryUpdates.favoredWorkers ?? []),
          ...(input.bootstrapProfile.profile.preferredWorkers ?? []),
        ],
        12,
      ),
      recurringEnvironments: mergeFreshStrings(existingUserMemory?.recurringEnvironments, input.report.memoryUpdates.recurringEnvironments, 12),
      escalationHabits: mergeFreshStrings(existingUserMemory?.escalationHabits, input.report.memoryUpdates.escalationHabits, 12),
      operatorPatterns: mergeFreshStrings(existingUserMemory?.operatorPatterns, input.report.operatorPatterns, 16),
      goalPatterns: mergeFreshStrings(existingUserMemory?.goalPatterns, input.report.goalPatterns, 16),
    };
    await input.memoryStore.putUserMemory(mergedUserMemory);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getNested(value: Record<string, unknown>, key: string, nestedKey: string): unknown {
  const nested = value[key];
  if (!isRecord(nested)) {
    return undefined;
  }
  return nested[nestedKey];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function capabilityArray(value: unknown): WorkerCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is WorkerCapability =>
    item === 'code'
      || item === 'browser'
      || item === 'review'
      || item === 'research'
      || item === 'ops'
      || item === 'document'
      || item === 'hybrid',
  );
}

function normalizePriority(value: unknown): 'low' | 'medium' | 'high' | 'critical' {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
    ? value
    : 'medium';
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function mergeFreshStrings(
  existing: string[] | undefined,
  incoming: string[] | undefined,
  maxItems: number,
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of [...(incoming ?? []), ...(existing ?? [])]) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
    if (merged.length >= maxItems) {
      break;
    }
  }
  return merged;
}

function mergeFreshCapabilities(
  existing: WorkerCapability[] | undefined,
  incoming: WorkerCapability[] | undefined,
  maxItems: number,
): WorkerCapability[] {
  const seen = new Set<WorkerCapability>();
  const merged: WorkerCapability[] = [];
  for (const item of [...(incoming ?? []), ...(existing ?? [])]) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    merged.push(item);
    if (merged.length >= maxItems) {
      break;
    }
  }
  return merged;
}

function resolveSinceDate(options: Pick<SessionReviewOptions, 'since' | 'lookbackDays'>): Date | undefined {
  if (options.since) {
    const parsed = new Date(options.since);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  if (options.lookbackDays !== undefined && Number.isFinite(options.lookbackDays)) {
    return new Date(Date.now() - options.lookbackDays * 24 * 60 * 60 * 1000);
  }
  return undefined;
}

function latestTraceTimestamp(bundle: TraceBundle): string | undefined {
  const candidates = [
    ...bundle.events.map((event) => event.at),
    bundle.metadata?.finishedAt,
    bundle.metadata?.startedAt,
  ].filter((value): value is string => Boolean(value));

  return candidates.sort((a, b) => compareIsoDates(b, a))[0];
}

function compareIsoDates(left?: string, right?: string): number {
  const leftTime = left ? new Date(left).getTime() : 0;
  const rightTime = right ? new Date(right).getTime() : 0;
  return leftTime - rightTime;
}

function trimText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function renderSessionReviewMarkdown(report: SessionReviewReport): string {
  const lines: string[] = [
    '# Foreman Session Review',
    '',
    report.summary,
    '',
    '## Operator Patterns',
    ...renderBulletSection(report.operatorPatterns),
    '',
    '## Goal Patterns',
    ...renderBulletSection(report.goalPatterns),
    '',
    '## Workflow Improvements',
    ...renderBulletSection(report.workflowImprovements),
    '',
    '## Skill And Tooling Improvements',
    ...renderBulletSection(report.skillOrToolingImprovements),
    '',
    '## Completion Recommendations',
  ];

  if (report.completionRecommendations.length === 0) {
    lines.push('- None');
  } else {
    for (const recommendation of report.completionRecommendations) {
      lines.push(`- [${recommendation.priority}] ${recommendation.title}`);
      lines.push(`  ${recommendation.rationale}`);
      if (recommendation.goal) {
        lines.push(`  Goal: ${recommendation.goal}`);
      }
      if (recommendation.repoPath) {
        lines.push(`  Repo: ${recommendation.repoPath}`);
      }
      if (recommendation.source) {
        lines.push(`  Source: ${recommendation.source}`);
      }
    }
  }

  lines.push('', '## Open Questions');
  lines.push(...renderBulletSection(report.openQuestions ?? []));

  return `${lines.join('\n')}\n`;
}

function renderBulletSection(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ['- None'];
}
