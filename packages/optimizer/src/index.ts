import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { ai, ax, type AxAIArgs } from '@ax-llm/ax';
import type { PromptVariant } from '@drew/foreman-planning';
import type { RewardSignal, TraceBundle, TraceStore } from '@drew/foreman-tracing';

export interface PromptDatasetRow {
  traceId: string;
  taskId: string;
  taskGoal: string;
  taskShape: string;
  environmentKind?: string;
  outcomeStatus?: string;
  validated: boolean;
  promptPolicyMode: 'active' | 'shadow' | 'explicit';
  promptVariantIds: Record<string, string>;
  rewardSignals: RewardSignal[];
  aggregateScore: number;
  evidenceCount: number;
  roundCount: number;
  repairCount: number;
  durationMs?: number;
  checkPassRate?: number;
  escalationCount: number;
  metadata?: Record<string, string>;
}

export interface PromptVariantScore {
  variantId: string;
  role: string;
  taskShape: string;
  runs: number;
  completionRate: number;
  validationRate: number;
  averageScore: number;
  averageDurationMs?: number;
  averageCheckPassRate?: number;
}

export interface PromptRecommendation {
  role: string;
  taskShape: string;
  variantId: string;
  averageScore: number;
  rationale: string;
}

export interface PromptPolicyThresholds {
  minRunsForCandidate: number;
  minAverageScoreForCandidate: number;
  minImprovementForPromotion: number;
  minValidationRateForPromotion: number;
  minRunsForRollbackCheck: number;
  maxAverageScoreDropBeforeRollback: number;
  minValidationRateBeforeRollback: number;
}

export interface PromptPolicyHistoryEntry {
  at: string;
  action: 'set-active' | 'candidate' | 'set-shadow' | 'promote-shadow' | 'retire' | 'rollback';
  role: string;
  variantId: string;
  replacedVariantId?: string;
  rationale: string;
}

export interface PromptRolePolicy {
  role: string;
  activeVariantId?: string;
  candidateVariantIds: string[];
  shadowVariantId?: string;
  retiredVariantIds: string[];
  thresholds: PromptPolicyThresholds;
  history: PromptPolicyHistoryEntry[];
  updatedAt?: string;
}

export interface PromptPolicyState {
  taskShape: string;
  roles: Record<string, PromptRolePolicy>;
  metadata?: Record<string, string>;
}

export interface PromptOptimizationSnapshot {
  generatedAt: string;
  taskShape?: string;
  rows: PromptDatasetRow[];
  scores: PromptVariantScore[];
  recommendations: PromptRecommendation[];
  policy: PromptPolicyState;
  exports?: {
    datasetJsonlPath?: string;
  };
  adapter?: {
    name: string;
    result?: Record<string, unknown>;
  };
}

export interface PromptOptimizerConfig {
  minimumRunsPerVariant?: number;
  exportDatasetJsonl?: boolean;
  autoPromoteShadows?: boolean;
  autoRollbackActives?: boolean;
  thresholds?: Partial<PromptPolicyThresholds>;
}

export interface OptimizationSchedule {
  id: string;
  cadence: 'hourly' | 'daily' | 'weekly' | 'manual';
  traceRoot: string;
  outputRoot: string;
  policyRoot?: string;
  taskShape?: string;
  minimumRunsPerVariant?: number;
}

export interface PromptOptimizerAdapterContext {
  taskShape?: string;
  rows: PromptDatasetRow[];
  scores: PromptVariantScore[];
  policy: PromptPolicyState;
}

export interface PromptOptimizerAdapterResult {
  recommendations?: PromptRecommendation[];
  variants?: PromptVariant[];
  metadata?: Record<string, unknown>;
}

export interface PromptOptimizerAdapter {
  name: string;
  run(context: PromptOptimizerAdapterContext): Promise<PromptOptimizerAdapterResult>;
}

export interface AxPromptOptimizerAdapterOptions {
  provider: 'openai' | 'anthropic';
  apiKey: string;
  model: string;
  teacherModel?: string;
  maxRecommendations?: number;
}

export class FilesystemPromptPolicyStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async get(taskShape: string): Promise<PromptPolicyState | null> {
    return readJson<PromptPolicyState>(join(this.root, `${sanitize(taskShape)}.json`));
  }

  async put(policy: PromptPolicyState): Promise<string> {
    const path = join(this.root, `${sanitize(policy.taskShape)}.json`);
    await writeJson(path, policy);
    return path;
  }

  async list(): Promise<string[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.replace(/\.json$/, ''))
      .sort();
  }
}

