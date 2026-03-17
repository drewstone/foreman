import { resolve } from 'node:path';

import { FilesystemTraceStore } from '@drew/foreman-tracing';

import { runEngineeringForeman, type EngineeringForemanRunResult } from './engineering-foreman.js';

export interface EngineeringReplayOptions {
  traceRoot: string;
  traceId: string;
  artifactsRoot?: string;
  traceOutputRoot?: string;
  memoryRoot?: string;
  promptPolicyRoot?: string;
  promptPolicyMode?: 'active' | 'shadow' | 'explicit';
  promptVariantIds?: Partial<Record<'hardener' | 'implementer' | 'reviewer', string>>;
  maxRounds?: number;
}

export interface EngineeringReplayResult {
  sourceTraceId: string;
  replay: EngineeringForemanRunResult;
}

export async function runEngineeringReplay(
  options: EngineeringReplayOptions,
): Promise<EngineeringReplayResult> {
  const traceStore = new FilesystemTraceStore(resolve(options.traceRoot));
  const bundle = await traceStore.get(options.traceId);
  if (!bundle) {
    throw new Error(`trace ${options.traceId} not found`);
  }

  const repoPath = bundle.metadata?.repoPath;
  if (!repoPath) {
    throw new Error(`trace ${options.traceId} is missing repoPath metadata`);
  }

  const replay = await runEngineeringForeman({
    repoPath,
    goal: bundle.metadata?.originalGoal ?? bundle.task.goal,
    successCriteria: parseStringArray(bundle.metadata?.successCriteriaJson),
    checkCommands: parseStringArray(bundle.metadata?.checkCommandsJson),
    toolCommands: parseStringArray(bundle.metadata?.toolCommandsJson),
    artifactsRoot: options.artifactsRoot,
    traceRoot: options.traceOutputRoot,
    memoryRoot: options.memoryRoot,
    promptPolicyRoot: options.promptPolicyRoot,
    promptPolicyMode: options.promptPolicyMode ?? normalizePromptPolicyMode(bundle.metadata?.promptPolicyMode),
    promptVariantIds: {
      hardener: options.promptVariantIds?.hardener ?? bundle.metadata?.hardenerPromptVariantId,
      implementer: options.promptVariantIds?.implementer ?? bundle.metadata?.implementationPromptVariantId,
      reviewer: options.promptVariantIds?.reviewer ?? bundle.metadata?.reviewPromptVariantId,
    },
    maxRounds: options.maxRounds,
    taskId: `${bundle.task.id}-replay`,
  });

  return {
    sourceTraceId: options.traceId,
    replay,
  };
}

function parseStringArray(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalizePromptPolicyMode(value: string | undefined): 'active' | 'shadow' | 'explicit' {
  return value === 'active' || value === 'shadow' || value === 'explicit' ? value : 'explicit';
}
