import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilesystemMemoryStore,
  recordWorkerRun,
  type WorkerPerformanceMemory,
  type EnvironmentMemory,
  type StrategyMemory,
  type UserMemory,
  type ProfileMemory,
} from './index.js';

// We need to test sanitize and weightedAverage indirectly since they are not exported.
// sanitize is tested through FilesystemMemoryStore key behavior.
// weightedAverage is tested through recordWorkerRun.

describe('FilesystemMemoryStore', () => {
  let tmpDir: string;
  let store: FilesystemMemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'foreman-memory-test-'));
    store = new FilesystemMemoryStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('put and get environment memory', async () => {
    const mem: EnvironmentMemory = {
      target: 'my-repo',
      facts: ['uses typescript', 'monorepo'],
      invariants: ['no default exports'],
      failureModes: ['flaky CI'],
    };
    await store.putEnvironmentMemory(mem);
    const got = await store.getEnvironmentMemory('my-repo');
    assert.deepStrictEqual(got, mem);
  });

  it('put and get worker memory', async () => {
    const mem: WorkerPerformanceMemory = {
      workerId: 'claude-coder',
      sampleCount: 5,
      successRate: 0.8,
      avgCostUsd: 0.03,
      avgRuntimeSec: 12.5,
      commonFailureClasses: ['provider-timeout'],
    };
    await store.putWorkerMemory(mem);
    const got = await store.getWorkerMemory('claude-coder');
    assert.deepStrictEqual(got, mem);
  });

  it('put and get strategy memory', async () => {
    const mem: StrategyMemory = {
      taskShape: 'code-review',
      successfulPatterns: ['diff-first', 'test-check'],
      badPatterns: ['blind-approve'],
      repairRecipes: ['re-run with stricter eval'],
    };
    await store.putStrategyMemory(mem);
    const got = await store.getStrategyMemory('code-review');
    assert.deepStrictEqual(got, mem);
  });

  it('put and get user memory', async () => {
    const mem: UserMemory = {
      userId: 'drew',
      preferences: ['concise output'],
      favoredWorkers: ['claude-coder'],
      recurringEnvironments: ['my-repo'],
      escalationHabits: ['asks for details'],
      operatorPatterns: ['reviews diffs before merge'],
      goalPatterns: ['ship fast, fix later'],
    };
    await store.putUserMemory(mem);
    const got = await store.getUserMemory('drew');
    assert.deepStrictEqual(got, mem);
  });

  it('put and get profile memory', async () => {
    const mem: ProfileMemory = {
      profileId: 'default',
      workerPreferences: ['prefer claude'],
      evaluationStyle: ['strict'],
      memoryScopes: ['all'],
      operatorPatterns: ['prefers CLI'],
      goalPatterns: ['ship features'],
      workflowImprovements: ['add caching'],
      skillOrToolingImprovements: ['better git integration'],
    };
    await store.putProfileMemory(mem);
    const got = await store.getProfileMemory('default');
    assert.deepStrictEqual(got, mem);
  });

  it('get returns null for missing environment memory', async () => {
    const got = await store.getEnvironmentMemory('nonexistent');
    assert.strictEqual(got, null);
  });

  it('get returns null for missing worker memory', async () => {
    const got = await store.getWorkerMemory('nonexistent');
    assert.strictEqual(got, null);
  });

  it('get returns null for missing strategy memory', async () => {
    const got = await store.getStrategyMemory('nonexistent');
    assert.strictEqual(got, null);
  });

  it('get returns null for missing user memory', async () => {
    const got = await store.getUserMemory('nonexistent');
    assert.strictEqual(got, null);
  });

  it('get returns null for missing profile memory', async () => {
    const got = await store.getProfileMemory('nonexistent');
    assert.strictEqual(got, null);
  });

  it('overwrites existing memory on re-put', async () => {
    await store.putEnvironmentMemory({ target: 'repo', facts: ['old'] });
    await store.putEnvironmentMemory({ target: 'repo', facts: ['new'] });
    const got = await store.getEnvironmentMemory('repo');
    assert.deepStrictEqual(got!.facts, ['new']);
  });
});

