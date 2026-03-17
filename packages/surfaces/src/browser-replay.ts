import { resolve } from 'node:path';

import { FilesystemTraceStore } from '@drew/foreman-tracing';

import { runSessionReplay, type SessionReplayOptions, type SessionReplayResult } from './session-replay.js';

export interface BrowserReplayOptions extends SessionReplayOptions {}

export interface BrowserReplayResult extends SessionReplayResult {}

export async function runBrowserReplay(
  options: BrowserReplayOptions,
): Promise<BrowserReplayResult> {
  const traceStore = new FilesystemTraceStore(resolve(options.traceRoot));
  const bundle = await traceStore.get(options.traceId);
  if (!bundle) {
    throw new Error(`trace ${options.traceId} not found`);
  }
  if (bundle.metadata?.surface !== 'session' || bundle.metadata?.provider !== 'browser') {
    throw new Error(`trace ${options.traceId} is not a browser session trace`);
  }

  return runSessionReplay(options);
}
