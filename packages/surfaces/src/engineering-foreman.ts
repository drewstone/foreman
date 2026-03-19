import {
  createFilesystemArtifacts,
  runTaskLoop,
  type ContextSnapshot,
  type Evidence,
  type TaskSpec,
  type TraceEvent,
  type TrackResult,
  type ValidationResult,
} from '@drew/foreman-core';
import { GitCodeEnvironment } from '@drew/foreman-environments';
import {
  createMemoryStore,
  type MemoryStore,
  type ProfileMemory,
  type WorkerPerformanceMemory,
} from '@drew/foreman-memory';
import { FilesystemPromptPolicyStore } from '@drew/foreman-optimizer';
import {
  HeuristicTaskHardener,
  ProviderTaskHardener,
  type HardenedTask,
  type PromptVariant,
  renderPromptVariant,
} from '@drew/foreman-planning';
import { FilesystemProfileStore } from '@drew/foreman-profiles';
import {
  createTangleFilesystemSessionStore,
  createTangleSandboxWorkerAdapter,
  type TangleBackendType,
  type TangleSandboxEvidenceOptions,
} from '@drew/foreman-tangle';
import {
  createClaudeProvider,
  createCodexProvider,
  type TextProvider,
} from '@drew/foreman-providers';
import { createTraceStore } from '@drew/foreman-tracing';
import {
  ProviderWorkerAdapter,
  type WorkerAdapter,
  type ForemanProfile,
  type ProviderWorkerTask,
  WorkerRegistry,
} from '@drew/foreman-workers';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  hardenTask,
  observeEnvironment,
  dispatchWorker,
  validateWork,
  updateMemory,
} from './engineering-tools.js';

const execFileAsync = promisify(execFile);

export interface EngineeringForemanOptions {
  repoPath: string;
  goal: string;
  successCriteria: string[];
  taskId?: string;
  artifactsRoot?: string;
  traceRoot?: string;
  memoryRoot?: string;
  profileRoot?: string;
  profileId?: string;
  promptPolicyRoot?: string;
  maxRounds?: number;
  checkCommands?: string[];
  toolCommands?: string[];
  preferredWorkers?: Array<'codex' | 'claude'>;
  blockedWorkers?: Array<'codex' | 'claude'>;
  plannerWorkerId?: 'codex' | 'claude';
  reviewWorkerId?: 'codex' | 'claude';
  promptVariantIds?: Partial<Record<'hardener' | 'implementer' | 'reviewer', string>>;
  promptPolicyMode?: 'active' | 'shadow' | 'explicit';
  sandboxMode?: 'local' | 'tangle';
  tangle?: TangleEngineeringOptions;
  onEvent?(event: TraceEvent): void;
}

export interface TangleEngineeringOptions {
  apiKey?: string;
  baseUrl?: string;
  backend?: Extract<TangleBackendType, 'codex' | 'claude-code'>;
  sessionRoot?: string;
  evidenceRoot?: string;
  gitUrl?: string;
  gitRef?: string;
  gitTokenEnvVar?: string;
  includeGitDiff?: boolean;
}

export interface EngineeringForemanRunResult {
  runDir: string;
  traceId: string;
  selectedWorkerId: string;
  reviewWorkerId: string;
  plannerWorkerId: string;
  promptPolicyMode: 'active' | 'shadow' | 'explicit';
  promptVariantIds: Record<'hardener' | 'implementer' | 'reviewer', string>;
  hardenedTask: HardenedTask;
  validation: ValidationResult | undefined;
}

