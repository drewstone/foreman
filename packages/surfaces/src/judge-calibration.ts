import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createClaudeProvider, createCodexProvider, parseJsonOutput, type TextProvider } from '@drew/foreman-providers';

type JudgeStatus = 'pass' | 'warn' | 'fail';
type JudgeRecommendation = 'complete' | 'repair' | 'escalate' | 'abort';

export interface JudgeCalibrationCase {
  id: string;
  input: {
    task: string;
    evidence?: string[];
    findings?: Array<{
      severity?: string;
      title?: string;
      body?: string;
    }>;
  };
  expected: {
    status: JudgeStatus;
    recommendation: JudgeRecommendation;
  };
}

export interface JudgeCalibrationDataset {
  id: string;
  summary?: string;
  cases: JudgeCalibrationCase[];
}

export interface JudgeCalibrationCaseResult {
  id: string;
  expected: JudgeCalibrationCase['expected'];
  actual: {
    status: JudgeStatus;
    recommendation: JudgeRecommendation;
    summary: string;
  };
  matchedStatus: boolean;
  matchedRecommendation: boolean;
}

export interface JudgeCalibrationResult {
  datasetId: string;
  providerId: string;
  summary: {
    totalCases: number;
    statusMatches: number;
    recommendationMatches: number;
    exactMatches: number;
  };
  cases: JudgeCalibrationCaseResult[];
}

export async function runJudgeCalibration(input: {
  datasetPath: string;
  provider: 'codex' | 'claude';
  providerTimeoutMs?: number;
  outputPath?: string;
}): Promise<JudgeCalibrationResult> {
  const dataset = await loadJudgeDataset(input.datasetPath);
  const provider = input.provider === 'codex' ? createCodexProvider() : createClaudeProvider();
  const cases: JudgeCalibrationCaseResult[] = [];

  for (const datasetCase of dataset.cases) {
    const actual = await evaluateJudgeCase(provider, datasetCase, input.providerTimeoutMs);
    cases.push({
      id: datasetCase.id,
      expected: datasetCase.expected,
      actual,
      matchedStatus: datasetCase.expected.status === actual.status,
      matchedRecommendation: datasetCase.expected.recommendation === actual.recommendation,
    });
  }

  const result: JudgeCalibrationResult = {
    datasetId: dataset.id,
    providerId: provider.id,
    summary: {
      totalCases: cases.length,
      statusMatches: cases.filter((item) => item.matchedStatus).length,
      recommendationMatches: cases.filter((item) => item.matchedRecommendation).length,
      exactMatches: cases.filter((item) => item.matchedStatus && item.matchedRecommendation).length,
    },
    cases,
  };

  if (input.outputPath) {
    const outputPath = resolve(input.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }

  return result;
}

async function evaluateJudgeCase(
  provider: TextProvider,
  datasetCase: JudgeCalibrationCase,
  providerTimeoutMs?: number,
): Promise<JudgeCalibrationCaseResult['actual']> {
  const prompt = [
    'You are calibrating an evaluation judge.',
    'Read the task evidence and return strict JSON only.',
    'Schema: {"status":"pass|warn|fail","recommendation":"complete|repair|escalate|abort","summary":"..."}',
    '',
    `Task: ${datasetCase.input.task}`,
    ...(datasetCase.input.evidence?.length ? ['', 'Evidence:', ...datasetCase.input.evidence.map((item) => `- ${item}`)] : []),
    ...(datasetCase.input.findings?.length
      ? ['', 'Findings:', ...datasetCase.input.findings.map((finding) => `- [${finding.severity ?? 'medium'}] ${finding.title ?? 'Finding'}: ${finding.body ?? ''}`)]
      : []),
  ].join('\n');

  const execution = await provider.run(prompt, {
    timeoutMs: providerTimeoutMs ?? 2 * 60 * 1000,
  });
  const parsed = parseJsonOutput(execution.stdout) as Record<string, unknown>;
  return {
    status: normalizeJudgeStatus(parsed.status),
    recommendation: normalizeJudgeRecommendation(parsed.recommendation),
    summary: typeof parsed.summary === 'string' ? parsed.summary : 'No summary provided.',
  };
}

async function loadJudgeDataset(path: string): Promise<JudgeCalibrationDataset> {
  const datasetPath = resolve(path);
  const parsed = JSON.parse(await readFile(datasetPath, 'utf8')) as JudgeCalibrationDataset;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cases)) {
    throw new Error(`invalid judge calibration dataset: ${datasetPath}`);
  }
  return parsed;
}

function normalizeJudgeStatus(value: unknown): JudgeStatus {
  return value === 'pass' || value === 'warn' || value === 'fail' ? value : 'warn';
}

function normalizeJudgeRecommendation(value: unknown): JudgeRecommendation {
  return value === 'complete' || value === 'repair' || value === 'escalate' || value === 'abort'
    ? value
    : 'repair';
}
