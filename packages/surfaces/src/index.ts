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

// ─── Kept surfaces (useful infrastructure for service integration) ────

export { pushBranch, createPR, checkCI, readCILogs } from './ci-tools.js';
export { runExperiments, type Experiment, type ExperimentResult, type ExperimentRunResult, type Scorer } from './worktree-experiment.js'
export { runEvals, listEnvNames, ENV_REGISTRY, type CombinedEvalReport, type EnvEntry } from './eval-runner.js';
export { scoreSession, scoreAllProjects, loadScoreHistory, type SessionScore } from './session-scorer.js'
export {
  spawn as spawnSession, send as sendToSession, status as sessionStatus,
  inspect as inspectSession, metrics as sessionMetrics, kill as killSession,
  killAll as killAllSessions, isAlive as isSessionAlive, driveProject,
  robotStatus, detectContextExhaustion,
  type SessionInfo, type SessionMetrics, type InspectOptions,
} from './session-controller.js'