export async function buildPromptDataset(
  traceStore: TraceStore,
  taskId?: string,
): Promise<PromptDatasetRow[]> {
  const refs = await traceStore.list(taskId);
  const rows: PromptDatasetRow[] = [];

  for (const ref of refs) {
    const bundle = await traceStore.get(ref.traceId);
    if (!bundle) {
      continue;
    }
    const row = traceBundleToDatasetRow(ref.traceId, bundle);
    if (row) {
      rows.push(row);
    }
  }

  return rows;
}

export function traceBundleToDatasetRow(
  traceId: string,
  bundle: TraceBundle,
): PromptDatasetRow | null {
  const promptVariantIds = extractPromptVariantIds(bundle.metadata);
  if (Object.keys(promptVariantIds).length === 0) {
    return null;
  }

  const rewardSignals = deriveRewardSignals(bundle);
  const aggregateScore = rewardSignals.length === 0
    ? 0
    : rewardSignals.reduce((sum, signal) => sum + signal.value, 0) / rewardSignals.length;

  return {
    traceId,
    taskId: bundle.task.id,
    taskGoal: bundle.metadata?.originalGoal ?? bundle.task.goal,
    taskShape: bundle.metadata?.taskShape ?? 'unknown',
    environmentKind: bundle.task.environmentKind,
    outcomeStatus: bundle.outcome?.status,
    validated: bundle.outcome?.validated ?? false,
    promptPolicyMode: normalizePromptPolicyMode(bundle.metadata?.promptPolicyMode),
    promptVariantIds,
    rewardSignals,
    aggregateScore,
    evidenceCount: bundle.evidence.length,
    roundCount: parseNumber(bundle.metadata?.roundCount) ?? 0,
    repairCount: parseNumber(bundle.metadata?.repairCount) ?? 0,
    durationMs: parseNumber(bundle.metadata?.durationMs),
    checkPassRate: parseNumber(bundle.metadata?.checkPassRate),
    escalationCount: parseNumber(bundle.metadata?.escalationCount) ?? 0,
    metadata: bundle.metadata,
  };
}

export function deriveRewardSignals(bundle: TraceBundle): RewardSignal[] {
  const completion = bundle.outcome?.status === 'completed' ? 1 : 0;
  const validated = bundle.outcome?.validated ? 1 : 0;
  const evidenceDensity = Math.min((bundle.evidence.length || 0) / 12, 1);
  const repairEfficiency = 1 / (1 + (parseNumber(bundle.metadata?.repairCount) ?? 0));
  const checkPassRate = parseNumber(bundle.metadata?.checkPassRate);
  const durationMs = parseNumber(bundle.metadata?.durationMs);
  const latencyScore = durationMs === undefined
    ? 0.5
    : Math.max(0, 1 - durationMs / (30 * 60 * 1000));
  const escalationAvoided = (parseNumber(bundle.metadata?.escalationCount) ?? 0) === 0 ? 1 : 0;

  return [
    {
      name: 'completed',
      value: completion,
      source: 'derived',
    },
    {
      name: 'validated',
      value: validated,
      source: 'derived',
    },
    {
      name: 'evidence_density',
      value: evidenceDensity,
      source: 'derived',
      metadata: {
        evidenceCount: String(bundle.evidence.length || 0),
      },
    },
    {
      name: 'repair_efficiency',
      value: repairEfficiency,
      source: 'derived',
      metadata: {
        repairCount: bundle.metadata?.repairCount ?? '0',
      },
    },
    {
      name: 'latency_efficiency',
      value: latencyScore,
      source: 'derived',
      metadata: {
        durationMs: bundle.metadata?.durationMs ?? '',
      },
    },
    {
      name: 'escalation_avoided',
      value: escalationAvoided,
      source: 'derived',
    },
    ...(checkPassRate === undefined
      ? []
      : [{
          name: 'check_pass_rate',
          value: checkPassRate,
          source: 'derived' as const,
        }]),
  ];
}

