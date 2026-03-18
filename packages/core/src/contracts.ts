export type RunStatus = 'running' | 'completed' | 'max_rounds' | 'blocked' | 'failed';
export type TrackStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type ValidationStatus = 'pass' | 'warn' | 'fail';
export type Recommendation = 'complete' | 'repair' | 'escalate' | 'abort';
export type EvidenceKind = 'log' | 'metric' | 'screenshot' | 'diff' | 'test' | 'note' | 'artifact' | (string & {});
export type EnvironmentKind = 'code' | 'browser' | 'shell' | 'api' | 'document' | 'hybrid';
export type EscalationMode = 'ask-human' | 'auto-repair' | 'halt';
export type OutcomeStatus = 'completed' | 'blocked' | 'failed' | 'max_rounds';

export interface Evidence {
  kind: EvidenceKind;
  label: string;
  value: string;
  uri?: string;
  metadata?: Record<string, string>;
}

export interface EnvironmentSpec {
  kind: EnvironmentKind;
  target?: string;
  metadata?: Record<string, string>;
}

export interface Policy {
  maxCostUsd?: number;
  maxRuntimeSec?: number;
  maxTurns?: number;
  escalationMode?: EscalationMode;
  requiredEvidenceKinds?: EvidenceKind[];
  allowedActions?: string[];
  metadata?: Record<string, string>;
}

export interface TaskSpec {
  id: string;
  goal: string;
  successCriteria: string[];
  environment?: EnvironmentSpec;
  policy?: Policy;
  constraints?: string[];
  persona?: string;
  metadata?: Record<string, string>;
}

export interface ContextSnapshot<TState = unknown> {
  summary: string;
  state?: TState;
  evidence?: Evidence[];
  metadata?: Record<string, string>;
}

export interface Track<Input = unknown> {
  id: string;
  goal: string;
  input?: Input;
  capability?: string;
  metadata?: Record<string, string>;
}

export interface Plan<TTrackInput = unknown> {
  summary: string;
  tracks: Array<Track<TTrackInput>>;
  risks?: string[];
  openQuestions?: string[];
}

export interface Finding {
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  body: string;
  evidence?: string;
  sourceTrackId?: string;
}

export interface TrackResult<TOutput = unknown> {
  trackId: string;
  status: TrackStatus;
  summary: string;
  output?: TOutput;
  evidence: Evidence[];
  findings?: Finding[];
  metadata?: Record<string, string>;
}

export interface ValidationResult {
  status: ValidationStatus;
  recommendation: Recommendation;
  summary: string;
  findings: Finding[];
  unmetCriteria?: string[];
  scores?: Record<string, number>;
  evidence?: Evidence[];
}

export interface RepairPlan {
  summary: string;
  actions: string[];
  metadata?: Record<string, string>;
}

export interface StopDecision {
  done: boolean;
  status: RunStatus;
  reason: string;
}

export interface TraceEvent {
  at: string;
  kind:
    | 'task.started'
    | 'context.built'
    | 'plan.created'
    | 'track.started'
    | 'track.completed'
    | 'validation.completed'
    | 'repair.created'
    | 'decision.made'
    | 'run.completed'
    | 'run.failed';
  workerId?: string;
  trackId?: string;
  summary: string;
  metadata?: Record<string, string>;
}

export interface Outcome {
  status: OutcomeStatus;
  summary: string;
  validated: boolean;
  unmetCriteria?: string[];
}

export interface ArtifactStore {
  root: string;
  writeJson(path: string, payload: unknown): Promise<string>;
  writeText(path: string, text: string): Promise<string>;
}

export interface RoundState<TContext = unknown, TTrackOutput = unknown> {
  round: number;
  context: ContextSnapshot<TContext>;
  plan: Plan;
  trackResults: Array<TrackResult<TTrackOutput>>;
  validation: ValidationResult;
  repair?: RepairPlan;
}

export interface LoopState<TContext = unknown, TTrackOutput = unknown> {
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  rounds: Array<RoundState<TContext, TTrackOutput>>;
  trace: TraceEvent[];
  outcome?: Outcome;
}

export interface StageContext<TContext = unknown, TTrackInput = unknown, TTrackOutput = unknown> {
  task: TaskSpec;
  round: number;
  loop: LoopState<TContext, TTrackOutput>;
  context?: ContextSnapshot<TContext>;
  plan?: Plan<TTrackInput>;
  track?: Track<TTrackInput>;
  trackResults?: Array<TrackResult<TTrackOutput>>;
  signal?: AbortSignal;
}

export interface LoopOptions<TContext = unknown, TTrackInput = unknown, TTrackOutput = unknown> {
  task: TaskSpec;
  maxRounds?: number;
  concurrency?: number;
  artifacts: ArtifactStore;
  signal?: AbortSignal;
  onEvent?(event: TraceEvent): void;
  context(input: StageContext<TContext, TTrackInput, TTrackOutput>): Promise<ContextSnapshot<TContext>>;
  plan(input: StageContext<TContext, TTrackInput, TTrackOutput> & { context: ContextSnapshot<TContext> }): Promise<Plan<TTrackInput>>;
  executeTrack(input: StageContext<TContext, TTrackInput, TTrackOutput> & {
    context: ContextSnapshot<TContext>;
    plan: Plan<TTrackInput>;
    track: Track<TTrackInput>;
  }): Promise<TrackResult<TTrackOutput>>;
  validate(input: StageContext<TContext, TTrackInput, TTrackOutput> & {
    context: ContextSnapshot<TContext>;
    plan: Plan<TTrackInput>;
    trackResults: Array<TrackResult<TTrackOutput>>;
  }): Promise<ValidationResult>;
  repair?(input: StageContext<TContext, TTrackInput, TTrackOutput> & {
    context: ContextSnapshot<TContext>;
    plan: Plan<TTrackInput>;
    trackResults: Array<TrackResult<TTrackOutput>>;
    validation: ValidationResult;
  }): Promise<RepairPlan | undefined>;
  shouldStop?(input: StageContext<TContext, TTrackInput, TTrackOutput> & {
    context: ContextSnapshot<TContext>;
    plan: Plan<TTrackInput>;
    trackResults: Array<TrackResult<TTrackOutput>>;
    validation: ValidationResult;
    repair?: RepairPlan;
  }): Promise<StopDecision>;
}

export interface LoopResult<TContext = unknown, TTrackOutput = unknown> {
  task: TaskSpec;
  state: LoopState<TContext, TTrackOutput>;
}
