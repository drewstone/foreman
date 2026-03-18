import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  EvaluationPipeline,
  classifySessionFailure,
  classifySupervisorFailure,
  type Evaluator,
  type EvaluationResult,
} from './index.js';

function makeEvaluator(
  name: string,
  result: EvaluationResult,
): Evaluator<unknown> {
  return {
    name,
    layer: result.layer,
    evaluate: async () => result,
  };
}

function makeThrowingEvaluator(name: string, error: Error): Evaluator<unknown> {
  return {
    name,
    layer: 'deterministic',
    evaluate: async () => {
      throw error;
    },
  };
}

describe('EvaluationPipeline', () => {
  it('all evaluators passing returns status pass and recommendation complete', async () => {
    const pipeline = new EvaluationPipeline([
      makeEvaluator('a', {
        layer: 'deterministic',
        status: 'pass',
        recommendation: 'complete',
        summary: 'looks good',
        findings: [],
        scores: { quality: 0.9 },
      }),
      makeEvaluator('b', {
        layer: 'environment',
        status: 'pass',
        recommendation: 'complete',
        summary: 'env ok',
        findings: [],
        scores: { quality: 1.0 },
      }),
    ]);

    const result = await pipeline.run({});
    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.recommendation, 'complete');
    assert.strictEqual(result.results.length, 2);
    assert.strictEqual(result.findings.length, 0);
  });

  it('one evaluator failing returns status fail and recommendation repair', async () => {
    const pipeline = new EvaluationPipeline([
      makeEvaluator('pass-eval', {
        layer: 'deterministic',
        status: 'pass',
        recommendation: 'complete',
        summary: 'ok',
        findings: [],
      }),
      makeEvaluator('fail-eval', {
        layer: 'judge',
        status: 'fail',
        recommendation: 'repair',
        summary: 'bad output',
        findings: [{ severity: 'high', title: 'bad', body: 'very bad' }],
      }),
    ]);

    const result = await pipeline.run({});
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.recommendation, 'repair');
    assert.strictEqual(result.findings.length, 1);
    assert.strictEqual(result.findings[0]!.severity, 'high');
  });

  it('evaluator throwing is caught by allSettled and returns warn/repair', async () => {
    const pipeline = new EvaluationPipeline([
      makeEvaluator('good', {
        layer: 'deterministic',
        status: 'pass',
        recommendation: 'complete',
        summary: 'fine',
        findings: [],
      }),
      makeThrowingEvaluator('broken', new Error('connection refused')),
    ]);

    const result = await pipeline.run({});
    assert.strictEqual(result.results.length, 2);

    const brokenResult = result.results[1]!;
    assert.strictEqual(brokenResult.status, 'warn');
    assert.strictEqual(brokenResult.recommendation, 'repair');
    assert.ok(brokenResult.summary.includes('connection refused'));
    assert.strictEqual(brokenResult.findings.length, 1);
    assert.strictEqual(brokenResult.findings[0]!.severity, 'medium');

    // Overall status should be warn (worst of pass and warn)
    assert.strictEqual(result.status, 'warn');
    assert.strictEqual(result.recommendation, 'repair');
  });

  it('mixed results: maxByOrder picks worst status and recommendation', async () => {
    const pipeline = new EvaluationPipeline([
      makeEvaluator('a', {
        layer: 'deterministic',
        status: 'pass',
        recommendation: 'complete',
        summary: 'ok',
        findings: [],
      }),
      makeEvaluator('b', {
        layer: 'environment',
        status: 'warn',
        recommendation: 'repair',
        summary: 'meh',
        findings: [],
      }),
      makeEvaluator('c', {
        layer: 'judge',
        status: 'fail',
        recommendation: 'escalate',
        summary: 'nope',
        findings: [],
      }),
    ]);

    const result = await pipeline.run({});
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.recommendation, 'escalate');
  });

  it('abort recommendation wins over escalate', async () => {
    const pipeline = new EvaluationPipeline([
      makeEvaluator('a', {
        layer: 'judge',
        status: 'fail',
        recommendation: 'escalate',
        summary: 'esc',
        findings: [],
      }),
      makeEvaluator('b', {
        layer: 'human',
        status: 'fail',
        recommendation: 'abort',
        summary: 'stop',
        findings: [],
      }),
    ]);

    const result = await pipeline.run({});
    assert.strictEqual(result.recommendation, 'abort');
  });

  it('no evaluators returns pass/complete with appropriate summary', async () => {
    const pipeline = new EvaluationPipeline([]);
    const result = await pipeline.run({});

    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.recommendation, 'complete');
    assert.strictEqual(result.summary, 'no evaluators configured');
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(result.findings.length, 0);
    assert.deepStrictEqual(result.scores, {});
  });

  it('merges scores by averaging per key across evaluators', async () => {
    const pipeline = new EvaluationPipeline([
      makeEvaluator('a', {
        layer: 'deterministic',
        status: 'pass',
        recommendation: 'complete',
        summary: 'ok',
        findings: [],
        scores: { quality: 0.8, speed: 1.0 },
      }),
      makeEvaluator('b', {
        layer: 'judge',
        status: 'pass',
        recommendation: 'complete',
        summary: 'ok',
        findings: [],
        scores: { quality: 0.6, correctness: 0.9 },
      }),
    ]);

    const result = await pipeline.run({});
    assert.strictEqual(result.scores.quality, 0.7); // (0.8 + 0.6) / 2
    assert.strictEqual(result.scores.speed, 1.0); // only one value
    assert.strictEqual(result.scores.correctness, 0.9); // only one value
  });

  it('aggregates findings from all evaluators', async () => {
    const pipeline = new EvaluationPipeline([
      makeEvaluator('a', {
        layer: 'deterministic',
        status: 'warn',
        recommendation: 'repair',
        summary: 'hmm',
        findings: [
          { severity: 'low', title: 'nit', body: 'minor' },
          { severity: 'medium', title: 'issue', body: 'something' },
        ],
      }),
      makeEvaluator('b', {
        layer: 'judge',
        status: 'fail',
        recommendation: 'repair',
        summary: 'bad',
        findings: [
          { severity: 'critical', title: 'broken', body: 'very broken' },
        ],
      }),
    ]);

    const result = await pipeline.run({});
    assert.strictEqual(result.findings.length, 3);
    assert.deepStrictEqual(
      result.findings.map((f) => f.severity),
      ['low', 'medium', 'critical'],
    );
  });

  it('aggregates evidence from all evaluators', async () => {
    const pipeline = new EvaluationPipeline([
      makeEvaluator('a', {
        layer: 'deterministic',
        status: 'pass',
        recommendation: 'complete',
        summary: 'ok',
        findings: [],
        evidence: [{ kind: 'log', label: 'stdout', value: 'hello' }],
      }),
      makeEvaluator('b', {
        layer: 'judge',
        status: 'pass',
        recommendation: 'complete',
        summary: 'ok',
        findings: [],
        evidence: [{ kind: 'note', label: 'remark', value: 'lgtm' }],
      }),
      makeEvaluator('c', {
        layer: 'environment',
        status: 'pass',
        recommendation: 'complete',
        summary: 'ok',
        findings: [],
        // no evidence
      }),
    ]);

    const result = await pipeline.run({});
    assert.strictEqual(result.evidence.length, 2);
  });

  it('summary joins all evaluator summaries with layer prefixes', async () => {
    const pipeline = new EvaluationPipeline([
      makeEvaluator('a', {
        layer: 'deterministic',
        status: 'pass',
        recommendation: 'complete',
        summary: 'first',
        findings: [],
      }),
      makeEvaluator('b', {
        layer: 'judge',
        status: 'pass',
        recommendation: 'complete',
        summary: 'second',
        findings: [],
      }),
    ]);

    const result = await pipeline.run({});
    assert.strictEqual(result.summary, '[deterministic] first | [judge] second');
  });
});

