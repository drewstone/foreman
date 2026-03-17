import {
  FilesystemSandboxSessionStore,
  InMemorySandboxSessionStore,
  type SandboxTaskOptionsLike,
  type SandboxClientLike,
  type SandboxArtifactSpec,
  type SandboxEvidenceCollectorInput,
  type SandboxInstanceLike,
  SandboxWorkerAdapter,
  type SandboxSessionStore,
} from '@drew/foreman-sandbox';
import type { ProviderWorkerTask, WorkerContextSnapshot, WorkerSpec } from '@drew/foreman-workers';
import {
  Sandbox,
  type BackendConfig,
  type CreateSandboxOptions,
  SandboxInstance,
  type SandboxClientConfig,
  type TaskOptions,
} from '@tangle-network/sandbox';

export type TangleBackendType =
  | 'opencode'
  | 'claude-code'
  | 'codex'
  | 'amp'
  | 'factory-droids';

export interface TangleSandboxWorkerAdapterOptions {
  client?: Sandbox;
  clientConfig?: SandboxClientConfig;
  worker?: WorkerSpec;
  sessionStore?: SandboxSessionStore;
  backend?: BackendConfig;
  createOptions?: CreateSandboxOptions;
  evidence?: TangleSandboxEvidenceOptions;
  promptBuilder?: (input: {
    task: ProviderWorkerTask;
    context: WorkerContextSnapshot;
    instructions?: string;
    worker: WorkerSpec;
    sessionId?: string;
  }) => string;
}

export interface TangleCommandArtifactSpec {
  command: string;
  label?: string;
  cwd?: string;
  optional?: boolean;
}

export interface TangleSandboxEvidenceOptions {
  includeWorkspaceRoot?: boolean;
  includeGitStatus?: boolean;
  includeGitDiff?: boolean;
  gitDiffRef?: string;
  maxDiffChars?: number;
  textArtifacts?: SandboxArtifactSpec[];
  downloads?: Array<SandboxArtifactSpec & { destinationPath: string }>;
  commands?: TangleCommandArtifactSpec[];
}

export function createTangleSandboxClient(config: SandboxClientConfig): Sandbox {
  return new Sandbox(config);
}

export function createTangleFilesystemSessionStore(rootDir: string): FilesystemSandboxSessionStore {
  return new FilesystemSandboxSessionStore(rootDir);
}

export function createTangleSandboxWorkerAdapter(
  options: TangleSandboxWorkerAdapterOptions,
): SandboxWorkerAdapter {
  const tangleClient = options.client ?? createClientFromOptions(options);
  const client = wrapTangleClient(tangleClient);
  const evidenceOptions = options.evidence;
  const worker = options.worker ?? {
    id: inferWorkerId(options.backend),
    name: inferWorkerName(options.backend),
    capabilities: ['code', 'review', 'ops'],
    metadata: {
      remote: 'true',
      sandbox: 'tangle',
      backendType: options.backend?.type ?? 'opencode',
    },
  };

  return new SandboxWorkerAdapter({
    client,
    worker,
    sessionStore: options.sessionStore ?? new InMemorySandboxSessionStore(),
    defaultBackend: options.backend,
    defaultCreateOptions: options.createOptions,
    promptBuilder: options.promptBuilder
      ? ({ task, context, instructions }) =>
          options.promptBuilder?.({
            task,
            context,
            instructions,
            worker,
          }) ?? buildDefaultTanglePrompt(task, worker, instructions)
      : ({ task, instructions }) => buildDefaultTanglePrompt(task, worker, instructions),
    sandboxKeyBuilder: ({ task, worker: currentWorker }) =>
      [
        'tangle',
        currentWorker.id,
        options.backend?.type ?? 'opencode',
        task.repoPath ?? 'sandbox',
        task.goal,
      ].join(':'),
    createSandbox: async ({ task, client: sandboxClient, defaultCreateOptions, backend }) => {
      const name = defaultCreateOptions?.name ?? makeSandboxName(worker.id);
      return sandboxClient.create({
        ...defaultCreateOptions,
        name,
        backend: backend ?? defaultCreateOptions?.backend,
        metadata: {
          ...(defaultCreateOptions?.metadata ?? {}),
          foremanWorkerId: worker.id,
          foremanGoal: task.goal,
          foremanRepoPath: task.repoPath ?? '',
        },
      });
    },
    collectEvidence: evidenceOptions
      ? async (input) => collectTangleSandboxEvidenceFromInput(input, evidenceOptions)
      : undefined,
  });
}

