import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  createFilesystemArtifacts,
  runTaskLoop,
  type ContextSnapshot,
  type Evidence,
  type TaskSpec,
  type TrackResult,
  type ValidationResult,
} from '@drew/foreman-core';
import {
  FilesystemDocumentEnvironment,
  GitCodeEnvironment,
  HybridEnvironment,
  ResearchCorpusEnvironment,
  ServiceEnvironment,
  type EnvironmentAdapter,
  type Observation,
} from '@drew/foreman-environments';
import { createMemoryStore, type EnvironmentMemory } from '@drew/foreman-memory';
import { createClaudeProvider, createCodexProvider, type TextProvider } from '@drew/foreman-providers';
import { createTraceStore } from '@drew/foreman-tracing';
import { ProviderWorkerAdapter, WorkerRegistry, type ProviderWorkerTask } from '@drew/foreman-workers';

export type HybridEnvironmentKind = 'code' | 'document' | 'research' | 'ops';

export interface HybridEnvironmentInput {
  kind: HybridEnvironmentKind;
  target: string;
}

export interface HybridForemanOptions {
  goal: string;
  successCriteria: string[];
  environments: HybridEnvironmentInput[];
  provider?: 'claude' | 'codex';
  taskId?: string;
  traceRoot?: string;
  memoryRoot?: string;
  artifactsRoot?: string;
  maxRounds?: number;
  healthUrls?: string[];
  checkCommands?: string[];
}

export interface HybridForemanResult {
  runDir: string;
  traceId: string;
  selectedWorkerId: 'claude' | 'codex';
  validation?: ValidationResult;
  environmentCount: number;
}

