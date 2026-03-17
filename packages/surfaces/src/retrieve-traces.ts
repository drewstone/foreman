import { resolve } from 'node:path';

import { createTraceStore, type TraceSearchResult } from '@drew/foreman-tracing';

export interface RetrieveTracesOptions {
  query: string;
  traceRoot?: string;
  taskId?: string;
  limit?: number;
}

export interface RetrieveTracesResult {
  query: string;
  backend: 'filesystem' | 'postgres' | 'composite';
  results: Array<TraceSearchResult & {
    rank: number;
  }>;
}

export async function runRetrieveTraces(
  options: RetrieveTracesOptions,
): Promise<RetrieveTracesResult> {
  const store = await createTraceStore({
    rootDir: options.traceRoot ? resolve(options.traceRoot) : undefined,
  });
  const results = await (store.search
    ? store.search(options.query, {
        limit: options.limit ?? 10,
        taskId: options.taskId,
      })
    : []);

  return {
    query: options.query,
    backend:
      store.constructor.name === 'PostgresTraceStore'
        ? 'postgres'
        : store.constructor.name === 'CompositeTraceStore'
          ? 'composite'
          : 'filesystem',
    results: results.map((result, index) => ({
      ...result,
      rank: index + 1,
    })),
  };
}