const ENGINEERING_PROMPT_VARIANTS: PromptVariant[] = [
  {
    id: 'engineering-implementer:minimal-v1',
    label: 'Engineering Implementer Minimal',
    role: 'implementer',
    taskShape: 'engineering',
    style: 'minimal',
    systemPreamble: 'You are an engineering implementation worker operating under Foreman supervision.',
    principles: [
      'Work directly toward the task goal.',
      'Keep output concise and action-oriented.',
      'Prefer repository-grounded claims over speculation.',
    ],
  },
  {
    id: 'engineering-implementer:operator-v1',
    label: 'Engineering Implementer Operator',
    role: 'implementer',
    taskShape: 'engineering',
    style: 'persona',
    systemPreamble: 'You are a staff-level engineer (L7/L8) executing under Foreman supervision. Your standard is production-ready, fully verified, zero-shortcuts.',
    persona: 'You own the outcome end-to-end. You do not deliver partial work. You do not leave TODOs. You implement, verify, self-review, and only declare done when you would bet your career on it.',
    principles: [
      'Complete the full scope. Partial implementations are failures.',
      'Read the codebase before writing. Match existing architecture exactly.',
      'Deduplicate ruthlessly. Extract common patterns. No copy-paste.',
      'Run every available check. Fix what breaks. Then run them again.',
      'Self-review before declaring done. Find your own bugs.',
      'Evidence over assertion. Show test output, not just "it works."',
    ],
  },
  {
    id: 'engineering-implementer:contract-v1',
    label: 'Engineering Implementer Contract',
    role: 'implementer',
    taskShape: 'engineering',
    style: 'contract-heavy',
    systemPreamble: 'You are an engineering execution worker operating under a strict verification contract.',
    principles: [
      'Do not claim completion without concrete evidence.',
      'Treat validation and repair as part of the task.',
      'Keep changes minimal, testable, and reversible.',
    ],
    outputContract: 'Summarize progress, blockers, files touched, and verification evidence.',
  },
  {
    id: 'engineering-reviewer:minimal-v1',
    label: 'Engineering Reviewer Minimal',
    role: 'reviewer',
    taskShape: 'engineering',
    style: 'minimal',
    systemPreamble: 'You are a review worker operating under Foreman supervision.',
    principles: [
      'Focus on concrete correctness and verification gaps.',
      'Avoid broad commentary unless it affects completion.',
    ],
    outputContract: 'Return JSON only using the provided schema.',
  },
  {
    id: 'engineering-reviewer:auditor-v1',
    label: 'Engineering Reviewer Auditor',
    role: 'reviewer',
    taskShape: 'engineering',
    style: 'persona',
    systemPreamble: 'You are a principal engineer blocking a production deploy. Nothing ships without your explicit approval.',
    persona: 'You are the last gate. You reject work that is merely "good enough." You demand production-ready, fully tested, properly architected code. You find the bugs the implementer missed.',
    principles: [
      'Check every success criterion explicitly. Missing one is a fail.',
      'Incomplete implementations, stubs, and TODOs are automatic fails.',
      'Duplicated code is a finding. Convention violations are findings.',
      'Missing error handling and edge cases are findings.',
      '"Tests pass" is not enough. Were the right tests written? Do they cover edge cases?',
      'Only recommend complete when you would approve this for immediate production deployment with zero follow-ups needed.',
    ],
    outputContract: 'Return JSON only using the provided schema.',
  },
  {
    id: 'engineering-reviewer:contract-v1',
    label: 'Engineering Reviewer Contract',
    role: 'reviewer',
    taskShape: 'engineering',
    style: 'contract-heavy',
    systemPreamble: 'You are a review worker enforcing a strict completion contract under Foreman supervision.',
    principles: [
      'Map findings to success criteria and verification evidence.',
      'Escalate objective uncertainty rather than hand-waving it away.',
      'Keep the review legible and machine-consumable.',
    ],
    outputContract: 'Return JSON only using the provided schema.',
  },
  {
    id: 'engineering-hardener:contract-v1',
    label: 'Engineering Hardener Contract',
    role: 'hardener',
    taskShape: 'engineering',
    style: 'contract-heavy',
    systemPreamble: 'You are a task-hardening worker operating under Foreman supervision.',
    principles: [
      'Preserve the original user goal.',
      'Make missing criteria explicit.',
      'Infer checks conservatively from repository evidence.',
    ],
    outputContract: 'Return JSON only with keys: goal, expandedGoal, successCriteria, checkCommands, executionNotes, inferred.',
  },
];

export function createEngineeringForemanProfile(
  overrides?: Partial<ForemanProfile>,
): ForemanProfile {
  return {
    id: 'engineering-foreman',
    name: 'Engineering Foreman',
    preferredCapabilities: ['code', 'review', 'ops'],
    preferredWorkers: ['codex', 'claude'],
    ...overrides,
  };
}

async function createEngineeringTangleWorker(input: {
  repoPath: string;
  taskId: string;
  implementationVariant: PromptVariant;
  tangle?: TangleEngineeringOptions;
}): Promise<WorkerAdapter<ProviderWorkerTask, unknown>> {
  const config = await resolveTangleEngineeringConfig(input.repoPath, input.tangle);
  const sessionRoot = resolve(config.sessionRoot ?? join(input.repoPath, '.foreman', 'sandbox-sessions'));
  const evidenceRoot = resolve(config.evidenceRoot ?? join(input.repoPath, '.foreman', 'sandbox-artifacts', input.taskId));
  await mkdir(sessionRoot, { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });

  const sessionStore = createTangleFilesystemSessionStore(sessionRoot);
  const backend = config.backend ?? 'codex';
  const gitAuthToken = config.gitTokenEnvVar ? process.env[config.gitTokenEnvVar] : undefined;

  return createTangleSandboxWorkerAdapter({
    clientConfig: {
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    },
    sessionStore,
    backend: {
      type: backend,
    },
    createOptions: {
      git: {
        url: config.gitUrl,
        ...(config.gitRef ? { ref: config.gitRef } : {}),
        ...(gitAuthToken ? { auth: { token: gitAuthToken } } : {}),
      },
      metadata: {
        foremanRepoPath: input.repoPath,
        foremanTaskId: input.taskId,
      },
    },
    evidence: createDefaultTangleEngineeringEvidence(evidenceRoot, config),
    promptBuilder: ({ task, context, instructions }) =>
      buildEngineeringPrompt({
        variant: input.implementationVariant,
        task,
        context,
        instructions,
      }),
  });
}