export function rankPromptVariants(
  rows: PromptDatasetRow[],
  config: PromptOptimizerConfig = {},
): PromptVariantScore[] {
  const grouped = new Map<string, PromptDatasetRow[]>();

  for (const row of rows) {
    for (const [role, variantId] of Object.entries(row.promptVariantIds)) {
      const key = `${row.taskShape}::${role}::${variantId}`;
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    }
  }

  const minimumRuns = config.minimumRunsPerVariant ?? 1;
  const scores: PromptVariantScore[] = [];

  for (const [key, group] of grouped.entries()) {
    if (group.length < minimumRuns) {
      continue;
    }
    const [taskShape, role, variantId] = key.split('::');
    const averageScore = average(group.map((row) => row.aggregateScore));
    const durationValues = group.flatMap((row) => row.durationMs === undefined ? [] : [row.durationMs]);
    const checkRateValues = group.flatMap((row) => row.checkPassRate === undefined ? [] : [row.checkPassRate]);
    scores.push({
      variantId,
      role,
      taskShape,
      runs: group.length,
      completionRate: average(group.map((row) => row.outcomeStatus === 'completed' ? 1 : 0)),
      validationRate: average(group.map((row) => row.validated ? 1 : 0)),
      averageScore,
      averageDurationMs: durationValues.length > 0 ? average(durationValues) : undefined,
      averageCheckPassRate: checkRateValues.length > 0 ? average(checkRateValues) : undefined,
    });
  }

  return scores.sort((a, b) =>
    b.averageScore - a.averageScore
    || b.validationRate - a.validationRate
    || b.completionRate - a.completionRate
    || b.runs - a.runs
    || a.variantId.localeCompare(b.variantId),
  );
}

export function recommendPromptVariants(scores: PromptVariantScore[]): PromptRecommendation[] {
  const bestByRole = new Map<string, PromptVariantScore>();

  for (const score of scores) {
    const key = `${score.taskShape}::${score.role}`;
    const current = bestByRole.get(key);
    if (!current || score.averageScore > current.averageScore) {
      bestByRole.set(key, score);
    }
  }

  return Array.from(bestByRole.values()).map((score) => ({
    role: score.role,
    taskShape: score.taskShape,
    variantId: score.variantId,
    averageScore: score.averageScore,
    rationale: `${score.runs} run(s), validation rate ${formatRate(score.validationRate)}, completion rate ${formatRate(score.completionRate)}`,
  }));
}

export function createDefaultPromptPolicy(
  taskShape: string,
  recommendations: PromptRecommendation[] = [],
  thresholds?: Partial<PromptPolicyThresholds>,
): PromptPolicyState {
  const roles = Object.fromEntries(
    recommendations.map((recommendation) => [
      recommendation.role,
      {
        role: recommendation.role,
        activeVariantId: recommendation.variantId,
        candidateVariantIds: [],
        retiredVariantIds: [],
        thresholds: mergeThresholds(thresholds),
        history: [
          {
            at: new Date().toISOString(),
            action: 'set-active',
            role: recommendation.role,
            variantId: recommendation.variantId,
            rationale: recommendation.rationale,
          },
        ],
        updatedAt: new Date().toISOString(),
      } satisfies PromptRolePolicy,
    ]),
  );

  return {
    taskShape,
    roles,
  };
}