export interface CreateTangleSandboxHandleOptions {
  client?: Sandbox;
  clientConfig?: SandboxClientConfig;
  createOptions?: CreateSandboxOptions;
}

export interface GetTangleSandboxHandleOptions {
  sandboxId: string;
  client?: Sandbox;
  clientConfig?: SandboxClientConfig;
}

export async function createTangleSandboxHandle(
  options: CreateTangleSandboxHandleOptions = {},
): Promise<TangleSandboxHandle> {
  const client = options.client ?? createClientFromOptions(options);
  const sandbox = await client.create(options.createOptions);
  return new TangleSandboxHandle(client, sandbox);
}

export async function getTangleSandboxHandle(
  options: GetTangleSandboxHandleOptions,
): Promise<TangleSandboxHandle | null> {
  const client = options.client ?? createClientFromOptions(options);
  const sandbox = await client.get(options.sandboxId);
  return sandbox ? new TangleSandboxHandle(client, sandbox) : null;
}

export function createCodexTangleWorkerAdapter(
  options: Omit<TangleSandboxWorkerAdapterOptions, 'backend' | 'worker'>,
): SandboxWorkerAdapter {
  return createTangleSandboxWorkerAdapter({
    ...options,
    backend: {
      type: 'codex',
      ...(options.createOptions?.backend ?? {}),
    },
    worker: {
      id: 'tangle-codex',
      name: 'Tangle Codex',
      capabilities: ['code', 'review'],
      metadata: {
        remote: 'true',
        sandbox: 'tangle',
        backendType: 'codex',
      },
    },
  });
}

export function createClaudeCodeTangleWorkerAdapter(
  options: Omit<TangleSandboxWorkerAdapterOptions, 'backend' | 'worker'>,
): SandboxWorkerAdapter {
  return createTangleSandboxWorkerAdapter({
    ...options,
    backend: {
      type: 'claude-code',
      ...(options.createOptions?.backend ?? {}),
    },
    worker: {
      id: 'tangle-claude-code',
      name: 'Tangle Claude Code',
      capabilities: ['code', 'review'],
      metadata: {
        remote: 'true',
        sandbox: 'tangle',
        backendType: 'claude-code',
      },
    },
  });
}

export class TangleSandboxHandle {
  constructor(
    private readonly client: Sandbox,
    private readonly sandbox: SandboxInstance,
  ) {}

  get id(): string {
    return this.sandbox.id;
  }

  get raw(): SandboxInstance {
    return this.sandbox;
  }

  async task(prompt: string, options?: TaskOptions) {
    return this.sandbox.task(prompt, options);
  }

  async resume(): Promise<void> {
    await this.sandbox.resume();
  }

  async stop(): Promise<void> {
    await this.sandbox.stop();
  }

  async snapshot(options?: Parameters<SandboxInstance['snapshot']>[0]) {
    return this.sandbox.snapshot(options);
  }

  async checkpoint(options?: Parameters<SandboxInstance['checkpoint']>[0]) {
    return this.sandbox.checkpoint(options);
  }

  async fork(
    checkpointId: string,
    options?: Parameters<SandboxInstance['fork']>[1],
  ): Promise<TangleSandboxHandle> {
    const forked = await this.sandbox.fork(checkpointId, options);
    return new TangleSandboxHandle(this.client, forked);
  }

  async exec(command: string, options?: Parameters<SandboxInstance['exec']>[1]) {
    return this.sandbox.exec(command, options);
  }

  async read(path: string): Promise<string> {
    return this.sandbox.read(path);
  }

  async write(path: string, content: string): Promise<void> {
    await this.sandbox.write(path, content);
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    await this.sandbox.fs.download(remotePath, localPath);
  }

  async getWorkspaceRoot(): Promise<string> {
    return this.sandbox.getWorkspaceRoot();
  }

