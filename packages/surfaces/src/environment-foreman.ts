import { mkdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  createFilesystemArtifacts,
  runTaskLoop,
  type ContextSnapshot,
  type Evidence,
  type Finding,
  type TaskSpec,
  type TrackResult,
  type ValidationResult,
} from '@drew/foreman-core';
import {
  FilesystemDocumentEnvironment,
  ResearchCorpusEnvironment,
  ServiceEnvironment,
  type EnvironmentAdapter,
  type Observation,
} from '@drew/foreman-environments';
import {
  createMemoryStore,
  recordWorkerRun,
  type EnvironmentMemory,
  type MemoryStore,
  type WorkerPerformanceMemory,
} from '@drew/foreman-memory';
import {
  createClaudeProvider,
  createCodexProvider,
  type TextProvider,
} from '@drew/foreman-providers';
import { createTraceStore } from '@drew/foreman-tracing';
import {
  ProviderWorkerAdapter,
  WorkerRegistry,
  type ForemanProfile,
  type ProviderWorkerTask,
} from '@drew/foreman-workers';

export type EnvironmentRunDomain = 'ops' | 'document' | 'research';

export interface EnvironmentForemanOptions {
  domain: EnvironmentRunDomain;
  target: string;
  goal: string;
  successCriteria: string[];
  provider?: 'claude' | 'codex';
  taskId?: string;
  traceRoot?: string;
  memoryRoot?: string;
  artifactsRoot?: string;
  maxRounds?: number;
  healthUrls?: string[];
  checkCommands?: string[];
  filePatterns?: string[];
  checklistPatterns?: string[];
  sourcePatterns?: string[];
  notePatterns?: string[];
}

export interface EnvironmentForemanResult {
  runDir: string;
  traceId: string;
  selectedWorkerId: 'claude' | 'codex';
  validation?: ValidationResult;
  domain: EnvironmentRunDomain;
}

interface DocumentState {
  root: string;
  fileCount: number;
  recentFiles: string[];
  checklistHits: string[];
}

interface ServiceState {
  label: string;
  healthy: boolean;
  endpointStatuses: Array<{ url: string; status: number; ok: boolean }>;
  checkResults: Array<{ command: string; exitCode: number; passed: boolean }>;
}

interface ResearchState {
  root: string;
  sourceCount: number;
  citationLikeFiles: string[];
  noteLikeFiles: string[];
}