export async function runHybridForeman(
  options: HybridForemanOptions,
): Promise<HybridForemanResult> {
  const taskId = options.taskId ?? `hybrid-${slugify(basename(options.environments[0]?.target ?? 'run'))}`;
  const traceRoot = resolve(options.traceRoot ?? join(process.cwd(), '.foreman', 'traces'));
  const memoryRoot = resolve(options.memoryRoot ?? join(process.cwd(), '.foreman', 'memory'));
  const artifactsRoot = resolve(options.artifactsRoot ?? join(process.cwd(), '.foreman', 'runs', taskId));
  const maxRounds = options.maxRounds ?? 2;

  await mkdir(traceRoot, { recursive: true });
  await mkdir(memoryRoot, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });

  const artifacts = createFilesystemArtifacts(artifactsRoot);
  const traceStore = await createTraceStore({ rootDir: traceRoot });
  const memoryStore = await createMemoryStore({ rootDir: memoryRoot });
  const adapters = createHybridAdapters(options);
  const hybridEnvironment = new HybridEnvironment(adapters.map((item) => item.adapter));
  const knownMemories = await Promise.all(
    adapters.map(async (item) => ({
      target: item.target,
      memory: await memoryStore.getEnvironmentMemory(item.target),
    })),
  );
  const providerId = options.provider ?? 'claude';
  const providers = {
    codex: createCodexProvider(),
    claude: createClaudeProvider(),
  } satisfies Record<'claude' | 'codex', TextProvider>;

  const registry = new WorkerRegistry();
  registry.register(createHybridWorker('codex', providers.codex));
  registry.register(createHybridWorker('claude', providers.claude));
  const worker = registry.get(providerId);
  if (!worker) {
    throw new Error(`no worker available for ${providerId}`);
  }

  const task: TaskSpec = {
    id: taskId,
    goal: options.goal,
    successCriteria: options.successCriteria,
    environment: {
      kind: 'hybrid',
      target: adapters.map((item) => `${item.kind}:${item.target}`).join(','),
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
    context: async () => {
      const observation = await hybridEnvironment.observe();
      return {
        summary: [
          observation.summary,
          ...knownMemories.flatMap((item) => item.memory?.facts?.length ? [`${item.target}: ${item.memory.facts.join(' | ')}`] : []),
        ].filter(Boolean).join('\n'),
        state: observation.state,
        evidence: (observation.evidence ?? []).map(toCoreEvidence),
      } satisfies ContextSnapshot;
    },
    plan: async () => ({
      summary: `hybrid execution across ${adapters.length} environment(s)`,
      tracks: adapters.map((item, index) => ({
        id: `env-${index + 1}`,
        goal: `${item.kind} environment work for ${options.goal}`,
        capability: item.kind === 'ops' ? 'ops' : item.kind === 'research' ? 'research' : item.kind === 'code' ? 'code' : 'document',
        metadata: {
          environmentKind: item.kind,
          target: item.target,
        },
      })),
    }),
    executeTrack: async ({ context, track }) => {
      const item = adapters.find((adapter, index) => `env-${index + 1}` === track.id);
      if (!item) {
        throw new Error(`missing hybrid environment for track ${track.id}`);
      }
      const observation = await item.adapter.observe();
      const run = await worker.run({
        task: {
          goal: options.goal,
          successCriteria: options.successCriteria,
          repoPath: item.kind === 'code' ? item.target : undefined,
          extraInstructions: buildHybridTrackInstructions(item.kind, item.target, observation, options),
        } satisfies ProviderWorkerTask,
        context: {
          summary: context.summary,
          state: context.state,
          evidence: [
            ...(context.evidence ?? []),
            ...(observation.evidence ?? []).map(toCoreEvidence),
          ],
        },
        instructions: track.goal,
      });

      return {
        trackId: track.id,
        status: run.result?.status ?? 'failed',
        summary: run.summary,
        output: run.result?.output,
        evidence: [
          ...run.evidence.map(toCoreEvidence),
          ...(observation.evidence ?? []).map(toCoreEvidence),
        ],
        metadata: {
          environmentKind: item.kind,
          target: item.target,
        },
      } satisfies TrackResult<unknown>;
    },
    validate: async ({ trackResults }) => {
      const observations = await Promise.all(adapters.map((item) => item.adapter.observe()));
      return validateHybridRun(adapters, observations, trackResults, options.successCriteria);
    },
  });

  const finalObservations = await Promise.all(adapters.map((item) => item.adapter.observe()));
  for (const [index, item] of adapters.entries()) {
    const observation = finalObservations[index];
    await memoryStore.putEnvironmentMemory({
      target: item.target,
      facts: [observation?.summary ?? `${item.kind} observed`],
    });
  }

  const evidence = [
    ...result.state.rounds.flatMap((round) => [
      ...(round.context.evidence ?? []),
      ...(round.validation.evidence ?? []),
      ...round.trackResults.flatMap((track) => track.evidence),
    ]),
    ...finalObservations.flatMap((item) => (item.evidence ?? []).map(toCoreEvidence)),
  ];

  const traceId = await traceStore.put({
    task: {
      id: task.id,
      goal: task.goal,
      environmentKind: 'hybrid',
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
      surface: 'hybrid',
      provider: providerId,
      taskShape: 'hybrid',
      environmentKinds: adapters.map((item) => item.kind).join(','),
      environmentTargets: adapters.map((item) => item.target).join(','),
    },
  });

  return {
    runDir: artifactsRoot,
    traceId,
    selectedWorkerId: providerId,
    validation: result.state.rounds.at(-1)?.validation,
    environmentCount: adapters.length,
  };
}

function createHybridAdapters(
  options: HybridForemanOptions,
): Array<{ kind: HybridEnvironmentKind; target: string; adapter: EnvironmentAdapter }> {
  return options.environments.map((env) => {
    const target = resolveMaybePath(env.target);
    if (env.kind === 'code') {
      return { kind: env.kind, target, adapter: new GitCodeEnvironment(target) };
    }
    if (env.kind === 'document') {
      return { kind: env.kind, target, adapter: new FilesystemDocumentEnvironment(target) };
    }
    if (env.kind === 'research') {
      return { kind: env.kind, target, adapter: new ResearchCorpusEnvironment(target) };
    }
    return {
      kind: env.kind,
      target,
      adapter: new ServiceEnvironment(target, {
        healthUrls: options.healthUrls,
        checkCommands: options.checkCommands,
        cwd: target.startsWith('http://') || target.startsWith('https://') ? process.cwd() : target,
      }),
    };
  });
}