async function resolveTangleEngineeringConfig(
  repoPath: string,
  input: TangleEngineeringOptions | undefined,
): Promise<Required<Pick<TangleEngineeringOptions, 'apiKey' | 'backend' | 'gitUrl'>> & TangleEngineeringOptions> {
  const apiKey = input?.apiKey ?? process.env.TANGLE_API_KEY;
  if (!apiKey) {
    throw new Error('Tangle mode requires tangle.apiKey or TANGLE_API_KEY');
  }

  const inferredGitUrl = input?.gitUrl ?? await inferRepoGitUrl(repoPath);
  if (!inferredGitUrl) {
    throw new Error('Tangle mode requires a git URL. Set tangle.gitUrl or configure git remote origin.');
  }

  const inferredGitRef = input?.gitRef ?? await inferRepoGitRef(repoPath);
  return {
    ...input,
    apiKey,
    backend: input?.backend ?? 'codex',
    gitUrl: inferredGitUrl,
    gitRef: inferredGitRef ?? input?.gitRef,
  };
}

function createDefaultTangleEngineeringEvidence(
  evidenceRoot: string,
  config: TangleEngineeringOptions,
): TangleSandboxEvidenceOptions {
  return {
    includeWorkspaceRoot: true,
    includeGitStatus: true,
    includeGitDiff: config.includeGitDiff ?? true,
    gitDiffRef: 'HEAD',
    maxDiffChars: 12000,
    commands: [
      {
        command: 'git rev-parse --abbrev-ref HEAD',
        label: 'git-branch',
        optional: true,
      },
      {
        command: 'git rev-parse HEAD',
        label: 'git-head',
        optional: true,
      },
      {
        command: 'pwd',
        label: 'sandbox-pwd',
        optional: true,
      },
    ],
    downloads: [
      {
        kind: 'download',
        path: '/tmp/foreman-summary.json',
        destinationPath: join(evidenceRoot, 'foreman-summary.json'),
        label: 'foreman-summary',
        optional: true,
      },
    ],
  };
}