export function updatePromptPolicy(input: {
  policy: PromptPolicyState | null;
  taskShape: string;
  scores: PromptVariantScore[];
  recommendations: PromptRecommendation[];
  thresholds?: Partial<PromptPolicyThresholds>;
  autoPromoteShadows?: boolean;
  autoRollbackActives?: boolean;
}): PromptPolicyState {
  const policy = input.policy ?? createDefaultPromptPolicy(
    input.taskShape,
    input.recommendations,
    input.thresholds,
  );

  for (const recommendation of input.recommendations) {
    if (recommendation.taskShape !== input.taskShape) {
      continue;
    }

    const roleState = ensureRolePolicy(
      policy,
      recommendation.role,
      input.thresholds,
    );
    const score = input.scores.find((item) =>
      item.taskShape === input.taskShape
      && item.role === recommendation.role
      && item.variantId === recommendation.variantId,
    );
    if (!score) {
      continue;
    }

    if (!roleState.activeVariantId) {
      roleState.activeVariantId = recommendation.variantId;
      roleState.updatedAt = new Date().toISOString();
      roleState.history.push({
        at: roleState.updatedAt,
        action: 'set-active',
        role: recommendation.role,
        variantId: recommendation.variantId,
        rationale: recommendation.rationale,
      });
      continue;
    }

    const activeScore = input.scores.find((item) =>
      item.taskShape === input.taskShape
      && item.role === recommendation.role
      && item.variantId === roleState.activeVariantId,
    );
    const improvement = score.averageScore - (activeScore?.averageScore ?? 0);

    if (recommendation.variantId === roleState.activeVariantId) {
      if (
        input.autoPromoteShadows
        && roleState.shadowVariantId
        && shouldPromoteShadowVariant({
          roleState,
          scores: input.scores,
          taskShape: input.taskShape,
        })
      ) {
        promoteShadowVariant(policy, roleState, input.scores, input.taskShape);
      }
      continue;
    }

    if (
      score.runs >= roleState.thresholds.minRunsForCandidate
      && score.averageScore >= roleState.thresholds.minAverageScoreForCandidate
    ) {
      if (!roleState.candidateVariantIds.includes(recommendation.variantId)) {
        roleState.candidateVariantIds.push(recommendation.variantId);
        roleState.updatedAt = new Date().toISOString();
        roleState.history.push({
          at: roleState.updatedAt,
          action: 'candidate',
          role: recommendation.role,
          variantId: recommendation.variantId,
          rationale: recommendation.rationale,
        });
      }
    }

    if (
      improvement >= roleState.thresholds.minImprovementForPromotion
      && score.validationRate >= roleState.thresholds.minValidationRateForPromotion
    ) {
      if (roleState.shadowVariantId !== recommendation.variantId) {
        roleState.shadowVariantId = recommendation.variantId;
        roleState.updatedAt = new Date().toISOString();
        roleState.history.push({
          at: roleState.updatedAt,
          action: 'set-shadow',
          role: recommendation.role,
          variantId: recommendation.variantId,
          replacedVariantId: roleState.activeVariantId,
          rationale: `Improvement ${improvement.toFixed(3)} over active variant ${roleState.activeVariantId}`,
        });
      }
    }
  }

  if (input.autoRollbackActives) {
    for (const roleState of Object.values(policy.roles)) {
      if (shouldRollbackActiveVariant({
        roleState,
        scores: input.scores,
        taskShape: input.taskShape,
      })) {
        rollbackActiveVariant(policy, roleState, input.scores, input.taskShape);
      }
    }
  }

  return policy;
}

export function shouldPromoteShadowVariant(input: {
  roleState: PromptRolePolicy;
  scores: PromptVariantScore[];
  taskShape: string;
}): boolean {
  if (!input.roleState.activeVariantId || !input.roleState.shadowVariantId) {
    return false;
  }

  const activeScore = input.scores.find((item) =>
    item.taskShape === input.taskShape
    && item.role === input.roleState.role
    && item.variantId === input.roleState.activeVariantId,
  );
  const shadowScore = input.scores.find((item) =>
    item.taskShape === input.taskShape
    && item.role === input.roleState.role
    && item.variantId === input.roleState.shadowVariantId,
  );
  if (!shadowScore) {
    return false;
  }

  return (
    shadowScore.runs >= input.roleState.thresholds.minRunsForCandidate
    && shadowScore.validationRate >= input.roleState.thresholds.minValidationRateForPromotion
    && shadowScore.averageScore - (activeScore?.averageScore ?? 0)
      >= input.roleState.thresholds.minImprovementForPromotion
  );
}

export function promoteShadowVariant(
  policy: PromptPolicyState,
  roleState: PromptRolePolicy,
  scores: PromptVariantScore[],
  taskShape: string,
): PromptPolicyState {
  if (!roleState.shadowVariantId || !roleState.activeVariantId) {
    return policy;
  }

  const activeVariantId = roleState.activeVariantId;
  const promotedVariantId = roleState.shadowVariantId;
  const promotedScore = scores.find((item) =>
    item.taskShape === taskShape
    && item.role === roleState.role
    && item.variantId === promotedVariantId,
  );
  roleState.activeVariantId = promotedVariantId;
  roleState.shadowVariantId = undefined;
  roleState.candidateVariantIds = roleState.candidateVariantIds.filter((item) => item !== promotedVariantId);
  roleState.retiredVariantIds = dedupe([
    ...roleState.retiredVariantIds,
    activeVariantId,
  ]);
  roleState.updatedAt = new Date().toISOString();
  roleState.history.push({
    at: roleState.updatedAt,
    action: 'promote-shadow',
    role: roleState.role,
    variantId: promotedVariantId,
    replacedVariantId: activeVariantId,
    rationale: promotedScore
      ? `Shadow variant promoted with score ${promotedScore.averageScore.toFixed(3)}`
      : 'Shadow variant promoted',
  });

  return policy;
}

