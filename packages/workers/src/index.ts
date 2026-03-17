export type WorkerCapability =
  | 'code'
  | 'browser'
  | 'review'
  | 'research'
  | 'ops'
  | 'document'
  | 'hybrid';

export interface WorkerContextSnapshot<TState = unknown> {
  summary: string;
  state?: TState;
  evidence?: Array<{
    kind: string;
    label: string;
    value: string;
    uri?: string;
    metadata?: Record<string, string>;
  }>;
}

export interface WorkerTrackResult<TOutput = unknown> {
  trackId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  summary: string;
  output?: TOutput;
  evidence: Array<{
    kind: string;
    label: string;
    value: string;
    uri?: string;
    metadata?: Record<string, string>;
  }>;
}

export interface WorkerSpec {
  id: string;
  name: string;
  capabilities: WorkerCapability[];
  metadata?: Record<string, string>;
}

export interface WorkerRun {
  worker: WorkerSpec;
  summary: string;
  evidence: WorkerTrackResult['evidence'];
  result?: WorkerTrackResult;
  metrics?: {
    durationMs?: number;
    costUsd?: number;
  };
}

function providerExecutionMetadata(
  execution: {
    durationMs: number;
    exitCode: number;
    costUsd?: number;
    metadata?: Record<string, string>;
  },
  providerId: string,
): Record<string, string> {
  return {
    durationMs: String(execution.durationMs),
    providerId,
    exitCode: String(execution.exitCode),
    ...(execution.costUsd !== undefined ? { costUsd: String(execution.costUsd) } : {}),
    ...(execution.metadata ?? {}),
  };
}

export interface WorkerAdapter<TTask = unknown, TResult = unknown> {
  worker: WorkerSpec;
  run(input: {
    task: TTask;
    context: WorkerContextSnapshot;
    instructions?: string;
  }): Promise<WorkerRun & { output?: TResult }>;
}

export interface WorkerScore {
  workerId: string;
  score: number;
  reasons: string[];
}

export interface WorkerSelectionRequest {
  capability?: WorkerCapability;
  preferredWorkerIds?: string[];
  blockedWorkerIds?: string[];
}

export interface ForemanProfile {
  id: string;
  name: string;
  preferredWorkers?: string[];
  blockedWorkers?: string[];
  preferredCapabilities?: WorkerCapability[];
  metadata?: Record<string, string>;
}

export class WorkerRegistry {
  private adapters = new Map<string, WorkerAdapter<unknown, unknown>>();

  register<TTask = unknown, TResult = unknown>(adapter: WorkerAdapter<TTask, TResult>): void {
    this.adapters.set(adapter.worker.id, adapter as WorkerAdapter<unknown, unknown>);
  }

  get(workerId: string): WorkerAdapter<unknown, unknown> | undefined {
    return this.adapters.get(workerId);
  }

  list(): WorkerAdapter<unknown, unknown>[] {
    return Array.from(this.adapters.values());
  }

  findByCapability(capability: WorkerCapability): WorkerAdapter<unknown, unknown>[] {
    return this.list().filter((adapter) => adapter.worker.capabilities.includes(capability));
  }

  score(request: WorkerSelectionRequest, profile?: ForemanProfile): WorkerScore[] {
    const blocked = new Set([
      ...(request.blockedWorkerIds ?? []),
      ...(profile?.blockedWorkers ?? []),
    ]);
    const preferred = [
      ...(request.preferredWorkerIds ?? []),
      ...(profile?.preferredWorkers ?? []),
    ];
    const preferredSet = new Set(preferred);
    const preferredCapabilities = new Set(profile?.preferredCapabilities ?? []);

    return this.list()
      .filter((adapter) => !blocked.has(adapter.worker.id))
      .map((adapter) => {
        let score = 0;
        const reasons: string[] = [];

        if (request.capability && adapter.worker.capabilities.includes(request.capability)) {
          score += 10;
          reasons.push(`supports capability ${request.capability}`);
        }
        if (preferredSet.has(adapter.worker.id)) {
          score += 5;
          reasons.push('preferred by request/profile');
        }
        if (adapter.worker.capabilities.some((cap) => preferredCapabilities.has(cap))) {
          score += 3;
          reasons.push('matches profile-preferred capability');
        }

        return {
          workerId: adapter.worker.id,
          score,
          reasons,
        };
      })
      .sort((a, b) => b.score - a.score || a.workerId.localeCompare(b.workerId));
  }

