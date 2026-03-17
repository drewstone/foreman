import {
  createBrowserSessionDriver,
  createClaudeSessionDriver,
  createCodexSessionDriver,
  createOpenclawSessionDriver,
  createOpencodeSessionDriver,
  type ProviderSessionRunOptions,
  type ProviderSessionRunResult,
  type ProviderSessionSummary,
  type SessionDriver,
} from '@drew/foreman-providers';

export interface ProviderSessionSurfaceOptions extends ProviderSessionRunOptions {
  provider: 'codex' | 'claude' | 'browser' | 'opencode' | 'openclaw';
  action: 'list' | 'start' | 'continue' | 'continue-last' | 'fork';
  prompt?: string;
  sessionId?: string;
  limit?: number;
}

export interface ProviderSessionSurfaceResult {
  provider: 'codex' | 'claude' | 'browser' | 'opencode' | 'openclaw';
  action: ProviderSessionSurfaceOptions['action'];
  sessions?: ProviderSessionSummary[];
  execution?: ProviderSessionRunResult;
}

export async function runProviderSessionSurface(
  options: ProviderSessionSurfaceOptions,
): Promise<ProviderSessionSurfaceResult> {
  const driver = getSessionDriver(options.provider);
  const prompt = options.prompt ?? '';

  if (options.action === 'list') {
    return {
      provider: options.provider,
      action: options.action,
      sessions: await driver.listRecent({
        cwd: options.cwd,
        limit: options.limit,
      }),
    };
  }

  if (!options.prompt && !(options.action === 'continue' && options.provider === 'browser')) {
    throw new Error(`--prompt is required for action ${options.action}`);
  }

  if (options.action === 'start') {
    return {
      provider: options.provider,
      action: options.action,
      execution: await driver.start(prompt, options),
    };
  }

  if (options.action === 'continue-last') {
    return {
      provider: options.provider,
      action: options.action,
      execution: await driver.continueLast(prompt, options),
    };
  }

  if (!options.sessionId) {
    throw new Error(`--session-id is required for action ${options.action}`);
  }

  if (options.action === 'fork') {
    if (!driver.fork) {
      throw new Error(`provider ${options.provider} does not support fork`);
    }
    return {
      provider: options.provider,
      action: options.action,
      execution: await driver.fork(options.sessionId, prompt, options),
    };
  }

  return {
    provider: options.provider,
    action: options.action,
    execution: await driver.continue(options.sessionId, prompt, options),
  };
}

function getSessionDriver(provider: 'codex' | 'claude' | 'browser' | 'opencode' | 'openclaw'): SessionDriver {
  if (provider === 'codex') {
    return createCodexSessionDriver();
  }
  if (provider === 'browser') {
    return createBrowserSessionDriver();
  }
  if (provider === 'opencode') {
    return createOpencodeSessionDriver();
  }
  if (provider === 'openclaw') {
    return createOpenclawSessionDriver();
  }
  return createClaudeSessionDriver();
}