describe('classifySessionFailure', () => {
  it('detects rate limiting from stderr', () => {
    const classes = classifySessionFailure({
      stderr: 'Error: 429 Too Many Requests - rate limit exceeded',
      exitCode: 1,
    });
    assert.ok(classes.includes('provider-rate-limited'));
    assert.ok(classes.includes('provider-runtime'));
  });

  it('detects rate limiting from reason', () => {
    const classes = classifySessionFailure({
      detectedFailureReason: 'insufficient quota for this model',
    });
    assert.ok(classes.includes('provider-rate-limited'));
  });

  it('detects timeout', () => {
    const classes = classifySessionFailure({
      detectedFailureReason: 'request timed out after 30s',
    });
    assert.ok(classes.includes('provider-timeout'));
    assert.ok(classes.includes('provider-runtime'));
  });

  it('detects model resolution failure', () => {
    const classes = classifySessionFailure({
      stderr: 'ProviderModelNotFoundError: model "gpt-5" not available',
      exitCode: 1,
    });
    assert.ok(classes.includes('provider-model-resolution'));
  });

  it('detects auth failure', () => {
    const classes = classifySessionFailure({
      stderr: '401 Unauthorized',
      exitCode: 1,
    });
    assert.ok(classes.includes('provider-auth'));
  });

  it('detects context overflow', () => {
    const classes = classifySessionFailure({
      detectedFailureReason: 'context length exceeded maximum token limit',
    });
    assert.ok(classes.includes('context-overflow'));
  });

  it('detects cancellation', () => {
    const classes = classifySessionFailure({
      detectedFailureReason: 'user stopped the session',
    });
    assert.ok(classes.includes('cancelled'));
  });

  it('detects session not found', () => {
    const classes = classifySessionFailure({
      detectedFailureReason: 'session not found',
    });
    assert.ok(classes.includes('session-not-found'));
  });

  it('non-zero exit with no reason or stderr gets provider-runtime', () => {
    // exitCode != 0 with no reason/stderr triggers provider-runtime,
    // which means classes is non-empty so 'unknown' is never added.
    const classes = classifySessionFailure({
      exitCode: 137,
    });
    assert.deepStrictEqual(classes, ['provider-runtime']);
  });

  it('returns empty for zero exit and no failure', () => {
    const classes = classifySessionFailure({
      exitCode: 0,
    });
    assert.deepStrictEqual(classes, []);
  });

  it('returns empty for no input', () => {
    const classes = classifySessionFailure({});
    assert.deepStrictEqual(classes, []);
  });

  it('classifies multiple failure classes from one input', () => {
    const classes = classifySessionFailure({
      detectedFailureReason: 'rate limit hit after timeout',
      stderr: '429 Too Many Requests, also context overflow detected',
      exitCode: 1,
    });
    assert.ok(classes.includes('provider-rate-limited'));
    assert.ok(classes.includes('provider-timeout'));
    assert.ok(classes.includes('context-overflow'));
    assert.ok(classes.includes('provider-runtime'));
  });

  it('reason alone triggers provider-runtime', () => {
    const classes = classifySessionFailure({
      detectedFailureReason: 'something weird happened',
    });
    assert.ok(classes.includes('provider-runtime'));
  });
});

