import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { Pool, type PoolConfig } from 'pg';

export interface TraceEvidence {
  kind: string;
  label: string;
  value: string;
  uri?: string;
  metadata?: Record<string, string>;
}

export interface TraceTaskRef {
  id: string;
  goal: string;
  environmentKind?: string;
}

export interface TraceEventRecord {
  at: string;
  kind: string;
  workerId?: string;
  trackId?: string;
  summary: string;
  metadata?: Record<string, string>;
}

export interface TraceOutcome {
  status: string;
  summary: string;
  validated: boolean;
  unmetCriteria?: string[];
}

export interface TraceBundle {
  task: TraceTaskRef;
  events: TraceEventRecord[];
  evidence: TraceEvidence[];
  outcome?: TraceOutcome;
  metadata?: Record<string, string>;
}

export interface RewardSignal {
  name: string;
  value: number;
  source: 'deterministic' | 'judge' | 'human' | 'derived';
  metadata?: Record<string, string>;
}

export interface ReplayRequest {
  traceId: string;
  fromEventIndex?: number;
  mode: 'dry-run' | 'full';
}

export interface TraceRef {
  traceId: string;
  taskId: string;
}

export interface TraceSearchResult extends TraceRef {
  score: number;
  excerpt: string;
  taskGoal: string;
  environmentKind?: string;
  metadata?: Record<string, string>;
}

export interface TraceStore {
  put(bundle: TraceBundle): Promise<string>;
  putWithId?(traceId: string, bundle: TraceBundle): Promise<void>;
  get(traceId: string): Promise<TraceBundle | null>;
  list(taskId?: string): Promise<TraceRef[]>;
  search?(query: string, options?: { limit?: number; taskId?: string }): Promise<TraceSearchResult[]>;
}

