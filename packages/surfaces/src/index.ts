export interface SurfaceTaskRef {
  id: string;
  goal: string;
  metadata?: Record<string, string>;
}

export interface SurfaceOutcome {
  status: string;
  summary: string;
  validated: boolean;
  unmetCriteria?: string[];
}

export interface Trigger {
  id: string;
  source: 'cli' | 'webhook' | 'cron' | 'queue' | 'api';
  task: SurfaceTaskRef;
  metadata?: Record<string, string>;
}

export interface PublicationSurface {
  name: string;
  publish(input: {
    task: SurfaceTaskRef;
    outcome: SurfaceOutcome;
    summary: string;
  }): Promise<void>;
}

export { createEngineeringForemanProfile, runEngineeringForeman } from './engineering-foreman.js';
export { dispatchWorker, hardenTask, observeEnvironment, updateMemory, validateWork } from './engineering-tools.js';
export type { PriorRoundState } from './engineering-tools.js';
export { runEngineeringBenchmarkSuite } from './engineering-benchmark.js';
export { runEngineeringReplay } from './engineering-replay.js';
export { runObserveEnvironment } from './environment-observe.js';
export { runGoldenSuite } from './golden-suite.js';
export { runJudgeCalibration } from './judge-calibration.js';
export { runLearnOperator } from './learn-operator.js';
export { runOperatorLearningEval } from './operator-learning-eval.js';
export { runProfileBootstrap } from './profile-bootstrap.js';
export { runProviderSessionSurface } from './provider-session.js';
export { runPromptOptimizerSidecar } from './prompt-optimizer.js';
export { runRetrieveTraces } from './retrieve-traces.js';
export { runScheduledJobs } from './schedule.js';
export { runSyncOperator } from './sync-operator.js';
export { runSessionRegistry } from './session-registry.js';
export { runSessionReview } from './session-review.js';
export { runSessionSurface } from './session-run.js';
export { runSessionReplay } from './session-replay.js';
export { runSessionBenchmark } from './session-benchmark.js';
export { runBrowserReplay } from './browser-replay.js';
export { runBrowserBenchmark } from './browser-benchmark.js';
export { runBrowserSupervision } from './browser-supervision.js';
export { runEnvironmentForeman } from './environment-foreman.js';
export { runHybridForeman } from './hybrid-foreman.js';
export { runSupervisorSurface } from './supervisor-run.js';
export { runSupervisorReplay } from './supervisor-replay.js';
export { runSupervisorBenchmark } from './supervisor-benchmark.js';
export { runTraceBenchmark } from './trace-benchmark.js';
export { runWorkContinuation } from './work-continuation.js';
export { runWorkDiscovery } from './work-discovery.js';
export { pushBranch, createPR, checkCI, readCILogs } from './ci-tools.js';