export function shouldRollbackActiveVariant(input: {
  roleState: PromptRolePolicy;
  scores: PromptVariantScore[];
  taskShape: string;
}): boolean {
  const rollbackCandidateId = getRollbackCandidateVariantId(input.roleState);
  if (!rollbackCandidateId || !input.roleState.activeVariantId) {
    return false;
  }

  const activeScore = input.scores.find((item) =>
    item.taskShape === input.taskShape
    && item.role === input.roleState.role
    && item.variantId === input.roleState.activeVariantId,
  );
  const rollbackScore = input.scores.find((item) =>
    item.taskShape === input.taskShape
    && item.role === input.roleState.role
    && item.variantId === rollbackCandidateId,
  );

  if (!activeScore || !rollbackScore) {
    return false;
  }

  return (
    activeScore.runs >= input.roleState.thresholds.minRunsForRollbackCheck
    && rollbackScore.runs >= input.roleState.thresholds.minRunsForRollbackCheck
    && (
      activeScore.validationRate < input.roleState.thresholds.minValidationRateBeforeRollback
      || rollbackScore.averageScore - activeScore.averageScore
        >= input.roleState.thresholds.maxAverageScoreDropBeforeRollback
    )
  );
}

export function rollbackActiveVariant(
  policy: PromptPolicyState,
  roleState: PromptRolePolicy,
  scores: PromptVariantScore[],
  taskShape: string,
): PromptPolicyState {
  const rollbackCandidateId = getRollbackCandidateVariantId(roleState);
  if (!rollbackCandidateId || !roleState.activeVariantId) {
    return policy;
  }

  const activeVariantId = roleState.activeVariantId;
  const rollbackScore = scores.find((item) =>
    item.taskShape === taskShape
    && item.role === roleState.role
    && item.variantId === rollbackCandidateId,
  );
  const activeScore = scores.find((item) =>
    item.taskShape === taskShape
    && item.role === roleState.role
    && item.variantId === activeVariantId,
  );

  roleState.activeVariantId = rollbackCandidateId;
  roleState.shadowVariantId = undefined;
  roleState.retiredVariantIds = dedupe(
    roleState.retiredVariantIds.filter((variantId) => variantId !== rollbackCandidateId)
      .concat(activeVariantId),
  );
  roleState.updatedAt = new Date().toISOString();
  roleState.history.push({
    at: roleState.updatedAt,
    action: 'rollback',
    role: roleState.role,
    variantId: rollbackCandidateId,
    replacedVariantId: activeVariantId,
    rationale: rollbackScore && activeScore
      ? `Rolled back after active score ${activeScore.averageScore.toFixed(3)} and validation ${activeScore.validationRate.toFixed(3)} fell behind ${rollbackCandidateId} at ${rollbackScore.averageScore.toFixed(3)}`
      : 'Rolled back to prior active variant',
  });

  return policy;
}

export function exportPromptDatasetRowsAsJsonl(rows: PromptDatasetRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

export async function writePromptDatasetJsonl(path: string, rows: PromptDatasetRow[]): Promise<string> {
  await writeText(path, exportPromptDatasetRowsAsJsonl(rows));
  return path;
}

export class FilesystemOptimizationStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async writeSnapshot(snapshot: PromptOptimizationSnapshot, name = 'latest'): Promise<string> {
    const dir = join(this.root, name);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'prompt-optimization.json');
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    return path;
  }
}

export class AxPromptOptimizerAdapter implements PromptOptimizerAdapter {
  public readonly name = 'ax-prompt-optimizer';

  constructor(private readonly options: AxPromptOptimizerAdapterOptions) {}