async function inferRepoGitUrl(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function inferRepoGitRef(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: repoPath,
    });
    const value = stdout.trim();
    if (value) {
      return value;
    }
  } catch {
    // Fall through to detached HEAD resolution.
  }

  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export async function runEngineeringForeman(
  options: EngineeringForemanOptions,
): Promise<EngineeringForemanRunResult> {
  const repoPath = resolve(options.repoPath);
  const taskId = options.taskId ?? `engineering-${basename(repoPath)}`;
  const artifactsRoot = resolve(options.artifactsRoot ?? join(repoPath, '.foreman', 'runs', taskId));
  const traceRoot = resolve(options.traceRoot ?? join(repoPath, '.foreman', 'traces'));
  const memoryRoot = resolve(options.memoryRoot ?? join(repoPath, '.foreman', 'memory'));
  const profileRoot = resolve(options.profileRoot ?? join(repoPath, '.foreman', 'profiles'));
  const promptPolicyRoot = resolve(options.promptPolicyRoot ?? join(repoPath, '.foreman', 'policies'));
  const sandboxMode = options.sandboxMode ?? (options.tangle ? 'tangle' : 'local');
  const maxRounds = options.maxRounds ?? 5;

  await mkdir(artifactsRoot, { recursive: true });
  await mkdir(traceRoot, { recursive: true });
  await mkdir(memoryRoot, { recursive: true });
  await mkdir(profileRoot, { recursive: true });
  await mkdir(promptPolicyRoot, { recursive: true });

  const artifacts = createFilesystemArtifacts(artifactsRoot);
  const traceStore = await createTraceStore({
    rootDir: traceRoot,
  });
  const memoryStore = await createMemoryStore({
    rootDir: memoryRoot,
  });
  const profileStore = new FilesystemProfileStore(profileRoot);
  const promptPolicyStore = new FilesystemPromptPolicyStore(promptPolicyRoot);
  const environment = new GitCodeEnvironment(repoPath);
  const storedProfile = options.profileId ? await profileStore.get(options.profileId) : null;
  const profileMemoryId = options.profileId ?? storedProfile?.profile.id ?? 'engineering-foreman';
  const [storedProfileMemory, existingEnvironmentMemory, codexWorkerMemory, claudeWorkerMemory] = await Promise.all([
    memoryStore.getProfileMemory(profileMemoryId),
    memoryStore.getEnvironmentMemory(repoPath),
    memoryStore.getWorkerMemory('codex'),
    memoryStore.getWorkerMemory('claude'),
  ]);
  const profile = createEngineeringForemanProfile({
    ...(storedProfile?.profile ?? {}),
    id: options.profileId ?? storedProfile?.profile.id ?? 'engineering-foreman',
    name: storedProfile?.profile.name ?? 'Engineering Foreman',
    preferredWorkers: options.preferredWorkers ?? toKnownWorkerIds(storedProfileMemory?.workerPreferences),
    blockedWorkers: options.blockedWorkers,
    preferredCapabilities: storedProfile?.profile.preferredCapabilities,
  });
  const promptPolicy = await promptPolicyStore.get('engineering');
  const promptPolicyMode = options.promptPolicyMode ?? (options.promptVariantIds ? 'explicit' : 'active');
  const selectedPromptVariantIds = resolvePromptVariantIds({
    explicit: options.promptVariantIds,
    policy: promptPolicy,
    mode: promptPolicyMode,
    profileMemory: storedProfileMemory,
  });
  const promptVariants = {
    hardener: selectEngineeringPromptVariant('hardener', selectedPromptVariantIds.hardener),
    implementer: selectEngineeringPromptVariant('implementer', selectedPromptVariantIds.implementer),
    reviewer: selectEngineeringPromptVariant('reviewer', selectedPromptVariantIds.reviewer),
  } satisfies Record<'hardener' | 'implementer' | 'reviewer', PromptVariant>;

  const providers = {
    codex: createCodexProvider(),
    claude: createClaudeProvider(),
  } satisfies Record<'codex' | 'claude', TextProvider>;

  const registry = new WorkerRegistry();
  const localImplementationWorkers: Array<'codex' | 'claude'> = ['codex', 'claude'];
  for (const workerId of localImplementationWorkers) {
    registry.register(
      new ProviderWorkerAdapter(
        {
          id: workerId,
          name: workerId === 'codex' ? 'Codex' : 'Claude',
          capabilities: ['code', 'review'],
        },
        providers[workerId],
        ({ task, context, instructions }) =>
          buildEngineeringPrompt({
            variant: promptVariants.implementer,
            task,
            context,
            instructions,
          }),
      ),
    );
  }

  const selectedWorker = sandboxMode === 'tangle'
    ? await createEngineeringTangleWorker({
        repoPath,
        taskId,
        implementationVariant: promptVariants.implementer,
        tangle: options.tangle,
      })
    : registry.select({ capability: 'code' }, profile) as WorkerAdapter<ProviderWorkerTask, unknown> | undefined;
  if (!selectedWorker) {
    throw new Error('no engineering worker available');
  }

  const reviewWorkerId = selectReviewWorkerId({
    registry,
    profile,
    preferredWorkerId: choosePreferredReviewWorkerId({
      explicitWorkerId: options.reviewWorkerId,
      implementationWorkerId: selectedWorker.worker.id,
      workerMemory: {
        codex: codexWorkerMemory,
        claude: claudeWorkerMemory,
      },
    }),
    implementationWorkerId: selectedWorker.worker.id,
  });
  const plannerWorkerId = selectPlannerWorkerId({
    preferredWorkerId: options.plannerWorkerId,
    reviewWorkerId,
    implementationWorkerId: selectedWorker.worker.id,
  });

  // --- Task hardening via extracted hardenTask ---
  const hardenedTask = await hardenTask({
    goal: options.goal,
    repoPath,
    successCriteria: options.successCriteria,
    provider: providers[plannerWorkerId] ?? providers.claude,
    promptVariant: promptVariants.hardener,
  });

  const inferredValidationCommands = inferValidationCommandsFromMemory({
    environmentMemory: existingEnvironmentMemory,
    profileMemory: storedProfileMemory,
  });
  const successCriteria = dedupe(hardenedTask.successCriteria);
  const checkCommands = dedupe([
    ...hardenedTask.checkCommands,
    ...inferredValidationCommands.checkCommands,
    ...(options.checkCommands ?? []),
  ]);
  const toolCommands = dedupe([
    ...inferredValidationCommands.toolCommands,
    ...(options.toolCommands ?? []),
  ]);

  const task: TaskSpec = {
    id: taskId,
    goal: hardenedTask.expandedGoal,
    successCriteria,
    environment: {
      kind: 'code',
      target: repoPath,
    },
    policy: {
      escalationMode: inferEngineeringEscalationMode(storedProfileMemory),
    },
    metadata: {
      originalGoal: options.goal,
      profileId: profile.id,
      selectedWorkerId: selectedWorker.worker.id,
      reviewWorkerId,
      plannerWorkerId,
      sandboxMode,
      taskEnvelopeInferred: String(hardenedTask.inferred),
      hardenerPromptVariantId: promptVariants.hardener.id,
      implementationPromptVariantId: promptVariants.implementer.id,
      reviewPromptVariantId: promptVariants.reviewer.id,
      promptPolicyMode,
    },
  };

  await artifacts.writeJson('task-envelope.json', {
    originalGoal: options.goal,
    hardenedTask,
    checkCommands,
    toolCommands,
    selectedWorkerId: selectedWorker.worker.id,
    reviewWorkerId,
    plannerWorkerId,
    sandboxMode,
    promptVariantIds: {
      hardener: promptVariants.hardener.id,
      implementer: promptVariants.implementer.id,
      reviewer: promptVariants.reviewer.id,
    },
    promptPolicyMode,
  });

  let latestValidation: ValidationResult | undefined;
  const fallbackReviewWorkerId: 'codex' | 'claude' = reviewWorkerId === 'codex' ? 'claude' : 'codex';

  const result = await runTaskLoop<unknown, { workerId: string }, unknown>({
    task,
    maxRounds,
    artifacts,
    onEvent: options.onEvent,
    context: async ({ loop }) => {
      // --- Environment observation via extracted observeEnvironment ---
      return observeEnvironment({
        repoPath,
        memoryStore,
        profileId: profile.id,
        round: loop.rounds.length,
        priorRound: loop.rounds.at(-1),
      });
    },
    plan: async ({ loop }) => {
      const repair = loop.rounds.at(-1)?.repair;
      return {
        summary: repair
          ? `Use ${selectedWorker.worker.id} to repair the latest validation issues`
          : `Use ${selectedWorker.worker.id} to advance the engineering task`,
        tracks: [
          {
            id: 'implement',
            goal: task.goal,
            capability: 'code',
            metadata: {
              workerId: selectedWorker.worker.id,
            },
            input: {
              workerId: selectedWorker.worker.id,
            },
          },
        ],
        risks: repair?.actions ?? [],
      };
    },
    executeTrack: async ({ context, loop, track }) => {
      const repair = loop.rounds.at(-1)?.repair;
      const isRepair = repair && repair.actions.length > 0;
      const workerTask: ProviderWorkerTask = {
        goal: track.goal,
        successCriteria: task.successCriteria,
        repoPath,
        extraInstructions: [
          ...(isRepair
            ? [
                'REPAIR ROUND: The previous implementation was reviewed and found lacking. Fix every issue listed below completely.',
                'Do not just patch the surface — understand the root cause and fix it properly.',
                ...repair.actions.map((action) => `MUST FIX: ${action}`),
              ]
            : [
                'Complete the full scope of this task. Do not stop at a partial implementation.',
                'Read the codebase first. Understand the architecture. Then implement.',
              ]),
          'After implementation, run all check commands and fix any failures.',
          'Self-review your work before finishing. Look for: missing edge cases, duplicated code, convention violations, incomplete error handling.',
          ...hardenedTask.executionNotes,
        ].join('\n'),
      };

      const fallbackWorker = sandboxMode === 'tangle'
        ? undefined
        : registry.list().find((adapter) =>
            adapter.worker.id !== selectedWorker.worker.id
            && adapter.worker.capabilities.includes('code'),
          ) as WorkerAdapter<ProviderWorkerTask, unknown> | undefined;

      // --- Worker dispatch via extracted dispatchWorker ---
      return dispatchWorker({
        worker: selectedWorker,
        fallbackWorker,
        task: workerTask,
        context: {
          summary: context.summary,
          state: context.state,
          evidence: context.evidence,
        },
        instructions: `Selected by profile ${profile.id}. Review will be performed by ${reviewWorkerId}.`,
      });
    },
    validate: async ({ context, trackResults }) => {
      // --- Validation via extracted validateWork ---
      latestValidation = await validateWork({
        task,
        context,
        trackResults,
        environment,
        checkCommands,
        toolCommands,
        reviewProvider: providers[reviewWorkerId] ?? providers.claude,
        fallbackReviewProvider: providers[fallbackReviewWorkerId],
        reviewWorkerId,
        fallbackReviewWorkerId,
        reviewerVariant: promptVariants.reviewer,
        profileMemory: storedProfileMemory,
      });
      return latestValidation;
    },
    repair: async ({ validation }) => {
      if (validation.recommendation === 'complete' || validation.recommendation === 'abort') {
        return undefined;
      }

      const actions = dedupe([
        ...(validation.unmetCriteria?.map((criterion) => `Satisfy criterion: ${criterion}`) ?? []),
        ...validation.findings.map((finding) => `Resolve ${finding.severity} finding: ${finding.title}`),
      ]);

      return actions.length > 0
        ? {
            summary: 'Repair the issues identified during validation.',
            actions: actions.slice(0, 8),
          }
        : undefined;
    },
    shouldStop: async ({ round, validation, repair }) =>
      decideStop({
        round,
        maxRounds,
        validation,
        repairSummary: repair?.summary,
        escalationMode: task.policy?.escalationMode ?? 'ask-human',
      }),
  });

  // --- Memory update via extracted updateMemory ---
  await updateMemory({
    memoryStore,
    repoPath,
    profileId: profile.id,
    implementationWorkerId: selectedWorker.worker.id,
    reviewWorkerId,
    plannerWorkerId,
    goal: options.goal,
    expandedGoal: hardenedTask.expandedGoal,
    successCriteria,
    validation: latestValidation,
    checkCommands,
    toolCommands,
  });

  const finalRepoEvidence = toCoreEvidence(await environment.collectRepoEvidence());
  const evidence = [
    ...result.state.rounds.flatMap((round) => [
    ...(round.context.evidence ?? []),
    ...(round.validation.evidence ?? []),
    ...round.trackResults.flatMap((track) => track.evidence),
    ]),
    ...finalRepoEvidence,
  ];
  const roundCount = result.state.rounds.length;
  const repairCount = result.state.rounds.filter((round) => round.repair).length;
  const durationMs = computeDurationMs(result.state.startedAt, result.state.finishedAt);
  const checkPassRate = computeCheckPassRate(evidence);
  const escalationCount = result.state.outcome?.status === 'blocked' ? 1 : 0;
  const providerCostUsd = computeProviderCostUsd(result.state.rounds);

  const traceId = await traceStore.put({
    task: {
      id: task.id,
      goal: task.goal,
      environmentKind: task.environment?.kind,
    },
    events: result.state.trace.map((event) => ({
      at: event.at,
      kind: event.kind,
      workerId: event.workerId,
      trackId: event.trackId,
      summary: event.summary,
      metadata: event.metadata,
    })),
    evidence: evidence.map((item) => ({
      kind: item.kind,
      label: item.label,
      value: item.value,
      uri: item.uri,
      metadata: item.metadata,
    })),
    outcome: result.state.outcome
      ? {
          status: result.state.outcome.status,
          summary: result.state.outcome.summary,
          validated: result.state.outcome.validated,
          unmetCriteria: result.state.outcome.unmetCriteria,
        }
      : undefined,
    metadata: {
      repoPath,
      profileId: profile.id,
      selectedWorkerId: selectedWorker.worker.id,
      reviewWorkerId,
      plannerWorkerId,
      sandboxMode,
      taskShape: 'engineering',
      originalGoal: options.goal,
      successCriteriaJson: JSON.stringify(successCriteria),
      checkCommandsJson: JSON.stringify(checkCommands),
      toolCommandsJson: JSON.stringify(toolCommands),
      roundCount: String(roundCount),
      repairCount: String(repairCount),
      durationMs: durationMs !== undefined ? String(durationMs) : '',
      checkPassRate: checkPassRate !== undefined ? String(checkPassRate) : '',
      escalationCount: String(escalationCount),
      providerCostUsd: providerCostUsd !== undefined ? String(providerCostUsd) : '',
      promptPolicyMode,
      hardenerPromptVariantId: promptVariants.hardener.id,
      implementationPromptVariantId: promptVariants.implementer.id,
      reviewPromptVariantId: promptVariants.reviewer.id,
    },
  });

  return {
    runDir: artifactsRoot,
    traceId,
    selectedWorkerId: selectedWorker.worker.id,
    reviewWorkerId,
    plannerWorkerId,
    promptPolicyMode,
    promptVariantIds: {
      hardener: promptVariants.hardener.id,
      implementer: promptVariants.implementer.id,
      reviewer: promptVariants.reviewer.id,
    },
    hardenedTask: {
      ...hardenedTask,
      successCriteria,
      checkCommands,
    },
    validation: latestValidation,
  };
}