function createHybridWorker(
  workerId: 'claude' | 'codex',
  provider: TextProvider,
): ProviderWorkerAdapter {
  return new ProviderWorkerAdapter(
    {
      id: workerId,
      name: workerId,
      capabilities: ['code', 'document', 'research', 'ops', 'hybrid', 'review'],
    },
    provider,
    ({ task, context, instructions }) => [
      'You are operating as a hybrid multi-environment worker under Foreman supervision.',
      `Goal: ${task.goal}`,
      instructions ? `Track: ${instructions}` : '',
      task.successCriteria?.length ? `Success criteria:\n- ${task.successCriteria.join('\n- ')}` : '',
      context.summary ? `Hybrid context:\n${context.summary}` : '',
      context.evidence?.length
        ? `Evidence:\n${context.evidence.map((item) => `- [${item.kind}] ${item.label}: ${item.value}`).join('\n')}`
        : '',
      task.extraInstructions ? `Additional instructions:\n${task.extraInstructions}` : '',
      'Return concise actions, risks, and validation-relevant observations for this environment track.',
    ].filter(Boolean).join('\n\n'),
  );
}

function buildHybridTrackInstructions(
  kind: HybridEnvironmentKind,
  target: string,
  observation: Observation,
  options: HybridForemanOptions,
): string {
  return [
    `Environment kind: ${kind}`,
    `Target: ${target}`,
    `Observed state: ${observation.summary}`,
    options.healthUrls?.length && kind === 'ops' ? `Health URLs:\n- ${options.healthUrls.join('\n- ')}` : '',
    options.checkCommands?.length && kind === 'ops' ? `Checks:\n- ${options.checkCommands.join('\n- ')}` : '',
    'Focus on this environment while keeping the overall hybrid goal in mind.',
  ].filter(Boolean).join('\n\n');
}

function validateHybridRun(
  adapters: Array<{ kind: HybridEnvironmentKind; target: string }>,
  observations: Array<Observation & { state?: unknown }>,
  trackResults: Array<TrackResult<unknown>>,
  successCriteria: string[],
): ValidationResult {
  const findings: ValidationResult['findings'] = [];
  let status: ValidationResult['status'] = 'pass';
  let recommendation: ValidationResult['recommendation'] = 'complete';

  for (const track of trackResults) {
    if (track.status === 'failed') {
      status = 'fail';
      recommendation = 'repair';
      findings.push({
        severity: 'high',
        title: `Track ${track.trackId} failed`,
        body: track.summary,
      });
    }
  }

  observations.forEach((observation, index) => {
    const item = adapters[index];
    if (!item) {
      return;
    }
    if (item.kind === 'ops') {
      const state = observation.state as { healthy?: boolean } | undefined;
      if (state?.healthy === false) {
        status = 'fail';
        recommendation = 'repair';
        findings.push({
          severity: 'critical',
          title: `Ops environment unhealthy: ${item.target}`,
          body: observation.summary,
        });
      }
    }
    if (item.kind === 'document') {
      const state = observation.state as { checklistHits?: string[] } | undefined;
      if ((state?.checklistHits?.length ?? 0) > 0) {
        status = status === 'fail' ? 'fail' : 'warn';
        recommendation = 'repair';
        findings.push({
          severity: 'medium',
          title: `Document checklist signals remain: ${item.target}`,
          body: observation.summary,
        });
      }
    }
    if (item.kind === 'research') {
      const state = observation.state as { sourceCount?: number; citationLikeFiles?: string[] } | undefined;
      if ((state?.sourceCount ?? 0) === 0) {
        status = 'fail';
        recommendation = 'repair';
        findings.push({
          severity: 'high',
          title: `Research sources missing: ${item.target}`,
          body: observation.summary,
        });
      } else if ((state?.citationLikeFiles?.length ?? 0) === 0) {
        status = status === 'fail' ? 'fail' : 'warn';
        recommendation = 'repair';
        findings.push({
          severity: 'medium',
          title: `Research citation signals missing: ${item.target}`,
          body: observation.summary,
        });
      }
    }
  });

  return {
    status,
    recommendation,
    summary: `${observations.length} environment(s) validated. Checked ${successCriteria.length} success criteria.`,
    findings,
    evidence: observations.flatMap((item) => (item.evidence ?? []).map(toCoreEvidence)),
  };
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

function resolveMaybePath(value: string): string {
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  return resolve(value);
}

function slugify(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
}
