import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  WorkerRegistry,
  ConnectorRegistry,
  ToolRegistry,
  CommandWorkerAdapter,
  normalizeSupervisorOutput,
  tryParseSupervisorOutput,
  type WorkerAdapter,
  type WorkerSpec,
  type WorkerContextSnapshot,
  type CommandConnectorDefinition,
  type ForemanProfile,
} from './index.js';

function makeSpec(id: string, capabilities: WorkerSpec['capabilities'] = ['code']): WorkerSpec {
  return { id, name: id, capabilities };
}

function makeAdapter(spec: WorkerSpec): WorkerAdapter<unknown, unknown> {
  return new CommandWorkerAdapter(spec);
}

const dummyContext: WorkerContextSnapshot = { summary: 'test' };

describe('WorkerRegistry', () => {
  it('register and get', () => {
    const registry = new WorkerRegistry();
    const adapter = makeAdapter(makeSpec('w1'));
    registry.register(adapter);
    assert.strictEqual(registry.get('w1'), adapter);
    assert.strictEqual(registry.get('nonexistent'), undefined);
  });

  it('list returns all registered adapters', () => {
    const registry = new WorkerRegistry();
    const a1 = makeAdapter(makeSpec('w1'));
    const a2 = makeAdapter(makeSpec('w2'));
    registry.register(a1);
    registry.register(a2);
    const listed = registry.list();
    assert.strictEqual(listed.length, 2);
    assert.ok(listed.includes(a1));
    assert.ok(listed.includes(a2));
  });

  it('findByCapability filters correctly', () => {
    const registry = new WorkerRegistry();
    registry.register(makeAdapter(makeSpec('coder', ['code'])));
    registry.register(makeAdapter(makeSpec('reviewer', ['review'])));
    registry.register(makeAdapter(makeSpec('hybrid', ['code', 'review'])));

    const codeWorkers = registry.findByCapability('code');
    assert.strictEqual(codeWorkers.length, 2);
    const ids = codeWorkers.map((a) => a.worker.id);
    assert.ok(ids.includes('coder'));
    assert.ok(ids.includes('hybrid'));

    const browserWorkers = registry.findByCapability('browser');
    assert.strictEqual(browserWorkers.length, 0);
  });

  it('score ranks by capability match + profile preferences', () => {
    const registry = new WorkerRegistry();
    registry.register(makeAdapter(makeSpec('w-code', ['code'])));
    registry.register(makeAdapter(makeSpec('w-review', ['review'])));
    registry.register(makeAdapter(makeSpec('w-both', ['code', 'review'])));

    const profile: ForemanProfile = {
      id: 'p1',
      name: 'test-profile',
      preferredWorkers: ['w-review'],
      preferredCapabilities: ['review'],
    };

    const scores = registry.score({ capability: 'review' }, profile);

    // w-review: capability match (10) + preferred worker (5) + preferred capability (3) = 18
    // w-both: capability match (10) + preferred capability (3) = 13
    // w-code: no capability match, no preferred = 0
    assert.strictEqual(scores[0]!.workerId, 'w-review');
    assert.strictEqual(scores[0]!.score, 18);
    assert.strictEqual(scores[1]!.workerId, 'w-both');
    assert.strictEqual(scores[1]!.score, 13);
    assert.strictEqual(scores[2]!.workerId, 'w-code');
    assert.strictEqual(scores[2]!.score, 0);
  });

  it('score excludes blocked workers', () => {
    const registry = new WorkerRegistry();
    registry.register(makeAdapter(makeSpec('w1', ['code'])));
    registry.register(makeAdapter(makeSpec('w2', ['code'])));
    registry.register(makeAdapter(makeSpec('w3', ['code'])));

    // Block via request
    const scores1 = registry.score({ capability: 'code', blockedWorkerIds: ['w1'] });
    assert.ok(!scores1.some((s) => s.workerId === 'w1'));
    assert.strictEqual(scores1.length, 2);

    // Block via profile
    const profile: ForemanProfile = { id: 'p', name: 'p', blockedWorkers: ['w2'] };
    const scores2 = registry.score({ capability: 'code' }, profile);
    assert.ok(!scores2.some((s) => s.workerId === 'w2'));

    // Block via both
    const scores3 = registry.score({ capability: 'code', blockedWorkerIds: ['w1'] }, profile);
    assert.strictEqual(scores3.length, 1);
    assert.strictEqual(scores3[0]!.workerId, 'w3');
  });

  it('select returns top-scored worker', () => {
    const registry = new WorkerRegistry();
    const preferred = makeAdapter(makeSpec('preferred', ['code']));
    registry.register(makeAdapter(makeSpec('other', ['code'])));
    registry.register(preferred);

    const profile: ForemanProfile = {
      id: 'p',
      name: 'p',
      preferredWorkers: ['preferred'],
    };

    const selected = registry.select({ capability: 'code' }, profile);
    assert.strictEqual(selected, preferred);
  });

  it('select returns undefined when all blocked', () => {
    const registry = new WorkerRegistry();
    registry.register(makeAdapter(makeSpec('w1', ['code'])));
    registry.register(makeAdapter(makeSpec('w2', ['code'])));

    const result = registry.select({
      capability: 'code',
      blockedWorkerIds: ['w1', 'w2'],
    });
    assert.strictEqual(result, undefined);
  });
});