  select(request: WorkerSelectionRequest, profile?: ForemanProfile): WorkerAdapter<unknown, unknown> | undefined {
    const ranked = this.score(request, profile);
    const top = ranked[0];
    return top ? this.get(top.workerId) : undefined;
  }
}

import { parseJsonOutput, type TextProvider } from '@drew/foreman-providers';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProviderWorkerTask {
  goal: string;
  successCriteria?: string[];
  repoPath?: string;
  extraInstructions?: string;
}

export class ProviderWorkerAdapter implements WorkerAdapter<ProviderWorkerTask, string> {
  constructor(
    public readonly worker: WorkerSpec,
    private readonly provider: TextProvider,
    private readonly promptBuilder: (input: {
      task: ProviderWorkerTask;
      context: WorkerContextSnapshot;
      instructions?: string;
    }) => string,
  ) {}

  async run(input: {
    task: ProviderWorkerTask;
    context: WorkerContextSnapshot;
    instructions?: string;
  }): Promise<WorkerRun & { output?: string }> {
    const prompt = this.promptBuilder(input);
    const execution = await this.provider.run(prompt, {
      cwd: input.task.repoPath,
    });
    const passed = execution.exitCode === 0;

    return {
      worker: this.worker,
      summary: passed
        ? `${this.worker.id} completed successfully`
        : `${this.worker.id} exited with code ${execution.exitCode}`,
      evidence: [
        {
          kind: 'log',
          label: 'stdout',
          value: (execution.rawStdout ?? execution.stdout).trim(),
          metadata: providerExecutionMetadata(execution, this.provider.id),
        },
        {
          kind: 'log',
          label: 'stderr',
          value: execution.stderr.trim(),
          metadata: providerExecutionMetadata(execution, this.provider.id),
        },
      ],
      result: {
        trackId: this.worker.id,
        status: passed ? 'completed' : 'failed',
        summary: passed
          ? `${this.worker.id} completed`
          : `${this.worker.id} failed`,
        output: execution.stdout.trim(),
        evidence: [
          {
            kind: 'log',
            label: 'command',
            value: execution.command.join(' '),
            metadata: providerExecutionMetadata(execution, this.provider.id),
          },
          {
            kind: 'log',
            label: 'stdout',
            value: (execution.rawStdout ?? execution.stdout).trim(),
            metadata: providerExecutionMetadata(execution, this.provider.id),
          },
          {
            kind: 'log',
            label: 'stderr',
            value: execution.stderr.trim(),
            metadata: providerExecutionMetadata(execution, this.provider.id),
          },
        ],
      },
      output: execution.stdout.trim(),
      metrics: {
        durationMs: execution.durationMs,
        costUsd: execution.costUsd,
      },
    };
  }
}

export class ParsedProviderWorkerAdapter<TParsed = unknown> implements WorkerAdapter<ProviderWorkerTask, TParsed> {
  constructor(
    public readonly worker: WorkerSpec,
    private readonly provider: TextProvider,
    private readonly promptBuilder: (input: {
      task: ProviderWorkerTask;
      context: WorkerContextSnapshot;
      instructions?: string;
    }) => string,
    private readonly parser: (stdout: string) => TParsed,
  ) {}