describe('FilesystemMemoryStore sanitize behavior', () => {
  let tmpDir: string;
  let store: FilesystemMemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'foreman-sanitize-test-'));
    store = new FilesystemMemoryStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('sanitizes path traversal characters in keys', async () => {
    const mem: EnvironmentMemory = {
      target: '../../../etc/passwd',
      facts: ['should be safe'],
    };
    await store.putEnvironmentMemory(mem);
    // Should be retrievable with the same key
    const got = await store.getEnvironmentMemory('../../../etc/passwd');
    assert.deepStrictEqual(got, mem);
  });

  it('sanitizes special characters in keys', async () => {
    const mem: EnvironmentMemory = {
      target: 'foo/bar:baz@qux',
      facts: ['special chars'],
    };
    await store.putEnvironmentMemory(mem);
    const got = await store.getEnvironmentMemory('foo/bar:baz@qux');
    assert.deepStrictEqual(got, mem);
  });

  it('handles empty string key via sanitize fallback', async () => {
    // sanitize('') returns 'item'
    const mem: EnvironmentMemory = {
      target: '',
      facts: ['empty key'],
    };
    await store.putEnvironmentMemory(mem);
    // An empty target sanitizes to 'item', so retrieving '' should work
    const got = await store.getEnvironmentMemory('');
    assert.deepStrictEqual(got, mem);
  });

  it('keys differing only in unsafe chars map to same file', async () => {
    await store.putEnvironmentMemory({ target: 'a/b', facts: ['first'] });
    await store.putEnvironmentMemory({ target: 'a:b', facts: ['second'] });
    // Both 'a/b' and 'a:b' sanitize to 'a-b', so the second overwrites the first
    const got = await store.getEnvironmentMemory('a/b');
    assert.deepStrictEqual(got!.facts, ['second']);
  });
});