export interface TraceStoreFactoryOptions {
  rootDir?: string;
  databaseUrl?: string;
  schemaName?: string;
  tableName?: string;
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export class FilesystemTraceStore implements TraceStore {
  private root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async put(bundle: TraceBundle): Promise<string> {
    const traceId = randomUUID();
    await this.putWithId(traceId, bundle);
    return traceId;
  }

  async putWithId(traceId: string, bundle: TraceBundle): Promise<void> {
    const dir = join(this.root, traceId);
    await ensureDir(dir);
    await writeFile(join(dir, 'trace.json'), `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  }

  async get(traceId: string): Promise<TraceBundle | null> {
    try {
      const raw = await readFile(join(this.root, traceId, 'trace.json'), 'utf8');
      return JSON.parse(raw) as TraceBundle;
    } catch {
      return null;
    }
  }

  async list(taskId?: string): Promise<TraceRef[]> {
    await ensureDir(this.root);
    const entries = await readdir(this.root, { withFileTypes: true });
    const out: TraceRef[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const bundle = await this.get(entry.name);
      if (!bundle) {
        continue;
      }
      if (taskId && bundle.task.id !== taskId) {
        continue;
      }
      out.push({ traceId: entry.name, taskId: bundle.task.id });
    }

    return out.sort((a, b) => a.traceId.localeCompare(b.traceId));
  }

  async search(query: string, options: { limit?: number; taskId?: string } = {}): Promise<TraceSearchResult[]> {
    const refs = await this.list(options.taskId);
    const terms = tokenize(query);
    const results: TraceSearchResult[] = [];

    for (const ref of refs) {
      const bundle = await this.get(ref.traceId);
      if (!bundle) {
        continue;
      }
      const haystack = buildTraceSearchText(bundle);
      const score = lexicalScore(haystack, terms);
      if (score <= 0) {
        continue;
      }
      results.push({
        traceId: ref.traceId,
        taskId: ref.taskId,
        score,
        excerpt: makeExcerpt(haystack, query),
        taskGoal: bundle.task.goal,
        environmentKind: bundle.task.environmentKind,
        metadata: bundle.metadata,
      });
    }

    return results
      .sort((left, right) => right.score - left.score)
      .slice(0, options.limit ?? 10);
  }
}

export class PostgresTraceStore implements TraceStore {
  private readonly pool: Pool;
  private readonly schemaName: string;
  private readonly tableName: string;
  private schemaReady: Promise<void> | null = null;

  constructor(input: {
    connectionString?: string;
    poolConfig?: PoolConfig;
    schemaName?: string;
    tableName?: string;
  }) {
    if (!input.connectionString && !input.poolConfig) {
      throw new Error('PostgresTraceStore requires connectionString or poolConfig');
    }
    this.pool = new Pool(input.poolConfig ?? { connectionString: input.connectionString });
    this.schemaName = sanitizeIdentifier(input.schemaName ?? 'foreman');
    this.tableName = sanitizeIdentifier(input.tableName ?? 'trace_items');
  }

  async put(bundle: TraceBundle): Promise<string> {
    const traceId = randomUUID();
    await this.putWithId(traceId, bundle);
    return traceId;
  }

  async putWithId(traceId: string, bundle: TraceBundle): Promise<void> {
    await this.ensureSchema();
    const searchText = buildTraceSearchText(bundle);
    await this.pool.query(
      `
        INSERT INTO ${this.qualifiedTable()} (
          trace_id,
          task_id,
          task_goal,
          environment_kind,
          outcome_status,
          bundle,
          search_text,
          search_document,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::jsonb,
          $7,
          to_tsvector('english', $7),
          NOW()
        )
      `,
      [
        traceId,
        bundle.task.id,
        bundle.task.goal,
        bundle.task.environmentKind ?? '',
        bundle.outcome?.status ?? '',
        JSON.stringify(bundle),
        searchText,
      ],
    );
  }

  async get(traceId: string): Promise<TraceBundle | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ bundle: TraceBundle }>(
      `SELECT bundle FROM ${this.qualifiedTable()} WHERE trace_id = $1`,
      [traceId],
    );
    return result.rows[0]?.bundle ?? null;
  }

  async list(taskId?: string): Promise<TraceRef[]> {
    await this.ensureSchema();
    const result = taskId
      ? await this.pool.query<{ trace_id: string; task_id: string }>(
          `SELECT trace_id, task_id FROM ${this.qualifiedTable()} WHERE task_id = $1 ORDER BY updated_at DESC`,
          [taskId],
        )
      : await this.pool.query<{ trace_id: string; task_id: string }>(
          `SELECT trace_id, task_id FROM ${this.qualifiedTable()} ORDER BY updated_at DESC`,
        );
    return result.rows.map((row) => ({
      traceId: row.trace_id,
      taskId: row.task_id,
    }));
  }

  async search(query: string, options: { limit?: number; taskId?: string } = {}): Promise<TraceSearchResult[]> {
    await this.ensureSchema();
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    const taskClause = options.taskId ? 'AND task_id = $3' : '';
    const params = options.taskId
      ? [query, limit, options.taskId]
      : [query, limit];
    const sql = `
      SELECT
        trace_id,
        task_id,
        task_goal,
        environment_kind,
        bundle->'metadata' AS metadata,
        ts_headline('english', search_text, plainto_tsquery('english', $1), 'MaxFragments=2, MinWords=8, MaxWords=18') AS excerpt,
        ts_rank_cd(search_document, plainto_tsquery('english', $1)) AS score
      FROM ${this.qualifiedTable()}
      WHERE search_document @@ plainto_tsquery('english', $1)
      ${taskClause}
      ORDER BY score DESC, updated_at DESC
      LIMIT $2
    `;
    const result = await this.pool.query<{
      trace_id: string;
      task_id: string;
      task_goal: string;
      environment_kind: string;
      metadata: Record<string, string> | null;
      excerpt: string | null;
      score: number;
    }>(sql, params);

    if (result.rows.length > 0) {
      return result.rows.map((row) => ({
        traceId: row.trace_id,
        taskId: row.task_id,
        taskGoal: row.task_goal,
        environmentKind: row.environment_kind || undefined,
        metadata: row.metadata ?? undefined,
        excerpt: row.excerpt ?? row.task_goal,
        score: Number(row.score ?? 0),
      }));
    }

    const fallbackSql = `
      SELECT trace_id, task_id, task_goal, environment_kind, bundle->'metadata' AS metadata, search_text
      FROM ${this.qualifiedTable()}
      WHERE search_text ILIKE $1
      ${options.taskId ? 'AND task_id = $3' : ''}
      ORDER BY updated_at DESC
      LIMIT $2
    `;
    const fallbackParams = options.taskId
      ? [`%${query}%`, limit, options.taskId]
      : [`%${query}%`, limit];
    const fallback = await this.pool.query<{
      trace_id: string;
      task_id: string;
      task_goal: string;
      environment_kind: string;
      metadata: Record<string, string> | null;
      search_text: string;
    }>(fallbackSql, fallbackParams);
    return fallback.rows.map((row) => ({
      traceId: row.trace_id,
      taskId: row.task_id,
      taskGoal: row.task_goal,
      environmentKind: row.environment_kind || undefined,
      metadata: row.metadata ?? undefined,
      excerpt: makeExcerpt(row.search_text, query),
      score: lexicalScore(row.search_text, tokenize(query)),
    }));
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.initSchema();
    }
    await this.schemaReady;
  }

  private async initSchema(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.qualifiedSchema()}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.qualifiedTable()} (
        trace_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_goal TEXT NOT NULL,
        environment_kind TEXT,
        outcome_status TEXT,
        bundle JSONB NOT NULL,
        search_text TEXT NOT NULL,
        search_document tsvector NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.qualifiedIndex('trace_items_task_id_idx')}
      ON ${this.qualifiedTable()} (task_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.qualifiedIndex('trace_items_search_document_idx')}
      ON ${this.qualifiedTable()} USING GIN (search_document)
    `);
  }

  private qualifiedSchema(): string {
    return `"${this.schemaName}"`;
  }

  private qualifiedTable(): string {
    return `"${this.schemaName}"."${this.tableName}"`;
  }

  private qualifiedIndex(name: string): string {
    return `"${sanitizeIdentifier(`${this.schemaName}_${name}`)}"`;
  }
}

export class CompositeTraceStore implements TraceStore {
  constructor(private readonly stores: TraceStore[]) {}

