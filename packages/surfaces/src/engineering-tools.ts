import {
  type ContextSnapshot,
  type Evidence,
  type Finding,
  type TaskSpec,
  type TrackResult,
  type ValidationResult,
  type ValidationStatus,
  type Recommendation,
} from '@drew/foreman-core';
import { GitCodeEnvironment } from '@drew/foreman-environments';
import { EvaluationPipeline, type EvaluationResult, type Evaluator } from '@drew/foreman-evals';
import {
  type MemoryStore,
  type EnvironmentMemory,
  type ProfileMemory,
  type StrategyMemory,
  type WorkerPerformanceMemory,
  recordWorkerRun,
} from '@drew/foreman-memory';
import {
  HeuristicTaskHardener,
  ProviderTaskHardener,
  type HardenedTask,
  type PromptVariant,
  renderPromptVariant,
} from '@drew/foreman-planning';
import {
  parseJsonOutput,
  type TextProvider,
} from '@drew/foreman-providers';
import {
  CommandWorkerAdapter,
  ParsedProviderWorkerAdapter,
  type WorkerAdapter,
  type CommandWorkerTask,
  type ProviderWorkerTask,
} from '@drew/foreman-workers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// hardenTask
// ---------------------------------------------------------------------------

export async function hardenTask(options: {
  goal: string;
  repoPath: string;
  successCriteria?: string[];
  provider?: TextProvider;
  promptVariant?: PromptVariant;
}): Promise<HardenedTask> {
  const variant = options.promptVariant ?? {
    id: 'engineering-hardener:contract-v1',
    label: 'Engineering Hardener Contract',
    role: 'hardener' as const,
    taskShape: 'engineering',
    style: 'contract-heavy' as const,
    systemPreamble: 'You are a task-hardening worker operating under Foreman supervision.',
    principles: [
      'Preserve the original user goal.',
      'Make missing criteria explicit.',
      'Infer checks conservatively from repository evidence.',
    ],
    outputContract: 'Return JSON only with keys: goal, expandedGoal, successCriteria, checkCommands, executionNotes, inferred.',
  };

  const hardener = new ProviderTaskHardener(
    options.provider!,
    new HeuristicTaskHardener(),
    (input) =>
      buildHardenerPrompt({
        variant,
        input,
      }),
  );

  return hardener.harden({
    goal: options.goal,
    repoPath: options.repoPath,
    successCriteria: options.successCriteria,
  });
}

// ---------------------------------------------------------------------------
// observeEnvironment
// ---------------------------------------------------------------------------

export interface PriorRoundState {
  trackResults: Array<TrackResult<unknown>>;
  validation: ValidationResult;
  repair?: { actions: string[] };
}

export async function observeEnvironment(options: {
  repoPath: string;
  memoryStore?: MemoryStore;
  profileId?: string;
  round?: number;
  priorRound?: PriorRoundState;
}): Promise<ContextSnapshot> {
  const environment = new GitCodeEnvironment(options.repoPath);
  const observation = await environment.observe();

  let memorySummary = '';
  if (options.memoryStore) {
    const [envMemory, profileMemory, strategyMemory] = await Promise.all([
      options.memoryStore.getEnvironmentMemory(options.repoPath),
      options.profileId ? options.memoryStore.getProfileMemory(options.profileId) : null,
      options.memoryStore.getStrategyMemory('engineering'),
    ]);
    memorySummary = compactMemorySummary(envMemory, profileMemory, strategyMemory);
  }

  const priorRoundSummary = summarizePriorRound(options.priorRound);

  const isFirstRound = (options.round ?? 0) === 0;
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
  } satisfies ContextSnapshot;
}

// ---------------------------------------------------------------------------
// dispatchWorker
// ---------------------------------------------------------------------------