describe('recordWorkerRun', () => {
  it('first run creates initial stats from null existing', () => {
    const result = recordWorkerRun(null, {
      succeeded: true,
      durationMs: 5000,
      costUsd: 0.02,
    });

    assert.strictEqual(result.workerId, 'unknown-worker');
    assert.strictEqual(result.sampleCount, 1);
    assert.strictEqual(result.successRate, 1);
    assert.strictEqual(result.avgCostUsd, 0.02);
    assert.strictEqual(result.avgRuntimeSec, 5);
    assert.deepStrictEqual(result.commonFailureClasses, []);
  });

  it('first failed run records zero success rate', () => {
    const result = recordWorkerRun(null, {
      succeeded: false,
      failureClasses: ['provider-timeout'],
    });

    assert.strictEqual(result.sampleCount, 1);
    assert.strictEqual(result.successRate, 0);
    assert.deepStrictEqual(result.commonFailureClasses, ['provider-timeout']);
  });

  it('subsequent runs compute running average correctly', () => {
    const existing: WorkerPerformanceMemory = {
      workerId: 'worker-a',
      sampleCount: 2,
      successRate: 1.0,
      avgCostUsd: 0.04,
      avgRuntimeSec: 10,
    };

    const result = recordWorkerRun(existing, {
      succeeded: false,
      durationMs: 4000,
      costUsd: 0.01,
    });

    assert.strictEqual(result.workerId, 'worker-a');
    assert.strictEqual(result.sampleCount, 3);
    // successRate: (1.0 * 2 + 0) / 3 = 0.6667
    assert.strictEqual(result.successRate, Number((2 / 3).toFixed(4)));
    // avgCostUsd: (0.04 * 2 + 0.01) / 3 = 0.03
    assert.strictEqual(result.avgCostUsd, 0.03);
    // avgRuntimeSec: (10 * 2 + 4) / 3 = 8.0
    assert.strictEqual(result.avgRuntimeSec, 8);
  });

  it('preserves existing workerId', () => {
    const existing: WorkerPerformanceMemory = {
      workerId: 'my-worker',
      sampleCount: 1,
      successRate: 1.0,
    };
    const result = recordWorkerRun(existing, { succeeded: true });
    assert.strictEqual(result.workerId, 'my-worker');
  });

  it('undefined duration does not overwrite existing avgRuntimeSec', () => {
    const existing: WorkerPerformanceMemory = {
      workerId: 'w',
      sampleCount: 3,
      avgRuntimeSec: 15,
    };
    const result = recordWorkerRun(existing, {
      succeeded: true,
      // durationMs is undefined
    });
    assert.strictEqual(result.avgRuntimeSec, 15);
  });

  it('undefined cost does not overwrite existing avgCostUsd', () => {
    const existing: WorkerPerformanceMemory = {
      workerId: 'w',
      sampleCount: 2,
      avgCostUsd: 0.05,
    };
    const result = recordWorkerRun(existing, {
      succeeded: true,
      // costUsd is undefined
    });
    assert.strictEqual(result.avgCostUsd, 0.05);
  });

  it('failure classes are deduped', () => {
    const existing: WorkerPerformanceMemory = {
      workerId: 'w',
      sampleCount: 1,
      commonFailureClasses: ['provider-timeout', 'provider-rate-limited'],
    };
    const result = recordWorkerRun(existing, {
      succeeded: false,
      failureClasses: ['provider-timeout', 'provider-auth'],
    });
    assert.deepStrictEqual(result.commonFailureClasses, [
      'provider-timeout',
      'provider-rate-limited',
      'provider-auth',
    ]);
  });

  it('failure classes are capped at maxFailureClasses', () => {
    const existing: WorkerPerformanceMemory = {
      workerId: 'w',
      sampleCount: 1,
      commonFailureClasses: ['a', 'b', 'c'],
    };
    const result = recordWorkerRun(
      existing,
      {
        succeeded: false,
        failureClasses: ['d', 'e'],
      },
      { maxFailureClasses: 4 },
    );
    assert.strictEqual(result.commonFailureClasses!.length, 4);
    assert.deepStrictEqual(result.commonFailureClasses, ['a', 'b', 'c', 'd']);
  });

  it('failure classes default cap is 12', () => {
    const classes = Array.from({ length: 15 }, (_, i) => `class-${i}`);
    const result = recordWorkerRun(null, {
      succeeded: false,
      failureClasses: classes,
    });
    assert.strictEqual(result.commonFailureClasses!.length, 12);
  });
});

describe('weightedAverage (via recordWorkerRun)', () => {
  it('first sample with value returns that value', () => {
    const result = recordWorkerRun(null, {
      succeeded: true,
      costUsd: 0.123456,
    });
    // toFixed(4) means 0.1235 (rounded)
    assert.strictEqual(result.avgCostUsd, 0.1235);
  });

  it('weighted average of two values is correct', () => {
    const existing: WorkerPerformanceMemory = {
      workerId: 'w',
      sampleCount: 1,
      avgCostUsd: 0.10,
    };
    const result = recordWorkerRun(existing, {
      succeeded: true,
      costUsd: 0.20,
    });
    // (0.10 * 1 + 0.20) / 2 = 0.15
    assert.strictEqual(result.avgCostUsd, 0.15);
  });

  it('weighted average with many samples', () => {
    const existing: WorkerPerformanceMemory = {
      workerId: 'w',
      sampleCount: 9,
      avgRuntimeSec: 10,
    };
    const result = recordWorkerRun(existing, {
      succeeded: true,
      durationMs: 20000, // 20 sec
    });
    // (10 * 9 + 20) / 10 = 110 / 10 = 11
    assert.strictEqual(result.avgRuntimeSec, 11);
  });

  it('previousSamples of 0 with existing value still treats as first sample', () => {
    // This tests the branch where existingValue exists but previousSamples <= 0
    const existing: WorkerPerformanceMemory = {
      workerId: 'w',
      sampleCount: 0,
      avgCostUsd: 999, // should be ignored
    };
    const result = recordWorkerRun(existing, {
      succeeded: true,
      costUsd: 0.05,
    });
    assert.strictEqual(result.avgCostUsd, 0.05);
  });
});