export async function runEnvironmentForeman(
  options: EnvironmentForemanOptions,
): Promise<EnvironmentForemanResult> {
  const target = resolveMaybePath(options.target);
  const taskId = options.taskId ?? `${options.domain}-${slugify(basename(target) || options.domain)}`;
  const traceRoot = resolve(options.traceRoot ?? join(process.cwd(), '.foreman', 'traces'));
  const memoryRoot = resolve(options.memoryRoot ?? join(process.cwd(), '.foreman', 'memory'));
  const artifactsRoot = resolve(options.artifactsRoot ?? join(process.cwd(), '.foreman', 'runs', taskId));
  const maxRounds = options.maxRounds ?? 2;

  await mkdir(traceRoot, { recursive: true });
  await mkdir(memoryRoot, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });

  const artifacts = createFilesystemArtifacts(artifactsRoot);
  const traceStore = await createTraceStore({
    rootDir: traceRoot,
  });
  const memoryStore = await createMemoryStore({
    rootDir: memoryRoot,
  });
  const environment = createEnvironmentAdapter(options, target);
  const [environmentMemory, codexMemory, claudeMemory] = await Promise.all([
    memoryStore.getEnvironmentMemory(target),
    memoryStore.getWorkerMemory('codex'),
    memoryStore.getWorkerMemory('claude'),
  ]);

  const selectedWorkerId = selectProvider(options.provider, { codex: codexMemory, claude: claudeMemory });
  const providers = {
    codex: createCodexProvider(),
    claude: createClaudeProvider(),
  } satisfies Record<'claude' | 'codex', TextProvider>;
  const registry = new WorkerRegistry();
  registry.register(createEnvironmentWorker('codex', providers.codex, options.domain));
  registry.register(createEnvironmentWorker('claude', providers.claude, options.domain));
  const profile: ForemanProfile = {
    id: `${options.domain}-foreman`,
    name: `${capitalize(options.domain)} Foreman`,
    preferredWorkers: [selectedWorkerId],
    preferredCapabilities: [domainToCapability(options.domain)],
  };
  const worker = registry.select(
    {
      capability: domainToCapability(options.domain),
      preferredWorkerIds: [selectedWorkerId],
    },
    profile,
  );
  if (!worker) {
    throw new Error(`no worker available for ${options.domain}`);
  }

  const task: TaskSpec = {
    id: taskId,
    goal: options.goal,
    successCriteria: options.successCriteria,
    environment: {
      kind: options.domain === 'ops' ? 'api' : 'document',
      target,
    },
    policy: {
      escalationMode: 'ask-human',
      maxTurns: maxRounds,
    },
  };

  const result = await runTaskLoop({
    task,
    maxRounds,
    artifacts,
    context: async () => buildEnvironmentContext(environment, environmentMemory),
    plan: async ({ context }) => ({
      summary: `single ${options.domain} execution track`,
      tracks: [
        {
          id: 'main',
          goal: options.goal,
          capability: domainToCapability(options.domain),
          metadata: {
            target,
            contextSummary: context.summary,
          },
        },
      ],
    }),
    executeTrack: async ({ context, track }) => {
      const run = await worker.run({
        task: {
          goal: options.goal,
          successCriteria: options.successCriteria,
          repoPath: await existingDirectory(target) ? target : undefined,
          extraInstructions: buildEnvironmentInstructions(options),
        } satisfies ProviderWorkerTask,
        context: {
          summary: context.summary,
          state: context.state,
          evidence: context.evidence,
        },
        instructions: track.goal,
      });

      return {
        trackId: track.id,
        status: run.result?.status ?? 'failed',
        summary: run.summary,
        output: run.result?.output,
        evidence: run.evidence.map(toCoreEvidence),
        metadata: {
          selectedWorkerId: worker.worker.id,
          ...(run.metrics?.durationMs !== undefined ? { durationMs: String(run.metrics.durationMs) } : {}),
          ...(run.metrics?.costUsd !== undefined ? { costUsd: String(run.metrics.costUsd) } : {}),
        },
      } satisfies TrackResult<unknown>;
    },
    validate: async ({ trackResults }) => {
      const verification = await environment.observe();
      return validateEnvironmentRun(options.domain, verification, trackResults, options.successCriteria);
    },
    repair: async ({ validation }) => {
      if (validation.recommendation !== 'repair') {
        return undefined;
      }
      return {
        summary: `repair ${options.domain} environment gaps`,
        actions: validation.findings.map((finding) => finding.title),
      };
    },
  });

  const finalObservation = await environment.observe();
  await updateEnvironmentMemory(memoryStore, target, finalObservation, options.domain);
  await updateWorkerMemory(memoryStore, worker.worker.id as 'claude' | 'codex', result.state.outcome?.status === 'completed', result.state);

  const evidence = [
    ...result.state.rounds.flatMap((round) => [
      ...(round.context.evidence ?? []),
      ...(round.validation.evidence ?? []),
      ...round.trackResults.flatMap((track) => track.evidence),
    ]),
    ...(finalObservation.evidence ?? []).map(toCoreEvidence),
  ];

  const traceId = await traceStore.put({
    task: {
      id: task.id,
      goal: task.goal,
      environmentKind: task.environment?.kind,
    },
    events: result.state.trace,
    evidence: evidence.map((item) => ({
      kind: item.kind,
      label: item.label,
      value: item.value,
      uri: item.uri,
      metadata: item.metadata,
    })),
    outcome: result.state.outcome,
    metadata: {
      surface: options.domain,
      provider: worker.worker.id,
      target,
      taskShape: options.domain,
    },
  });

  return {
    runDir: artifactsRoot,
    traceId,
    selectedWorkerId: worker.worker.id as 'claude' | 'codex',
    validation: result.state.rounds.at(-1)?.validation,
    domain: options.domain,
  };
}

function createEnvironmentAdapter(
  options: EnvironmentForemanOptions,
  target: string,
): EnvironmentAdapter {
  if (options.domain === 'ops') {
    return new ServiceEnvironment(target, {
      healthUrls: options.healthUrls,
      checkCommands: options.checkCommands,
      cwd: target.startsWith('http://') || target.startsWith('https://') ? process.cwd() : target,
    });
  }
  if (options.domain === 'research') {
    return new ResearchCorpusEnvironment(target, {
      sourcePatterns: options.sourcePatterns,
      notePatterns: options.notePatterns,
    });
  }
  return new FilesystemDocumentEnvironment(target, {
    filePatterns: options.filePatterns,
    checklistPatterns: options.checklistPatterns,
  });
}