export async function dispatchWorker(options: {
  worker: WorkerAdapter<ProviderWorkerTask, unknown>;
  fallbackWorker?: WorkerAdapter<ProviderWorkerTask, unknown>;
  task: ProviderWorkerTask;
  context: { summary: string; state?: unknown; evidence?: Evidence[] };
  instructions?: string;
}): Promise<TrackResult<unknown>> {
  let run: Awaited<ReturnType<WorkerAdapter<ProviderWorkerTask, unknown>['run']>>;
  let effectiveWorkerId = options.worker.worker.id;

  try {
    run = await options.worker.run({
      task: options.task,
      context: options.context,
      instructions: options.instructions,
    });
    if (run.result?.status === 'failed' && isProviderUnavailable(run.evidence)) {
      throw new Error(`${options.worker.worker.id} unavailable`);
    }
  } catch {
    if (!options.fallbackWorker) {
      throw new Error(`${options.worker.worker.id} failed and no fallback worker available`);
    }
    effectiveWorkerId = options.fallbackWorker.worker.id;
    run = await options.fallbackWorker.run({
      task: options.task,
      context: options.context,
      instructions: options.instructions
        ? `[fallback from ${options.worker.worker.id}] ${options.instructions}`
        : `[fallback from ${options.worker.worker.id}]`,
    });
  }

  return {
    trackId: 'implement',
    status: run.result?.status ?? 'completed',
    summary: run.summary,
    output: run.output,
    evidence: toCoreEvidence(run.evidence),
    findings: [],
    metadata: {
      workerId: effectiveWorkerId,
      ...(effectiveWorkerId !== options.worker.worker.id ? { fallbackFrom: options.worker.worker.id } : {}),
      ...(run.metrics?.durationMs !== undefined ? { durationMs: String(run.metrics.durationMs) } : {}),
      ...(run.metrics?.costUsd !== undefined ? { costUsd: String(run.metrics.costUsd) } : {}),
    },
  } satisfies TrackResult<unknown>;
}

// ---------------------------------------------------------------------------
// validateWork
// ---------------------------------------------------------------------------

export async function validateWork(options: {
  task: TaskSpec;
  context: ContextSnapshot;
  trackResults: TrackResult<unknown>[];
  environment: GitCodeEnvironment;
  checkCommands: string[];
  toolCommands?: string[];
  reviewProvider: TextProvider;
  fallbackReviewProvider?: TextProvider;
  reviewWorkerId: string;
  fallbackReviewWorkerId?: string;
  reviewerVariant: PromptVariant;
  profileMemory?: ProfileMemory | null;
}): Promise<ValidationResult> {
  const evaluators = buildEngineeringEvaluators({
    environment: options.environment,
    checkCommands: options.checkCommands,
    toolCommands: options.toolCommands ?? [],
    implementationWorkerId: options.trackResults[0]?.metadata?.workerId ?? 'unknown',
    reviewWorkerId: options.reviewWorkerId,
    repoPath: options.task.environment?.target ?? '',
    provider: options.reviewProvider,
    fallbackProvider: options.fallbackReviewProvider,
    fallbackWorkerId: options.fallbackReviewWorkerId,
    reviewerVariant: options.reviewerVariant,
    profileMemory: options.profileMemory ?? null,
  });

  const pipeline = new EvaluationPipeline<EngineeringEvaluationInput>(evaluators);
  const evaluation = await pipeline.run({
    task: options.task,
    context: options.context,
    trackResults: options.trackResults,
  });

  return {
    status: evaluation.status,
    recommendation: evaluation.recommendation,
    summary: evaluation.summary,
    findings: evaluation.findings.map(toCoreFinding),
    scores: evaluation.scores,
    evidence: toCoreEvidence(evaluation.evidence),
  };
}

// ---------------------------------------------------------------------------
// updateMemory
// ---------------------------------------------------------------------------