describe('classifySupervisorFailure', () => {
  it('returns external-command-failed for non-completed status', () => {
    const classes = classifySupervisorFailure({ status: 'failed' });
    assert.ok(classes.includes('external-command-failed'));
  });

  it('returns empty for completed status with no issues', () => {
    const classes = classifySupervisorFailure({ status: 'completed' });
    assert.deepStrictEqual(classes, []);
  });

  it('detects high-severity findings', () => {
    const classes = classifySupervisorFailure({
      status: 'completed',
      findings: [{ severity: 'high' }],
    });
    assert.ok(classes.includes('high-severity-findings'));
  });

  it('detects critical findings', () => {
    const classes = classifySupervisorFailure({
      status: 'completed',
      findings: [{ severity: 'critical' }],
    });
    assert.ok(classes.includes('high-severity-findings'));
  });

  it('ignores low/medium findings', () => {
    const classes = classifySupervisorFailure({
      status: 'completed',
      findings: [{ severity: 'low' }, { severity: 'medium' }],
    });
    assert.ok(!classes.includes('high-severity-findings'));
  });

  it('detects failed child runs', () => {
    const classes = classifySupervisorFailure({
      status: 'completed',
      childRuns: [{ status: 'failed' }],
    });
    assert.ok(classes.includes('child-run-failed'));
  });

  it('detects validation failure', () => {
    const classes = classifySupervisorFailure({
      status: 'completed',
      validated: false,
    });
    assert.ok(classes.includes('validation-failed'));
  });

  it('detects contract-invalid from evidence', () => {
    const classes = classifySupervisorFailure({
      status: 'completed',
      evidence: [{ label: 'stdout', value: 'invalid supervisor-v1 response detected' }],
    });
    assert.ok(classes.includes('contract-invalid'));
  });

  it('returns multiple classes for compound failure', () => {
    const classes = classifySupervisorFailure({
      status: 'failed',
      findings: [{ severity: 'critical' }],
      childRuns: [{ status: 'error' }],
      validated: false,
    });
    assert.ok(classes.includes('external-command-failed'));
    assert.ok(classes.includes('high-severity-findings'));
    assert.ok(classes.includes('child-run-failed'));
    assert.ok(classes.includes('validation-failed'));
  });
});
