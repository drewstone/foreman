import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export interface ProviderExecution {
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  costUsd?: number;
  rawStdout?: string;
  metadata?: Record<string, string>;
}

export interface TextProvider {
  id: string;
  run(prompt: string, options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<ProviderExecution>;
}

export interface ProviderSessionSummary {
  providerId: string;
  sessionId: string;
  title: string;
  summary?: string;
  cwd?: string;
  sourcePath?: string;
  createdAt?: string;
  updatedAt?: string;
  firstPrompt?: string;
  metadata?: Record<string, string>;
}

export interface ProviderSessionRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  model?: string;
  binary?: string;
  targetUrl?: string;
}

export interface ProviderSessionRunResult extends ProviderExecution {
  sessionId?: string;
}

export interface SessionDriver {
  id: string;
  listRecent(options?: {
    cwd?: string;
    limit?: number;
  }): Promise<ProviderSessionSummary[]>;
  start(prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult>;
  continue(sessionId: string, prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult>;
  continueLast(prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult>;
  fork?(sessionId: string, prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult>;
}

export function parseJsonOutput(raw: string): unknown {
  const text = raw.trim();
  if (!text) {
    throw new Error('empty provider output');
  }
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim());
    }
    // Try to find the last valid JSON object/array by scanning from the end.
    const lastBrace = text.lastIndexOf('}');
    const lastBracket = text.lastIndexOf(']');
    if (lastBrace >= 0) {
      const candidate = extractBalancedJson(text, '{', '}', lastBrace);
      if (candidate) {
        try { return JSON.parse(candidate); } catch { /* try next */ }
      }
    }
    if (lastBracket >= 0) {
      const candidate = extractBalancedJson(text, '[', ']', lastBracket);
      if (candidate) {
        try { return JSON.parse(candidate); } catch { /* try next */ }
      }
    }
    throw new Error('provider output did not contain valid JSON');
  }
}

function extractBalancedJson(text: string, open: string, close: string, closeIndex: number): string | undefined {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i--) {
    if (text[i] === close) {
      depth++;
    } else if (text[i] === open) {
      depth--;
    }
    if (depth === 0) {
      return text.slice(i, closeIndex + 1);
    }
  }
  return undefined;
}

export class CommandTextProvider implements TextProvider {
  constructor(
    public readonly id: string,
    private readonly commandBuilder: (prompt: string) => string[],
  ) {}

  async run(
    prompt: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<ProviderExecution> {
    const command = this.commandBuilder(prompt);
    if (!command[0]) {
      throw new Error(`provider ${this.id} built an empty command`);
    }
    return runProviderCommand(command, options);
  }
}

export class CommandSessionDriver implements SessionDriver {
  constructor(
    public readonly id: string,
    private readonly commandRunner: (command: string[], options?: ProviderSessionRunOptions) => Promise<ProviderExecution>,
    private readonly listImpl: (options?: { cwd?: string; limit?: number }) => Promise<ProviderSessionSummary[]>,
    private readonly commandBuilder: {
      start(prompt: string, options?: ProviderSessionRunOptions): { command: string[]; sessionId?: string };
      continue(sessionId: string, prompt: string, options?: ProviderSessionRunOptions): { command: string[]; sessionId?: string };
      continueLast(prompt: string, options?: ProviderSessionRunOptions): { command: string[]; sessionId?: string };
      fork?: (sessionId: string, prompt: string, options?: ProviderSessionRunOptions) => { command: string[]; sessionId?: string };
    },
  ) {}

  listRecent(options?: { cwd?: string; limit?: number }): Promise<ProviderSessionSummary[]> {
    return this.listImpl(options);
  }