describe('ConnectorRegistry', () => {
  function cmdConnector(id: string): CommandConnectorDefinition {
    return {
      kind: 'command',
      id,
      name: id,
      command: `run-${id}`,
      cwd: '/tmp',
      env: { BASE: '1' },
      capabilities: ['ops'],
    };
  }

  it('register and list', () => {
    const registry = new ConnectorRegistry();
    registry.register(cmdConnector('c1'));
    registry.register(cmdConnector('c2'));
    const listed = registry.list();
    assert.strictEqual(listed.length, 2);
    // list is sorted by id
    assert.strictEqual(listed[0]!.id, 'c1');
    assert.strictEqual(listed[1]!.id, 'c2');
  });

  it('toCommandTask builds correct task', () => {
    const registry = new ConnectorRegistry();
    registry.register(cmdConnector('my-tool'));

    const task = registry.toCommandTask({
      connectorId: 'my-tool',
      args: ['--verbose', 'file.txt'],
      env: { EXTRA: '2' },
    });

    assert.strictEqual(task.command, 'run-my-tool --verbose file.txt');
    assert.strictEqual(task.cwd, '/tmp');
    assert.deepStrictEqual(task.env, { BASE: '1', EXTRA: '2' });
  });

  it('toCommandTask throws for unknown connector', () => {
    const registry = new ConnectorRegistry();
    assert.throws(
      () => registry.toCommandTask({ connectorId: 'nope' }),
      /unknown connector nope/,
    );
  });

  it('toCommandTask throws for service connector', () => {
    const registry = new ConnectorRegistry();
    registry.register({
      kind: 'service',
      id: 'svc',
      name: 'svc',
      url: 'http://localhost',
    });
    assert.throws(
      () => registry.toCommandTask({ connectorId: 'svc' }),
      /not a command connector/,
    );
  });

  it('createWorker returns CommandWorkerAdapter', () => {
    const registry = new ConnectorRegistry();
    registry.register(cmdConnector('tool1'));
    const worker = registry.createWorker('tool1');
    assert.strictEqual(worker.worker.id, 'tool1');
    assert.strictEqual(worker.worker.name, 'tool1');
    assert.deepStrictEqual(worker.worker.capabilities, ['ops']);
  });
});

describe('ToolRegistry', () => {
  it('register, get, list, toCommandTask', () => {
    const registry = new ToolRegistry();
    registry.register({
      id: 't1',
      name: 'Tool One',
      command: 'echo',
      cwd: '/tmp',
      env: { A: '1' },
      capabilities: ['code'],
    });
    registry.register({
      id: 't2',
      name: 'Tool Two',
      command: 'ls',
    });

    // get
    const t1 = registry.get('t1');
    assert.ok(t1);
    assert.strictEqual(t1.id, 't1');
    assert.strictEqual(t1.name, 'Tool One');

    assert.strictEqual(registry.get('nonexistent'), undefined);

    // list
    const listed = registry.list();
    assert.strictEqual(listed.length, 2);

    // toCommandTask
    const task = registry.toCommandTask({ toolId: 't1', args: ['-n', 'hello'] });
    assert.strictEqual(task.command, 'echo -n hello');
    assert.strictEqual(task.cwd, '/tmp');
    assert.deepStrictEqual(task.env, { A: '1' });
  });
});