function createEnvironmentWorker(
  workerId: 'claude' | 'codex',
  provider: TextProvider,
  domain: EnvironmentRunDomain,
): ProviderWorkerAdapter {
  return new ProviderWorkerAdapter(
    {
      id: workerId,
      name: capitalize(workerId),
      capabilities: [domainToCapability(domain), 'review'],
    },
    provider,
    ({ task, context, instructions }) => {
      const lines = [
        `You are operating as a ${domain} worker under Foreman supervision.`,
        `Goal: ${task.goal}`,
        instructions ? `Track: ${instructions}` : '',
        task.successCriteria?.length ? `Success criteria:\n- ${task.successCriteria.join('\n- ')}` : '',
        context.summary ? `Environment context:\n${context.summary}` : '',
        context.evidence?.length
          ? `Environment evidence:\n${context.evidence.map((item) => `- [${item.kind}] ${item.label}: ${item.value}`).join('\n')}`
          : '',
        task.extraInstructions ? `Additional instructions:\n${task.extraInstructions}` : '',
        'Return a concise execution summary, the concrete actions you would take, and any validation-relevant observations.',
      ].filter(Boolean);
      return lines.join('\n\n');
    },
  );
}

async function buildEnvironmentContext(
  environment: EnvironmentAdapter,
  memory: EnvironmentMemory | null,
): Promise<ContextSnapshot> {
  const observation = await environment.observe();
  return {
    summary: [
      observation.summary,
      memory?.facts?.length ? `Known facts: ${memory.facts.join(' | ')}` : '',
      memory?.failureModes?.length ? `Known failure modes: ${memory.failureModes.join(' | ')}` : '',
    ].filter(Boolean).join('\n'),
    state: observation.state,
    evidence: (observation.evidence ?? []).map(toCoreEvidence),
  };
}

function validateEnvironmentRun(
  domain: EnvironmentRunDomain,
  observation: Observation & { state?: unknown },
  trackResults: Array<TrackResult<unknown>>,
  successCriteria: string[],
): ValidationResult {
  const failedTrack = trackResults.find((track) => track.status === 'failed');
  const findings: Finding[] = [];
  let status: ValidationResult['status'] = 'pass';
  let recommendation: ValidationResult['recommendation'] = 'complete';

  if (failedTrack) {
    status = 'fail';
    recommendation = 'repair';
    findings.push({
      severity: 'high',
      title: 'Worker execution failed',
      body: failedTrack.summary,
      sourceTrackId: failedTrack.trackId,
    });
  }

  if (domain === 'ops') {
    const state = observation.state as ServiceState | undefined;
    if (state && !state.healthy) {
      status = 'fail';
      recommendation = 'repair';
      findings.push({
        severity: 'critical',
        title: 'Service checks failed',
        body: 'One or more health endpoints or command checks failed.',
        evidence: observation.summary,
      });
    }
  } else {
    const state = observation.state as DocumentState | ResearchState | undefined;
    if (domain === 'document' && state && 'checklistHits' in state && state.checklistHits.length > 0) {
      status = status === 'fail' ? 'fail' : 'warn';
      recommendation = status === 'fail' ? 'repair' : 'repair';
      findings.push({
        severity: 'medium',
        title: 'Document workspace still has checklist-like signals',
        body: `Found ${state.checklistHits.length} file(s) with unresolved checklist patterns.`,
        evidence: state.checklistHits.join(', '),
      });
    }
    if (domain === 'document' && state && 'fileCount' in state && state.fileCount === 0) {
      status = 'fail';
      recommendation = 'repair';
      findings.push({
        severity: 'high',
        title: 'No document files found',
        body: 'The target workspace did not contain any matching document files.',
      });
    }
    if (domain === 'research' && state && 'sourceCount' in state) {
      if (state.sourceCount === 0) {
        status = 'fail';
        recommendation = 'repair';
        findings.push({
          severity: 'high',
          title: 'No research sources found',
          body: 'The research workspace did not contain any matching source files.',
        });
      } else if (state.citationLikeFiles.length === 0) {
        status = status === 'fail' ? 'fail' : 'warn';
        recommendation = 'repair';
        findings.push({
          severity: 'medium',
          title: 'Research workspace lacks citation-like signals',
          body: 'Sources were found, but no citation-like markers were detected.',
        });
      }
    }
  }

  return {
    status,
    recommendation,
    summary: [
      observation.summary,
      successCriteria.length > 0 ? `Checked ${successCriteria.length} success criteria.` : '',
    ].filter(Boolean).join(' '),
    findings,
    evidence: (observation.evidence ?? []).map(toCoreEvidence),
  };
}

