import {
  FilesystemDocumentEnvironment,
  GitCodeEnvironment,
  HybridEnvironment,
  ResearchCorpusEnvironment,
  ServiceEnvironment,
  type EnvironmentAdapter,
} from '@drew/foreman-environments';
import { basename, resolve } from 'node:path';

export type ObservableEnvironmentKind =
  | 'code'
  | 'document'
  | 'research'
  | 'ops'
  | 'hybrid';

export interface ObserveEnvironmentOptions {
  kind: ObservableEnvironmentKind;
  target?: string;
  targets?: string[];
  healthUrls?: string[];
  checkCommands?: string[];
  verifyGoal?: string;
}

export interface ObserveEnvironmentResult {
  kind: ObservableEnvironmentKind;
  target?: string;
  summary: string;
  verificationSummary?: string;
  evidence: Array<{
    kind: string;
    label: string;
    value: string;
    uri?: string;
    metadata?: Record<string, string>;
  }>;
  verificationEvidence?: Array<{
    kind: string;
    label: string;
    value: string;
    uri?: string;
    metadata?: Record<string, string>;
  }>;
  state?: unknown;
}

export async function runObserveEnvironment(
  options: ObserveEnvironmentOptions,
): Promise<ObserveEnvironmentResult> {
  const adapter = createAdapter(options);
  const observation = await adapter.observe();
  const verification = options.verifyGoal && adapter.verify
    ? await adapter.verify(options.verifyGoal)
    : undefined;

  return {
    kind: options.kind,
    target: adapter.environment.target,
    summary: observation.summary,
    verificationSummary: verification?.summary,
    evidence: observation.evidence ?? [],
    verificationEvidence: verification?.evidence ?? [],
    state: observation.state,
  };
}

function createAdapter(options: ObserveEnvironmentOptions): EnvironmentAdapter {
  if (options.kind === 'code') {
    if (!options.target) {
      throw new Error('code environment requires --target');
    }
    return new GitCodeEnvironment(resolve(options.target));
  }

  if (options.kind === 'document') {
    if (!options.target) {
      throw new Error('document environment requires --target');
    }
    return new FilesystemDocumentEnvironment(resolve(options.target));
  }

  if (options.kind === 'research') {
    if (!options.target) {
      throw new Error('research environment requires --target');
    }
    return new ResearchCorpusEnvironment(resolve(options.target));
  }

  if (options.kind === 'ops') {
    return new ServiceEnvironment(options.target ?? 'service-environment', {
      healthUrls: options.healthUrls,
      checkCommands: options.checkCommands,
      cwd: options.target ? resolve(options.target) : process.cwd(),
    });
  }

  const targets = options.targets?.length ? options.targets : options.target ? [options.target] : [];
  if (targets.length === 0) {
    throw new Error('hybrid environment requires at least one --target');
  }

  const adapters = targets.map((target) => inferHybridAdapter(target, options));
  return new HybridEnvironment(adapters);
}

function inferHybridAdapter(target: string, options: ObserveEnvironmentOptions): EnvironmentAdapter {
  const resolved = resolve(target);
  if (target.startsWith('http://') || target.startsWith('https://')) {
    return new ServiceEnvironment(target, {
      healthUrls: [target],
      checkCommands: options.checkCommands,
      cwd: process.cwd(),
    });
  }
  const base = basename(resolved);
  if (
    resolved.endsWith('.md')
    || resolved.endsWith('.pdf')
    || resolved.endsWith('/docs')
    || resolved.includes('/docs/')
    || base === 'examples'
    || resolved.includes('/examples/')
    || base === 'research'
    || resolved.includes('/research/')
  ) {
    return new FilesystemDocumentEnvironment(resolved);
  }
  return new GitCodeEnvironment(resolved);
}