function buildEngineeringPrompt(input: {
  variant: PromptVariant;
  task: ProviderWorkerTask;
  context: { summary: string };
  instructions?: string;
}): string {
  return renderPromptVariant({
    variant: input.variant,
    goal: input.task.goal,
    successCriteria: input.task.successCriteria,
    contextSummary: input.context.summary,
    extraInstructions: [
      'Work non-interactively. Execute directly in the repository.',
      'COMPLETION STANDARD: You are not done when it compiles. You are not done when tests pass. You are done when the work is production-ready, fully verified, and you would stake your reputation on it.',
      'EXECUTION RULES:',
      '- Implement the full scope. Do not leave stubs, TODOs, or partial implementations.',
      '- Deduplicate ruthlessly. If you see repeated patterns, extract them.',
      '- Follow the existing architecture and conventions exactly. Read before you write.',
      '- Run every check command. Run the test suite. Fix what breaks.',
      '- After you think you are done, review your own work critically. Look for edge cases, missing error handling, inconsistent naming, dead code.',
      '- If you find issues in your review, fix them before declaring completion.',
      'EVIDENCE: Provide concrete proof of completion — test output, command results, file diffs. Self-report without evidence is worthless.',
      'If blocked, explain the exact blocker with reproduction steps.',
      ...(input.task.extraInstructions ? [input.task.extraInstructions] : []),
      ...(input.instructions ? [input.instructions] : []),
    ],
  });
}

