export type EvaluationLayer = 'deterministic' | 'environment' | 'judge' | 'human';
export type { FailureClass } from './failure-taxonomy.js';
export { classifySessionFailure, classifySupervisorFailure } from './failure-taxonomy.js';

export interface EvaluationFinding {
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  body: string;
  evidence?: string;
}

export interface EvaluationEvidence {
  kind: string;
  label: string;
  value: string;
  uri?: string;
  metadata?: Record<string, string>;
}

export interface EvaluationResult {
  layer: EvaluationLayer;
  status: 'pass' | 'warn' | 'fail';
  recommendation: 'complete' | 'repair' | 'escalate' | 'abort';
  summary: string;
  findings: EvaluationFinding[];
  scores?: Record<string, number>;
  evidence?: EvaluationEvidence[];
}

export interface Evaluator<TInput = unknown> {
  name: string;
  layer: EvaluationLayer;
  evaluate(input: TInput): Promise<EvaluationResult>;
}

export interface Judge<TInput = unknown> {
  name: string;
  kind: 'llm' | 'human';
  evaluate(input: TInput): Promise<EvaluationResult>;
}

export interface EvaluationPipelineResult {
  status: 'pass' | 'warn' | 'fail';
  recommendation: 'complete' | 'repair' | 'escalate' | 'abort';
  summary: string;
  results: EvaluationResult[];
  findings: EvaluationFinding[];
  scores: Record<string, number>;
  evidence: EvaluationEvidence[];
}

const RECOMMENDATION_ORDER: Array<EvaluationResult['recommendation']> = [
  'complete',
  'repair',
  'escalate',
  'abort',
];

const STATUS_ORDER: Array<EvaluationResult['status']> = ['pass', 'warn', 'fail'];

function maxByOrder<T extends string>(values: T[], order: T[]): T {
  let best = values[0] as T;
  for (const value of values) {
    if (order.indexOf(value) > order.indexOf(best)) {
      best = value;
    }
  }
  return best;
}

export class EvaluationPipeline<TInput = unknown> {
  constructor(private evaluators: Array<Evaluator<TInput>>) {}

  async run(input: TInput): Promise<EvaluationPipelineResult> {
    const settled = await Promise.allSettled(this.evaluators.map((evaluator) => evaluator.evaluate(input)));
    const results: EvaluationResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        results.push({
          layer: this.evaluators[i]?.layer ?? 'judge',
          status: 'warn',
          recommendation: 'repair',
          summary: `evaluator ${this.evaluators[i]?.name ?? i} threw: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          findings: [{
            severity: 'medium',
            title: `Evaluator failure: ${this.evaluators[i]?.name ?? i}`,
            body: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          }],
        });
      }
    }
    const findings = results.flatMap((result) => result.findings);
    const evidence = results.flatMap((result) => result.evidence ?? []);

    const mergedScores: Record<string, number[]> = {};
    for (const result of results) {
      for (const [key, value] of Object.entries(result.scores ?? {})) {
        if (!mergedScores[key]) {
          mergedScores[key] = [];
        }
        mergedScores[key].push(value);
      }
    }

    const scores: Record<string, number> = {};
    for (const [key, values] of Object.entries(mergedScores)) {
      scores[key] = values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    const status = results.length > 0 ? maxByOrder(results.map((r) => r.status), STATUS_ORDER) : 'pass';
    const recommendation =
      results.length > 0
        ? maxByOrder(results.map((r) => r.recommendation), RECOMMENDATION_ORDER)
        : 'complete';

    const summary = results.length > 0
      ? results.map((result) => `[${result.layer}] ${result.summary}`).join(' | ')
      : 'no evaluators configured';

    return {
      status,
      recommendation,
      summary,
      results,
      findings,
      scores,
      evidence,
    };
  }
}