  async run(input: {
    task: ProviderWorkerTask;
    context: WorkerContextSnapshot;
    instructions?: string;
  }): Promise<WorkerRun & { output?: TParsed }> {
    const prompt = this.promptBuilder(input);
    const execution = await this.provider.run(prompt, {
      cwd: input.task.repoPath,
    });
    const passed = execution.exitCode === 0;
    const parsed = passed ? this.parser(execution.stdout) : undefined;

    return {
      worker: this.worker,
      summary: passed
        ? `${this.worker.id} completed successfully`
        : `${this.worker.id} exited with code ${execution.exitCode}`,
      evidence: [
        {
          kind: 'log',
          label: 'stdout',
          value: (execution.rawStdout ?? execution.stdout).trim(),
          metadata: providerExecutionMetadata(execution, this.provider.id),
        },
        {
          kind: 'log',
          label: 'stderr',
          value: execution.stderr.trim(),
          metadata: providerExecutionMetadata(execution, this.provider.id),
        },
      ],
      result: {
        trackId: this.worker.id,
        status: passed ? 'completed' : 'failed',
        summary: passed ? `${this.worker.id} completed` : `${this.worker.id} failed`,
        output: parsed,
        evidence: [
          {
            kind: 'log',
            label: 'command',
            value: execution.command.join(' '),
            metadata: providerExecutionMetadata(execution, this.provider.id),
          },
          {
            kind: 'log',
            label: 'stdout',
            value: (execution.rawStdout ?? execution.stdout).trim(),
            metadata: providerExecutionMetadata(execution, this.provider.id),
          },
          {
            kind: 'log',
            label: 'stderr',
            value: execution.stderr.trim(),
            metadata: providerExecutionMetadata(execution, this.provider.id),
          },
        ],
      },
      output: parsed,
      metrics: {
        durationMs: execution.durationMs,
        costUsd: execution.costUsd,
      },
    };
  }
}