function computeProviderCostUsd(
  rounds: Array<{
    trackResults: Array<TrackResult<unknown>>;
    validation: ValidationResult;
  }>,
): number | undefined {
  const rawValues = rounds.flatMap((round) => [
    ...round.trackResults.map((track) => (
      track.metadata?.costUsd
      ?? track.evidence.map((item) => item.metadata?.costUsd).find(Boolean)
    )),
    ...((round.validation.evidence ?? []).map((item) => item.metadata?.costUsd)),
  ]);
  const total = rawValues
    .map((value) => (value ? Number(value) : undefined))
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0);
  return total > 0 ? total : undefined;
}

function decideStop(input: {
  round: number;
  maxRounds: number;
  validation: ValidationResult;
  repairSummary?: string;
  escalationMode: 'ask-human' | 'auto-repair' | 'halt';
}): {
  done: boolean;
  status: 'running' | 'completed' | 'max_rounds' | 'blocked';
  reason: string;
} {
  if (input.validation.recommendation === 'complete') {
    return {
      done: true,
      status: 'completed',
      reason: input.validation.summary,
    };
  }
  if (input.validation.recommendation === 'abort') {
    return {
      done: true,
      status: 'blocked',
      reason: input.validation.summary,
    };
  }
  // If deterministic checks failed, always repair — these are fixable
  const hasDeterministicFailure = input.validation.findings.some(
    (f) => f.severity === 'high' && f.title.startsWith('Check failed:'),
  );
  if (input.validation.recommendation === 'escalate' && !hasDeterministicFailure && input.escalationMode !== 'auto-repair') {
    return {
      done: true,
      status: 'blocked',
      reason: input.validation.summary,
    };
  }
  if (input.round >= input.maxRounds) {
    return {
      done: true,
      status: 'max_rounds',
      reason: 'maximum rounds reached',
    };
  }
  return {
    done: false,
    status: 'running',
    reason: input.repairSummary ?? 'continuing with another round',
  };
}