  async start(prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult> {
    const built = this.commandBuilder.start(prompt, options);
    const execution = await this.commandRunner(built.command, options);
    return {
      ...execution,
      sessionId: built.sessionId,
    };
  }

  async continue(sessionId: string, prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult> {
    const built = this.commandBuilder.continue(sessionId, prompt, options);
    const execution = await this.commandRunner(built.command, options);
    return {
      ...execution,
      sessionId: built.sessionId ?? sessionId,
    };
  }

  async continueLast(prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult> {
    const built = this.commandBuilder.continueLast(prompt, options);
    const execution = await this.commandRunner(built.command, options);
    return {
      ...execution,
      sessionId: built.sessionId,
    };
  }

  async fork(sessionId: string, prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult> {
    if (!this.commandBuilder.fork) {
      throw new Error(`session driver ${this.id} does not support fork`);
    }
    const built = this.commandBuilder.fork(sessionId, prompt, options);
    const execution = await this.commandRunner(built.command, options);
    return {
      ...execution,
      sessionId: built.sessionId ?? sessionId,
    };
  }
}

export function createCodexProvider(id = 'codex', providerOptions?: { model?: string }): TextProvider {
  return {
    id,
    async run(prompt, options) {
      const execution = await runProviderCommand(
        [
          'codex', 'exec', '--full-auto', '--json',
          ...(providerOptions?.model ? ['--model', providerOptions.model] : []),
          ...(options?.cwd ? ['-C', options.cwd] : []),
          prompt,
        ],
        options,
      );
      return normalizeCodexExecution(execution);
    },
  };
}

export function createClaudeProvider(id = 'claude', providerOptions?: { model?: string }): TextProvider {
  return {
    id,
    async run(prompt, options) {
      const execution = await runProviderCommand(
        [
          'claude',
          '--dangerously-skip-permissions',
          '-p',
          '--output-format', 'json',
          ...(providerOptions?.model ? ['--model', providerOptions.model] : []),
          prompt,
        ],
        options,
      );
      return normalizeClaudeExecution(execution);
    },
  };
}

export function createCodexSessionDriver(id = 'codex'): SessionDriver {
  return new CommandSessionDriver(
    id,
    runProviderCommand,
    listRecentCodexSessions,
    {
      start(prompt, options) {
        return {
          command: [
            'codex',
            'exec',
            '--full-auto',
            ...(options?.model ? ['--model', options.model] : []),
            ...(options?.cwd ? ['-C', options.cwd] : []),
            prompt,
          ],
        };
      },
      continue(sessionId, prompt, options) {
        return {
          command: [
            'codex',
            'exec',
            'resume',
            ...(options?.model ? ['--model', options.model] : []),
            ...(options?.cwd ? ['-C', options.cwd] : []),
            sessionId,
            prompt,
          ],
          sessionId,
        };
      },
      continueLast(prompt, options) {
        return {
          command: [
            'codex',
            'exec',
            'resume',
            '--last',
            ...(options?.model ? ['--model', options.model] : []),
            ...(options?.cwd ? ['-C', options.cwd] : []),
            prompt,
          ],
        };
      },
    },
  );
}

export function createClaudeSessionDriver(id = 'claude'): SessionDriver {
  return new CommandSessionDriver(
    id,
    runProviderCommand,
    listRecentClaudeSessions,
    {
      start(prompt, options) {
        const sessionId = randomUUID();
        return {
          command: [
            'claude',
            '--dangerously-skip-permissions',
            '-p',
            '--output-format',
            'text',
            '--session-id',
            sessionId,
            ...(options?.model ? ['--model', options.model] : []),
            prompt,
          ],
          sessionId,
        };
      },
      continue(sessionId, prompt, options) {
        return {
          command: [
            'claude',
            '--dangerously-skip-permissions',
            '-p',
            '--output-format',
            'text',
            '--resume',
            sessionId,
            ...(options?.model ? ['--model', options.model] : []),
            prompt,
          ],
          sessionId,
        };
      },
      continueLast(prompt, options) {
        return {
          command: [
            'claude',
            '--dangerously-skip-permissions',
            '-p',
            '--output-format',
            'text',
            '--continue',
            ...(options?.model ? ['--model', options.model] : []),
            prompt,
          ],
        };
      },
    },
  );
}

export function createOpencodeSessionDriver(id = 'opencode'): SessionDriver {
  return new CommandSessionDriver(
    id,
    runProviderCommand,
    listRecentOpencodeSessions,
    {
      start(prompt, options) {
        return {
          command: [
            'opencode',
            'run',
            ...(options?.model ? ['--model', options.model] : []),
            prompt,
          ],
        };
      },
      continue(sessionId, prompt, options) {
        return {
          command: [
            'opencode',
            'run',
            '-s',
            sessionId,
            ...(options?.model ? ['--model', options.model] : []),
            prompt,
          ],
          sessionId,
        };
      },
      continueLast(prompt, options) {
        return {
          command: [
            'opencode',
            'run',
            '-c',
            ...(options?.model ? ['--model', options.model] : []),
            prompt,
          ],
        };
      },
    },
  );
}

export function createOpenclawSessionDriver(id = 'openclaw'): SessionDriver {
  return new OpenclawSessionDriver(id);
}

export function createBrowserSessionDriver(id = 'browser'): SessionDriver {
  return new BrowserCliSessionDriver(id);
}

class OpenclawSessionDriver implements SessionDriver {
  constructor(public readonly id: string) {}

  async listRecent(options?: { cwd?: string; limit?: number }): Promise<ProviderSessionSummary[]> {
    const execution = await runProviderCommand(
      [
        this.binary(options),
        'sessions',
        '--all-agents',
        '--json',
      ],
      options,
    );
    if (execution.exitCode !== 0) {
      return [];
    }

    const parsed = parseJsonOutput(execution.stdout);
    const cronSummaries = await loadOpenclawCronSummaryIndex();
    return parseOpenclawSessionSummaries(parsed, cronSummaries)
      .slice(0, options?.limit ?? 50);
  }

  async start(prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult> {
    const sessionId = randomUUID();
    const execution = await runProviderCommand(
      [
        this.binary(options),
        'agent',
        '--json',
        '--local',
        '--session-id',
        sessionId,
        '--message',
        prompt,
      ],
      options,
    );
    return {
      ...execution,
      sessionId,
    };
  }

  async continue(sessionId: string, prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult> {
    const execution = await runProviderCommand(
      [
        this.binary(options),
        'agent',
        '--json',
        '--local',
        '--session-id',
        sessionId,
        '--message',
        prompt,
      ],
      options,
    );
    return {
      ...execution,
      sessionId,
    };
  }

  async continueLast(prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult> {
    const recent = await this.listRecent({
      cwd: options?.cwd,
      limit: 1,
    });
    const latest = recent[0];
    if (!latest) {
      throw new Error('no recent openclaw sessions found to continue');
    }
    return this.continue(latest.sessionId, prompt, options);
  }

  private binary(options?: ProviderSessionRunOptions): string {
    return options?.binary
      || process.env.OPENCLAW_BIN
      || 'openclaw';
  }
}

class BrowserCliSessionDriver implements SessionDriver {
  constructor(public readonly id: string) {}

  async listRecent(options?: { cwd?: string; limit?: number }): Promise<ProviderSessionSummary[]> {
    const execution = await runProviderCommand(
      [
        ...this.commandPrefix(options),
        'runs',
        '--json',
      ],
      options,
    );
    if (execution.exitCode !== 0) {
      throw new Error(`browser run listing failed: ${execution.stderr || execution.stdout || execution.exitCode}`);
    }
    const stdout = execution.stdout.trim();
    if (/no runs found/i.test(stdout)) {
      return [];
    }
    return parseBrowserRunSummaries(parseJsonOutput(stdout), options?.cwd)
      .slice(0, options?.limit ?? 50);
  }

  async start(prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult> {
    if (!options?.targetUrl) {
      throw new Error('browser session start requires targetUrl');
    }
    return this.executeRunCommand(
      [
        ...this.commandPrefix(options),
        'run',
        '--goal',
        prompt,
        '--url',
        options.targetUrl,
        '--json',
      ],
      options,
    );
  }

  async continue(sessionId: string, prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult> {
    return this.executeRunCommand(
      [
        ...this.commandPrefix(options),
        'run',
        '--resume-run',
        sessionId,
        ...(prompt ? ['--goal', prompt] : []),
        '--json',
      ],
      options,
      sessionId,
    );
  }

  async continueLast(prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult> {
    const recent = await this.listRecent({
      cwd: options?.cwd,
      limit: 1,
    });
    const latest = recent[0];
    if (!latest) {
      throw new Error('no recent browser runs found to continue');
    }
    return this.continue(latest.sessionId, prompt, options);
  }

  async fork(sessionId: string, prompt: string, options?: ProviderSessionRunOptions): Promise<ProviderSessionRunResult> {
    return this.executeRunCommand(
      [
        ...this.commandPrefix(options),
        'run',
        '--fork-run',
        sessionId,
        ...(prompt ? ['--goal', prompt] : []),
        '--json',
      ],
      options,
      sessionId,
    );
  }

  private commandPrefix(options?: ProviderSessionRunOptions): string[] {
    return [
      options?.binary
        || process.env.BROWSER_AGENT_DRIVER_BIN
        || 'bad',
    ];
  }

  private async executeRunCommand(
    command: string[],
    options?: ProviderSessionRunOptions,
    fallbackSessionId?: string,
  ): Promise<ProviderSessionRunResult> {
    const execution = await runProviderCommand(command, options);
    const resolvedSessionId = extractBrowserRunId(execution.stdout) ?? fallbackSessionId;
    return {
      ...execution,
      sessionId: resolvedSessionId,
    };
  }
}

async function runProviderCommand(
  command: string[],
  options?: ProviderSessionRunOptions,
): Promise<ProviderExecution> {
  const [bin, ...args] = command;
  if (!bin) {
    throw new Error('provider session driver built an empty command');
  }

  return new Promise<ProviderExecution>((resolve, reject) => {
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const child = spawn(bin, args, {
      cwd: options?.cwd,
      env: {
        ...process.env,
        ...options?.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = options?.timeoutMs ?? 15 * 60 * 1000;
    const maxOutputBytes = 10 * 1024 * 1024;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
      reject(new Error(`provider session driver timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxOutputBytes) {
        stdout += String(chunk);
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxOutputBytes) {
        stderr += String(chunk);
      }
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        stdout,
        stderr,
        exitCode: exitCode ?? -1,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
      });
    });
  });
}

async function listRecentClaudeSessions(options?: {
  cwd?: string;
  limit?: number;
}): Promise<ProviderSessionSummary[]> {
  const root = resolve(homedir(), '.claude', 'projects');
  let projectDirs: string[] = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    projectDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  } catch {
    return [];
  }

  const summaries: ProviderSessionSummary[] = [];
  for (const dir of projectDirs) {
    const indexPath = join(dir, 'sessions-index.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(indexPath, 'utf8'));
    } catch {
      continue;
    }
    const entries = isRecord(parsed) && Array.isArray(parsed.entries) ? parsed.entries : [];
    for (const entry of entries) {
      if (!isRecord(entry)) {
        continue;
      }
      const cwd = optionalString(entry.projectPath);
      if (options?.cwd && cwd && resolve(cwd) !== resolve(options.cwd)) {
        continue;
      }
      summaries.push({
        providerId: 'claude',
        sessionId: stringValue(entry.sessionId, ''),
        title: stringValue(entry.summary, 'Claude session'),
        summary: optionalString(entry.summary),
        cwd,
        sourcePath: optionalString(entry.fullPath),
        createdAt: optionalString(entry.created),
        updatedAt: optionalString(entry.modified) ?? fromEpochMillis(entry.fileMtime),
        firstPrompt: optionalString(entry.firstPrompt),
        metadata: recordStringMap({
          gitBranch: entry.gitBranch,
          messageCount: entry.messageCount,
          isSidechain: entry.isSidechain,
        }),
      });
    }
  }

  return summaries
    .filter((summary) => Boolean(summary.sessionId))
    .sort((a, b) => compareIsoDates(b.updatedAt, a.updatedAt))
    .slice(0, options?.limit ?? 50);
}

async function listRecentCodexSessions(options?: {
  cwd?: string;
  limit?: number;
}): Promise<ProviderSessionSummary[]> {
  const historyPath = resolve(homedir(), '.codex', 'history.jsonl');
  let raw = '';
  try {
    raw = await readFile(historyPath, 'utf8');
  } catch {
    return [];
  }

  const bySession = new Map<string, {
    firstText?: string;
    latestText?: string;
    firstTs?: number;
    lastTs?: number;
  }>();

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const sessionId = optionalString(parsed.session_id);
    if (!sessionId) {
      continue;
    }
    const ts = typeof parsed.ts === 'number' ? parsed.ts : undefined;
    const text = optionalString(parsed.text);
    const current = bySession.get(sessionId) ?? {};
    if (!current.firstText && text) {
      current.firstText = text;
    }
    if (text) {
      current.latestText = text;
    }
    if (ts !== undefined) {
      current.firstTs = current.firstTs === undefined ? ts : Math.min(current.firstTs, ts);
      current.lastTs = current.lastTs === undefined ? ts : Math.max(current.lastTs, ts);
    }
    bySession.set(sessionId, current);
  }

  return Array.from(bySession.entries())
    .map(([sessionId, entry]) => ({
      providerId: 'codex',
      sessionId,
      title: summarizeText(entry.firstText ?? entry.latestText ?? 'Codex session'),
      summary: summarizeText(entry.latestText ?? entry.firstText ?? ''),
      createdAt: fromEpochSeconds(entry.firstTs),
      updatedAt: fromEpochSeconds(entry.lastTs),
      firstPrompt: entry.firstText,
      metadata: recordStringMap({
        source: historyPath,
      }),
    }))
    .sort((a, b) => compareIsoDates(b.updatedAt, a.updatedAt))
    .slice(0, options?.limit ?? 50);
}

async function listRecentOpencodeSessions(options?: {
  cwd?: string;
  limit?: number;
}): Promise<ProviderSessionSummary[]> {
  const execution = await runProviderCommand(
    ['opencode', 'session', 'list'],
    options,
  );
  if (execution.exitCode !== 0) {
    return [];
  }

  const sessionIds = parseOpencodeSessionList(execution.stdout);
  const summaries: ProviderSessionSummary[] = [];
  const maxItems = options?.limit ?? 50;

  for (const session of sessionIds.slice(0, maxItems)) {
    const exported = await exportOpencodeSession(session.sessionId, options);
    if (!exported) {
      summaries.push({
        providerId: 'opencode',
        sessionId: session.sessionId,
        title: session.title,
        updatedAt: session.updatedAtText,
      });
      continue;
    }
    if (options?.cwd && exported.cwd && resolve(exported.cwd) !== resolve(options.cwd)) {
      continue;
    }
    summaries.push({
      providerId: 'opencode',
      sessionId: session.sessionId,
      title: exported.title ?? session.title,
      summary: exported.summary,
      cwd: exported.cwd,
      createdAt: exported.createdAt,
      updatedAt: exported.updatedAt,
      firstPrompt: exported.firstPrompt,
      metadata: recordStringMap({
        slug: exported.slug,
        projectId: exported.projectId,
        version: exported.version,
        providerId: exported.providerId,
        modelId: exported.modelId,
        costUsd: exported.costUsd,
      }),
    });
  }

  return summaries
    .sort((a, b) => compareIsoDates(b.updatedAt, a.updatedAt))
    .slice(0, maxItems);
}

async function loadOpenclawCronSummaryIndex(): Promise<Map<string, {
  summary?: string;
  updatedAt?: string;
  status?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  jobId?: string;
}>> {
  const root = resolve(homedir(), '.openclaw', 'cron', 'runs');
  let files: string[] = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => join(root, entry.name))
      .sort()
      .slice(-500);
  } catch {
    return new Map();
  }

  const index = new Map<string, {
    summary?: string;
    updatedAt?: string;
    status?: string;
    sessionKey?: string;
    provider?: string;
    model?: string;
    jobId?: string;
  }>();

  for (const file of files) {
    let raw = '';
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) {
        continue;
      }
      const sessionId = optionalString(parsed.sessionId);
      if (!sessionId) {
        continue;
      }
      const ts = typeof parsed.ts === 'number'
        ? parsed.ts
        : typeof parsed.runAtMs === 'number'
          ? parsed.runAtMs
          : undefined;
      const updatedAt = fromEpochMillis(ts);
      const current = index.get(sessionId);
      if (current?.updatedAt && updatedAt && compareIsoDates(current.updatedAt, updatedAt) >= 0) {
        continue;
      }
      index.set(sessionId, {
        summary: optionalString(parsed.summary),
        updatedAt,
        status: optionalString(parsed.status),
        sessionKey: optionalString(parsed.sessionKey),
        provider: optionalString(parsed.provider),
        model: optionalString(parsed.model),
        jobId: optionalString(parsed.jobId),
      });
    }
  }

  return index;
}

function normalizeCodexExecution(execution: ProviderExecution): ProviderExecution {
  const events = execution.rawStdout
    ? parseJsonLines(execution.rawStdout)
    : parseJsonLines(execution.stdout);
  if (events.length === 0) {
    return execution;
  }

  const agentMessages: string[] = [];
  let sessionId: string | undefined;
  let resultText: string | undefined;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;

  for (const event of events) {
    if (!isRecord(event)) {
      continue;
    }
    if (event.type === 'thread.started') {
      sessionId = optionalString(event.thread_id) ?? sessionId;
    }
    if (event.type === 'item.completed' && isRecord(event.item)) {
      if (event.item.type === 'agent_message') {
        const text = optionalString(event.item.text);
        if (text) {
          agentMessages.push(text);
        }
      }
    }
    if (event.type === 'turn.completed' && isRecord(event.usage)) {
      inputTokens += numberValue(event.usage.input_tokens) ?? 0;
      cachedInputTokens += numberValue(event.usage.cached_input_tokens) ?? 0;
      outputTokens += numberValue(event.usage.output_tokens) ?? 0;
    }
    if (event.type === 'result') {
      resultText = optionalString(event.result) ?? resultText;
      sessionId = optionalString(event.session_id) ?? sessionId;
    }
  }

  return {
    ...execution,
    rawStdout: execution.stdout,
    stdout: resultText ?? (agentMessages.join('\n').trim() || execution.stdout),
    metadata: recordStringMap({
      providerFormat: 'jsonl',
      sessionId,
      inputTokens: inputTokens || undefined,
      cachedInputTokens: cachedInputTokens || undefined,
      outputTokens: outputTokens || undefined,
    }),
  };
}

function normalizeClaudeExecution(execution: ProviderExecution): ProviderExecution {
  let parsed: unknown;
  try {
    parsed = parseJsonOutput(execution.stdout);
  } catch {
    return execution;
  }
  if (!isRecord(parsed)) {
    return execution;
  }

  const usage = isRecord(parsed.usage) ? parsed.usage : {};
  const modelUsage = isRecord(parsed.modelUsage) ? parsed.modelUsage : {};
  const modelIds = Object.keys(modelUsage);
  const modeledCostUsd = modelIds
    .map((key) => {
      const entry = modelUsage[key];
      return isRecord(entry) ? numberValue(entry.costUSD) : undefined;
    })
    .reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const totalCostUsd = numberValue(parsed.total_cost_usd)
    ?? modeledCostUsd;
  const resultText = optionalString(parsed.result) ?? execution.stdout;

  return {
    ...execution,
    rawStdout: execution.stdout,
    stdout: resultText,
    costUsd: totalCostUsd && totalCostUsd > 0 ? totalCostUsd : undefined,
    metadata: recordStringMap({
      providerFormat: 'json',
      sessionId: optionalString(parsed.session_id),
      stopReason: optionalString(parsed.stop_reason),
      numTurns: numberValue(parsed.num_turns),
      modelIds: modelIds.length > 0 ? modelIds.join(',') : undefined,
      inputTokens: numberValue(usage.input_tokens),
      cacheCreationInputTokens: numberValue(usage.cache_creation_input_tokens),
      cacheReadInputTokens: numberValue(usage.cache_read_input_tokens),
      outputTokens: numberValue(usage.output_tokens),
      totalCostUsd: totalCostUsd,
    }),
  };
}

function summarizeText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

function parseOpencodeSessionList(raw: string): Array<{
  sessionId: string;
  title: string;
  updatedAtText?: string;
}> {
  const lines = raw.split(/\r?\n/);
  const sessions: Array<{ sessionId: string; title: string; updatedAtText?: string }> = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('Session ID') || /^─+$/.test(trimmed)) {
      continue;
    }
    const match = trimmed.match(/^(ses_[A-Za-z0-9]+)\s{2,}(.+?)\s{2,}(.+)$/);
    if (!match) {
      continue;
    }
    sessions.push({
      sessionId: match[1] ?? '',
      title: (match[2] ?? '').trim(),
      updatedAtText: (match[3] ?? '').trim() || undefined,
    });
  }

  return sessions;
}

function parseOpenclawSessionSummaries(
  parsed: unknown,
  cronSummaries: Map<string, {
    summary?: string;
    updatedAt?: string;
    status?: string;
    sessionKey?: string;
    provider?: string;
    model?: string;
    jobId?: string;
  }>,
): ProviderSessionSummary[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) {
    return [];
  }

  const sourcePath = optionalString(parsed.path);
  const bySessionId = new Map<string, ProviderSessionSummary>();

  for (const item of parsed.sessions) {
    if (!isRecord(item)) {
      continue;
    }
    const sessionId = optionalString(item.sessionId);
    if (!sessionId) {
      continue;
    }
    const key = optionalString(item.key);
    const updatedAt = fromEpochMillis(item.updatedAt) ?? cronSummaries.get(sessionId)?.updatedAt;
    const cron = cronSummaries.get(sessionId);
    const summary = cron?.summary;
    const titleSeed = summary
      ?? key
      ?? `OpenClaw session ${sessionId}`;

    const candidate: ProviderSessionSummary = {
      providerId: 'openclaw',
      sessionId,
      title: summarizeText(titleSeed),
      summary,
      sourcePath,
      createdAt: updatedAt,
      updatedAt,
      metadata: recordStringMap({
        key,
        agentId: item.agentId,
        kind: item.kind,
        systemSent: item.systemSent,
        abortedLastRun: item.abortedLastRun,
        model: item.model,
        modelProvider: item.modelProvider,
        contextTokens: item.contextTokens,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        totalTokens: item.totalTokens,
        totalTokensFresh: item.totalTokensFresh,
        sessionKey: cron?.sessionKey,
        status: cron?.status,
        upstreamProvider: cron?.provider,
        upstreamModel: cron?.model,
        jobId: cron?.jobId,
      }),
    };

    const existing = bySessionId.get(sessionId);
    if (!existing) {
      bySessionId.set(sessionId, candidate);
      continue;
    }

    const existingHasSummary = Boolean(existing.summary);
    const candidateHasSummary = Boolean(candidate.summary);
    const preferred = candidateHasSummary && !existingHasSummary
      ? candidate
      : candidateHasSummary === existingHasSummary && compareIsoDates(candidate.updatedAt, existing.updatedAt) > 0
        ? candidate
        : existing;
    bySessionId.set(sessionId, preferred);
  }

  return Array.from(bySessionId.values())
    .sort((a, b) => compareIsoDates(b.updatedAt, a.updatedAt));
}

async function exportOpencodeSession(
  sessionId: string,
  options?: ProviderSessionRunOptions,
): Promise<{
  title?: string;
  summary?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  firstPrompt?: string;
  slug?: string;
  projectId?: string;
  version?: string;
  providerId?: string;
  modelId?: string;
  costUsd?: string;
} | null> {
  const execution = await runProviderCommand(
    ['opencode', 'export', sessionId],
    options,
  );
  if (execution.exitCode !== 0) {
    return null;
  }
  const parsed = parseOpencodeExport(execution.stdout);
  if (!parsed) {
    return null;
  }

  const info = isRecord(parsed.info) ? parsed.info : {};
  const messages = Array.isArray(parsed.messages) ? parsed.messages.filter(isRecord) : [];
  const firstUserMessage = messages.find((message) => {
    const messageInfo = isRecord(message.info) ? message.info : {};
    return messageInfo.role === 'user';
  });
  const lastAssistantMessage = [...messages].reverse().find((message) => {
    const messageInfo = isRecord(message.info) ? message.info : {};
    return messageInfo.role === 'assistant';
  });
  const firstPrompt = extractOpencodePrompt(firstUserMessage);
  const summary = extractOpencodeAssistantSummary(lastAssistantMessage);
  const lastAssistantInfo = isRecord(lastAssistantMessage?.info) ? lastAssistantMessage.info : {};
  const model = isRecord(lastAssistantInfo.model) ? lastAssistantInfo.model : {};
  const time = isRecord(info.time) ? info.time : {};

  return {
    title: optionalString(info.title),
    summary,
    cwd: optionalString(info.directory),
    createdAt: fromEpochMillis(time.created),
    updatedAt: fromEpochMillis(time.updated),
    firstPrompt,
    slug: optionalString(info.slug),
    projectId: optionalString(info.projectID),
    version: optionalString(info.version),
    providerId: optionalString(model.providerID) ?? optionalString(lastAssistantInfo.providerID),
    modelId: optionalString(model.modelID) ?? optionalString(lastAssistantInfo.modelID),
    costUsd: typeof lastAssistantInfo.cost === 'number' ? String(lastAssistantInfo.cost) : undefined,
  };
}

function parseOpencodeExport(raw: string): { info?: unknown; messages?: unknown } | null {
  const text = raw.trim();
  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) {
    return null;
  }
  try {
    return JSON.parse(text.slice(jsonStart)) as { info?: unknown; messages?: unknown };
  } catch {
    return null;
  }
}

function extractOpencodePrompt(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  const parts = Array.isArray(message.parts) ? message.parts.filter(isRecord) : [];
  const textParts = parts
    .map((part) => optionalString(part.text))
    .filter((value): value is string => Boolean(value));
  return textParts.length > 0 ? summarizeText(textParts.join(' ')) : undefined;
}

function extractOpencodeAssistantSummary(message: Record<string, unknown> | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  const parts = Array.isArray(message.parts) ? message.parts.filter(isRecord) : [];
  const textParts = parts
    .map((part) => optionalString(part.text))
    .filter((value): value is string => Boolean(value));
  return textParts.length > 0 ? summarizeText(textParts.join(' ')) : undefined;
}

function extractBrowserRunId(raw: string): string | undefined {
  try {
    const parsed = parseJsonOutput(raw);
    if (isRecord(parsed)) {
      return optionalString(parsed.runId)
        ?? optionalString(parsed.id)
        ?? optionalString(parsed.sessionId);
    }
  } catch {
    // Ignore parse errors and fall back to the supplied id.
  }
  return undefined;
}

function parseBrowserRunSummaries(
  parsed: unknown,
  cwdFallback?: string,
): ProviderSessionSummary[] {
  const items = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.runs)
      ? parsed.runs
      : isRecord(parsed) && Array.isArray(parsed.items)
        ? parsed.items
        : [];

  const summaries: ProviderSessionSummary[] = [];

  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const runId = optionalString(item.runId) ?? optionalString(item.id);
    if (!runId) {
      continue;
    }
    const goal = optionalString(item.goal);
    const summary = optionalString(item.summary)
      ?? optionalString(item.result)
      ?? goal;
    const sessionThreadId = optionalString(item.sessionId);
    const status = optionalString(item.status);
    const domain = optionalString(item.domain);
    const currentUrl = optionalString(item.currentUrl);
    const finalUrl = optionalString(item.finalUrl);
    const startUrl = optionalString(item.startUrl);
    const cwd = optionalString(item.cwd) ?? cwdFallback;

    summaries.push({
      providerId: 'browser',
      sessionId: runId,
      title: summarizeText(summary ?? goal ?? domain ?? 'Browser run'),
      summary,
      cwd,
      sourcePath: optionalString(item.manifestPath) ?? optionalString(item.path),
      createdAt: optionalString(item.startedAt) ?? optionalString(item.createdAt),
      updatedAt: optionalString(item.updatedAt) ?? optionalString(item.completedAt) ?? optionalString(item.startedAt),
      firstPrompt: goal,
      metadata: recordStringMap({
        runId,
        sessionId: sessionThreadId,
        parentRunId: item.parentRunId,
        status,
        domain,
        currentUrl,
        finalUrl,
        startUrl,
      }),
    });
  }

  return summaries.sort((a, b) => compareIsoDates(b.updatedAt, a.updatedAt));
}

function fromEpochSeconds(value: number | undefined): string | undefined {
  return value !== undefined ? new Date(value * 1000).toISOString() : undefined;
}

function fromEpochMillis(value: unknown): string | undefined {
  return typeof value === 'number' ? new Date(value).toISOString() : undefined;
}

function compareIsoDates(left?: string, right?: string): number {
  const leftTime = left ? new Date(left).getTime() : 0;
  const rightTime = right ? new Date(right).getTime() : 0;
  return leftTime - rightTime;
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

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseJsonLines(raw: string): unknown[] {
  const items: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON lines in mixed output streams.
    }
  }
  return items;
}

function recordStringMap(value: Record<string, unknown>): Record<string, string> | undefined {
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && String(entryValue).trim())
    .map(([key, entryValue]) => [key, String(entryValue)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
