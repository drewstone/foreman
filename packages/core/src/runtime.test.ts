import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { runTaskLoop } from './runtime.js';
import type {
  ArtifactStore,
  ContextSnapshot,
  LoopOptions,
  Plan,
  RepairPlan,
  TaskSpec,
  TrackResult,
  ValidationResult,
} from './contracts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<TaskSpec>): TaskSpec {
  return {
    id: 'task-1',
    goal: 'test goal',
    successCriteria: ['criterion-a'],
    environment: { kind: 'shell' },
    ...overrides,
  };
}

function makeArtifactStore(): ArtifactStore & { written: Array<{ path: string; payload: unknown }> } {
  const written: Array<{ path: string; payload: unknown }> = [];
  return {
    root: '/tmp/test-artifacts',
    written,
    async writeJson(path: string, payload: unknown) {
      written.push({ path, payload });
      return `${this.root}/${path}`;
    },
    async writeText(path: string, text: string) {
      written.push({ path, payload: text });
      return `${this.root}/${path}`;
    },
  };
}

function makeContext(_input?: unknown): Promise<ContextSnapshot> {
  return Promise.resolve({ summary: 'ctx' });
}

function makePlan(tracks: Array<{ id: string }>): () => Promise<Plan> {
  return () =>
    Promise.resolve({
      summary: 'plan',
      tracks: tracks.map((t) => ({ id: t.id, goal: `do ${t.id}` })),
    });
}

function makeTrackResult(trackId: string): TrackResult {
  return { trackId, status: 'completed', summary: `${trackId} done`, evidence: [] };
}

function passValidation(): ValidationResult {
  return { status: 'pass', recommendation: 'complete', summary: 'all good', findings: [] };
}

function failValidation(unmet?: string[]): ValidationResult {
  return {
    status: 'fail',
    recommendation: 'repair',
    summary: 'not good',
    findings: [],
    unmetCriteria: unmet,
  };
}

function abortValidation(): ValidationResult {
  return { status: 'fail', recommendation: 'abort', summary: 'cannot continue', findings: [] };
}