function selectEngineeringPromptVariant(
  role: 'hardener' | 'implementer' | 'reviewer',
  requestedId?: string,
): PromptVariant {
  const matching = ENGINEERING_PROMPT_VARIANTS.filter((variant) => variant.role === role);
  if (requestedId) {
    const selected = matching.find((variant) => variant.id === requestedId);
    if (selected) {
      return selected;
    }
  }

  const defaults: Record<'hardener' | 'implementer' | 'reviewer', string> = {
    hardener: 'engineering-hardener:contract-v1',
    implementer: 'engineering-implementer:operator-v1',
    reviewer: 'engineering-reviewer:auditor-v1',
  };
  const fallback = matching.find((variant) => variant.id === defaults[role]);
  if (!fallback) {
    throw new Error(`no prompt variant available for role ${role}`);
  }
  return fallback;
}

function resolvePromptVariantIds(input: {
  explicit?: Partial<Record<'hardener' | 'implementer' | 'reviewer', string>>;
  policy: {
    roles?: Record<string, {
      activeVariantId?: string;
      shadowVariantId?: string;
    }>;
  } | null;
  mode: 'active' | 'shadow' | 'explicit';
  profileMemory?: ProfileMemory | null;
}): Partial<Record<'hardener' | 'implementer' | 'reviewer', string>> {
  const resolved: Partial<Record<'hardener' | 'implementer' | 'reviewer', string>> = {
    ...input.explicit,
  };
  if (input.mode === 'explicit') {
    return resolved;
  }

  const roleMap = {
    hardener: 'hardener',
    implementer: 'implementer',
    reviewer: 'reviewer',
  } as const;
  for (const [role, policyKey] of Object.entries(roleMap) as Array<
    ['hardener' | 'implementer' | 'reviewer', keyof typeof roleMap]
  >) {
    if (resolved[role]) {
      continue;
    }
    const policy = input.policy?.roles?.[policyKey];
    resolved[role] = input.mode === 'shadow'
      ? policy?.shadowVariantId ?? policy?.activeVariantId
      : policy?.activeVariantId;
  }

  const evaluationStyle = new Set(input.profileMemory?.evaluationStyle ?? []);
  if (!resolved.hardener && evaluationStyle.has('deterministic-first')) {
    resolved.hardener = 'engineering-hardener:contract-v1';
  }
  if (!resolved.reviewer && (
    evaluationStyle.has('deterministic-first')
    || evaluationStyle.has('judge-after-grounded-checks')
  )) {
    resolved.reviewer = 'engineering-reviewer:contract-v1';
  }
  if (!resolved.implementer && evaluationStyle.has('tool-audits')) {
    resolved.implementer = 'engineering-implementer:contract-v1';
  }
  return resolved;
}

function computeDurationMs(startedAt: string, finishedAt?: string): number | undefined {
  if (!finishedAt) {
    return undefined;
  }
  const startMs = Date.parse(startedAt);
  const finishMs = Date.parse(finishedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs)) {
    return undefined;
  }
  return Math.max(0, finishMs - startMs);
}

