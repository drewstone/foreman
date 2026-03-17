import { resolve } from 'node:path';

import {
  createMemoryStore,
  type ProfileMemory,
  type StrategyMemory,
  type UserMemory,
  type WorkerPerformanceMemory,
} from '@drew/foreman-memory';
import { FilesystemProfileStore, type StoredForemanProfile } from '@drew/foreman-profiles';

export interface OperatorRuntimeContext {
  profileRecord: StoredForemanProfile | null;
  profileMemory: ProfileMemory | null;
  userMemory: UserMemory | null;
  workerMemoryById: Record<string, WorkerPerformanceMemory | null>;
  strategyMemoryByTaskShape: Record<string, StrategyMemory | null>;
}

export interface OperatorPreferenceTarget {
  providerOrWorker?: string;
  capability?: string;
  taskShape?: string;
  environmentHints?: string[];
  text?: string;
}

export interface OperatorPreferenceScore {
  score: number;
  reasons: string[];
}

export async function loadOperatorRuntimeContext(input: {
  profileId?: string;
  userId?: string;
  profileRoot?: string;
  memoryRoot?: string;
  workerIds?: string[];
  taskShapes?: string[];
}): Promise<OperatorRuntimeContext | null> {
  if (!input.profileId || !input.memoryRoot) {
    return null;
  }

  const memoryStore = await createMemoryStore({
    rootDir: resolve(input.memoryRoot),
  });
  const profileStore = input.profileRoot
    ? new FilesystemProfileStore(resolve(input.profileRoot))
    : null;

  const workerIds = uniqueValues(input.workerIds ?? []);
  const taskShapes = uniqueValues(input.taskShapes ?? []);
  const [profileRecord, profileMemory, userMemory, workerMemories, strategyMemories] = await Promise.all([
    profileStore?.get(input.profileId) ?? Promise.resolve(null),
    memoryStore.getProfileMemory(input.profileId),
    input.userId ? memoryStore.getUserMemory(input.userId) : Promise.resolve(null),
    Promise.all(workerIds.map(async (workerId) => [workerId, await memoryStore.getWorkerMemory(workerId)] as const)),
    Promise.all(taskShapes.map(async (taskShape) => [taskShape, await memoryStore.getStrategyMemory(taskShape)] as const)),
  ]);

  if (!profileRecord && !profileMemory && !userMemory && workerMemories.length === 0 && strategyMemories.length === 0) {
    return null;
  }

  return {
    profileRecord,
    profileMemory,
    userMemory,
    workerMemoryById: Object.fromEntries(workerMemories),
    strategyMemoryByTaskShape: Object.fromEntries(strategyMemories),
  };
}