describe('normalizeSupervisorOutput', () => {
  it('handles valid supervisor JSON', () => {
    const input = {
      status: 'completed',
      summary: 'All checks passed.',
      childRuns: [
        {
          id: 'run-1',
          kind: 'agent',
          status: 'completed',
          summary: 'Ran tests.',
          workerId: 'w1',
          backend: 'local',
          sandboxId: 's1',
          sessionId: 'sess1',
          traceId: 'tr1',
          startedAt: '2024-01-01T00:00:00Z',
          finishedAt: '2024-01-01T00:01:00Z',
          artifactUris: ['file:///out.log'],
          metadata: { key: 'val' },
        },
      ],
      findings: [
        { severity: 'high', title: 'Bug found', body: 'Details here', evidence: 'line 42', metadata: { file: 'a.ts' } },
      ],
      artifacts: [
        { kind: 'report', label: 'coverage', value: '95%', uri: 'file:///cov', path: '/tmp/cov', metadata: { fmt: 'text' } },
      ],
      recommendedNextActions: ['Fix the bug', 'Re-run tests'],
      metadata: { runId: '123' },
    };

    const output = normalizeSupervisorOutput(input);

    assert.strictEqual(output.status, 'completed');
    assert.strictEqual(output.summary, 'All checks passed.');

    assert.strictEqual(output.childRuns.length, 1);
    assert.strictEqual(output.childRuns[0]!.id, 'run-1');
    assert.strictEqual(output.childRuns[0]!.kind, 'agent');
    assert.strictEqual(output.childRuns[0]!.status, 'completed');
    assert.strictEqual(output.childRuns[0]!.workerId, 'w1');
    assert.deepStrictEqual(output.childRuns[0]!.artifactUris, ['file:///out.log']);

    assert.strictEqual(output.findings.length, 1);
    assert.strictEqual(output.findings[0]!.severity, 'high');
    assert.strictEqual(output.findings[0]!.title, 'Bug found');
    assert.strictEqual(output.findings[0]!.evidence, 'line 42');

    assert.strictEqual(output.artifacts.length, 1);
    assert.strictEqual(output.artifacts[0]!.kind, 'report');
    assert.strictEqual(output.artifacts[0]!.uri, 'file:///cov');

    assert.deepStrictEqual(output.recommendedNextActions, ['Fix the bug', 'Re-run tests']);
    assert.deepStrictEqual(output.metadata, { runId: '123' });
  });

  it('handles missing/malformed fields with defaults', () => {
    // Pass a completely empty object
    const output = normalizeSupervisorOutput({});
    assert.strictEqual(output.status, 'needs_followup');
    assert.strictEqual(output.summary, 'Supervisor run completed.');
    assert.deepStrictEqual(output.childRuns, []);
    assert.deepStrictEqual(output.findings, []);
    assert.deepStrictEqual(output.artifacts, []);
    assert.deepStrictEqual(output.recommendedNextActions, []);
    assert.strictEqual(output.metadata, undefined);

    // Pass null
    const output2 = normalizeSupervisorOutput(null);
    assert.strictEqual(output2.status, 'needs_followup');
    assert.strictEqual(output2.summary, 'Supervisor run completed.');

    // Pass non-object
    const output3 = normalizeSupervisorOutput('garbage');
    assert.strictEqual(output3.status, 'needs_followup');

    // Invalid status
    const output4 = normalizeSupervisorOutput({ status: 'banana' });
    assert.strictEqual(output4.status, 'needs_followup');

    // Invalid child kind defaults to 'task'
    const output5 = normalizeSupervisorOutput({
      childRuns: [{ id: 'x', kind: 'invalid', status: 'running', summary: 'ok' }],
    });
    assert.strictEqual(output5.childRuns[0]!.kind, 'task');

    // Invalid finding severity defaults to 'medium'
    const output6 = normalizeSupervisorOutput({
      findings: [{ severity: 'banana', title: 'F', body: 'B' }],
    });
    assert.strictEqual(output6.findings[0]!.severity, 'medium');

    // childRuns with missing id gets default
    const output7 = normalizeSupervisorOutput({
      childRuns: [{ summary: 'hello' }],
    });
    assert.strictEqual(output7.childRuns[0]!.id, 'child-1');
    assert.strictEqual(output7.childRuns[0]!.summary, 'hello');

    // artifacts with missing label gets default
    const output8 = normalizeSupervisorOutput({
      artifacts: [{ kind: 'file' }],
    });
    assert.strictEqual(output8.artifacts[0]!.label, 'artifact-1');
  });
});

describe('tryParseSupervisorOutput', () => {
  it('returns undefined for empty input', () => {
    assert.strictEqual(tryParseSupervisorOutput(''), undefined);
    assert.strictEqual(tryParseSupervisorOutput('   '), undefined);
  });

  it('returns undefined for invalid JSON', () => {
    assert.strictEqual(tryParseSupervisorOutput('not json at all'), undefined);
    assert.strictEqual(tryParseSupervisorOutput('{broken'), undefined);
  });

  it('parses valid supervisor JSON', () => {
    const input = JSON.stringify({
      status: 'completed',
      summary: 'Done.',
      childRuns: [],
      findings: [],
      artifacts: [],
      recommendedNextActions: [],
    });
    const result = tryParseSupervisorOutput(input);
    assert.ok(result);
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.summary, 'Done.');
  });
});
