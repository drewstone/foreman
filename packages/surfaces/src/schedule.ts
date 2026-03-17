import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { runEngineeringReplay, type EngineeringReplayOptions } from './engineering-replay.js';
import { runPromptOptimizerSidecar, type PromptOptimizerSidecarOptions } from './prompt-optimizer.js';
import { runSessionSurface, type SessionRunOptions } from './session-run.js';
import { runSessionReview, type SessionReviewOptions } from './session-review.js';
import { runSyncOperator, type SyncOperatorOptions } from './sync-operator.js';
import { runSupervisorSurface, type SupervisorRunOptions } from './supervisor-run.js';
import { runWorkContinuation, type WorkContinuationOptions } from './work-continuation.js';

export interface PromptOptimizerJob extends PromptOptimizerSidecarOptions {
  id: string;
  kind: 'prompt-optimizer';
}

export interface EngineeringReplayJob extends EngineeringReplayOptions {
  id: string;
  kind: 'engineering-replay';
}

export interface SessionReviewJob extends SessionReviewOptions {
  id: string;
  kind: 'session-review';
}

export interface SessionRunJob extends SessionRunOptions {
  id: string;
  kind: 'session-run';
}

export interface WorkContinuationJob extends WorkContinuationOptions {
  id: string;
  kind: 'work-continuation';
}

export interface SupervisorRunJob extends SupervisorRunOptions {
  id: string;
  kind: 'supervisor-run';
}

export interface SyncOperatorJob extends SyncOperatorOptions {
  id: string;
  kind: 'sync-operator';
}

export type ScheduledJob =
  | PromptOptimizerJob
  | EngineeringReplayJob
  | SessionRunJob
  | SessionReviewJob
  | SyncOperatorJob
  | WorkContinuationJob
  | SupervisorRunJob;

export interface ScheduleManifest {
  jobs: ScheduledJob[];
}

export async function runScheduledJobs(input: {
  manifestPath: string;
  jobId?: string;
}): Promise<Array<{
  jobId: string;
  kind: ScheduledJob['kind'];
  status: 'completed' | 'failed';
  result?: unknown;
  error?: string;
}>> {
  const manifest = await readManifest(input.manifestPath);
  const jobs = input.jobId
    ? manifest.jobs.filter((job) => job.id === input.jobId)
    : manifest.jobs;

  const results: Array<{
    jobId: string;
    kind: ScheduledJob['kind'];
    status: 'completed' | 'failed';
    result?: unknown;
    error?: string;
  }> = [];

  for (const job of jobs) {
    try {
      const result = job.kind === 'prompt-optimizer'
        ? await runPromptOptimizerSidecar(job)
        : job.kind === 'engineering-replay'
          ? await runEngineeringReplay(job)
          : job.kind === 'session-run'
            ? await runSessionSurface(job)
          : job.kind === 'session-review'
            ? await runSessionReview(job)
            : job.kind === 'sync-operator'
              ? await runSyncOperator(job)
            : job.kind === 'supervisor-run'
              ? await runSupervisorSurface(job)
              : await runWorkContinuation(job);
      results.push({
        jobId: job.id,
        kind: job.kind,
        status: 'completed',
        result,
      });
    } catch (error) {
      results.push({
        jobId: job.id,
        kind: job.kind,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

async function readManifest(path: string): Promise<ScheduleManifest> {
  const raw = await readFile(resolve(path), 'utf8');
  const parsed = JSON.parse(raw) as Partial<ScheduleManifest>;
  return {
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs as ScheduledJob[] : [],
  };
}