function toKnownWorkerIds(values: string[] | undefined): Array<'codex' | 'claude'> | undefined {
  if (!values?.length) {
    return undefined;
  }
  const normalized = values
    .map((value) => value.toLowerCase())
    .flatMap((value) => {
      const out: Array<'codex' | 'claude'> = [];
      if (value.includes('codex')) {
        out.push('codex');
      }
      if (value.includes('claude')) {
        out.push('claude');
      }
      return out;
    });
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function computeCheckPassRate(evidence: Evidence[]): number | undefined {
  const checks = evidence.filter((item) => item.kind === 'test');
  if (checks.length === 0) {
    return undefined;
  }
  const passed = checks.filter((item) => item.metadata?.passed === 'true').length;
  return passed / checks.length;
}

function choosePreferredReviewWorkerId(input: {
  explicitWorkerId?: 'codex' | 'claude';
  implementationWorkerId: string;
  workerMemory: Record<'codex' | 'claude', WorkerPerformanceMemory | null>;
}): 'codex' | 'claude' | undefined {
  if (input.explicitWorkerId) {
    return input.explicitWorkerId;
  }

  const candidates = (['codex', 'claude'] as const)
    .filter((workerId) => workerId !== input.implementationWorkerId)
    .map((workerId) => ({
      workerId,
      score: scoreWorkerForReview(input.workerMemory[workerId]),
    }))
    .sort((left, right) => right.score - left.score || left.workerId.localeCompare(right.workerId));

  return candidates[0]?.workerId;
}

function scoreWorkerForReview(memory: WorkerPerformanceMemory | null): number {
  if (!memory) {
    return 0;
  }
  const successScore = memory.successRate ?? 0;
  const failurePenalty = (memory.commonFailureClasses ?? [])
    .filter((value) => value === 'high' || value === 'critical')
    .length * 0.1;
  return successScore - failurePenalty;
}

function inferValidationCommandsFromMemory(input: {
  environmentMemory: import('@drew/foreman-memory').EnvironmentMemory | null;
  profileMemory: ProfileMemory | null;
}): {
  checkCommands: string[];
  toolCommands: string[];
} {
  const evaluationStyle = new Set(input.profileMemory?.evaluationStyle ?? []);
  const facts = input.environmentMemory?.facts ?? [];
  return {
    checkCommands: evaluationStyle.has('deterministic-first')
      ? facts.filter((fact) => fact.startsWith('check: ')).map((fact) => fact.slice('check: '.length)).slice(-4)
      : [],
    toolCommands: evaluationStyle.has('tool-audits')
      ? facts.filter((fact) => fact.startsWith('tool: ')).map((fact) => fact.slice('tool: '.length)).slice(-4)
      : [],
  };
}

function inferEngineeringEscalationMode(profileMemory: ProfileMemory | null): 'ask-human' | 'auto-repair' | 'halt' {
  const evaluationStyle = new Set(profileMemory?.evaluationStyle ?? []);
  if (evaluationStyle.has('judge-after-grounded-checks') || evaluationStyle.has('deterministic-first')) {
    return 'auto-repair';
  }
  return 'ask-human';
}

function selectReviewWorkerId(input: {
  registry: WorkerRegistry;
  profile: ForemanProfile;
  preferredWorkerId?: 'codex' | 'claude';
  implementationWorkerId: string;
}): 'codex' | 'claude' {
  const preferred = input.preferredWorkerId ? [input.preferredWorkerId] : [];
  const alternate = input.registry.select(
    {
      capability: 'review',
      preferredWorkerIds: preferred,
      blockedWorkerIds: [input.implementationWorkerId],
    },
    input.profile,
  );
  if (alternate && (alternate.worker.id === 'codex' || alternate.worker.id === 'claude')) {
    return alternate.worker.id;
  }

  const fallback = input.registry.select(
    {
      capability: 'review',
      preferredWorkerIds: preferred,
    },
    input.profile,
  );
  if (!fallback || (fallback.worker.id !== 'codex' && fallback.worker.id !== 'claude')) {
    throw new Error('no review worker available');
  }
  return fallback.worker.id;
}

function selectPlannerWorkerId(input: {
  preferredWorkerId?: 'codex' | 'claude';
  reviewWorkerId: 'codex' | 'claude';
  implementationWorkerId: string;
}): 'codex' | 'claude' {
  return input.preferredWorkerId ?? input.reviewWorkerId ?? (
    input.implementationWorkerId === 'codex' ? 'claude' : 'codex'
  );
}

function toCoreEvidence(
  evidence: Array<{
    kind: string;
    label: string;
    value: string;
    uri?: string;
    metadata?: Record<string, string>;
  }>,
): Evidence[] {
  return evidence as Evidence[];
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}
