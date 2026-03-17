import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { ProfileMemory, UserMemory } from '@drew/foreman-memory';
import { createTraceStore, FilesystemTraceStore, type TraceBundle } from '@drew/foreman-tracing';
import type { ForemanProfile, WorkerCapability } from '@drew/foreman-workers';

export interface StoredForemanProfile {
  profile: ForemanProfile;
  summary?: string;
  createdAt: string;
  updatedAt: string;
  bootstrap?: {
    sources: string[];
    traceCount?: number;
    transcriptCount?: number;
    repoCount?: number;
  };
}

export interface ProfileStore {
  get(profileId: string): Promise<StoredForemanProfile | null>;
  put(record: StoredForemanProfile): Promise<void>;
  list(): Promise<StoredForemanProfile[]>;
}

export interface ProfileBootstrapInput {
  profileId: string;
  profileName?: string;
  traceRoots?: string[];
  transcriptRoots?: string[];
  repoPaths?: string[];
  userId?: string;
  maxTranscriptFiles?: number;
}

export interface ProfileBootstrapResult {
  profileRecord: StoredForemanProfile;
  profileMemory: ProfileMemory;
  userMemory?: UserMemory;
  summary: string;
}

export interface WorkDiscoveryInput {
  profileId?: string;
  traceRoots?: string[];
  transcriptRoots?: string[];
  maxTranscriptFiles?: number;
  maxItems?: number;
}

export interface WorkDiscoveryItem {
  id: string;
  source: 'trace' | 'transcript';
  title: string;
  summary: string;
  status: 'open' | 'blocked' | 'stale' | 'completed';
  confidence: number;
  updatedAt?: string;
  recommendedAction: string;
  metadata?: Record<string, string>;
}

export interface WorkDiscoveryResult {
  profileId?: string;
  generatedAt: string;
  items: WorkDiscoveryItem[];
  summary: string;
}

export class FilesystemProfileStore implements ProfileStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async get(profileId: string): Promise<StoredForemanProfile | null> {
    return readJson(join(this.root, `${sanitize(profileId)}.json`));
  }

  async put(record: StoredForemanProfile): Promise<void> {
    await writeJson(join(this.root, `${sanitize(record.profile.id)}.json`), record);
  }

  async list(): Promise<StoredForemanProfile[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const records: StoredForemanProfile[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const record = await readJson<StoredForemanProfile>(join(this.root, entry.name));
      if (record) {
        records.push(record);
      }
    }

    return records.sort((a, b) => a.profile.id.localeCompare(b.profile.id));
  }
}