export interface CommandWorkerTask {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export type SupervisorRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'unknown';

export interface SupervisorChildRun {
  id: string;
  kind: 'agent' | 'sandbox' | 'session' | 'task' | 'job' | 'worker';
  status: SupervisorRunStatus;
  summary: string;
  workerId?: string;
  backend?: string;
  sandboxId?: string;
  sessionId?: string;
  traceId?: string;
  startedAt?: string;
  finishedAt?: string;
  artifactUris?: string[];
  metadata?: Record<string, string>;
}

export interface SupervisorFinding {
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  body: string;
  evidence?: string;
  metadata?: Record<string, string>;
}

export interface SupervisorArtifact {
  kind: string;
  label: string;
  value?: string;
  uri?: string;
  path?: string;
  metadata?: Record<string, string>;
}

export interface SupervisorWorkerOutput {
  status: 'completed' | 'failed' | 'partial' | 'blocked' | 'needs_followup';
  summary: string;
  childRuns: SupervisorChildRun[];
  findings: SupervisorFinding[];
  artifacts: SupervisorArtifact[];
  recommendedNextActions: string[];
  metadata?: Record<string, string>;
}

export interface ServiceWorkerTask {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export type ConnectorOutputContract = 'raw-text' | 'supervisor-v1';

export interface CommandConnectorDefinition {
  kind: 'command';
  id: string;
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  capabilities?: WorkerCapability[];
  outputContract?: ConnectorOutputContract;
  metadata?: Record<string, string>;
}

export interface ServiceConnectorDefinition {
  kind: 'service';
  id: string;
  name: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  capabilities?: WorkerCapability[];
  outputContract?: ConnectorOutputContract;
  metadata?: Record<string, string>;
}

export type ConnectorDefinition = CommandConnectorDefinition | ServiceConnectorDefinition;

export interface ConnectorInvocation {
  connectorId: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export class ConnectorRegistry {
  private readonly connectors = new Map<string, ConnectorDefinition>();

  register(connector: ConnectorDefinition): void {
    this.connectors.set(connector.id, connector);
  }

  get(connectorId: string): ConnectorDefinition | undefined {
    return this.connectors.get(connectorId);
  }

  list(): ConnectorDefinition[] {
    return Array.from(this.connectors.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  toCommandTask(invocation: ConnectorInvocation): CommandWorkerTask {
    const connector = this.get(invocation.connectorId);
    if (!connector) {
      throw new Error(`unknown connector ${invocation.connectorId}`);
    }
    if (connector.kind !== 'command') {
      throw new Error(`connector ${invocation.connectorId} is not a command connector`);
    }

    return {
      command: [connector.command, ...(invocation.args ?? [])].join(' ').trim(),
      cwd: invocation.cwd ?? connector.cwd,
      env: {
        ...(connector.env ?? {}),
        ...(invocation.env ?? {}),
      },
    };
  }

  toServiceTask(invocation: ConnectorInvocation): ServiceWorkerTask {
    const connector = this.get(invocation.connectorId);
    if (!connector) {
      throw new Error(`unknown connector ${invocation.connectorId}`);
    }
    if (connector.kind !== 'service') {
      throw new Error(`connector ${invocation.connectorId} is not a service connector`);
    }

    return {
      url: invocation.url ?? connector.url,
      method: invocation.method ?? connector.method ?? 'POST',
      headers: {
        ...(connector.headers ?? {}),
        ...(invocation.headers ?? {}),
      },
      body: invocation.body ?? connector.body,
      timeoutMs: invocation.timeoutMs ?? connector.timeoutMs,
    };
  }

  createWorker(connectorId: string): WorkerAdapter<unknown, unknown> {
    const connector = this.get(connectorId);
    if (!connector) {
      throw new Error(`unknown connector ${connectorId}`);
    }

    if (connector.kind === 'command') {
      if (connector.outputContract === 'supervisor-v1') {
        return new SupervisorCommandWorkerAdapter({
          id: connector.id,
          name: connector.name,
          capabilities: connector.capabilities ?? ['review', 'ops'],
          metadata: {
            ...(connector.metadata ?? {}),
            outputContract: 'supervisor-v1',
          },
        });
      }
      return new CommandWorkerAdapter({
        id: connector.id,
        name: connector.name,
        capabilities: connector.capabilities ?? ['ops'],
        metadata: connector.metadata,
      });
    }

    if (connector.outputContract === 'supervisor-v1') {
      return new SupervisorServiceWorkerAdapter({
        id: connector.id,
        name: connector.name,
        capabilities: connector.capabilities ?? ['review', 'ops'],
        metadata: {
          ...(connector.metadata ?? {}),
          outputContract: 'supervisor-v1',
        },
      });
    }

    return new ServiceWorkerAdapter({
      id: connector.id,
      name: connector.name,
      capabilities: connector.capabilities ?? ['ops'],
      metadata: connector.metadata,
    });
  }
}

export interface ToolDefinition {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  capabilities?: WorkerCapability[];
  metadata?: Record<string, string>;
}

export interface ToolInvocation {
  toolId: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export class ToolRegistry {
  private readonly connectors = new ConnectorRegistry();

  register(tool: ToolDefinition): void {
    this.connectors.register({
      ...tool,
      kind: 'command',
    });
  }

  get(toolId: string): ToolDefinition | undefined {
    const connector = this.connectors.get(toolId);
    return connector?.kind === 'command' ? connector : undefined;
  }

  list(): ToolDefinition[] {
    return this.connectors
      .list()
      .filter((connector): connector is CommandConnectorDefinition => connector.kind === 'command');
  }

  toCommandTask(invocation: ToolInvocation): CommandWorkerTask {
    return this.connectors.toCommandTask({
      ...invocation,
      connectorId: invocation.toolId,
    });
  }

  createWorker(toolId: string): CommandWorkerAdapter {
    return this.connectors.createWorker(toolId) as CommandWorkerAdapter;
  }
}

export class ServiceWorkerAdapter implements WorkerAdapter<ServiceWorkerTask, unknown> {
  constructor(public readonly worker: WorkerSpec) {}

  async run(input: {
    task: ServiceWorkerTask;
    context: WorkerContextSnapshot;
    instructions?: string;
  }): Promise<WorkerRun & { output?: unknown }> {
    const controller = new AbortController();
    const timeoutMs = input.task.timeoutMs ?? 60_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAtMs = Date.now();

    let responseStatus = 0;
    let responseText = '';
    let responseHeaders: Record<string, string> = {};
    let passed = false;
    let errorMessage = '';

    try {
      const response = await fetch(input.task.url, {
        method: input.task.method ?? 'POST',
        headers: input.task.headers,
        body: input.task.body,
        signal: controller.signal,
      });
      responseStatus = response.status;
      responseHeaders = Object.fromEntries(response.headers.entries());
      responseText = await response.text();
      passed = response.ok;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      responseText = errorMessage;
      passed = false;
    } finally {
      clearTimeout(timeout);
    }

    const durationMs = Date.now() - startedAtMs;
    const summary = passed
      ? `${this.worker.id} service call completed`
      : `${this.worker.id} service call failed`;
    const parsedOutput = parseServiceOutput(responseText, responseHeaders['content-type']);

    return {
      worker: this.worker,
      summary,
      evidence: [
        {
          kind: 'log',
          label: 'request',
          value: `${input.task.method ?? 'POST'} ${input.task.url}`,
          metadata: {
            durationMs: String(durationMs),
            status: String(responseStatus),
          },
        },
        {
          kind: 'log',
          label: 'response',
          value: responseText.trim(),
          metadata: {
            durationMs: String(durationMs),
            status: String(responseStatus),
            contentType: responseHeaders['content-type'] ?? '',
            error: errorMessage,
          },
        },
      ],
      result: {
        trackId: this.worker.id,
        status: passed ? 'completed' : 'failed',
        summary,
        output: parsedOutput,
        evidence: [
          {
            kind: 'log',
            label: 'request',
            value: `${input.task.method ?? 'POST'} ${input.task.url}`,
            metadata: {
              durationMs: String(durationMs),
              status: String(responseStatus),
            },
          },
          {
            kind: 'log',
            label: 'response',
            value: responseText.trim(),
            metadata: {
              durationMs: String(durationMs),
              status: String(responseStatus),
              contentType: responseHeaders['content-type'] ?? '',
              error: errorMessage,
            },
          },
        ],
      },
      output: parsedOutput,
      metrics: {
        durationMs,
      },
    };
  }
}

function parseServiceOutput(text: string, contentType?: string): unknown {
  if (contentType?.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export class SupervisorServiceWorkerAdapter implements WorkerAdapter<ServiceWorkerTask, SupervisorWorkerOutput> {
  constructor(public readonly worker: WorkerSpec) {}

  async run(input: {
    task: ServiceWorkerTask;
    context: WorkerContextSnapshot;
    instructions?: string;
  }): Promise<WorkerRun & { output?: SupervisorWorkerOutput }> {
    const controller = new AbortController();
    const timeoutMs = input.task.timeoutMs ?? 60_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAtMs = Date.now();

    let responseStatus = 0;
    let responseText = '';
    let responseHeaders: Record<string, string> = {};
    let passed = false;
    let errorMessage = '';

    try {
      const response = await fetch(input.task.url, {
        method: input.task.method ?? 'POST',
        headers: input.task.headers,
        body: input.task.body,
        signal: controller.signal,
      });
      responseStatus = response.status;
      responseHeaders = Object.fromEntries(response.headers.entries());
      responseText = await response.text();
      passed = response.ok;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      responseText = errorMessage;
      passed = false;
    } finally {
      clearTimeout(timeout);
    }

    const durationMs = Date.now() - startedAtMs;
    const parsed = passed ? tryParseSupervisorOutput(responseText) : undefined;
    const summary = parsed?.summary ?? (
      passed
        ? `${this.worker.id} orchestrator completed`
        : `${this.worker.id} orchestrator failed`
    );

    return {
      worker: this.worker,
      summary,
      evidence: buildSupervisorEvidence({
        requestLabel: `${input.task.method ?? 'POST'} ${input.task.url}`,
        responseText,
        durationMs,
        statusCode: responseStatus,
        parsed,
        errorMessage,
        contentType: responseHeaders['content-type'],
      }),
      result: {
        trackId: this.worker.id,
        status: mapSupervisorTrackStatus(parsed?.status, passed),
        summary,
        output: parsed,
        evidence: buildSupervisorEvidence({
          requestLabel: `${input.task.method ?? 'POST'} ${input.task.url}`,
          responseText,
          durationMs,
          statusCode: responseStatus,
          parsed,
          errorMessage,
          contentType: responseHeaders['content-type'],
        }),
      },
      output: parsed,
      metrics: {
        durationMs,
      },
    };
  }
}

export class CommandWorkerAdapter implements WorkerAdapter<CommandWorkerTask, string> {
  constructor(public readonly worker: WorkerSpec) {}

  async run(input: {
    task: CommandWorkerTask;
    context: WorkerContextSnapshot;
    instructions?: string;
  }): Promise<WorkerRun & { output?: string }> {
    if (!input.task.command.trim()) {
      throw new Error('command worker received an empty command');
    }

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    const startedAtMs = Date.now();
    try {
      const output = await execFileAsync('bash', ['-lc', input.task.command], {
        cwd: input.task.cwd,
        env: {
          ...process.env,
          ...input.task.env,
        },
        timeout: 10 * 60 * 1000,
      });
      stdout = output.stdout ?? '';
      stderr = output.stderr ?? '';
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? String(error);
      exitCode = typeof err.code === 'number' ? err.code : 1;
    }

    const passed = exitCode === 0;
    const summary = passed
      ? `${this.worker.id} command completed`
      : `${this.worker.id} command failed`;
    const durationMs = Date.now() - startedAtMs;

    return {
      worker: this.worker,
      summary,
      evidence: [
        {
          kind: 'log',
          label: 'stdout',
          value: stdout.trim(),
          metadata: {
            durationMs: String(durationMs),
            exitCode: String(exitCode),
          },
        },
        {
          kind: 'log',
          label: 'stderr',
          value: stderr.trim(),
          metadata: {
            durationMs: String(durationMs),
            exitCode: String(exitCode),
          },
        },
      ],
      result: {
        trackId: this.worker.id,
        status: passed ? 'completed' : 'failed',
        summary,
        output: stdout.trim(),
        evidence: [
          {
            kind: 'log',
            label: 'command',
            value: input.task.command,
            metadata: {
              durationMs: String(durationMs),
              exitCode: String(exitCode),
            },
          },
          {
            kind: 'log',
            label: 'stdout',
            value: stdout.trim(),
            metadata: {
              durationMs: String(durationMs),
            },
          },
          {
            kind: 'log',
            label: 'stderr',
            value: stderr.trim(),
            metadata: {
              durationMs: String(durationMs),
            },
          },
        ],
      },
      output: stdout.trim(),
      metrics: {
        durationMs,
      },
    };
  }
}

export class SupervisorCommandWorkerAdapter implements WorkerAdapter<CommandWorkerTask, SupervisorWorkerOutput> {
  constructor(public readonly worker: WorkerSpec) {}

  async run(input: {
    task: CommandWorkerTask;
    context: WorkerContextSnapshot;
    instructions?: string;
  }): Promise<WorkerRun & { output?: SupervisorWorkerOutput }> {
    if (!input.task.command.trim()) {
      throw new Error('supervisor command worker received an empty command');
    }

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    const startedAtMs = Date.now();
    try {
      const output = await execFileAsync('bash', ['-lc', input.task.command], {
        cwd: input.task.cwd,
        env: {
          ...process.env,
          ...input.task.env,
        },
        timeout: 10 * 60 * 1000,
      });
      stdout = output.stdout ?? '';
      stderr = output.stderr ?? '';
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      stdout = err.stdout ?? '';
      stderr = err.stderr ?? String(error);
      exitCode = typeof err.code === 'number' ? err.code : 1;
    }

    const durationMs = Date.now() - startedAtMs;
    const passed = exitCode === 0;
    const parsed = passed ? tryParseSupervisorOutput(stdout) : undefined;
    const summary = parsed?.summary ?? (
      passed
        ? `${this.worker.id} orchestrator completed`
        : `${this.worker.id} orchestrator failed`
    );

    return {
      worker: this.worker,
      summary,
      evidence: buildSupervisorEvidence({
        requestLabel: input.task.command,
        responseText: stdout,
        stderrText: stderr,
        durationMs,
        exitCode,
        parsed,
      }),
      result: {
        trackId: this.worker.id,
        status: mapSupervisorTrackStatus(parsed?.status, passed),
        summary,
        output: parsed,
        evidence: buildSupervisorEvidence({
          requestLabel: input.task.command,
          responseText: stdout,
          stderrText: stderr,
          durationMs,
          exitCode,
          parsed,
        }),
      },
      output: parsed,
      metrics: {
        durationMs,
      },
    };
  }
}

function tryParseSupervisorOutput(stdout: string): SupervisorWorkerOutput | undefined {
  if (!stdout.trim()) {
    return undefined;
  }
  try {
    return normalizeSupervisorOutput(parseJsonOutput(stdout));
  } catch {
    return undefined;
  }
}

function normalizeSupervisorOutput(value: unknown): SupervisorWorkerOutput {
  const record = isRecord(value) ? value : {};
  return {
    status: normalizeSupervisorOutputStatus(record.status),
    summary: stringValue(record.summary, 'Supervisor run completed.'),
    childRuns: Array.isArray(record.childRuns)
      ? record.childRuns.filter(isRecord).map((child, index) => ({
          id: stringValue(child.id, `child-${index + 1}`),
          kind: normalizeChildKind(child.kind),
          status: normalizeSupervisorRunStatus(child.status),
          summary: stringValue(child.summary, 'No summary provided.'),
          workerId: optionalString(child.workerId),
          backend: optionalString(child.backend),
          sandboxId: optionalString(child.sandboxId),
          sessionId: optionalString(child.sessionId),
          traceId: optionalString(child.traceId),
          startedAt: optionalString(child.startedAt),
          finishedAt: optionalString(child.finishedAt),
          artifactUris: stringArray(child.artifactUris),
          metadata: recordStringMap(child.metadata),
        }))
      : [],
    findings: Array.isArray(record.findings)
      ? record.findings.filter(isRecord).map((finding) => ({
          severity: normalizeFindingSeverity(finding.severity),
          title: stringValue(finding.title, 'Finding'),
          body: stringValue(finding.body, 'No details provided.'),
          evidence: optionalString(finding.evidence),
          metadata: recordStringMap(finding.metadata),
        }))
      : [],
    artifacts: Array.isArray(record.artifacts)
      ? record.artifacts.filter(isRecord).map((artifact, index) => ({
          kind: stringValue(artifact.kind, 'artifact'),
          label: stringValue(artifact.label, `artifact-${index + 1}`),
          value: optionalString(artifact.value),
          uri: optionalString(artifact.uri),
          path: optionalString(artifact.path),
          metadata: recordStringMap(artifact.metadata),
        }))
      : [],
    recommendedNextActions: stringArray(record.recommendedNextActions),
    metadata: recordStringMap(record.metadata),
  };
}

function buildSupervisorEvidence(input: {
  requestLabel: string;
  responseText: string;
  stderrText?: string;
  durationMs: number;
  exitCode?: number;
  statusCode?: number;
  parsed?: SupervisorWorkerOutput;
  errorMessage?: string;
  contentType?: string;
}): WorkerTrackResult['evidence'] {
  const evidence: WorkerTrackResult['evidence'] = [
    {
      kind: 'log',
      label: 'request',
      value: input.requestLabel,
      metadata: {
        durationMs: String(input.durationMs),
        ...(input.exitCode !== undefined ? { exitCode: String(input.exitCode) } : {}),
        ...(input.statusCode !== undefined ? { statusCode: String(input.statusCode) } : {}),
      },
    },
    {
      kind: 'log',
      label: 'stdout',
      value: input.responseText.trim(),
      metadata: {
        durationMs: String(input.durationMs),
        ...(input.exitCode !== undefined ? { exitCode: String(input.exitCode) } : {}),
        ...(input.statusCode !== undefined ? { statusCode: String(input.statusCode) } : {}),
        ...(input.contentType ? { contentType: input.contentType } : {}),
      },
    },
  ];

  if (input.stderrText !== undefined) {
    evidence.push({
      kind: 'log',
      label: 'stderr',
      value: input.stderrText.trim(),
      metadata: {
        durationMs: String(input.durationMs),
        ...(input.exitCode !== undefined ? { exitCode: String(input.exitCode) } : {}),
      },
    });
  }

  if (input.errorMessage) {
    evidence.push({
      kind: 'log',
      label: 'error',
      value: input.errorMessage,
      metadata: {
        durationMs: String(input.durationMs),
      },
    });
  }

  for (const child of input.parsed?.childRuns ?? []) {
    evidence.push({
      kind: 'child-run',
      label: child.id,
      value: child.summary,
      metadata: {
        status: child.status,
        kind: child.kind,
        ...(child.workerId ? { workerId: child.workerId } : {}),
        ...(child.backend ? { backend: child.backend } : {}),
        ...(child.sandboxId ? { sandboxId: child.sandboxId } : {}),
        ...(child.sessionId ? { sessionId: child.sessionId } : {}),
        ...(child.traceId ? { traceId: child.traceId } : {}),
      },
    });
  }

  for (const finding of input.parsed?.findings ?? []) {
    evidence.push({
      kind: 'finding',
      label: finding.title,
      value: finding.body,
      metadata: {
        severity: finding.severity,
        ...(finding.evidence ? { evidence: finding.evidence } : {}),
      },
    });
  }

  for (const artifact of input.parsed?.artifacts ?? []) {
    evidence.push({
      kind: artifact.kind,
      label: artifact.label,
      value: artifact.value ?? artifact.path ?? artifact.uri ?? '',
      uri: artifact.uri,
      metadata: artifact.metadata,
    });
  }

  for (const [index, action] of (input.parsed?.recommendedNextActions ?? []).entries()) {
    evidence.push({
      kind: 'next-action',
      label: `next-action-${index + 1}`,
      value: action,
    });
  }

  return evidence;
}

function mapSupervisorTrackStatus(
  status: SupervisorWorkerOutput['status'] | undefined,
  passed: boolean,
): WorkerTrackResult['status'] {
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'failed' || status === 'blocked') {
    return 'failed';
  }
  if (status === 'partial' || status === 'needs_followup') {
    return 'running';
  }
  return passed ? 'completed' : 'failed';
}

function normalizeSupervisorOutputStatus(value: unknown): SupervisorWorkerOutput['status'] {
  return value === 'completed'
    || value === 'failed'
    || value === 'partial'
    || value === 'blocked'
    || value === 'needs_followup'
    ? value
    : 'needs_followup';
}

function normalizeSupervisorRunStatus(value: unknown): SupervisorRunStatus {
  return value === 'pending'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'blocked'
    || value === 'cancelled'
    || value === 'unknown'
    ? value
    : 'unknown';
}

function normalizeChildKind(value: unknown): SupervisorChildRun['kind'] {
  return value === 'agent'
    || value === 'sandbox'
    || value === 'session'
    || value === 'task'
    || value === 'job'
    || value === 'worker'
    ? value
    : 'task';
}

function normalizeFindingSeverity(value: unknown): SupervisorFinding['severity'] {
  return value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'critical'
    ? value
    : 'medium';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function recordStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null)
    .map(([key, entryValue]) => [key, String(entryValue)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