async function updateEnvironmentMemory(
  memoryStore: MemoryStore,
  target: string,
  observation: Observation & { state?: unknown },
  domain: EnvironmentRunDomain,
): Promise<void> {
  const state = observation.state as { checklistHits?: string[]; healthy?: boolean } | undefined;
  await memoryStore.putEnvironmentMemory({
    target,
    facts: [observation.summary],
    failureModes: domain === 'ops'
      ? state?.healthy === false ? ['service-check-failure'] : []
      : domain === 'document'
        ? state?.checklistHits?.length ? ['unresolved-document-checklists'] : []
        : 'citationLikeFiles' in (observation.state as object ?? {})
          ? ((observation.state as ResearchState).citationLikeFiles.length === 0 ? ['missing-research-citation-signals'] : [])
          : [],
  });
}

async function updateWorkerMemory(
  memoryStore: MemoryStore,
  workerId: 'claude' | 'codex',
  succeeded: boolean,
  state: { startedAt: string; finishedAt?: string; rounds: Array<{ trackResults: Array<{ metadata?: Record<string, string> }> }> },
): Promise<void> {
  const existing = await memoryStore.getWorkerMemory(workerId);
  const durationMs = computeDurationMs(state.startedAt, state.finishedAt);
  const costUsd = state.rounds
    .flatMap((round) => round.trackResults)
    .map((track) => Number(track.metadata?.costUsd ?? ''))
    .filter((value) => Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0);
  const updated = recordWorkerRun(
    existing ? { ...existing, workerId } : { workerId },
    {
      succeeded,
      durationMs,
      costUsd: costUsd > 0 ? costUsd : undefined,
      failureClasses: succeeded ? [] : ['environment-run-failed'],
    },
  );
  updated.workerId = workerId;
  await memoryStore.putWorkerMemory(updated);
}

function selectProvider(
  explicit: EnvironmentForemanOptions['provider'],
  memories: Record<'claude' | 'codex', WorkerPerformanceMemory | null>,
): 'claude' | 'codex' {
  if (explicit) {
    return explicit;
  }
  const codexScore = (memories.codex?.successRate ?? 0) - (memories.codex?.avgCostUsd ?? 0);
  const claudeScore = (memories.claude?.successRate ?? 0) - (memories.claude?.avgCostUsd ?? 0);
  return codexScore > claudeScore ? 'codex' : 'claude';
}

function buildOpsInstructions(options: EnvironmentForemanOptions): string {
  return [
    options.healthUrls?.length ? `Health URLs:\n- ${options.healthUrls.join('\n- ')}` : '',
    options.checkCommands?.length ? `Deterministic checks:\n- ${options.checkCommands.join('\n- ')}` : '',
    'Focus on operational health, blockers, and the next concrete actions required to stabilize or advance the service.',
  ].filter(Boolean).join('\n\n');
}

function buildDocumentInstructions(options: EnvironmentForemanOptions): string {
  return [
    options.checklistPatterns?.length ? `Checklist patterns:\n- ${options.checklistPatterns.join('\n- ')}` : '',
    'Focus on unresolved document gaps, missing checklist items, and what needs to be completed or reviewed next.',
  ].filter(Boolean).join('\n\n');
}

function buildResearchInstructions(options: EnvironmentForemanOptions): string {
  return [
    options.sourcePatterns?.length ? `Source patterns:\n- ${options.sourcePatterns.join('\n- ')}` : '',
    options.notePatterns?.length ? `Note patterns:\n- ${options.notePatterns.join('\n- ')}` : '',
    'Focus on source coverage, citation quality, synthesis gaps, and what follow-up research or summarization work should happen next.',
  ].filter(Boolean).join('\n\n');
}

function buildEnvironmentInstructions(options: EnvironmentForemanOptions): string {
  if (options.domain === 'ops') {
    return buildOpsInstructions(options);
  }
  if (options.domain === 'research') {
    return buildResearchInstructions(options);
  }
  return buildDocumentInstructions(options);
}

function toCoreEvidence(input: {
  kind: string;
  label: string;
  value: string;
  uri?: string;
  metadata?: Record<string, string>;
}): Evidence {
  const allowedKinds = new Set(['log', 'metric', 'screenshot', 'diff', 'test', 'note', 'artifact']);
  return {
    kind: allowedKinds.has(input.kind) ? input.kind as Evidence['kind'] : 'note',
    label: input.label,
    value: input.value,
    uri: input.uri,
    metadata: input.metadata,
  };
}

function computeDurationMs(startedAt: string, finishedAt?: string): number | undefined {
  if (!finishedAt) {
    return undefined;
  }
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) {
    return undefined;
  }
  return Math.max(0, finished - started);
}

function resolveMaybePath(value: string): string {
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  return resolve(value);
}

async function existingDirectory(path: string): Promise<boolean> {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return false;
  }
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function slugify(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function domainToCapability(domain: EnvironmentRunDomain): 'ops' | 'document' | 'research' {
  return domain === 'ops' ? 'ops' : domain === 'research' ? 'research' : 'document';
}