  async run(context: PromptOptimizerAdapterContext): Promise<PromptOptimizerAdapterResult> {
    const roles = dedupe(
      context.rows.flatMap((row) => Object.keys(row.promptVariantIds)),
    );
    const recommendations: PromptRecommendation[] = [];

    for (const role of roles) {
      const roleRows = context.rows.filter((row) => row.promptVariantIds[role]);
      const variantIds = dedupe(roleRows.map((row) => row.promptVariantIds[role] as string));
      if (variantIds.length < 2 || roleRows.length < 6) {
        continue;
      }

      const training = roleRows.map((row) => ({
        taskGoal: row.taskGoal,
        taskShape: row.taskShape,
        environmentKind: row.environmentKind ?? 'unknown',
        roundCount: String(row.roundCount),
        repairCount: String(row.repairCount),
        evidenceCount: String(row.evidenceCount),
        variantId: row.promptVariantIds[role] as string,
      }));
      const splitIndex = Math.max(1, Math.floor(training.length * 0.8));
      const train = training.slice(0, splitIndex);
      const validation = training.slice(splitIndex);
      if (validation.length === 0) {
        continue;
      }

      const selector = ax(
        `taskGoal:string, taskShape:string, environmentKind:string, roundCount:string, repairCount:string, evidenceCount:string -> variantId:class "${variantIds.join(', ')}", rationale:string`,
        {
          description: `Choose the best ${role} prompt variant for a Foreman task.`,
        },
      );
      const optimizer = new (await import('@ax-llm/ax')).AxGEPA({
        studentAI: createAxService({
          provider: this.options.provider,
          apiKey: this.options.apiKey,
          model: this.options.model,
        }),
        teacherAI: createAxService({
          provider: this.options.provider,
          apiKey: this.options.apiKey,
          model: this.options.teacherModel ?? this.options.model,
        }),
        numTrials: 8,
        minibatch: true,
        minibatchSize: 4,
        earlyStoppingTrials: 3,
        sampleCount: 1,
      });

      const result = await optimizer.compile(
        selector,
        train,
        (({ prediction, example }: any) =>
          prediction?.variantId === example?.variantId ? 1 : 0) as any,
        {
          validationExamples: validation,
          maxMetricCalls: 64,
        },
      );
      selector.applyOptimization(result.optimizedProgram!);

      const bestObserved = context.scores.find((score) =>
        score.taskShape === context.policy.taskShape
        && score.role === role,
      );
      if (!bestObserved) {
        continue;
      }

      const prediction = await selector.forward(
        createAxService({
          provider: this.options.provider,
          apiKey: this.options.apiKey,
          model: this.options.model,
        }),
        {
          taskGoal: bestObserved.taskShape,
          taskShape: bestObserved.taskShape,
          environmentKind: roleRows[0]?.environmentKind ?? 'unknown',
          roundCount: '1',
          repairCount: '0',
          evidenceCount: '3',
        },
      );

      if (prediction?.variantId && variantIds.includes(prediction.variantId)) {
        recommendations.push({
          role,
          taskShape: context.policy.taskShape,
          variantId: prediction.variantId,
          averageScore: result.bestScore,
          rationale: `Ax selector optimized with GEPA across ${training.length} examples.`,
        });
      }
    }

    return {
      recommendations: recommendations.slice(0, this.options.maxRecommendations ?? recommendations.length),
      metadata: {
        provider: this.options.provider,
        model: this.options.model,
      },
    };
  }
}

export async function runPromptOptimizationJob(input: {
  traceStore: TraceStore;
  outputRoot: string;
  policyRoot?: string;
  taskId?: string;
  taskShape?: string;
  config?: PromptOptimizerConfig;
  adapter?: PromptOptimizerAdapter;
}): Promise<{
  rows: number;
  scoreCount: number;
  recommendationCount: number;
  outputPath: string;
  policyPath: string;
  datasetJsonlPath?: string;
}> {
  const rows = await buildPromptDataset(input.traceStore, input.taskId);
  const filteredRows = input.taskShape
    ? rows.filter((row) => row.taskShape === input.taskShape)
    : rows;
  const taskShape = input.taskShape ?? filteredRows[0]?.taskShape ?? 'unknown';
  const scores = rankPromptVariants(filteredRows, input.config);
  const heuristics = recommendPromptVariants(scores);
  const policyStore = new FilesystemPromptPolicyStore(
    input.policyRoot ?? join(input.outputRoot, 'policies'),
  );
  const existingPolicy = await policyStore.get(taskShape);
  let policy = updatePromptPolicy({
    policy: existingPolicy,
    taskShape,
    scores,
    recommendations: heuristics,
    thresholds: input.config?.thresholds,
    autoPromoteShadows: input.config?.autoPromoteShadows,
  });

  let adapterInfo: PromptOptimizationSnapshot['adapter'];
  let recommendations = heuristics;
  if (input.adapter) {
    const adapterResult = await input.adapter.run({
      taskShape,
      rows: filteredRows,
      scores,
      policy,
    });
    recommendations = dedupeRecommendations([
      ...heuristics,
      ...(adapterResult.recommendations ?? []),
    ]);
    policy = updatePromptPolicy({
      policy,
      taskShape,
      scores,
      recommendations,
      thresholds: input.config?.thresholds,
      autoPromoteShadows: input.config?.autoPromoteShadows,
      autoRollbackActives: input.config?.autoRollbackActives,
    });
    adapterInfo = {
      name: input.adapter.name,
      result: adapterResult.metadata,
    };
  }

  const policyPath = await policyStore.put(policy);
  let datasetJsonlPath: string | undefined;
  if (input.config?.exportDatasetJsonl) {
    datasetJsonlPath = await writePromptDatasetJsonl(
      join(input.outputRoot, 'latest', 'prompt-dataset.jsonl'),
      filteredRows,
    );
  }

  const store = new FilesystemOptimizationStore(input.outputRoot);
  const outputPath = await store.writeSnapshot({
    generatedAt: new Date().toISOString(),
    taskShape,
    rows: filteredRows,
    scores,
    recommendations,
    policy,
    exports: {
      datasetJsonlPath,
    },
    adapter: adapterInfo,
  });

  return {
    rows: filteredRows.length,
    scoreCount: scores.length,
    recommendationCount: recommendations.length,
    outputPath,
    policyPath,
    datasetJsonlPath,
  };
}

