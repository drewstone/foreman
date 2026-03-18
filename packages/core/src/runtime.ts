import type {
  LoopOptions,
  LoopResult,
  LoopState,
  Outcome,
  RepairPlan,
  RoundState,
  StopDecision,
  TrackResult,
  TraceEvent,
  ValidationResult,
} from './contracts.js';

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_CONCURRENCY = 4;

function isoNow(): string {
  return new Date().toISOString();
}

function makeEvent(event: Omit<TraceEvent, 'at'>): TraceEvent {
  return {
    at: isoNow(),
    ...event,
  };
}

function outcomeFromDecision(input: {
  status: StopDecision['status'];
  validation: ValidationResult;
  reason: string;
}): Outcome {
  return {
    status:
      input.status === 'completed'
        ? 'completed'
        : input.status === 'blocked'
          ? 'blocked'
          : input.status === 'max_rounds'
            ? 'max_rounds'
            : 'failed',
    summary: input.reason,
    validated: input.validation.status === 'pass',
    unmetCriteria: input.validation.unmetCriteria,
  };
}

async function mapLimit<T, TResult>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<TResult>,
  signal?: AbortSignal,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let cursor = 0;
  let firstError: unknown;

  async function runWorker(): Promise<void> {
    for (;;) {
      if (firstError || signal?.aborted) {
        return;
      }
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = await worker(items[index] as T, index);
      } catch (error) {
        if (!firstError) {
          firstError = error;
        }
        return;
      }
    }
  }

  const width = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.allSettled(Array.from({ length: width }, () => runWorker()));
  if (firstError) {
    throw firstError;
  }
  return results;
}

async function defaultShouldStop(input: {
  round: number;
  maxRounds: number;
  validation: ValidationResult;
  repair?: RepairPlan;
}): Promise<StopDecision> {
  if (input.validation.recommendation === 'complete') {
    return { done: true, status: 'completed', reason: input.validation.summary };
  }
  if (input.validation.recommendation === 'abort') {
    return { done: true, status: 'blocked', reason: input.validation.summary };
  }
  if (input.round >= input.maxRounds) {
    return { done: true, status: 'max_rounds', reason: 'maximum rounds reached' };
  }
  return {
    done: false,
    status: 'running',
    reason: input.repair?.summary ?? 'continuing with another round',
  };
}

