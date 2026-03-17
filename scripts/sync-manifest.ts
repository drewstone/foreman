export interface CliSurfaceManifestEntry {
  scriptName: string;
  entrypoint: string;
  exportName: string;
}

export const cliSurfaceManifest: CliSurfaceManifestEntry[] = [
  {
    scriptName: 'engineering',
    entrypoint: 'packages/surfaces/src/cli.ts',
    exportName: 'runEngineeringForeman',
  },
  {
    scriptName: 'bootstrap-profile',
    entrypoint: 'packages/surfaces/src/profile-bootstrap-cli.ts',
    exportName: 'runProfileBootstrap',
  },
  {
    scriptName: 'benchmark-traces',
    entrypoint: 'packages/surfaces/src/trace-benchmark-cli.ts',
    exportName: 'runTraceBenchmark',
  },
  {
    scriptName: 'calibrate-judge',
    entrypoint: 'packages/surfaces/src/judge-calibration-cli.ts',
    exportName: 'runJudgeCalibration',
  },
  {
    scriptName: 'continue-work',
    entrypoint: 'packages/surfaces/src/work-continuation-cli.ts',
    exportName: 'runWorkContinuation',
  },
  {
    scriptName: 'provider-session',
    entrypoint: 'packages/surfaces/src/provider-session-cli.ts',
    exportName: 'runProviderSessionSurface',
  },
  {
    scriptName: 'retrieve-traces',
    entrypoint: 'packages/surfaces/src/retrieve-traces-cli.ts',
    exportName: 'runRetrieveTraces',
  },
  {
    scriptName: 'session-run',
    entrypoint: 'packages/surfaces/src/session-run-cli.ts',
    exportName: 'runSessionSurface',
  },
  {
    scriptName: 'replay-session',
    entrypoint: 'packages/surfaces/src/session-replay-cli.ts',
    exportName: 'runSessionReplay',
  },
  {
    scriptName: 'benchmark-session',
    entrypoint: 'packages/surfaces/src/session-benchmark-cli.ts',
    exportName: 'runSessionBenchmark',
  },
  {
    scriptName: 'replay-browser',
    entrypoint: 'packages/surfaces/src/browser-replay-cli.ts',
    exportName: 'runBrowserReplay',
  },
  {
    scriptName: 'benchmark-browser',
    entrypoint: 'packages/surfaces/src/browser-benchmark-cli.ts',
    exportName: 'runBrowserBenchmark',
  },
  {
    scriptName: 'supervise-browser',
    entrypoint: 'packages/surfaces/src/browser-supervision-cli.ts',
    exportName: 'runBrowserSupervision',
  },
  {
    scriptName: 'sync-operator',
    entrypoint: 'packages/surfaces/src/sync-operator-cli.ts',
    exportName: 'runSyncOperator',
  },
  {
    scriptName: 'session-registry',
    entrypoint: 'packages/surfaces/src/session-registry-cli.ts',
    exportName: 'runSessionRegistry',
  },
  {
    scriptName: 'supervisor-run',
    entrypoint: 'packages/surfaces/src/supervisor-run-cli.ts',
    exportName: 'runSupervisorSurface',
  },
  {
    scriptName: 'replay-supervisor',
    entrypoint: 'packages/surfaces/src/supervisor-replay-cli.ts',
    exportName: 'runSupervisorReplay',
  },
  {
    scriptName: 'benchmark-supervisor',
    entrypoint: 'packages/surfaces/src/supervisor-benchmark-cli.ts',
    exportName: 'runSupervisorBenchmark',
  },
  {
    scriptName: 'benchmark-engineering',
    entrypoint: 'packages/surfaces/src/engineering-benchmark-cli.ts',
    exportName: 'runEngineeringBenchmarkSuite',
  },
  {
    scriptName: 'discover-work',
    entrypoint: 'packages/surfaces/src/work-discovery-cli.ts',
    exportName: 'runWorkDiscovery',
  },
  {
    scriptName: 'document-foreman',
    entrypoint: 'packages/surfaces/src/document-foreman-cli.ts',
    exportName: 'runEnvironmentForeman',
  },
  {
    scriptName: 'hybrid-foreman',
    entrypoint: 'packages/surfaces/src/hybrid-foreman-cli.ts',
    exportName: 'runHybridForeman',
  },
  {
    scriptName: 'observe-environment',
    entrypoint: 'packages/surfaces/src/environment-observe-cli.ts',
    exportName: 'runObserveEnvironment',
  },
  {
    scriptName: 'eval-operator-learning',
    entrypoint: 'packages/surfaces/src/operator-learning-eval-cli.ts',
    exportName: 'runOperatorLearningEval',
  },
  {
    scriptName: 'golden-suite',
    entrypoint: 'packages/surfaces/src/golden-suite-cli.ts',
    exportName: 'runGoldenSuite',
  },
  {
    scriptName: 'learn-operator',
    entrypoint: 'packages/surfaces/src/learn-operator-cli.ts',
    exportName: 'runLearnOperator',
  },
  {
    scriptName: 'optimize-prompts',
    entrypoint: 'packages/surfaces/src/prompt-optimizer-cli.ts',
    exportName: 'runPromptOptimizerSidecar',
  },
  {
    scriptName: 'ops-foreman',
    entrypoint: 'packages/surfaces/src/ops-foreman-cli.ts',
    exportName: 'runEnvironmentForeman',
  },
  {
    scriptName: 'research-foreman',
    entrypoint: 'packages/surfaces/src/research-foreman-cli.ts',
    exportName: 'runEnvironmentForeman',
  },
  {
    scriptName: 'review-sessions',
    entrypoint: 'packages/surfaces/src/session-review-cli.ts',
    exportName: 'runSessionReview',
  },
  {
    scriptName: 'replay-engineering',
    entrypoint: 'packages/surfaces/src/engineering-replay-cli.ts',
    exportName: 'runEngineeringReplay',
  },
  {
    scriptName: 'run-schedule',
    entrypoint: 'packages/surfaces/src/schedule-cli.ts',
    exportName: 'runScheduledJobs',
  },
];

export const sdkWorkspaceExports: string[] = [
  '@drew/foreman-core',
  '@drew/foreman-environments',
  '@drew/foreman-evals',
  '@drew/foreman-memory',
  '@drew/foreman-optimizer',
  '@drew/foreman-planning',
  '@drew/foreman-profiles',
  '@drew/foreman-providers',
  '@drew/foreman-sandbox',
  '@drew/foreman-surfaces',
  '@drew/foreman-tangle',
  '@drew/foreman-tracing',
  '@drew/foreman-workers',
];
