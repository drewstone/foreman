import {
  createFilesystemArtifacts,
  runTaskLoop,
  type ContextSnapshot,
  type Evidence,
  type Finding,
  type Recommendation,
  type TaskSpec,
  type TraceEvent,
  type TrackResult,
  type ValidationResult,
  type ValidationStatus,
} from '@drew/foreman-core';
import { GitCodeEnvironment } from '@drew/foreman-environments';
import { EvaluationPipeline, type EvaluationResult, type Evaluator } from '@drew/foreman-evals';
import {
  createMemoryStore,
  recordWorkerRun,
  type MemoryStore,
  type EnvironmentMemory,
  type ProfileMemory,
  type StrategyMemory,
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
  parseJsonOutput,
  type TextProvider,
} from '@drew/foreman-providers';
import { createTraceStore } from '@drew/foreman-tracing';
import {
  CommandWorkerAdapter,
  ParsedProviderWorkerAdapter,
  ProviderWorkerAdapter,
  type WorkerAdapter,
  type CommandWorkerTask,
  type ForemanProfile,
  type ProviderWorkerTask,
  WorkerRegistry,
} from '@drew/foreman-workers';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

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

interface EngineeringEvaluationInput {
  task: TaskSpec;
  context: ContextSnapshot;
  trackResults: Array<TrackResult<unknown>>;
}

interface ReviewJudgePayload {
  status: ValidationStatus;
  recommendation: Recommendation;
  summary: string;
  findings?: Array<{
    severity?: 'low' | 'medium' | 'high' | 'critical';
    title?: string;
    body?: string;
    evidence?: string;
  }>;
  scores?: Record<string, number>;
  evidence?: Array<{
    kind: string;
    label: string;
    value: string;
    uri?: string;
    metadata?: Record<string, string>;
  }>;
}