export async function runTaskLoop<TContext = unknown, TTrackInput = unknown, TTrackOutput = unknown>(
  options: LoopOptions<TContext, TTrackInput, TTrackOutput>,
): Promise<LoopResult<TContext, TTrackOutput>> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  const state: LoopState<TContext, TTrackOutput> = {
    startedAt: isoNow(),
    status: 'running',
    rounds: [],
    trace: [],
  };

  function emit(event: TraceEvent): void {
    state.trace.push(event);
    options.onEvent?.(event);
  }

  emit(
    makeEvent({
      kind: 'task.started',
      summary: `task ${options.task.id} started`,
      metadata: {
        goal: options.task.goal,
        environment: options.task.environment?.kind ?? 'unknown',
      },
    }),
  );

  await options.artifacts.writeJson('request.json', {
    task: options.task,
    startedAt: state.startedAt,
    maxRounds,
    concurrency,
  });

  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      const context = await options.context({
        task: options.task,
        round,
        loop: state,
        signal: options.signal,
      });
      emit(
        makeEvent({
          kind: 'context.built',
          summary: `round ${round} context built`,
        }),
      );
      await options.artifacts.writeJson(`rounds/${round}/context.json`, context);

      const plan = await options.plan({
        task: options.task,
        round,
        loop: state,
        context,
        signal: options.signal,
      });
      emit(
        makeEvent({
          kind: 'plan.created',
          summary: `round ${round} plan created with ${plan.tracks.length} track(s)`,
        }),
      );
      await options.artifacts.writeJson(`rounds/${round}/plan.json`, plan);

      const trackResults = await mapLimit(plan.tracks, concurrency, async (track) => {
        emit(
          makeEvent({
            kind: 'track.started',
            trackId: track.id,
            summary: `track ${track.id} started`,
          }),
        );
        const result = await options.executeTrack({
          task: options.task,
          round,
          loop: state,
          context,
          plan,
          track,
          signal: options.signal,
        });
        emit(
          makeEvent({
            kind: 'track.completed',
            trackId: track.id,
            summary: `track ${track.id} ${result.status}`,
          }),
        );
        return result;
      }, options.signal);
      await options.artifacts.writeJson(`rounds/${round}/track-results.json`, trackResults);

      const validation = await options.validate({
        task: options.task,
        round,
        loop: state,
        context,
        plan,
        trackResults,
        signal: options.signal,
      });
      emit(
        makeEvent({
          kind: 'validation.completed',
          summary: `round ${round} validation ${validation.status}`,
          metadata: {
            recommendation: validation.recommendation,
          },
        }),
      );
      await options.artifacts.writeJson(`rounds/${round}/validation.json`, validation);

      const repair = options.repair
        ? await options.repair({
            task: options.task,
            round,
            loop: state,
            context,
            plan,
            trackResults,
            validation,
            signal: options.signal,
          })
        : undefined;
      if (repair) {
        emit(
          makeEvent({
            kind: 'repair.created',
            summary: `round ${round} repair created`,
          }),
        );
        await options.artifacts.writeJson(`rounds/${round}/repair.json`, repair);
      }

      const roundState: RoundState<TContext, TTrackOutput> = {
        round,
        context,
        plan,
        trackResults: trackResults as Array<TrackResult<TTrackOutput>>,
        validation,
        repair,
      };
      state.rounds.push(roundState);

      const stop = options.shouldStop
        ? await options.shouldStop({
            task: options.task,
            round,
            loop: state,
            context,
            plan,
            trackResults,
            validation,
            repair,
            signal: options.signal,
          })
        : await defaultShouldStop({ round, maxRounds, validation, repair });
      emit(
        makeEvent({
          kind: 'decision.made',
          summary: `round ${round} decision: ${stop.status}`,
          metadata: {
            done: String(stop.done),
          },
        }),
      );

      await options.artifacts.writeJson(`rounds/${round}/decision.json`, stop);
      await options.artifacts.writeJson(`rounds/${round}/trace.json`, state.trace);

      if (stop.done) {
        state.status = stop.status;
        state.finishedAt = isoNow();
        state.outcome = outcomeFromDecision({
          status: stop.status,
          validation,
          reason: stop.reason,
        });
        emit(
          makeEvent({
            kind: 'run.completed',
            summary: `run finished with status ${state.status}`,
          }),
        );
        await options.artifacts.writeJson('final-summary.json', {
          task: options.task,
          status: state.status,
          finishedAt: state.finishedAt,
          rounds: state.rounds.length,
          finalValidation: validation,
          outcome: state.outcome,
          reason: stop.reason,
        });
        await options.artifacts.writeJson('trace.json', state.trace);
        return { task: options.task, state };
      }
    }

    state.status = 'max_rounds';
    state.finishedAt = isoNow();
    state.outcome = {
      status: 'max_rounds',
      summary: 'maximum rounds reached',
      validated: false,
    };
    emit(
      makeEvent({
        kind: 'run.completed',
        summary: 'run finished at max rounds',
      }),
    );
    await options.artifacts.writeJson('final-summary.json', {
      task: options.task,
      status: state.status,
      finishedAt: state.finishedAt,
      rounds: state.rounds.length,
      outcome: state.outcome,
    });
    await options.artifacts.writeJson('trace.json', state.trace);
    return { task: options.task, state };
  } catch (error) {
    state.status = 'failed';
    state.finishedAt = isoNow();
    state.outcome = {
      status: 'failed',
      summary: error instanceof Error ? error.message : String(error),
      validated: false,
    };
    emit(
      makeEvent({
        kind: 'run.failed',
        summary: state.outcome.summary,
      }),
    );
    try {
      await options.artifacts.writeJson('final-summary.json', {
        task: options.task,
        status: state.status,
        finishedAt: state.finishedAt,
        rounds: state.rounds.length,
        outcome: state.outcome,
        error: error instanceof Error ? error.message : String(error),
      });
      await options.artifacts.writeJson('trace.json', state.trace);
    } catch {
      // Artifact write failed during error handling — preserve original error.
    }
    throw error;
  }
}