  async put(bundle: TraceBundle): Promise<string> {
    const traceId = randomUUID();
    await this.putWithId(traceId, bundle);
    return traceId;
  }

  async putWithId(traceId: string, bundle: TraceBundle): Promise<void> {
    if (this.stores.length === 0) {
      throw new Error('CompositeTraceStore requires at least one store');
    }
    await Promise.all(this.stores.map(async (store) => {
      if (store.putWithId) {
        await store.putWithId(traceId, bundle);
        return;
      }
      await store.put(bundle);
    }));
  }

  async get(traceId: string): Promise<TraceBundle | null> {
    for (const store of this.stores) {
      const bundle = await store.get(traceId);
      if (bundle) {
        return bundle;
      }
    }
    return null;
  }

  async list(taskId?: string): Promise<TraceRef[]> {
    const refs = await Promise.all(this.stores.map((store) => store.list(taskId)));
    return dedupeRefs(refs.flat());
  }

  async search(query: string, options: { limit?: number; taskId?: string } = {}): Promise<TraceSearchResult[]> {
    const searchStores = this.stores.filter((store) => typeof store.search === 'function');
    const results = await Promise.all(searchStores.map((store) => store.search!(query, options)));
    return dedupeSearchResults(results.flat())
      .sort((left, right) => right.score - left.score)
      .slice(0, options.limit ?? 10);
  }
}

export async function createTraceStore(options: TraceStoreFactoryOptions = {}): Promise<TraceStore> {
  const databaseUrl = options.databaseUrl
    ?? process.env.FOREMAN_TRACE_DATABASE_URL
    ?? process.env.FOREMAN_MEMORY_DATABASE_URL
    ?? process.env.FOREMAN_POSTGRES_URL;
  const filesystemStore = options.rootDir ? new FilesystemTraceStore(options.rootDir) : undefined;
  const postgresStore = databaseUrl
    ? new PostgresTraceStore({
        connectionString: databaseUrl,
        schemaName: options.schemaName ?? process.env.FOREMAN_TRACE_DB_SCHEMA ?? process.env.FOREMAN_MEMORY_DB_SCHEMA,
        tableName: options.tableName ?? process.env.FOREMAN_TRACE_DB_TABLE ?? 'trace_items',
      })
    : undefined;

  if (filesystemStore && postgresStore) {
    await postgresStore.list().catch(() => []);
    return new CompositeTraceStore([filesystemStore, postgresStore]);
  }
  if (postgresStore) {
    await postgresStore.list().catch(() => []);
    return postgresStore;
  }
  if (filesystemStore) {
    return filesystemStore;
  }
  throw new Error('createTraceStore requires rootDir when no trace database URL is configured');
}

function buildTraceSearchText(bundle: TraceBundle): string {
  return [
    bundle.task.id,
    bundle.task.goal,
    bundle.task.environmentKind ?? '',
    bundle.outcome?.status ?? '',
    bundle.outcome?.summary ?? '',
    ...Object.entries(bundle.metadata ?? {}).flatMap(([key, value]) => [key, value]),
    ...bundle.events.flatMap((event) => [
      event.kind,
      event.summary,
      ...(event.workerId ? [event.workerId] : []),
      ...(event.trackId ? [event.trackId] : []),
      ...Object.entries(event.metadata ?? {}).flatMap(([key, value]) => [key, value]),
    ]),
    ...bundle.evidence.flatMap((item) => [
      item.kind,
      item.label,
      item.value,
      item.uri ?? '',
      ...Object.entries(item.metadata ?? {}).flatMap(([key, value]) => [key, value]),
    ]),
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n');
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function lexicalScore(text: string, terms: string[]): number {
  if (terms.length === 0) {
    return 0;
  }
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!lower.includes(term)) {
      continue;
    }
    score += 1;
    const exactMatches = lower.split(term).length - 1;
    score += exactMatches * 0.2;
  }
  return Number(score.toFixed(4));
}

function makeExcerpt(text: string, query: string): string {
  const lower = text.toLowerCase();
  const index = lower.indexOf(query.toLowerCase());
  if (index < 0) {
    return text.slice(0, 220);
  }
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + query.length + 140);
  return text.slice(start, end);
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!sanitized) {
    throw new Error(`invalid SQL identifier: ${value}`);
  }
  return sanitized;
}

function dedupeRefs(items: TraceRef[]): TraceRef[] {
  const seen = new Set<string>();
  const out: TraceRef[] = [];
  for (const item of items) {
    if (seen.has(item.traceId)) {
      continue;
    }
    seen.add(item.traceId);
    out.push(item);
  }
  return out;
}

function dedupeSearchResults(items: TraceSearchResult[]): TraceSearchResult[] {
  const best = new Map<string, TraceSearchResult>();
  for (const item of items) {
    const existing = best.get(item.traceId);
    if (!existing || item.score > existing.score) {
      best.set(item.traceId, item);
    }
  }
  return [...best.values()];
}