export async function updateMemory(options: {
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
  productContext?: { docs: Array<{ path: string }> };
  ciFailures?: string[];
}): Promise<void> {
  const existingEnv = await options.memoryStore.getEnvironmentMemory(options.repoPath);
  const succeeded = options.validation?.status === 'pass'
    || (options.validation?.status === 'warn' && options.validation.findings.every((f) => f.severity === 'low'));

  // Store atomic, verifiable facts — not raw goal text
  const newFacts: string[] = [
    ...options.checkCommands.map((cmd) => `check-command: ${cmd}`),
    ...options.toolCommands.map((cmd) => `tool-command: ${cmd}`),
    ...(options.productContext?.docs.map((d) => `has-doc: ${d.path}`) ?? []),
  ];
  // Learn CI requirements from failures
  if (options.ciFailures?.length) {
    newFacts.push(...options.ciFailures.map((f) => `ci-requirement: ${f}`));
  }

  const environmentMemory: EnvironmentMemory = {
    target: options.repoPath,
    facts: dedupe([
      ...(existingEnv?.facts ?? []).filter((f) =>
        // Keep structured facts, drop old raw goal text
        f.startsWith('check-command:')
        || f.startsWith('tool-command:')
        || f.startsWith('has-doc:')
        || f.startsWith('ci-requirement:')
        || f.startsWith('uses-dep:')
        || f.startsWith('lang:')
        || f.startsWith('build-system:')
      ),
      ...newFacts,
    ]).slice(0, 50),
    invariants: dedupe(existingEnv?.invariants ?? []).slice(0, 20),
    failureModes: dedupe([
      ...(existingEnv?.failureModes ?? []),
      ...(options.validation?.findings
        .filter((f) => f.severity === 'high' || f.severity === 'critical')
        .map((f) => f.title) ?? []),
    ]).slice(0, 20),
  };
  await options.memoryStore.putEnvironmentMemory(environmentMemory);

  // Only record worker performance for the implementation worker, not reviewer
  await putWorkerMemory(options.memoryStore, options.implementationWorkerId, options.validation);

  const existingStrategy = await options.memoryStore.getStrategyMemory('engineering');
  const strategyMemory: StrategyMemory = {
    taskShape: 'engineering',
    successfulPatterns: dedupe([
      ...(existingStrategy?.successfulPatterns ?? []),
      ...(succeeded
        ? options.checkCommands.slice(0, 5).map((cmd) => `validated-by: ${cmd}`)
        : []),
    ]).slice(0, 20),
    badPatterns: dedupe([
      ...(existingStrategy?.badPatterns ?? []),
      ...(options.ciFailures?.length ? ['ci-failed-after-local-pass'] : []),
    ]).slice(0, 10),
    repairRecipes: dedupe([
      ...(existingStrategy?.repairRecipes ?? []),
      ...(options.ciFailures?.map((f) => `ci-fix: ${f}`) ?? []),
      ...(options.validation?.findings
        .filter((f) => f.severity === 'high' || f.severity === 'critical')
        .map((f) => `repair: ${f.title}`) ?? []),
    ]).slice(0, 20),
  };
  await options.memoryStore.putStrategyMemory(strategyMemory);

  await options.memoryStore.putProfileMemory({
    profileId: options.profileId,
    workerPreferences: dedupe([
      options.implementationWorkerId,
      options.reviewWorkerId,
      options.plannerWorkerId,
    ]),
    evaluationStyle: dedupe([
      'deterministic-first',
      options.toolCommands.length > 0 ? 'tool-audits' : '',
      'judge-after-grounded-checks',
    ]),
    memoryScopes: ['profile', 'project', 'environment'],
  });
}

// ---------------------------------------------------------------------------
// Internal helpers (shared by the exported functions)
// ---------------------------------------------------------------------------

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

function buildEngineeringEvaluators(input: {
  environment: GitCodeEnvironment;
  checkCommands: string[];
  toolCommands: string[];
  implementationWorkerId: string;
  reviewWorkerId: string;
  repoPath: string;
  provider: TextProvider;
  fallbackProvider?: TextProvider;
  fallbackWorkerId?: string;
  reviewerVariant: PromptVariant;
  profileMemory: ProfileMemory | null;
}): Array<Evaluator<EngineeringEvaluationInput>> {
  const deterministic = createDeterministicCodeEvaluator(input.environment, input.checkCommands);
  const review = createReviewEvaluator({
    implementationWorkerId: input.implementationWorkerId,
    reviewWorkerId: input.reviewWorkerId,
    repoPath: input.repoPath,
    provider: input.provider,
    fallbackProvider: input.fallbackProvider,
    fallbackWorkerId: input.fallbackWorkerId,
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
        succeeded: hasInfraFailureOnly
          || validation?.status === 'pass'
          || (validation?.status === 'warn' && workerFindings.every((f) => f.severity === 'low')),
        failureClasses: workerFindings.map((finding) => finding.title || finding.severity || 'validation-failed'),
      },
    ),
    workerId,
  };
  await memoryStore.putWorkerMemory(workerMemory);
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

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