function ensureRolePolicy(
  policy: PromptPolicyState,
  role: string,
  thresholds?: Partial<PromptPolicyThresholds>,
): PromptRolePolicy {
  if (!policy.roles[role]) {
    policy.roles[role] = {
      role,
      candidateVariantIds: [],
      retiredVariantIds: [],
      thresholds: mergeThresholds(thresholds),
      history: [],
    };
  }
  return policy.roles[role] as PromptRolePolicy;
}

function mergeThresholds(overrides?: Partial<PromptPolicyThresholds>): PromptPolicyThresholds {
  return {
    minRunsForCandidate: overrides?.minRunsForCandidate ?? 3,
    minAverageScoreForCandidate: overrides?.minAverageScoreForCandidate ?? 0.55,
    minImprovementForPromotion: overrides?.minImprovementForPromotion ?? 0.05,
    minValidationRateForPromotion: overrides?.minValidationRateForPromotion ?? 0.7,
    minRunsForRollbackCheck: overrides?.minRunsForRollbackCheck ?? 3,
    maxAverageScoreDropBeforeRollback: overrides?.maxAverageScoreDropBeforeRollback ?? 0.08,
    minValidationRateBeforeRollback: overrides?.minValidationRateBeforeRollback ?? 0.55,
  };
}

function dedupeRecommendations(recommendations: PromptRecommendation[]): PromptRecommendation[] {
  const seen = new Set<string>();
  const deduped: PromptRecommendation[] = [];
  for (const recommendation of recommendations) {
    const key = `${recommendation.taskShape}::${recommendation.role}::${recommendation.variantId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(recommendation);
  }
  return deduped;
}

function extractPromptVariantIds(metadata?: Record<string, string>): Record<string, string> {
  if (!metadata) {
    return {};
  }

  const entries = Object.entries(metadata).flatMap(([key, value]) => {
    if (!key.endsWith('PromptVariantId')) {
      return [];
    }
    const role = key.replace(/PromptVariantId$/, '').replace(/^[A-Z]/, (s) => s.toLowerCase());
    return [[role, value] as const];
  });
  return Object.fromEntries(entries);
}

function normalizePromptPolicyMode(value: string | undefined): 'active' | 'shadow' | 'explicit' {
  return value === 'active' || value === 'shadow' || value === 'explicit' ? value : 'explicit';
}

function createAxService(input: {
  provider: 'openai' | 'anthropic';
  apiKey: string;
  model: string;
}) {
  const config = {
    name: input.provider,
    apiKey: input.apiKey,
    config: {
      model: input.model,
    },
  };

  return ai(config as AxAIArgs<string>);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatRate(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function getRollbackCandidateVariantId(roleState: PromptRolePolicy): string | undefined {
  const latestPromotion = [...roleState.history]
    .reverse()
    .find((entry) =>
      (entry.action === 'promote-shadow' || entry.action === 'set-active')
      && entry.replacedVariantId,
    );
  return latestPromotion?.replacedVariantId;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
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

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}
