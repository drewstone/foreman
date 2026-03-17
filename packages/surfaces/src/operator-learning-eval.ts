import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createMemoryStore } from '@drew/foreman-memory';
import { FilesystemProfileStore } from '@drew/foreman-profiles';

export interface OperatorLearningEvalOptions {
  profileId: string;
  userId?: string;
  profileRoot: string;
  memoryRoot: string;
  outputPath?: string;
  markdownPath?: string;
}

export interface OperatorLearningEvalResult {
  profileId: string;
  summary: string;
  score: number;
  strengths: string[];
  gaps: string[];
  metrics: Record<string, number>;
  outputPath?: string;
  markdownPath?: string;
}

export async function runOperatorLearningEval(
  options: OperatorLearningEvalOptions,
): Promise<OperatorLearningEvalResult> {
  const profileStore = new FilesystemProfileStore(resolve(options.profileRoot));
  const memoryStore = await createMemoryStore({
    rootDir: resolve(options.memoryRoot),
  });

  const [profileRecord, profileMemory, userMemory] = await Promise.all([
    profileStore.get(options.profileId),
    memoryStore.getProfileMemory(options.profileId),
    options.userId ? memoryStore.getUserMemory(options.userId) : Promise.resolve(null),
  ]);

  const metrics = {
    profilePreferredWorkers: profileRecord?.profile.preferredWorkers?.length ?? 0,
    profilePreferredCapabilities: profileRecord?.profile.preferredCapabilities?.length ?? 0,
    workerPreferences: profileMemory?.workerPreferences?.length ?? 0,
    evaluationStyles: profileMemory?.evaluationStyle?.length ?? 0,
    operatorPatterns: profileMemory?.operatorPatterns?.length ?? 0,
    goalPatterns: profileMemory?.goalPatterns?.length ?? 0,
    workflowImprovements: profileMemory?.workflowImprovements?.length ?? 0,
    skillOrToolingImprovements: profileMemory?.skillOrToolingImprovements?.length ?? 0,
    userPreferences: userMemory?.preferences?.length ?? 0,
    favoredWorkers: userMemory?.favoredWorkers?.length ?? 0,
    recurringEnvironments: userMemory?.recurringEnvironments?.length ?? 0,
    escalationHabits: userMemory?.escalationHabits?.length ?? 0,
  };

  const strengths: string[] = [];
  const gaps: string[] = [];

  if (metrics.operatorPatterns >= 4) {
    strengths.push('Captured concrete operator steering patterns from prior sessions.');
  } else {
    gaps.push('Operator steering patterns are still sparse.');
  }

  if (metrics.goalPatterns >= 4) {
    strengths.push('Captured recurring goal clusters across repos and domains.');
  } else {
    gaps.push('Goal patterns are still too shallow.');
  }

  if (metrics.workflowImprovements >= 3) {
    strengths.push('Produced actionable workflow improvements rather than only summaries.');
  } else {
    gaps.push('Workflow improvement recommendations need more depth.');
  }

  if (metrics.favoredWorkers >= 2 && metrics.recurringEnvironments >= 2) {
    strengths.push('Learned worker and environment preferences that can shape runtime behavior.');
  } else {
    gaps.push('Worker/environment preference learning is not yet strong enough.');
  }

  if (metrics.profilePreferredCapabilities === 0) {
    gaps.push('Preferred capability learning is still missing; the profile does not yet express stable capability bias.');
  }

  if (metrics.operatorPatterns > 12 || metrics.goalPatterns > 12) {
    gaps.push('Learned memory is getting dense enough that freshness and ranking will matter; counts alone should not drive runtime decisions.');
  }

  if (metrics.skillOrToolingImprovements >= 2) {
    strengths.push('Tooling and harness improvement ideas are being retained.');
  } else {
    gaps.push('Tooling improvement extraction is still weak.');
  }

  const rawScore = (
    Math.min(metrics.operatorPatterns, 6) * 8
    + Math.min(metrics.goalPatterns, 6) * 7
    + Math.min(metrics.workflowImprovements, 5) * 6
    + Math.min(metrics.skillOrToolingImprovements, 5) * 5
    + Math.min(metrics.favoredWorkers, 4) * 5
    + Math.min(metrics.recurringEnvironments, 6) * 4
    + Math.min(metrics.evaluationStyles, 4) * 4
    + Math.min(metrics.workerPreferences, 5) * 3
    + Math.min(metrics.profilePreferredCapabilities, 3) * 4
  );
  const penalties = (
    (metrics.profilePreferredCapabilities === 0 ? 8 : 0)
    + ((metrics.operatorPatterns > 12 || metrics.goalPatterns > 12) ? 6 : 0)
    + (gaps.length > strengths.length ? 8 : 0)
  );
  const uncappedScore = Math.max(0, Math.min(100, rawScore - penalties));
  const score = gaps.length > 0
    ? Math.min(uncappedScore, Math.max(55, 96 - gaps.length * 6))
    : uncappedScore;

  const summary = score >= 80
    ? 'Operator learning looks strong enough to be useful now, though it still needs broader runtime adaptation.'
    : score >= 60
      ? 'Operator learning is materially useful but still partial; it has real signal, not yet full coverage.'
      : 'Operator learning is still too thin to trust without more source coverage.';

  const result: OperatorLearningEvalResult = {
    profileId: options.profileId,
    summary,
    score,
    strengths,
    gaps,
    metrics,
  };

  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    result.outputPath = outputPath;
  }

  if (options.markdownPath) {
    const markdownPath = resolve(options.markdownPath);
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, renderOperatorLearningEvalMarkdown(result), 'utf8');
    result.markdownPath = markdownPath;
  }

  return result;
}

function renderOperatorLearningEvalMarkdown(result: OperatorLearningEvalResult): string {
  const lines = [
    '# Foreman Operator Learning Eval',
    '',
    `- Profile: ${result.profileId}`,
    `- Score: ${result.score}/100`,
    '',
    result.summary,
    '',
    '## Strengths',
    ...(result.strengths.length > 0 ? result.strengths.map((item) => `- ${item}`) : ['- None']),
    '',
    '## Gaps',
    ...(result.gaps.length > 0 ? result.gaps.map((item) => `- ${item}`) : ['- None']),
    '',
    '## Metrics',
    ...Object.entries(result.metrics).map(([key, value]) => `- ${key}: ${value}`),
  ];
  return `${lines.join('\n')}\n`;
}