export async function bootstrapProfileFromSources(
  input: ProfileBootstrapInput,
): Promise<ProfileBootstrapResult> {
  const traceBundles = await loadTraceBundles(input.traceRoots ?? []);
  const transcriptFiles = await loadTranscriptFiles(
    input.transcriptRoots ?? [],
    input.maxTranscriptFiles ?? 200,
  );
  const transcriptText = transcriptFiles.map((file) => file.content).join('\n\n');

  const workerCounts = new Map<string, number>();
  const capabilityCounts = new Map<WorkerCapability, number>();
  const environmentCounts = new Map<string, number>();
  const evaluationStyle = new Set<string>();

  for (const trace of traceBundles) {
    incrementFromTrace(trace, workerCounts, capabilityCounts, environmentCounts, evaluationStyle);
  }

  incrementFromTranscriptText(transcriptText, workerCounts, capabilityCounts, evaluationStyle);
  incrementFromRepos(input.repoPaths ?? [], capabilityCounts, environmentCounts);

  const preferredWorkers = rankMap(workerCounts, 5);
  const preferredCapabilities = rankMap(capabilityCounts, 5) as WorkerCapability[];
  const recurringEnvironments = rankMap(environmentCounts, 8);

  const profile: ForemanProfile = {
    id: input.profileId,
    name: input.profileName ?? humanizeProfileName(input.profileId),
    preferredWorkers,
    preferredCapabilities,
    metadata: {
      bootstrapTraceCount: String(traceBundles.length),
      bootstrapTranscriptCount: String(transcriptFiles.length),
      bootstrapRepoCount: String((input.repoPaths ?? []).length),
    },
  };

  const profileMemory: ProfileMemory = {
    profileId: profile.id,
    workerPreferences: preferredWorkers,
    evaluationStyle: Array.from(evaluationStyle),
    memoryScopes: ['profile', 'project', 'environment'],
  };

  const userMemory: UserMemory | undefined = input.userId
    ? {
        userId: input.userId,
        favoredWorkers: preferredWorkers,
        recurringEnvironments,
        preferences: [
          ...(traceBundles.length > 0 ? ['trace-informed-bootstrap'] : []),
          ...(transcriptFiles.length > 0 ? ['session-informed-bootstrap'] : []),
        ],
      }
    : undefined;

  const profileRecord: StoredForemanProfile = {
    profile,
    summary: buildBootstrapSummary({
      preferredWorkers,
      preferredCapabilities,
      recurringEnvironments,
      traceCount: traceBundles.length,
      transcriptCount: transcriptFiles.length,
      repoCount: (input.repoPaths ?? []).length,
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrap: {
      sources: [
        ...(input.traceRoots ?? []).map((value) => `trace:${value}`),
        ...(input.transcriptRoots ?? []).map((value) => `transcript:${value}`),
        ...(input.repoPaths ?? []).map((value) => `repo:${value}`),
      ],
      traceCount: traceBundles.length,
      transcriptCount: transcriptFiles.length,
      repoCount: (input.repoPaths ?? []).length,
    },
  };

  return {
    profileRecord,
    profileMemory,
    userMemory,
    summary: profileRecord.summary ?? '',
  };
}

export async function discoverWorkFromSources(
  input: WorkDiscoveryInput,
): Promise<WorkDiscoveryResult> {
  const traceBundles = await loadTraceBundles(input.traceRoots ?? []);
  const transcriptFiles = await loadTranscriptFiles(
    input.transcriptRoots ?? [],
    input.maxTranscriptFiles ?? 200,
  );

  const traceItems = traceBundles
    .map(traceBundleToWorkItem)
    .filter((item): item is WorkDiscoveryItem => Boolean(item));
  const transcriptItems = transcriptFiles
    .map(transcriptFileToWorkItem)
    .filter((item): item is WorkDiscoveryItem => Boolean(item));

  const items = [...traceItems, ...transcriptItems]
    .sort(compareWorkDiscoveryItems)
    .slice(0, input.maxItems ?? 25);

  return {
    profileId: input.profileId,
    generatedAt: new Date().toISOString(),
    items,
    summary: buildWorkDiscoverySummary(items),
  };
}

async function loadTraceBundles(traceRoots: string[]): Promise<TraceBundle[]> {
  if (process.env.FOREMAN_TRACE_DATABASE_URL || process.env.FOREMAN_MEMORY_DATABASE_URL || process.env.FOREMAN_POSTGRES_URL) {
    const store = await createTraceStore({
      rootDir: traceRoots[0],
    });
    const refs = await store.list();
    const bundles = await Promise.all(refs.map(async (ref) => store.get(ref.traceId)));
    return bundles.filter((bundle): bundle is TraceBundle => Boolean(bundle));
  }

  const bundles: TraceBundle[] = [];
  for (const root of traceRoots) {
    const store = new FilesystemTraceStore(root);
    const refs = await store.list();
    for (const ref of refs) {
      const bundle = await store.get(ref.traceId);
      if (bundle) {
        bundles.push(bundle);
      }
    }
  }
  return bundles;
}

async function loadTranscriptFiles(
  roots: string[],
  maxFiles: number,
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string; updatedAt?: string }> = [];
  for (const root of roots) {
    await walkTranscriptRoot(resolve(root), files, maxFiles);
    if (files.length >= maxFiles) {
      break;
    }
  }
  return files;
}

async function walkTranscriptRoot(
  root: string,
  out: Array<{ path: string; content: string; updatedAt?: string }>,
  maxFiles: number,
): Promise<void> {
  if (out.length >= maxFiles) {
    return;
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) {
      return;
    }
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkTranscriptRoot(fullPath, out, maxFiles);
      continue;
    }
    if (!entry.isFile() || !/\.(json|jsonl|md|txt)$/i.test(entry.name)) {
      continue;
    }
    try {
      const content = await readFile(fullPath, 'utf8');
      const info = await stat(fullPath).catch(() => null);
      out.push({
        path: fullPath,
        content,
        updatedAt: info?.mtime.toISOString(),
      });
    } catch {
      // Ignore unreadable files during bootstrap.
    }
  }
}