  async gitStatus() {
    return this.sandbox.git.status();
  }

  async gitDiff(ref?: string) {
    return this.sandbox.git.diff(ref);
  }

  async listSnapshots() {
    return this.sandbox.listSnapshots();
  }

  toSandboxInstanceLike(): SandboxInstanceLike {
    return wrapTangleSandboxInstance(this.client, this.sandbox);
  }

  async collectEvidence(options: TangleSandboxEvidenceOptions): Promise<Array<{
    kind: string;
    label: string;
    value: string;
    uri?: string;
    metadata?: Record<string, string>;
  }>> {
    return collectTangleSandboxEvidence(this, options);
  }
}

function createClientFromOptions(
  options: TangleSandboxWorkerAdapterOptions | CreateTangleSandboxHandleOptions | GetTangleSandboxHandleOptions,
): Sandbox {
  if (!options.clientConfig) {
    throw new Error('createTangleSandboxWorkerAdapter requires either client or clientConfig');
  }
  return createTangleSandboxClient(options.clientConfig);
}

function wrapTangleClient(client: Sandbox): SandboxClientLike {
  return {
    create: async (createOptions) => {
      const sandbox = await client.create(createOptions as CreateSandboxOptions | undefined);
      return wrapTangleSandboxInstance(client, sandbox);
    },
    get: async (id) => {
      const sandbox = await client.get(id);
      return sandbox ? wrapTangleSandboxInstance(client, sandbox) : null;
    },
  };
}

function wrapTangleSandboxInstance(client: Sandbox, sandbox: SandboxInstance): SandboxInstanceLike {
  const handle = new TangleSandboxHandle(client, sandbox);
  return {
    id: sandbox.id,
    task: (prompt, taskOptions) =>
      sandbox.task(prompt, normalizeTaskOptions(taskOptions)),
    resume: sandbox.resume.bind(sandbox),
    stop: sandbox.stop.bind(sandbox),
    waitFor: (status, timeoutMs) =>
      sandbox.waitFor(
        status as Parameters<SandboxInstance['waitFor']>[0],
        timeoutMs ? { timeoutMs } : undefined,
      ),
    snapshot: sandbox.snapshot.bind(sandbox),
    checkpoint: sandbox.checkpoint.bind(sandbox),
    fork: async (checkpointId, options) =>
      wrapTangleSandboxInstance(client, await sandbox.fork(checkpointId, options)),
    exec: sandbox.exec.bind(sandbox),
    read: sandbox.read.bind(sandbox),
    write: sandbox.write.bind(sandbox),
    getWorkspaceRoot: sandbox.getWorkspaceRoot.bind(sandbox),
    fs: {
      download: sandbox.fs.download.bind(sandbox.fs),
    },
    git: {
      status: sandbox.git.status.bind(sandbox.git),
      diff: sandbox.git.diff.bind(sandbox.git),
      add: sandbox.git.add.bind(sandbox.git),
      commit: sandbox.git.commit.bind(sandbox.git),
    },
    __tangleHandle: handle,
  } as SandboxInstanceLike & { __tangleHandle: TangleSandboxHandle };
}

function normalizeTaskOptions(
  taskOptions?: SandboxTaskOptionsLike,
): TaskOptions {
  return {
    sessionId: taskOptions?.sessionId,
    maxTurns: taskOptions?.maxTurns,
    timeoutMs: taskOptions?.timeoutMs,
    backend: taskOptions?.backend as Partial<BackendConfig> | undefined,
  };
}

function inferWorkerId(backend?: BackendConfig): string {
  const suffix = backend?.type ?? 'opencode';
  return `tangle-${suffix}`;
}

function inferWorkerName(backend?: BackendConfig): string {
  const suffix = backend?.type ?? 'opencode';
  return `Tangle ${suffix}`;
}

function makeSandboxName(workerId: string): string {
  return `${workerId}-${Date.now()}`;
}