export function scoreOperatorPreference(
  target: OperatorPreferenceTarget,
  context: OperatorRuntimeContext | null,
): OperatorPreferenceScore {
  if (!context) {
    return { score: 0, reasons: [] };
  }

  const reasons: string[] = [];
  let score = 0;

  const preferredWorkers = uniqueValues([
    ...(context.profileRecord?.profile.preferredWorkers ?? []),
    ...(context.profileMemory?.workerPreferences ?? []),
    ...(context.userMemory?.favoredWorkers ?? []),
  ]);
  const preferredCapabilities = uniqueValues(context.profileRecord?.profile.preferredCapabilities ?? []);
  const recurringEnvironments = uniqueValues(context.userMemory?.recurringEnvironments ?? []);
  const operatorPatterns = uniqueValues([
    ...(context.profileMemory?.operatorPatterns ?? []),
    ...(context.userMemory?.operatorPatterns ?? []),
  ]);
  const goalPatterns = uniqueValues([
    ...(context.profileMemory?.goalPatterns ?? []),
    ...(context.userMemory?.goalPatterns ?? []),
  ]);

  const providerOrWorker = target.providerOrWorker;
  if (providerOrWorker && preferredWorkers.some((item) => looselyMatches(providerOrWorker, item))) {
    score += 2.5;
    reasons.push(`matches favored worker/provider ${providerOrWorker}`);
  }

  const workerMemory = providerOrWorker ? context.workerMemoryById[providerOrWorker] : null;
  if (workerMemory?.successRate !== undefined) {
    const performanceDelta = Number(((workerMemory.successRate - 0.5) * 3).toFixed(2));
    if (Math.abs(performanceDelta) >= 0.15) {
      score += performanceDelta;
      reasons.push(
        performanceDelta > 0
          ? `worker performance favors ${providerOrWorker} (${Math.round(workerMemory.successRate * 100)}% success)`
          : `worker performance penalizes ${providerOrWorker} (${Math.round(workerMemory.successRate * 100)}% success)`,
      );
    }
  }

  const capability = target.capability;
  if (capability && preferredCapabilities.some((item) => looselyMatches(capability, item))) {
    score += 2;
    reasons.push(`matches preferred capability ${capability}`);
  }

  const matchedEnvironments = recurringEnvironments
    .filter((item) => target.environmentHints?.some((hint) => looselyMatches(hint, item)))
    .slice(0, 2);
  if (matchedEnvironments.length > 0) {
    score += matchedEnvironments.length * 1.5;
    reasons.push(`matches recurring environment ${matchedEnvironments.join(', ')}`);
  }

  const operatorPatternMatches = matchedPatterns(operatorPatterns, target.text).slice(0, 2);
  const positiveOperatorPatterns = operatorPatternMatches.filter((pattern) => !isNegativePattern(pattern));
  const negativeOperatorPatterns = operatorPatternMatches.filter((pattern) => isNegativePattern(pattern));
  if (positiveOperatorPatterns.length > 0) {
    score += positiveOperatorPatterns.length * 0.9;
    reasons.push(`matches operator pattern ${positiveOperatorPatterns.join(', ')}`);
  }
  if (negativeOperatorPatterns.length > 0) {
    score -= negativeOperatorPatterns.length * 1.25;
    reasons.push(`conflicts with operator pattern ${negativeOperatorPatterns.join(', ')}`);
  }

  const goalPatternMatches = matchedPatterns(goalPatterns, target.text).slice(0, 2);
  const positiveGoalPatterns = goalPatternMatches.filter((pattern) => !isNegativePattern(pattern));
  const negativeGoalPatterns = goalPatternMatches.filter((pattern) => isNegativePattern(pattern));
  if (positiveGoalPatterns.length > 0) {
    score += positiveGoalPatterns.length * 0.9;
    reasons.push(`matches recurring goal ${positiveGoalPatterns.join(', ')}`);
  }
  if (negativeGoalPatterns.length > 0) {
    score -= negativeGoalPatterns.length * 1.25;
    reasons.push(`conflicts with recurring goal ${negativeGoalPatterns.join(', ')}`);
  }

  const strategyMemory = target.taskShape ? context.strategyMemoryByTaskShape[target.taskShape] : null;
  const successfulStrategyMatches = matchedPatterns(strategyMemory?.successfulPatterns ?? [], target.text).slice(0, 2);
  if (successfulStrategyMatches.length > 0) {
    score += successfulStrategyMatches.length * 1.1;
    reasons.push(`matches successful ${target.taskShape} strategy ${successfulStrategyMatches.join(', ')}`);
  }
  const badStrategyMatches = matchedPatterns(strategyMemory?.badPatterns ?? [], target.text).slice(0, 2);
  if (badStrategyMatches.length > 0) {
    score -= badStrategyMatches.length * 1.2;
    reasons.push(`conflicts with known ${target.taskShape} strategy ${badStrategyMatches.join(', ')}`);
  }

  return {
    score: Number(score.toFixed(2)),
    reasons,
  };
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function looselyMatches(left: string, right: string): boolean {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

function matchedPatterns(patterns: string[], text?: string): string[] {
  if (!text) {
    return [];
  }

  return patterns.filter((pattern) => patternMatches(pattern, text));
}

function patternMatches(pattern: string, text: string): boolean {
  const normalizedPattern = normalizeText(pattern);
  const normalizedText = normalizeText(text);
  if (!normalizedPattern || !normalizedText) {
    return false;
  }

  if (normalizedPattern.length >= 16 && normalizedText.includes(normalizedPattern)) {
    return true;
  }

  const patternTokens = significantTokens(normalizedPattern);
  const textTokens = significantTokens(normalizedText);
  if (patternTokens.length < 2 || textTokens.length < 2) {
    return false;
  }

  const overlap = patternTokens.filter((token) => textTokens.includes(token));
  return overlap.length >= 2;
}

function significantTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9/._ -]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isNegativePattern(value: string): boolean {
  return /\b(not trusted|benchmark noise|avoid|do not|dont|don't|not preferred|low trust|noise)\b/i.test(value);
}