function baseOptions(
  artifacts: ArtifactStore,
  overrides?: Partial<LoopOptions>,
): LoopOptions {
  return {
    task: makeTask(),
    artifacts,
    context: makeContext,
    plan: makePlan([{ id: 'track-1' }]),
    executeTrack: async ({ track }) => makeTrackResult(track.id),
    validate: async () => passValidation(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTaskLoop', () => {
  // 1. Single-round completion
  it('completes in one round when validation passes', async () => {
    const store = makeArtifactStore();
    const result = await runTaskLoop(baseOptions(store));

    assert.equal(result.state.status, 'completed');
    assert.equal(result.state.rounds.length, 1);
    assert.ok(result.state.outcome);
    assert.equal(result.state.outcome.status, 'completed');
    assert.equal(result.state.outcome.validated, true);
    assert.ok(result.state.finishedAt);
  });

  // 2. Multi-round with repair
  it('repairs on first round then completes on second', async () => {
    const store = makeArtifactStore();
    let callCount = 0;

    const result = await runTaskLoop(
      baseOptions(store, {
        maxRounds: 5,
        validate: async () => {
          callCount++;
          return callCount === 1 ? failValidation(['criterion-a']) : passValidation();
        },
        repair: async () => ({
          summary: 'fix it',
          actions: ['action-1'],
        }),
      }),
    );

    assert.equal(result.state.status, 'completed');
    assert.equal(result.state.rounds.length, 2);
    assert.ok(result.state.rounds[0]!.repair);
    assert.equal(result.state.rounds[0]!.repair!.summary, 'fix it');
    assert.equal(result.state.outcome!.validated, true);
  });

  // 3. Max rounds reached
  it('stops at maxRounds when validation always fails', async () => {
    const store = makeArtifactStore();
    const result = await runTaskLoop(
      baseOptions(store, {
        maxRounds: 3,
        validate: async () => failValidation(['criterion-a']),
      }),
    );

    assert.equal(result.state.status, 'max_rounds');
    assert.equal(result.state.rounds.length, 3);
    assert.equal(result.state.outcome!.status, 'max_rounds');
    assert.equal(result.state.outcome!.validated, false);
  });

  // 4. Abort recommendation
  it('stops with blocked when validation recommends abort', async () => {
    const store = makeArtifactStore();
    const result = await runTaskLoop(
      baseOptions(store, {
        validate: async () => abortValidation(),
      }),
    );

    assert.equal(result.state.status, 'blocked');
    assert.equal(result.state.rounds.length, 1);
    assert.equal(result.state.outcome!.status, 'blocked');
    assert.equal(result.state.outcome!.summary, 'cannot continue');
  });

  // 5. Parallel track execution
  it('executes multiple tracks with concurrency', async () => {
    const store = makeArtifactStore();
    const executedIds: string[] = [];
    let peakConcurrent = 0;
    let currentConcurrent = 0;

    const result = await runTaskLoop(
      baseOptions(store, {
        concurrency: 3,
        plan: makePlan([{ id: 't-1' }, { id: 't-2' }, { id: 't-3' }]),
        executeTrack: async ({ track }) => {
          currentConcurrent++;
          if (currentConcurrent > peakConcurrent) {
            peakConcurrent = currentConcurrent;
          }
          // Small delay to allow concurrency overlap
          await new Promise((r) => setTimeout(r, 10));
          executedIds.push(track.id);
          currentConcurrent--;
          return makeTrackResult(track.id);
        },
      }),
    );

    assert.equal(result.state.status, 'completed');
    assert.deepEqual(executedIds.sort(), ['t-1', 't-2', 't-3']);
    // With concurrency=3 and 3 tracks, all should run concurrently
    assert.ok(peakConcurrent >= 2, `expected peak concurrency >= 2, got ${peakConcurrent}`);
  });

  // 6. Track failure propagation
  it('propagates track execution error to the loop', async () => {
    const store = makeArtifactStore();
    const trackError = new Error('track exploded');

    await assert.rejects(
      () =>
        runTaskLoop(
          baseOptions(store, {
            executeTrack: async () => {
              throw trackError;
            },
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'track exploded');
        return true;
      },
    );

    // Error path should still attempt to write final artifacts
    const finalWrite = store.written.find((w) => w.path === 'final-summary.json');
    assert.ok(finalWrite, 'expected final-summary.json to be written on error');
    assert.equal((finalWrite!.payload as Record<string, unknown>).status, 'failed');
  });

  // 7. Artifact writes
  it('writes expected artifacts for each stage', async () => {
    const store = makeArtifactStore();
    await runTaskLoop(
      baseOptions(store, {
        repair: async () => ({
          summary: 'repair plan',
          actions: ['a'],
        }),
      }),
    );

    const paths = store.written.map((w) => w.path);

    // Top-level artifacts
    assert.ok(paths.includes('request.json'));
    assert.ok(paths.includes('final-summary.json'));
    assert.ok(paths.includes('trace.json'));

    // Round artifacts
    assert.ok(paths.includes('rounds/1/context.json'));
    assert.ok(paths.includes('rounds/1/plan.json'));
    assert.ok(paths.includes('rounds/1/track-results.json'));
    assert.ok(paths.includes('rounds/1/validation.json'));
    assert.ok(paths.includes('rounds/1/repair.json'));
    assert.ok(paths.includes('rounds/1/decision.json'));
    assert.ok(paths.includes('rounds/1/trace.json'));
  });

  // 8. Trace events
  it('trace contains expected event kinds in order for a single round', async () => {
    const store = makeArtifactStore();
    const result = await runTaskLoop(baseOptions(store));

    const kinds = result.state.trace.map((e) => e.kind);

    assert.deepEqual(kinds, [
      'task.started',
      'context.built',
      'plan.created',
      'track.started',
      'track.completed',
      'validation.completed',
      'decision.made',
      'run.completed',
    ]);

    // Every trace event has a timestamp
    for (const event of result.state.trace) {
      assert.ok(event.at, `event ${event.kind} missing timestamp`);
      assert.ok(!isNaN(Date.parse(event.at)), `event ${event.kind} has invalid timestamp`);
    }
  });

  it('trace includes repair event when repair produces a plan', async () => {
    const store = makeArtifactStore();
    let callCount = 0;

    const result = await runTaskLoop(
      baseOptions(store, {
        maxRounds: 2,
        validate: async () => {
          callCount++;
          return callCount === 1 ? failValidation() : passValidation();
        },
        repair: async () => ({ summary: 'fix', actions: ['a'] }),
      }),
    );

    const kinds = result.state.trace.map((e) => e.kind);
    assert.ok(kinds.includes('repair.created'));
  });

  // 9. AbortSignal
  it('terminates early when AbortSignal fires during execution', async () => {
    const store = makeArtifactStore();
    const ac = new AbortController();
    let executeCalled = 0;

    await assert.rejects(
      () =>
        runTaskLoop(
          baseOptions(store, {
            maxRounds: 10,
            plan: makePlan([{ id: 't-1' }, { id: 't-2' }, { id: 't-3' }, { id: 't-4' }]),
            concurrency: 1, // serialize so we can abort mid-way
            executeTrack: async ({ track, signal }) => {
              executeCalled++;
              if (executeCalled === 2) {
                ac.abort(new Error('user cancelled'));
              }
              if (signal?.aborted) {
                throw signal.reason ?? new Error('aborted');
              }
              return makeTrackResult(track.id);
            },
            signal: ac.signal,
          }),
        ),
      (err: unknown) => {
        // The abort should propagate as an error
        assert.ok(err instanceof Error);
        return true;
      },
    );

    // Should not have executed all 4 tracks
    assert.ok(executeCalled < 4, `expected fewer than 4 executions, got ${executeCalled}`);
  });

  // 10. Catch block safety: artifact write fails during error handling
  it('preserves original error when artifact write fails in catch block', async () => {
    const originalError = new Error('original boom');
    let artifactWriteCount = 0;

    const failingStore: ArtifactStore = {
      root: '/tmp/fail',
      async writeJson(path: string, _payload: unknown) {
        artifactWriteCount++;
        // Let the initial request.json write succeed so we reach the loop,
        // then fail all subsequent writes except during the try body
        if (path === 'final-summary.json' || path === 'trace.json') {
          throw new Error('disk full');
        }
        return `/tmp/fail/${path}`;
      },
      async writeText(path: string, _text: string) {
        return `/tmp/fail/${path}`;
      },
    };

    await assert.rejects(
      () =>
        runTaskLoop({
          task: makeTask(),
          artifacts: failingStore,
          context: makeContext,
          plan: makePlan([{ id: 't-1' }]),
          executeTrack: async () => {
            throw originalError;
          },
          validate: async () => passValidation(),
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // The original error must be preserved, not the artifact write error
        assert.equal(err.message, 'original boom');
        return true;
      },
    );
  });

  // Additional edge cases

  it('uses default maxRounds of 3 when not specified', async () => {
    const store = makeArtifactStore();
    const result = await runTaskLoop(
      baseOptions(store, {
        maxRounds: undefined,
        validate: async () => failValidation(),
      }),
    );

    assert.equal(result.state.rounds.length, 3);
    assert.equal(result.state.status, 'max_rounds');
  });

  it('passes task and round info to all stage callbacks', async () => {
    const store = makeArtifactStore();
    const task = makeTask({ id: 'task-check', goal: 'verify plumbing' });
    const contextRounds: number[] = [];
    const planRounds: number[] = [];
    const execTasks: string[] = [];

    await runTaskLoop({
      task,
      artifacts: store,
      context: async ({ round, task: t }) => {
        contextRounds.push(round);
        assert.equal(t.id, 'task-check');
        return { summary: 'ctx' };
      },
      plan: async ({ round }) => {
        planRounds.push(round);
        return { summary: 'p', tracks: [{ id: 'tk', goal: 'g' }] };
      },
      executeTrack: async ({ task: t }) => {
        execTasks.push(t.id);
        return makeTrackResult('tk');
      },
      validate: async () => passValidation(),
    });

    assert.deepEqual(contextRounds, [1]);
    assert.deepEqual(planRounds, [1]);
    assert.deepEqual(execTasks, ['task-check']);
  });

  it('skips repair when no repair callback is provided', async () => {
    const store = makeArtifactStore();
    let callCount = 0;

    const result = await runTaskLoop(
      baseOptions(store, {
        maxRounds: 2,
        validate: async () => {
          callCount++;
          return callCount === 1 ? failValidation() : passValidation();
        },
        // no repair callback
      }),
    );

    assert.equal(result.state.rounds.length, 2);
    assert.equal(result.state.rounds[0]!.repair, undefined);
    // Trace should not include repair.created
    const kinds = result.state.trace.map((e) => e.kind);
    assert.ok(!kinds.includes('repair.created'));
  });

  it('custom shouldStop overrides default logic', async () => {
    const store = makeArtifactStore();

    const result = await runTaskLoop(
      baseOptions(store, {
        validate: async () => passValidation(),
        shouldStop: async ({ round }) => {
          // Force two rounds even though validation passes
          if (round < 2) {
            return { done: false, status: 'running', reason: 'need more' };
          }
          return { done: true, status: 'completed', reason: 'custom done' };
        },
        maxRounds: 5,
      }),
    );

    assert.equal(result.state.rounds.length, 2);
    assert.equal(result.state.status, 'completed');
    assert.equal(result.state.outcome!.summary, 'custom done');
  });

  it('outcome includes unmetCriteria from validation', async () => {
    const store = makeArtifactStore();

    const result = await runTaskLoop(
      baseOptions(store, {
        validate: async () => abortValidation(),
      }),
    );

    // abortValidation doesn't set unmetCriteria, so it should be undefined
    assert.equal(result.state.outcome!.unmetCriteria, undefined);

    // Now test with unmet criteria
    const store2 = makeArtifactStore();
    const result2 = await runTaskLoop(
      baseOptions(store2, {
        validate: async () => ({
          ...abortValidation(),
          unmetCriteria: ['crit-x', 'crit-y'],
        }),
      }),
    );

    assert.deepEqual(result2.state.outcome!.unmetCriteria, ['crit-x', 'crit-y']);
  });

  it('returns the task in the result', async () => {
    const store = makeArtifactStore();
    const task = makeTask({ id: 'return-check' });

    const result = await runTaskLoop(baseOptions(store, { task }));

    assert.equal(result.task.id, 'return-check');
    assert.equal(result.task, task);
  });

  it('max_rounds fallback path when loop exhausts without shouldStop stopping', async () => {
    const store = makeArtifactStore();
    // Use a custom shouldStop that never says done
    const result = await runTaskLoop(
      baseOptions(store, {
        maxRounds: 2,
        validate: async () => failValidation(),
        shouldStop: async () => ({ done: false, status: 'running', reason: 'keep going' }),
      }),
    );

    // The for-loop exits, hitting the post-loop max_rounds path
    assert.equal(result.state.status, 'max_rounds');
    assert.equal(result.state.rounds.length, 2);
    assert.equal(result.state.outcome!.status, 'max_rounds');
    assert.equal(result.state.outcome!.summary, 'maximum rounds reached');
  });
});