function buildDefaultTanglePrompt(
  task: ProviderWorkerTask,
  worker: WorkerSpec,
  instructions?: string,
): string {
  return [
    `You are ${worker.name}, a remote worker running in a Tangle sandbox under Foreman supervision.`,
    '',
    `Goal: ${task.goal}`,
    '',
    'Success criteria:',
    ...(task.successCriteria?.map((criterion) => `- ${criterion}`) ?? []),
    '',
    'Operating rules:',
    '- Work non-interactively.',
    '- Use the sandbox workspace directly.',
    '- Prefer concrete repository or runtime evidence over self-report.',
    '- Preserve session continuity when continuing prior work.',
    task.repoPath ? `- Repository context: ${task.repoPath}` : '',
    task.extraInstructions ? `- ${task.extraInstructions}` : '',
    instructions ? `- ${instructions}` : '',
  ].filter(Boolean).join('\n');
}

async function collectTangleSandboxEvidenceFromInput(
  input: SandboxEvidenceCollectorInput,
  options: TangleSandboxEvidenceOptions,
) {
  const handle = getTangleSandboxHandleFromLike(input.sandbox);
  return collectTangleSandboxEvidence(handle, options);
}

function getTangleSandboxHandleFromLike(
  sandbox: SandboxInstanceLike,
): TangleSandboxHandle {
  const wrapped = sandbox as SandboxInstanceLike & { __tangleHandle?: TangleSandboxHandle };
  if (wrapped.__tangleHandle) {
    return wrapped.__tangleHandle;
  }
  throw new Error('Tangle evidence collection requires a Tangle-backed sandbox handle');
}

async function collectTangleSandboxEvidence(
  handle: TangleSandboxHandle,
  options: TangleSandboxEvidenceOptions,
): Promise<Array<{
  kind: string;
  label: string;
  value: string;
  uri?: string;
  metadata?: Record<string, string>;
}>> {
  const evidence: Array<{
    kind: string;
    label: string;
    value: string;
    uri?: string;
    metadata?: Record<string, string>;
  }> = [];

  if (options.includeWorkspaceRoot) {
    const workspaceRoot = await handle.getWorkspaceRoot();
    evidence.push({
      kind: 'log',
      label: 'workspace-root',
      value: workspaceRoot,
    });
  }

  if (options.includeGitStatus) {
    const status = await handle.gitStatus();
    evidence.push({
      kind: 'log',
      label: 'git-status',
      value: JSON.stringify(status, null, 2),
    });
  }

  if (options.includeGitDiff) {
    const diff = await handle.gitDiff(options.gitDiffRef);
    const serialized = truncateText(stringifyEvidenceValue(diff), options.maxDiffChars ?? 12000);
    evidence.push({
      kind: 'log',
      label: 'git-diff',
      value: serialized,
      metadata: options.gitDiffRef ? { ref: options.gitDiffRef } : undefined,
    });
  }

  for (const artifact of options.textArtifacts ?? []) {
    await collectOptionalArtifact(artifact.optional, async () => {
      const content = await handle.read(artifact.path);
      evidence.push({
        kind: 'artifact',
        label: artifact.label ?? artifact.path,
        value: content,
        metadata: {
          path: artifact.path,
          artifactKind: artifact.kind,
        },
      });
    });
  }

  for (const artifact of options.downloads ?? []) {
    await collectOptionalArtifact(artifact.optional, async () => {
      await handle.download(artifact.path, artifact.destinationPath);
      evidence.push({
        kind: 'artifact',
        label: artifact.label ?? artifact.path,
        value: artifact.destinationPath,
        uri: artifact.destinationPath,
        metadata: {
          path: artifact.path,
          artifactKind: artifact.kind,
        },
      });
    });
  }

  for (const command of options.commands ?? []) {
    await collectOptionalArtifact(command.optional, async () => {
      const result = await handle.exec(command.command, command.cwd ? { cwd: command.cwd } : undefined);
      evidence.push({
        kind: 'log',
        label: command.label ?? command.command,
        value: result.stdout.trim(),
        metadata: {
          stderr: result.stderr.trim(),
          exitCode: String(result.exitCode),
        },
      });
    });
  }

  return evidence;
}

async function collectOptionalArtifact(optional: boolean | undefined, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (!optional) {
      throw error;
    }
  }
}

function stringifyEvidenceValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n... [truncated ${value.length - maxChars} chars]`;
}