function incrementFromTrace(
  trace: TraceBundle,
  workerCounts: Map<string, number>,
  capabilityCounts: Map<WorkerCapability, number>,
  environmentCounts: Map<string, number>,
  evaluationStyle: Set<string>,
): void {
  const workerIds = [
    trace.metadata?.selectedWorkerId,
    trace.metadata?.reviewWorkerId,
    trace.metadata?.plannerWorkerId,
    ...trace.events.map((event) => event.workerId),
  ].filter((value): value is string => Boolean(value));

  for (const workerId of workerIds) {
    increment(workerCounts, workerId);
    if (workerId.includes('review') || workerId.includes('claude')) {
      increment(capabilityCounts, 'review');
    }
    if (workerId.includes('codex') || workerId.includes('claude') || workerId.includes('code')) {
      increment(capabilityCounts, 'code');
    }
  }

  if (trace.task.environmentKind) {
    increment(environmentCounts, trace.task.environmentKind);
    if (isCapability(trace.task.environmentKind)) {
      increment(capabilityCounts, trace.task.environmentKind);
    }
  }

  if (trace.metadata?.repoPath) {
    increment(environmentCounts, `repo:${trace.metadata.repoPath}`);
  }

  if (trace.evidence.some((item) => item.kind === 'test')) {
    evaluationStyle.add('deterministic-first');
  }
  if (trace.metadata?.toolCommandsJson && trace.metadata.toolCommandsJson !== '[]') {
    evaluationStyle.add('tool-audits');
  }
  if (trace.metadata?.reviewWorkerId) {
    evaluationStyle.add('judge-after-grounded-checks');
  }
}

function incrementFromTranscriptText(
  text: string,
  workerCounts: Map<string, number>,
  capabilityCounts: Map<WorkerCapability, number>,
  evaluationStyle: Set<string>,
): void {
  const lower = text.toLowerCase();
  const phrases: Array<[string, string | WorkerCapability]> = [
    ['codex', 'codex'],
    ['claude', 'claude'],
    ['opencode', 'opencode'],
    ['browser', 'browser'],
    ['research', 'research'],
    ['review', 'review'],
    ['audit', 'review'],
    ['deploy', 'ops'],
    ['ops', 'ops'],
    ['document', 'document'],
    ['tax', 'document'],
    ['test', 'code'],
  ];

  for (const [needle, key] of phrases) {
    if (!lower.includes(needle)) {
      continue;
    }
    if (isCapability(key)) {
      increment(capabilityCounts, key);
    } else {
      increment(workerCounts, key);
    }
  }

  if (lower.includes('test') || lower.includes('typecheck') || lower.includes('lint')) {
    evaluationStyle.add('deterministic-first');
  }
  if (lower.includes('review') || lower.includes('audit')) {
    evaluationStyle.add('judge-after-grounded-checks');
  }
}

function incrementFromRepos(
  repoPaths: string[],
  capabilityCounts: Map<WorkerCapability, number>,
  environmentCounts: Map<string, number>,
): void {
  for (const repoPath of repoPaths) {
    increment(capabilityCounts, 'code');
    increment(environmentCounts, `repo:${repoPath}`);
  }
}