type ReviewJudgeFinding = NonNullable<ReviewJudgePayload['findings']>[number];

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

  const hardener = new ProviderTaskHardener(
    providers[plannerWorkerId] ?? providers.claude,
    new HeuristicTaskHardener(),
    (input) =>
      buildHardenerPrompt({
        variant: promptVariants.hardener,
        input,
      }),
  );
  const hardenedTask = await hardener.harden({
    goal: options.goal,
    repoPath,
    successCriteria: options.successCriteria,
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

  const result = await runTaskLoop<unknown, { workerId: string }, unknown>({
    task,
    maxRounds,
    artifacts,
    onEvent: options.onEvent,
    context: async ({ loop }) => {
      const observation = await environment.observe();
      const envMemory = await memoryStore.getEnvironmentMemory(repoPath);
      const profileMemory = await memoryStore.getProfileMemory(profile.id);
      const strategyMemory = await memoryStore.getStrategyMemory('engineering');

      const memorySummary = compactMemorySummary(envMemory, profileMemory, strategyMemory);
      const priorRoundSummary = summarizePriorRound(loop.rounds.at(-1));

      const isFirstRound = loop.rounds.length === 0;
      let productContext = '';
      let productEvidence: Evidence[] = [];
      if (isFirstRound) {
        const discovered = await environment.discoverProductContext();
        if (discovered.docs.length > 0) {
          productContext = discovered.docs
            .map((doc) => `--- ${doc.path} ---\n${doc.content}`)
            .join('\n\n');
          productEvidence = toCoreEvidence(discovered.evidence);
        }
      }

      return {
        summary: [
          observation.summary,
          productContext ? `Product documentation:\n${productContext}` : '',
          memorySummary ? `Known memory:\n${memorySummary}` : '',
          priorRoundSummary ? `Prior round:\n${priorRoundSummary}` : '',
        ].filter(Boolean).join('\n\n'),
        state: observation.state,
        evidence: [
          ...toCoreEvidence(observation.evidence ?? []),
          ...productEvidence,
        ],
        metadata: {
          repoPath,
          reviewWorkerId,
        },
      } satisfies ContextSnapshot;
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
      const workerContext = {
        summary: context.summary,
        state: context.state,
        evidence: context.evidence,
      };
      const workerInstructions = `Selected by profile ${profile.id}. Review will be performed by ${reviewWorkerId}.`;

      let run: Awaited<ReturnType<typeof selectedWorker.run>>;
      let effectiveWorkerId = selectedWorker.worker.id;
      try {
        run = await selectedWorker.run({
          task: workerTask,
          context: workerContext,
          instructions: workerInstructions,
        });
        if (run.result?.status === 'failed' && isProviderUnavailable(run.evidence)) {
          throw new Error(`${selectedWorker.worker.id} unavailable`);
        }
      } catch {
        const fallbackWorker = sandboxMode === 'tangle'
          ? undefined
          : registry.list().find((adapter) =>
              adapter.worker.id !== selectedWorker.worker.id
              && adapter.worker.capabilities.includes('code'),
            );
        if (!fallbackWorker) {
          throw new Error(`${selectedWorker.worker.id} failed and no fallback worker available`);
        }
        effectiveWorkerId = fallbackWorker.worker.id;
        run = await fallbackWorker.run({
          task: workerTask,
          context: workerContext,
          instructions: `[fallback from ${selectedWorker.worker.id}] ${workerInstructions}`,
        });
      }

      return {
        trackId: track.id,
        status: run.result?.status ?? 'completed',
        summary: run.summary,
        output: run.output,
        evidence: toCoreEvidence(run.evidence),
        findings: [],
        metadata: {
          workerId: effectiveWorkerId,
          ...(effectiveWorkerId !== selectedWorker.worker.id ? { fallbackFrom: selectedWorker.worker.id } : {}),
          ...(run.metrics?.durationMs !== undefined ? { durationMs: String(run.metrics.durationMs) } : {}),
          ...(run.metrics?.costUsd !== undefined ? { costUsd: String(run.metrics.costUsd) } : {}),
        },
      } satisfies TrackResult<unknown>;
    },
    validate: async ({ context, trackResults }) => {
      const evaluators = buildEngineeringEvaluators({
        environment,
        checkCommands,
        toolCommands,
        implementationWorkerId: selectedWorker.worker.id,
        reviewWorkerId,
        repoPath,
        providers,
        reviewerVariant: promptVariants.reviewer,
        profileMemory: storedProfileMemory,
      });

      const pipeline = new EvaluationPipeline<EngineeringEvaluationInput>(evaluators);
      const evaluation = await pipeline.run({
        task,
        context,
        trackResults,
      });

      latestValidation = {
        status: evaluation.status,
        recommendation: evaluation.recommendation,
        summary: evaluation.summary,
        findings: evaluation.findings.map(toCoreFinding),
        scores: evaluation.scores,
        evidence: toCoreEvidence(evaluation.evidence),
      };
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

  await updateEngineeringMemory({
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

function buildReviewPrompt(input: {
  variant: PromptVariant;
  task: ProviderWorkerTask;
  context: { summary: string };
  implementationWorkerId: string;
}): string {
  return renderPromptVariant({
    variant: input.variant,
    goal: input.task.goal,
    successCriteria: input.task.successCriteria,
    contextSummary: [
      `Implementation worker: ${input.implementationWorkerId}`,
      input.context.summary,
    ].join('\n\n'),
    extraInstructions: [
      'Review the implementation with the rigor of a principal engineer blocking a production deploy. Return JSON only.',
      'Use this schema: {"status":"pass|warn|fail","recommendation":"complete|repair|escalate|abort","summary":"...","findings":[{"severity":"low|medium|high|critical","title":"...","body":"...","evidence":"..."}],"scores":{"quality":0-10,"correctness":0-10},"evidence":[{"kind":"note","label":"...","value":"..."}]}',
      'REVIEW CHECKLIST:',
      '- Does the implementation fully satisfy every success criterion? Check each one explicitly.',
      '- Are there any incomplete implementations, stubs, TODOs, or placeholder logic?',
      '- Is there duplicated code that should be extracted?',
      '- Does it follow the existing codebase architecture and conventions?',
      '- Are edge cases handled? Error paths? Boundary conditions?',
      '- Were all check commands actually run and passing?',
      '- Is the code production-quality — would you ship this without a follow-up?',
      'SCORING: quality and correctness are 0-10. Only score 9+ if the work is genuinely production-ready with no caveats.',
      'Recommend complete ONLY when you would approve this for immediate production deployment.',
      'If anything is missing, incomplete, or below professional standard, recommend repair with specific actionable findings.',
    ],
  });
}

function buildHardenerPrompt(input: {
  variant: PromptVariant;
  input: {
    goal: string;
    repoPath?: string;
    successCriteria?: string[];
  };
}): string {
  return renderPromptVariant({
    variant: input.variant,
    goal: input.input.goal,
    successCriteria: input.input.successCriteria,
    contextSummary: input.input.repoPath ? `Repository target: ${input.input.repoPath}` : undefined,
    extraInstructions: [
      'You are hardening a task for a demanding engineering team that ships production-quality work.',
      'GOAL EXPANSION: Take the user goal and expand it to cover the full scope of what "done" means. If the goal says "add tests," the expanded goal should include what those tests must cover, what patterns to follow, and what quality bar to hit.',
      'SUCCESS CRITERIA: Be specific and verifiable. "Tests pass" is not enough — specify what tests, what coverage, what edge cases. Each criterion must be checkable with evidence.',
      'CHECK COMMANDS: Infer every relevant verification command from the repository. Look at package.json scripts, Cargo.toml, Makefile, CI configs. Include type checks, lints, and test suites — not just the most obvious one.',
      'EXECUTION NOTES: Include architectural guidance. What patterns does this codebase use? What conventions must be followed? What common mistakes should be avoided?',
      'Preserve the original user goal. Add rigor, do not change intent.',
      'Return JSON only with keys: goal, expandedGoal, successCriteria, checkCommands, executionNotes, inferred.',
    ],
  });
}

function createDeterministicCodeEvaluator(
  environment: GitCodeEnvironment,
  commands: string[],
): Evaluator<EngineeringEvaluationInput> {
  return {
    name: 'deterministic-code-checks',
    layer: 'deterministic',
    evaluate: async ({ task }) => {
      if (commands.length === 0) {
        return {
          layer: 'deterministic',
          status: 'warn',
          recommendation: 'repair',
          summary: 'no deterministic check commands configured',
          findings: [
            {
              severity: 'medium',
              title: 'Missing deterministic checks',
              body: 'Configure check commands so success is grounded in executed verification.',
            },
          ],
          scores: {
            deterministic: 0,
          },
          evidence: [],
        };
      }

      const results = await environment.runChecks(commands);
      const failed = results.filter((result) => !result.passed);
      const allPassed = failed.length === 0;

      return {
        layer: 'deterministic',
        status: allPassed ? 'pass' : 'fail',
        recommendation: allPassed ? 'complete' : 'repair',
        summary: allPassed
          ? `all deterministic checks passed for ${task.id}`
          : `${failed.length} deterministic check(s) failed`,
        findings: failed.map((result) => ({
          severity: 'high',
          title: `Check failed: ${result.command}`,
          body: result.stderr || result.stdout || `exit code ${result.exitCode}`,
          evidence: result.command,
        })),
        scores: {
          deterministic: allPassed ? 1 : 0,
        },
        evidence: results.map((result) => ({
          kind: 'test',
          label: result.command,
          value: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n'),
          metadata: {
            passed: String(result.passed),
            exitCode: String(result.exitCode),
          },
        })),
      };
    },
  };
}

function isProviderUnavailable(evidence: Array<{ kind: string; label: string; value: string; metadata?: Record<string, string> }>): boolean {
  for (const item of evidence) {
    const text = `${item.value} ${item.metadata?.error ?? ''}`.toLowerCase();
    if (
      text.includes('usage limit')
      || text.includes('rate limit')
      || text.includes('quota')
      || text.includes('429')
      || text.includes('insufficient_quota')
      || text.includes('credits')
      || (item.metadata?.exitCode !== undefined && item.metadata.exitCode !== '0' && text.includes('limit'))
    ) {
      return true;
    }
  }
  return false;
}

function createReviewWorkerAdapter(
  workerId: string,
  provider: TextProvider,
  variant: PromptVariant,
  implementationWorkerId: string,
): ParsedProviderWorkerAdapter<ReviewJudgePayload> {
  return new ParsedProviderWorkerAdapter<ReviewJudgePayload>(
    {
      id: `${workerId}-review`,
      name: `${workerId} Review`,
      capabilities: ['review'],
    },
    provider,
    ({ task, context }) =>
      buildReviewPrompt({
        variant,
        task,
        context,
        implementationWorkerId,
      }),
    (stdout) => normalizeReviewPayload(parseJsonOutput(stdout)),
  );
}

function createReviewEvaluator(input: {
  implementationWorkerId: string;
  reviewWorkerId: string;
  repoPath: string;
  provider: TextProvider;
  fallbackProvider?: TextProvider;
  fallbackWorkerId?: string;
  variant: PromptVariant;
}): Evaluator<EngineeringEvaluationInput> {
  const reviewer = createReviewWorkerAdapter(
    input.reviewWorkerId,
    input.provider,
    input.variant,
    input.implementationWorkerId,
  );

  const fallbackReviewer = input.fallbackProvider && input.fallbackWorkerId
    ? createReviewWorkerAdapter(
        input.fallbackWorkerId,
        input.fallbackProvider,
        input.variant,
        input.implementationWorkerId,
      )
    : undefined;

  async function attemptReview(
    adapter: ParsedProviderWorkerAdapter<ReviewJudgePayload>,
    workerId: string,
    reviewTask: { goal: string; successCriteria: string[]; repoPath: string },
    reviewContext: string,
  ): Promise<{ result: EvaluationResult; unavailable: boolean }> {
    try {
      const run = await adapter.run({
        task: reviewTask,
        context: { summary: reviewContext },
      });

      const unavailable = !run.output && isProviderUnavailable(run.evidence);

      if (!run.output) {
        return {
          unavailable,
          result: {
            layer: 'judge',
            status: 'warn',
            recommendation: 'repair',
            summary: unavailable
              ? `${workerId} unavailable (rate limit or quota)`
              : `${workerId} review produced no structured output`,
            findings: [{
              severity: unavailable ? 'low' : 'medium',
              title: unavailable ? 'Provider unavailable' : 'Missing review output',
              body: unavailable
                ? `${workerId} hit a usage or rate limit. This is not a code quality issue.`
                : 'The review worker did not return a structured review payload.',
            }],
            scores: { review: 0 },
            evidence: toEvaluationEvidence(run.evidence),
          },
        };
      }

      return {
        unavailable: false,
        result: {
          layer: 'judge',
          status: run.output.status,
          recommendation: run.output.recommendation,
          summary: run.output.summary,
          findings: (run.output.findings ?? []).map((finding) => ({
            severity: finding.severity ?? 'medium',
            title: finding.title ?? 'Review finding',
            body: finding.body ?? 'No details provided.',
            evidence: finding.evidence,
          })),
          scores: run.output.scores ?? {
            review: run.output.status === 'pass' ? 1 : 0,
          },
          evidence: dedupeEvidence([
            ...toEvaluationEvidence(run.evidence),
            ...toEvaluationEvidence(run.output.evidence ?? []),
          ]),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unavailable = message.toLowerCase().includes('timed out')
        || message.toLowerCase().includes('limit')
        || message.toLowerCase().includes('quota');
      return {
        unavailable,
        result: {
          layer: 'judge',
          status: 'warn',
          recommendation: 'repair',
          summary: `${workerId} review failed: ${message}`,
          findings: [{
            severity: unavailable ? 'low' : 'medium',
            title: unavailable ? 'Provider unavailable' : 'Review worker failed',
            body: message,
          }],
          scores: { review: 0 },
          evidence: [],
        },
      };
    }
  }

  return {
    name: 'llm-review-judge',
    layer: 'judge',
    evaluate: async ({ task, context, trackResults }) => {
      const reviewContext = buildReviewContext(context, trackResults);
      const reviewTask = {
        goal: task.goal,
        successCriteria: task.successCriteria,
        repoPath: input.repoPath,
      };

      const primary = await attemptReview(reviewer, input.reviewWorkerId, reviewTask, reviewContext);

      if (!primary.unavailable || !fallbackReviewer || !input.fallbackWorkerId) {
        return primary.result;
      }

      const fallback = await attemptReview(fallbackReviewer, input.fallbackWorkerId, reviewTask, reviewContext);
      if (!fallback.unavailable) {
        fallback.result.summary = `[fallback from ${input.reviewWorkerId}] ${fallback.result.summary}`;
      }
      return fallback.result;
    },
  };
}

function createToolCommandEvaluator(
  repoPath: string,
  commands: string[],
): Evaluator<EngineeringEvaluationInput> {
  const workers = commands.map((command, index) => ({
    command,
    worker: new CommandWorkerAdapter({
      id: `tool-${index + 1}`,
      name: `Tool ${index + 1}`,
      capabilities: ['ops'],
    }),
  }));

  return {
    name: 'tool-command-audits',
    layer: 'environment',
    evaluate: async () => {
      const runs = await Promise.all(
        workers.map(({ command, worker }) =>
          worker.run({
            task: {
              command,
              cwd: repoPath,
            } satisfies CommandWorkerTask,
            context: {
              summary: `Run tool command in ${repoPath}`,
            },
          }),
        ),
      );
      const failed = runs.filter((run) => run.result?.status !== 'completed');

      return {
        layer: 'environment',
        status: failed.length === 0 ? 'pass' : 'warn',
        recommendation: failed.length === 0 ? 'complete' : 'repair',
        summary: failed.length === 0
          ? `${runs.length} tool command(s) completed`
          : `${failed.length} tool command(s) reported issues`,
        findings: failed.map((run, index) => ({
          severity: 'medium',
          title: `Tool command failed: ${workers[index]?.command ?? run.worker.id}`,
          body: run.evidence.map((item) => item.value).filter(Boolean).join('\n') || 'No tool output captured.',
          evidence: workers[index]?.command,
        })),
        scores: {
          tools: failed.length === 0 ? 1 : 0.5,
        },
        evidence: runs.flatMap((run) => toEvaluationEvidence(run.evidence)),
      };
    },
  };
}

function normalizeReviewPayload(payload: unknown): ReviewJudgePayload {
  if (!isRecord(payload)) {
    throw new Error('review output was not an object');
  }

  const rawFindings = firstArray(payload.findings, payload.issues, payload.concerns, payload.problems);
  const findings = dedupeReviewFindings(
    (rawFindings ?? [])
      .map((item) => normalizeReviewFinding(item))
      .filter((item): item is NonNullable<typeof item> => Boolean(item)),
  );
  let status = normalizeStatus(
    payload.status
      ?? payload.verdict
      ?? payload.result,
  );
  let recommendation = normalizeRecommendation(
    payload.recommendation
      ?? payload.nextAction
      ?? payload.decision,
  );
  const summary = typeof payload.summary === 'string' && payload.summary.trim()
    ? payload.summary.trim()
    : deriveReviewSummary(status, findings);
  const evidence = normalizeReviewEvidence(firstArray(payload.evidence, payload.artifacts, payload.notes));
  const scores = normalizeReviewScores(payload.scores);

  if (status === 'pass' && findings.some((finding) => finding.severity === 'critical' || finding.severity === 'high')) {
    status = 'fail';
  } else if (status === 'pass' && findings.length > 0) {
    status = 'warn';
  }

  if (recommendation === 'complete' && status !== 'pass') {
    recommendation = status === 'fail' ? 'repair' : 'repair';
  }
  if (status === 'fail' && findings.length === 0) {
    findings.push({
      severity: 'high',
      title: 'Review failed without concrete findings',
      body: 'The review worker marked the run as failed but did not provide concrete findings.',
    });
  }
  if (recommendation === 'repair' && findings.length === 0 && status === 'warn') {
    findings.push({
      severity: 'medium',
      title: 'Review requested repair without concrete findings',
      body: 'The review worker requested repair but did not provide concrete issues to resolve.',
    });
  }

  return {
    status,
    recommendation,
    summary,
    findings,
    scores,
    evidence,
  };
}

function normalizeStatus(value: unknown): ValidationStatus {
  return value === 'pass' || value === 'warn' || value === 'fail' ? value : 'warn';
}

function normalizeRecommendation(value: unknown): Recommendation {
  return value === 'complete' || value === 'repair' || value === 'escalate' || value === 'abort'
    ? value
    : 'repair';
}

function normalizeSeverity(value: unknown): 'low' | 'medium' | 'high' | 'critical' {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
    ? value
    : 'medium';
}

function normalizeReviewFinding(
  value: unknown,
): ReviewJudgeFinding | undefined {
  if (typeof value === 'string' && value.trim()) {
    return {
      severity: 'medium',
      title: 'Review finding',
      body: value.trim(),
    };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const title = typeof value.title === 'string' && value.title.trim()
    ? value.title.trim()
    : typeof value.label === 'string' && value.label.trim()
      ? value.label.trim()
      : 'Review finding';
  const body = typeof value.body === 'string' && value.body.trim()
    ? value.body.trim()
    : typeof value.message === 'string' && value.message.trim()
      ? value.message.trim()
      : typeof value.description === 'string' && value.description.trim()
        ? value.description.trim()
        : 'No details provided.';
  return {
    severity: normalizeSeverity(value.severity),
    title,
    body,
    evidence: typeof value.evidence === 'string' ? value.evidence : undefined,
  };
}

function dedupeReviewFindings(
  findings: NonNullable<ReviewJudgePayload['findings']>,
): NonNullable<ReviewJudgePayload['findings']> {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.severity}|${finding.title}|${finding.body}|${finding.evidence ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizeReviewScores(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    .map(([key, score]) => [key, Math.max(0, Math.min(1, score))] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeReviewEvidence(value: unknown): NonNullable<ReviewJudgePayload['evidence']> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .map((item) => ({
      kind: typeof item.kind === 'string' ? item.kind : 'note',
      label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : 'review-note',
      value: typeof item.value === 'string' ? item.value : (
        typeof item.body === 'string' ? item.body : ''
      ),
      uri: typeof item.uri === 'string' ? item.uri : undefined,
      metadata: isRecord(item.metadata)
        ? Object.fromEntries(
            Object.entries(item.metadata).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : undefined,
    }))
    .filter((item) => item.value.trim());
}

function deriveReviewSummary(
  status: ValidationStatus,
  findings: NonNullable<ReviewJudgePayload['findings']>,
): string {
  if (findings.length === 0) {
    return status === 'pass'
      ? 'Review passed without concrete findings.'
      : 'Review completed without a concrete summary.';
  }
  const topFinding = findings[0];
  return status === 'pass'
    ? 'Review passed with sufficient evidence.'
    : `${status === 'fail' ? 'Review failed' : 'Review warned'}: ${topFinding?.title ?? 'issues found'}`;
}

function firstArray(...values: unknown[]): unknown[] | undefined {
  return values.find(Array.isArray) as unknown[] | undefined;
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

function summarizePriorRound(round: {
  trackResults: Array<TrackResult<unknown>>;
  validation: ValidationResult;
  repair?: { actions: string[] };
} | undefined): string {
  if (!round) {
    return '';
  }

  const lines = [
    ...round.trackResults.map((track) => `- ${track.trackId}: ${track.summary}`),
    `- validation: ${round.validation.summary}`,
    ...(round.validation.findings.map((finding) => `- finding: ${finding.title}`)),
    ...(round.repair?.actions.map((action) => `- repair: ${action}`) ?? []),
  ];
  return lines.join('\n');
}

function buildReviewContext(
  context: ContextSnapshot,
  trackResults: Array<TrackResult<unknown>>,
): string {
  const lines = [
    context.summary,
    '',
    'Track results:',
    ...trackResults.flatMap((track) => [
      `- ${track.trackId}: ${track.summary}`,
      ...track.evidence.slice(0, 4).map((item) => `  ${item.label}: ${truncate(item.value, 500)}`),
    ]),
  ];
  return lines.join('\n');
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
  if (input.validation.recommendation === 'escalate' && input.escalationMode !== 'auto-repair') {
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
  environmentMemory: EnvironmentMemory | null;
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

function buildEngineeringEvaluators(input: {
  environment: GitCodeEnvironment;
  checkCommands: string[];
  toolCommands: string[];
  implementationWorkerId: string;
  reviewWorkerId: 'codex' | 'claude';
  repoPath: string;
  providers: Record<'codex' | 'claude', TextProvider>;
  reviewerVariant: PromptVariant;
  profileMemory: ProfileMemory | null;
}): Array<Evaluator<EngineeringEvaluationInput>> {
  const deterministic = createDeterministicCodeEvaluator(input.environment, input.checkCommands);
  const fallbackWorkerId: 'codex' | 'claude' = input.reviewWorkerId === 'codex' ? 'claude' : 'codex';
  const review = createReviewEvaluator({
    implementationWorkerId: input.implementationWorkerId,
    reviewWorkerId: input.reviewWorkerId,
    repoPath: input.repoPath,
    provider: input.providers[input.reviewWorkerId] ?? input.providers.claude,
    fallbackProvider: input.providers[fallbackWorkerId],
    fallbackWorkerId,
    variant: input.reviewerVariant,
  });
  const tool = input.toolCommands.length > 0
    ? createToolCommandEvaluator(input.repoPath, input.toolCommands)
    : undefined;

  const evaluationStyle = new Set(input.profileMemory?.evaluationStyle ?? []);
  const evaluators: Array<Evaluator<EngineeringEvaluationInput>> = [];

  if (evaluationStyle.has('deterministic-first')) {
    evaluators.push(deterministic);
    if (tool && evaluationStyle.has('tool-audits')) {
      evaluators.push(tool);
    }
    evaluators.push(review);
    return evaluators;
  }

  if (tool && evaluationStyle.has('tool-audits')) {
    evaluators.push(tool);
  }
  evaluators.push(deterministic, review);
  return evaluators;
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

function toCoreFinding(finding: {
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  body: string;
  evidence?: string;
}): Finding {
  return {
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
    evidence: finding.evidence,
  };
}

function toEvaluationEvidence(
  evidence: Array<{ kind: string; label: string; value: string; uri?: string; metadata?: Record<string, string> }>,
): Evidence[] {
  return evidence as Evidence[];
}

function dedupeEvidence(
  evidence: Array<{
    kind: string;
    label: string;
    value: string;
    uri?: string;
    metadata?: Record<string, string>;
  }>,
): Array<{
  kind: string;
  label: string;
  value: string;
  uri?: string;
  metadata?: Record<string, string>;
}> {
  const seen = new Set<string>();
  const deduped: typeof evidence = [];
  for (const item of evidence) {
    const key = JSON.stringify([item.kind, item.label, item.value, item.uri, item.metadata]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function compactMemorySummary(
  environmentMemory: EnvironmentMemory | null,
  profileMemory: ProfileMemory | null,
  strategyMemory: StrategyMemory | null,
): string {
  const lines: string[] = [];
  if (environmentMemory?.facts?.length) {
    lines.push(...environmentMemory.facts.map((fact) => `- ${fact}`));
  }
  if (environmentMemory?.failureModes?.length) {
    lines.push(...environmentMemory.failureModes.slice(0, 5).map((fact) => `- known failure: ${fact}`));
  }
  if (profileMemory?.workerPreferences?.length) {
    lines.push(`- preferred workers: ${profileMemory.workerPreferences.join(', ')}`);
  }
  if (profileMemory?.operatorPatterns?.length) {
    lines.push(...profileMemory.operatorPatterns.slice(0, 5).map((pattern) => `- operator pattern: ${pattern}`));
  }
  if (profileMemory?.goalPatterns?.length) {
    lines.push(...profileMemory.goalPatterns.slice(0, 5).map((pattern) => `- goal pattern: ${pattern}`));
  }
  if (profileMemory?.workflowImprovements?.length) {
    lines.push(...profileMemory.workflowImprovements.slice(0, 5).map((item) => `- workflow preference: ${item}`));
  }
  if (profileMemory?.skillOrToolingImprovements?.length) {
    lines.push(...profileMemory.skillOrToolingImprovements.slice(0, 5).map((item) => `- tooling note: ${item}`));
  }
  if (strategyMemory?.successfulPatterns?.length) {
    lines.push(...strategyMemory.successfulPatterns.slice(0, 5).map((pattern) => `- strategy: ${pattern}`));
  }
  return lines.join('\n');
}

async function updateEngineeringMemory(input: {
  memoryStore: MemoryStore;
  repoPath: string;
  profileId: string;
  implementationWorkerId: string;
  reviewWorkerId: string;
  plannerWorkerId: string;
  goal: string;
  expandedGoal: string;
  successCriteria: string[];
  validation?: ValidationResult;
  checkCommands: string[];
  toolCommands: string[];
}): Promise<void> {
  const existingEnv = await input.memoryStore.getEnvironmentMemory(input.repoPath);
  const environmentMemory: EnvironmentMemory = {
    target: input.repoPath,
    facts: dedupe([
      ...(existingEnv?.facts ?? []),
      `latest goal: ${input.goal}`,
      `expanded goal: ${input.expandedGoal}`,
      ...input.successCriteria.map((criterion) => `criterion: ${criterion}`),
      ...input.checkCommands.map((command) => `check: ${command}`),
      ...input.toolCommands.map((command) => `tool: ${command}`),
    ]),
    invariants: dedupe(existingEnv?.invariants ?? []),
    failureModes: dedupe([
      ...(existingEnv?.failureModes ?? []),
      ...(input.validation?.findings.map((finding) => finding.title) ?? []),
    ]),
  };
  await input.memoryStore.putEnvironmentMemory(environmentMemory);

  await putWorkerMemory(input.memoryStore, input.implementationWorkerId, input.validation);
  await putWorkerMemory(input.memoryStore, input.reviewWorkerId, input.validation);

  const existingStrategy = await input.memoryStore.getStrategyMemory('engineering');
  const strategyMemory: StrategyMemory = {
    taskShape: 'engineering',
    successfulPatterns: dedupe([
      ...(existingStrategy?.successfulPatterns ?? []),
      ...(input.validation?.status === 'pass'
        ? [
            ...input.checkCommands.map((command) => `validated by ${command}`),
            ...input.toolCommands.map((command) => `audited by ${command}`),
          ]
        : []),
    ]),
    badPatterns: dedupe([
      ...(existingStrategy?.badPatterns ?? []),
      ...(input.validation?.status !== 'pass' ? ['missing or failing validation gates'] : []),
    ]),
    repairRecipes: dedupe([
      ...(existingStrategy?.repairRecipes ?? []),
      ...(input.validation?.findings.map((finding) => `repair ${finding.title}`) ?? []),
    ]),
  };
  await input.memoryStore.putStrategyMemory(strategyMemory);

  await input.memoryStore.putProfileMemory({
    profileId: input.profileId,
    workerPreferences: dedupe([
      input.implementationWorkerId,
      input.reviewWorkerId,
      input.plannerWorkerId,
    ]),
    evaluationStyle: dedupe([
      'deterministic-first',
      input.toolCommands.length > 0 ? 'tool-audits' : '',
      'judge-after-grounded-checks',
    ]),
    memoryScopes: ['profile', 'project', 'environment'],
    operatorPatterns: existingEnv?.facts?.filter((fact) => fact.startsWith('latest goal:')).slice(-3),
    workflowImprovements: dedupe([
      ...(input.validation?.status === 'pass' ? ['prefer validation-backed completion'] : []),
      ...(input.toolCommands.length > 0 ? ['use tool-backed audits when available'] : []),
    ]),
  });
}

async function putWorkerMemory(
  memoryStore: MemoryStore,
  workerId: string,
  validation: ValidationResult | undefined,
): Promise<void> {
  const workerFindings = (validation?.findings ?? []).filter((finding) => {
    const title = finding.title.toLowerCase();
    return !title.includes('provider unavailable')
      && !title.includes('evaluator failure')
      && !title.includes('usage limit')
      && !title.includes('rate limit');
  });
  const hasInfraFailureOnly = workerFindings.length === 0
    && (validation?.findings ?? []).length > 0
    && validation?.status !== 'pass';

  const existingWorker = await memoryStore.getWorkerMemory(workerId);
  const workerMemory: WorkerPerformanceMemory = {
    ...recordWorkerRun(
      existingWorker ? { ...existingWorker, workerId } : { workerId },
      {
        succeeded: hasInfraFailureOnly ? true : validation?.status === 'pass',
        failureClasses: workerFindings.map((finding) => finding.title || finding.severity || 'validation-failed'),
      },
    ),
    workerId,
  };
  await memoryStore.putWorkerMemory(workerMemory);
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
