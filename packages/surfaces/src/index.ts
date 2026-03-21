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

export { dispatchWorker, hardenTask, observeEnvironment, updateMemory, validateWork } from './engineering-tools.js';
export type { PriorRoundState } from './engineering-tools.js';
export { pushBranch, createPR, checkCI, readCILogs } from './ci-tools.js';
export { generateClaudeMd, type ManagedSession } from './claudemd-generator.js';
export { runObserveEnvironment } from './environment-observe.js';
export { runGoldenSuite } from './golden-suite.js';
export { runJudgeCalibration } from './judge-calibration.js';
export { runOperatorLearningEval } from './operator-learning-eval.js';
export { runProfileBootstrap } from './profile-bootstrap.js';
export { runProviderSessionSurface } from './provider-session.js';
export { runPromptOptimizerSidecar } from './prompt-optimizer.js';
export { runRetrieveTraces } from './retrieve-traces.js';
export { runSessionRegistry } from './session-registry.js';
export { runSessionSurface } from './session-run.js';
export { runSessionReplay } from './session-replay.js';
export { runSessionBenchmark } from './session-benchmark.js';
export { runBrowserReplay } from './browser-replay.js';
export { runBrowserBenchmark } from './browser-benchmark.js';
export { runBrowserSupervision } from './browser-supervision.js';
export { runSupervisorSurface } from './supervisor-run.js';
export { runSupervisorReplay } from './supervisor-replay.js';
export { runSupervisorBenchmark } from './supervisor-benchmark.js';
export { runTraceBenchmark } from './trace-benchmark.js';
export { runExperiments, type Experiment, type ExperimentResult, type ExperimentRunResult, type Scorer } from './worktree-experiment.js'
export { TerminalTaskEnv, SWEBenchEnv, MultiHarnessEnv } from './benchmark-env.js'
export { CIRepairEnv } from './ci-repair-env.js'
export { ReportQualityEnv } from './report-quality-env.js'
export { runEvals, listEnvNames, ENV_REGISTRY, type CombinedEvalReport, type EnvEntry } from './eval-runner.js';
export { buildStateSnapshot, formatStateForLLM, type ForemanState, type ForemanEvent, type ProjectState, type BudgetState } from './state-snapshot.js'
export { decideAction, executeAction, gateAndExecute, runPolicyCycle, type Action, type ActionType, type ActionOutcome, type PolicyDecision, type GatedResult } from './policy.js'
export { createDaemon, type ForemanDaemon, type DaemonConfig } from './foreman-daemon.js'