function buildBootstrapSummary(input: {
  preferredWorkers: string[];
  preferredCapabilities: string[];
  recurringEnvironments: string[];
  traceCount: number;
  transcriptCount: number;
  repoCount: number;
}): string {
  return [
    `Bootstrap analyzed ${input.traceCount} trace(s), ${input.transcriptCount} transcript file(s), and ${input.repoCount} repo target(s).`,
    input.preferredWorkers.length > 0
      ? `Preferred workers inferred: ${input.preferredWorkers.join(', ')}.`
      : 'No stable worker preference was inferred.',
    input.preferredCapabilities.length > 0
      ? `Preferred capabilities inferred: ${input.preferredCapabilities.join(', ')}.`
      : 'No stable capability preference was inferred.',
    input.recurringEnvironments.length > 0
      ? `Recurring environments: ${input.recurringEnvironments.join(', ')}.`
      : 'No recurring environments were inferred.',
  ].join(' ');
}

function rankMap<T extends string>(map: Map<T, number>, maxItems: number): T[] {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxItems)
    .map(([key]) => key);
}

function increment<T>(map: Map<T, number>, key: T): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function isCapability(value: string): value is WorkerCapability {
  return value === 'code'
    || value === 'browser'
    || value === 'review'
    || value === 'research'
    || value === 'ops'
    || value === 'document'
    || value === 'hybrid';
}

