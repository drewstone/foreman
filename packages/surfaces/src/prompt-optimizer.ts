import { basename, join, resolve } from 'node:path';

import {
  AxPromptOptimizerAdapter,
  runPromptOptimizationJob,
} from '@drew/foreman-optimizer';
import { FilesystemTraceStore } from '@drew/foreman-tracing';

export interface PromptOptimizerSidecarOptions {
  traceRoot: string;
  outputRoot?: string;
  policyRoot?: string;
  taskId?: string;
  taskShape?: string;
  minimumRunsPerVariant?: number;
  exportDatasetJsonl?: boolean;
  autoPromoteShadows?: boolean;
  autoRollbackActives?: boolean;
  adapter?: 'heuristic' | 'ax';
  axProvider?: 'openai' | 'anthropic';
  axModel?: string;
  axTeacherModel?: string;
  axApiKeyEnv?: string;
}

export interface PromptOptimizerSidecarResult {
  outputPath: string;
  policyPath: string;
  rows: number;
  scoreCount: number;
  recommendationCount: number;
  datasetJsonlPath?: string;
}

export async function runPromptOptimizerSidecar(
  options: PromptOptimizerSidecarOptions,
): Promise<PromptOptimizerSidecarResult> {
  const traceRoot = resolve(options.traceRoot);
  const outputRoot = resolve(
    options.outputRoot ?? join(traceRoot, '..', 'optimizer', basename(traceRoot)),
  );
  const traceStore = new FilesystemTraceStore(traceRoot);
  const adapter = options.adapter === 'ax'
    ? buildAxAdapter(options)
    : undefined;

  return runPromptOptimizationJob({
    traceStore,
    outputRoot,
    policyRoot: options.policyRoot,
    taskId: options.taskId,
    taskShape: options.taskShape,
    config: {
      minimumRunsPerVariant: options.minimumRunsPerVariant,
      exportDatasetJsonl: options.exportDatasetJsonl,
      autoPromoteShadows: options.autoPromoteShadows,
      autoRollbackActives: options.autoRollbackActives,
    },
    adapter,
  });
}

function buildAxAdapter(options: PromptOptimizerSidecarOptions): AxPromptOptimizerAdapter {
  const apiKeyEnv = options.axApiKeyEnv ?? (
    options.axProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
  );
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`missing API key in env var ${apiKeyEnv}`);
  }

  return new AxPromptOptimizerAdapter({
    provider: options.axProvider ?? 'openai',
    apiKey,
    model: options.axModel ?? 'gpt-4.1-mini',
    teacherModel: options.axTeacherModel,
  });
}
