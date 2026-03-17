import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ProviderWorkerTask,
  WorkerAdapter,
  WorkerContextSnapshot,
  WorkerRun,
  WorkerSpec,
  WorkerTrackResult,
} from '@drew/foreman-workers';

export interface SandboxTaskOptionsLike {
  sessionId?: string;
  maxTurns?: number;
  backend?: SandboxBackendLike;
  cwd?: string;
  timeoutMs?: number;
}

export interface SandboxTaskResultLike {
  success: boolean;
  response?: string;
  error?: string;
  traceId?: string;
  durationMs?: number;
  turnsUsed?: number;
  sessionId: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface SandboxInstanceLike {
  id: string;
  task(prompt: string, options?: SandboxTaskOptionsLike): Promise<SandboxTaskResultLike>;
  resume?(): Promise<void>;
  stop?(): Promise<void>;
  waitFor?(status: string | string[], timeoutMs?: number): Promise<void>;
  snapshot?(options?: Record<string, unknown>): Promise<unknown>;
  checkpoint?(options?: Record<string, unknown>): Promise<{
    checkpointId: string;
    createdAt?: Date;
    sizeBytes?: number;
    tags?: string[];
  }>;
  fork?(checkpointId: string, options?: Record<string, unknown>): Promise<SandboxInstanceLike>;
  exec?(command: string, options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  read?(path: string): Promise<string>;
  write?(path: string, content: string): Promise<void>;
  getWorkspaceRoot?(): Promise<string>;
  fs?: {
    download?(remotePath: string, localPath: string, options?: Record<string, unknown>): Promise<void>;
  };
  git?: {
    status?(): Promise<{
      branch?: string;
      head?: string;
      isDirty?: boolean;
      ahead?: number;
      behind?: number;
      staged?: string[];
      modified?: string[];
      untracked?: string[];
    }>;
    diff?(ref?: string): Promise<unknown>;
    add?(paths: string[]): Promise<void>;
    commit?(message: string, options?: { amend?: boolean }): Promise<unknown>;
  };
}

export interface SandboxBackendLike {
  type?: string;
  profile?: unknown;
  model?: unknown;
}

export interface CreateSandboxOptionsLike {
  name?: string;
  image?: string;
  git?: {
    url: string;
    ref?: string;
    depth?: number;
    sparse?: string[];
  };
  backend?: SandboxBackendLike;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface SandboxClientLike {
  create(options?: CreateSandboxOptionsLike): Promise<SandboxInstanceLike>;
  get?(id: string): Promise<SandboxInstanceLike | null>;
}

export interface SandboxSessionRecord {
  key: string;
  sandboxId: string;
  sessionId: string;
  updatedAt?: string;
  metadata?: Record<string, string>;
}

export interface SandboxSessionStore {
  get(key: string): Promise<SandboxSessionRecord | null>;
  put(record: SandboxSessionRecord): Promise<void>;
}

export class InMemorySandboxSessionStore implements SandboxSessionStore {
  private readonly records = new Map<string, SandboxSessionRecord>();

  async get(key: string): Promise<SandboxSessionRecord | null> {
    return this.records.get(key) ?? null;
  }

  async put(record: SandboxSessionRecord): Promise<void> {
    this.records.set(record.key, record);
  }
}

export class FilesystemSandboxSessionStore implements SandboxSessionStore {
  constructor(private readonly rootDir: string) {}

  async get(key: string): Promise<SandboxSessionRecord | null> {
    const filePath = this.resolvePath(key);
    try {
      const raw = await readFile(filePath, 'utf8');
      return JSON.parse(raw) as SandboxSessionRecord;
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async put(record: SandboxSessionRecord): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const filePath = this.resolvePath(record.key);
    const persisted: SandboxSessionRecord = {
      ...record,
      updatedAt: record.updatedAt ?? new Date().toISOString(),
    };
    await writeFile(filePath, JSON.stringify(persisted, null, 2), 'utf8');
  }

  private resolvePath(key: string): string {
    const safeName = encodeURIComponent(key).replace(/%/g, '_');
    return path.join(this.rootDir, `${safeName}.json`);
  }
}

export interface SandboxArtifactSpec {
  kind: 'text' | 'download';
  path: string;
  label?: string;
  destinationPath?: string;
  optional?: boolean;
}

export interface SandboxEvidenceCollectorInput {
  key: string;
  worker: WorkerSpec;
  task: ProviderWorkerTask;
  context: WorkerContextSnapshot;
  instructions?: string;
  sandbox: SandboxInstanceLike;
  session: SandboxSessionRecord | null;
  taskResult: SandboxTaskResultLike;
}

export interface SandboxWorkerOptions {
  client: SandboxClientLike;
  worker: WorkerSpec;
  sessionStore?: SandboxSessionStore;
  defaultBackend?: SandboxTaskOptionsLike['backend'];
  defaultCreateOptions?: CreateSandboxOptionsLike;
  promptBuilder?: (input: {
    task: ProviderWorkerTask;
    context: WorkerContextSnapshot;
    instructions?: string;
  }) => string;
  sandboxKeyBuilder?: (input: {
    task: ProviderWorkerTask;
    worker: WorkerSpec;
  }) => string;
  createSandbox?: (input: {
    task: ProviderWorkerTask;
    worker: WorkerSpec;
    client: SandboxClientLike;
    defaultCreateOptions?: CreateSandboxOptionsLike;
    backend?: SandboxTaskOptionsLike['backend'];
  }) => Promise<SandboxInstanceLike>;
  collectEvidence?: (
    input: SandboxEvidenceCollectorInput,
  ) => Promise<WorkerTrackResult['evidence']>;
}

export interface SandboxWorkerOutput {
  sandboxId: string;
  sessionId: string;
  traceId?: string;
  response?: string;
  usage?: SandboxTaskResultLike['usage'];
}

export class SandboxWorkerAdapter implements WorkerAdapter<ProviderWorkerTask, SandboxWorkerOutput> {
  public readonly worker: WorkerSpec;
  private readonly client: SandboxClientLike;
  private readonly sessionStore: SandboxSessionStore;
  private readonly defaultBackend?: SandboxTaskOptionsLike['backend'];
  private readonly defaultCreateOptions?: CreateSandboxOptionsLike;
  private readonly promptBuilder: NonNullable<SandboxWorkerOptions['promptBuilder']>;
  private readonly sandboxKeyBuilder: NonNullable<SandboxWorkerOptions['sandboxKeyBuilder']>;
  private readonly createSandboxImpl: NonNullable<SandboxWorkerOptions['createSandbox']>;
  private readonly collectEvidence?: SandboxWorkerOptions['collectEvidence'];

  constructor(options: SandboxWorkerOptions) {
    this.worker = options.worker;
    this.client = options.client;
    this.sessionStore = options.sessionStore ?? new InMemorySandboxSessionStore();
    this.defaultBackend = options.defaultBackend;
    this.defaultCreateOptions = options.defaultCreateOptions;
    this.promptBuilder = options.promptBuilder ?? defaultSandboxPromptBuilder;
    this.sandboxKeyBuilder = options.sandboxKeyBuilder ?? defaultSandboxKeyBuilder;
    this.createSandboxImpl = options.createSandbox ?? defaultCreateSandbox;
    this.collectEvidence = options.collectEvidence;
  }

  async run(input: {
    task: ProviderWorkerTask;
    context: WorkerContextSnapshot;
    instructions?: string;
  }): Promise<WorkerRun & { output?: SandboxWorkerOutput }> {
    const key = this.sandboxKeyBuilder({
      task: input.task,
      worker: this.worker,
    });
    const existing = await this.sessionStore.get(key);
    const sandbox = existing
      ? await loadSandbox(this.client, existing.sandboxId)
      : await this.createSandboxImpl({
          task: input.task,
          worker: this.worker,
          client: this.client,
          defaultCreateOptions: this.defaultCreateOptions,
          backend: this.defaultBackend,
        });

    if (sandbox.resume) {
      try {
        await sandbox.resume();
      } catch {
        // Ignore resume failures when sandbox is already running.
      }
    }

    const prompt = this.promptBuilder(input);
    const taskResult = await sandbox.task(prompt, {
      sessionId: existing?.sessionId,
      backend: this.defaultBackend,
    });

    const sessionRecord: SandboxSessionRecord = {
      key,
      sandboxId: sandbox.id,
      sessionId: taskResult.sessionId,
      updatedAt: new Date().toISOString(),
    };
    await this.sessionStore.put(sessionRecord);

    const collectedEvidence = this.collectEvidence
      ? await this.collectEvidence({
          key,
          worker: this.worker,
          task: input.task,
          context: input.context,
          instructions: input.instructions,
          sandbox,
          session: existing,
          taskResult,
        })
      : [];

    const baseEvidence: WorkerTrackResult['evidence'] = [
      {
        kind: 'log',
        label: 'sandbox-id',
        value: sandbox.id,
      },
      {
        kind: 'log',
        label: 'session-id',
        value: taskResult.sessionId,
      },
      {
        kind: 'log',
        label: 'response',
        value: taskResult.response ?? '',
        metadata: {
          success: String(taskResult.success),
          turnsUsed: String(taskResult.turnsUsed ?? 0),
          durationMs: String(taskResult.durationMs ?? 0),
          ...(taskResult.traceId ? { traceId: taskResult.traceId } : {}),
        },
      },
      {
        kind: 'log',
        label: 'error',
        value: taskResult.error ?? '',
      },
    ];

    const trackResult: WorkerTrackResult<SandboxWorkerOutput> = {
      trackId: this.worker.id,
      status: taskResult.success ? 'completed' : 'failed',
      summary: taskResult.success
        ? `${this.worker.id} completed in sandbox ${sandbox.id}`
        : `${this.worker.id} failed in sandbox ${sandbox.id}`,
      output: {
        sandboxId: sandbox.id,
        sessionId: taskResult.sessionId,
        traceId: taskResult.traceId,
        response: taskResult.response,
        usage: taskResult.usage,
      },
      evidence: [...baseEvidence, ...collectedEvidence],
    };

    return {
      worker: this.worker,
      summary: trackResult.summary,
      evidence: trackResult.evidence,
      result: trackResult,
      output: trackResult.output,
      metrics: {
        durationMs: taskResult.durationMs,
      },
    };
  }
}

async function loadSandbox(
  client: SandboxClientLike,
  sandboxId: string,
): Promise<SandboxInstanceLike> {
  if (!client.get) {
    throw new Error(`sandbox client cannot resume existing sandbox ${sandboxId} because get() is unavailable`);
  }
  const sandbox = await client.get(sandboxId);
  if (!sandbox) {
    throw new Error(`sandbox client could not find existing sandbox ${sandboxId}`);
  }
  return sandbox;
}

async function defaultCreateSandbox(input: {
  task: ProviderWorkerTask;
  worker: WorkerSpec;
  client: SandboxClientLike;
  defaultCreateOptions?: CreateSandboxOptionsLike;
  backend?: SandboxTaskOptionsLike['backend'];
}): Promise<SandboxInstanceLike> {
  return input.client.create({
    ...(input.defaultCreateOptions ?? {}),
    name: input.defaultCreateOptions?.name ?? `${input.worker.id}-${Date.now()}`,
    backend: input.backend ?? input.defaultCreateOptions?.backend,
    metadata: {
      ...(input.defaultCreateOptions?.metadata ?? {}),
      workerId: input.worker.id,
      goal: input.task.goal,
    },
  });
}

function defaultSandboxPromptBuilder(input: {
  task: ProviderWorkerTask;
  context: WorkerContextSnapshot;
  instructions?: string;
}): string {
  return [
    `Goal: ${input.task.goal}`,
    '',
    'Success criteria:',
    ...(input.task.successCriteria?.map((criterion) => `- ${criterion}`) ?? []),
    '',
    'Context:',
    input.context.summary,
    '',
    input.task.extraInstructions ? `Extra instructions: ${input.task.extraInstructions}` : '',
    input.instructions ? `Foreman instructions: ${input.instructions}` : '',
  ].filter(Boolean).join('\n');
}

function defaultSandboxKeyBuilder(input: {
  task: ProviderWorkerTask;
  worker: WorkerSpec;
}): string {
  return `${input.worker.id}:${input.task.repoPath ?? 'sandbox'}:${input.task.goal}`;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