function humanizeProfileName(profileId: string): string {
  return profileId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function traceBundleToWorkItem(bundle: TraceBundle): WorkDiscoveryItem | null {
  const outcomeStatus = bundle.outcome?.status;
  const validated = bundle.outcome?.validated ?? false;
  const updatedAt = latestTraceTimestamp(bundle);
  const surface = bundle.metadata?.surface ?? 'trace';
  const title = deriveTraceWorkItemTitle(bundle);
  const roundCount = bundle.metadata?.roundCount ?? '0';
  const highSeverityFindingCount = parseOptionalNumber(bundle.metadata?.highSeverityFindingCount) ?? 0;
  const failedChildRunCount = parseOptionalNumber(bundle.metadata?.childRunFailedCount) ?? 0;

  if (outcomeStatus === 'completed' && validated) {
    return null;
  }

  let status: WorkDiscoveryItem['status'] = 'open';
  let confidence = 0.6;
  let recommendedAction = surface === 'supervisor'
    ? 'Inspect the external orchestrator result and decide whether to rerun, repair, or escalate the failed child work.'
    : 'Review the last run and continue the task with the same profile.';

  if (outcomeStatus === 'blocked') {
    status = 'blocked';
    confidence = 0.95;
    recommendedAction = surface === 'supervisor'
      ? 'Decide whether to approve, reconfigure, or escalate the blocked external orchestrator run.'
      : 'Inspect blockers, gather missing context, and decide whether to resume or escalate.';
  } else if (outcomeStatus === 'max_rounds') {
    status = 'stale';
    confidence = 0.85;
    recommendedAction = 'Resume with a repair-oriented plan and stricter validation focus.';
  } else if (outcomeStatus === 'running') {
    status = 'open';
    confidence = 0.8;
    recommendedAction = 'Resume the task and verify whether the prior worker actually made progress.';
  } else if (!validated) {
    status = 'open';
    confidence = 0.75;
    recommendedAction = surface === 'supervisor'
      ? 'Review supervisor findings, failed child runs, and rerun or repair the orchestrator before treating it as complete.'
      : 'Run validation and review before treating this work as complete.';
  }

  if (surface === 'supervisor' && (highSeverityFindingCount > 0 || failedChildRunCount > 0)) {
    status = 'blocked';
    confidence = Math.max(confidence, 0.92);
    recommendedAction = 'Repair or rerun the external orchestrator with attention to failed child runs and high-severity findings.';
  }

  return {
    id: `trace:${bundle.task.id}:${updatedAt ?? 'unknown'}`,
    source: 'trace',
    title: truncate(title, 140),
    summary: truncate(
      [
        `Task ${bundle.task.id}`,
        bundle.outcome?.summary,
        `Rounds: ${roundCount}`,
      ].filter(Boolean).join(' | '),
      240,
    ),
    status,
    confidence,
    updatedAt,
    recommendedAction,
    metadata: {
      surface,
      taskId: bundle.task.id,
      taskShape: bundle.metadata?.taskShape ?? (surface === 'supervisor' ? 'supervisor' : 'unknown'),
      repoPath: bundle.metadata?.repoPath ?? '',
      originalGoal: bundle.metadata?.originalGoal ?? bundle.task.goal,
      outcomeStatus: outcomeStatus ?? '',
      traceIdHint: bundle.task.id,
      label: bundle.metadata?.label ?? '',
      childRunFailedCount: bundle.metadata?.childRunFailedCount ?? '',
      highSeverityFindingCount: bundle.metadata?.highSeverityFindingCount ?? '',
    },
  };
}

function deriveTraceWorkItemTitle(bundle: TraceBundle): string {
  const surface = bundle.metadata?.surface;
  if (surface === 'supervisor' && bundle.metadata?.label) {
    return `supervisor ${bundle.metadata.label}`;
  }
  return bundle.metadata?.originalGoal ?? bundle.task.goal;
}

function transcriptFileToWorkItem(input: {
  path: string;
  content: string;
  updatedAt?: string;
}): WorkDiscoveryItem | null {
  const text = input.content.trim();
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  const titleLine = text.split(/\r?\n/).find((line) => line.trim()) ?? input.path;
  const summaryLine = text
    .split(/\r?\n/)
    .find((line) => /todo|next|blocked|resume|continue|follow up|pending/i.test(line))
    ?? text.split(/\r?\n/).slice(0, 3).join(' ');

  const status = lower.includes('blocked')
    ? 'blocked'
    : lower.includes('resume') || lower.includes('continue') || lower.includes('pending') || lower.includes('todo')
      ? 'open'
      : lower.includes('done') || lower.includes('complete')
        ? 'completed'
        : 'stale';

  if (status === 'completed') {
    return null;
  }

  const confidence = status === 'blocked'
    ? 0.75
    : status === 'open'
      ? 0.65
      : 0.4;

  return {
    id: `transcript:${input.path}`,
    source: 'transcript',
    title: truncate(titleLine.replace(/^#+\s*/, ''), 140),
    summary: truncate(summaryLine, 240),
    status,
    confidence,
    updatedAt: input.updatedAt,
    recommendedAction: status === 'blocked'
      ? 'Review the transcript for blockers and decide whether to resume with more context.'
      : 'Review the transcript and resume or close the work loop explicitly.',
    metadata: {
      path: input.path,
    },
  };
}

function latestTraceTimestamp(bundle: TraceBundle): string | undefined {
  const candidates = [
    ...bundle.events.map((event) => event.at),
    bundle.metadata?.finishedAt,
    bundle.metadata?.startedAt,
  ].filter((value): value is string => Boolean(value));
  return candidates.sort().at(-1);
}

function compareWorkDiscoveryItems(a: WorkDiscoveryItem, b: WorkDiscoveryItem): number {
  const statusOrder: Record<WorkDiscoveryItem['status'], number> = {
    blocked: 4,
    open: 3,
    stale: 2,
    completed: 1,
  };
  return (
    statusOrder[b.status] - statusOrder[a.status]
    || b.confidence - a.confidence
    || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
    || a.id.localeCompare(b.id)
  );
}

function buildWorkDiscoverySummary(items: WorkDiscoveryItem[]): string {
  if (items.length === 0) {
    return 'No open or stalled work was discovered from the provided sources.';
  }
  const blocked = items.filter((item) => item.status === 'blocked').length;
  const open = items.filter((item) => item.status === 'open').length;
  const stale = items.filter((item) => item.status === 'stale').length;
  return `Discovered ${items.length} candidate work item(s): ${blocked} blocked, ${open} open, ${stale} stale.`;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}
