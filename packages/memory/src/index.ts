export interface EnvironmentMemory {
  target: string;
  facts: string[];
  invariants?: string[];
  failureModes?: string[];
}

export interface WorkerPerformanceMemory {
  workerId: string;
  sampleCount?: number;
  successRate?: number;
  avgCostUsd?: number;
  avgRuntimeSec?: number;
  commonFailureClasses?: string[];
}

export interface WorkerRunObservation {
  succeeded: boolean;
  durationMs?: number;
  costUsd?: number;
  failureClasses?: string[];
}

export interface RepairRecipe {
  pattern: string;
  confidence: number;
  successCount: number;
  failCount: number;
  lastUsed?: string;
}

export interface StrategyMemory {
  taskShape: string;
  successfulPatterns: string[];
  badPatterns?: string[];
  repairRecipes?: string[];
  scoredRecipes?: RepairRecipe[];
}

export interface UserMemory {
  userId: string;
  preferences?: string[];
  favoredWorkers?: string[];
  recurringEnvironments?: string[];
  escalationHabits?: string[];
  operatorPatterns?: string[];
  goalPatterns?: string[];
}

export interface ProfileMemory {
  profileId: string;
  workerPreferences?: string[];
  evaluationStyle?: string[];
  memoryScopes?: string[];
  operatorPatterns?: string[];
  goalPatterns?: string[];
  workflowImprovements?: string[];
  skillOrToolingImprovements?: string[];
}

export interface MemoryStore {
  getEnvironmentMemory(target: string): Promise<EnvironmentMemory | null>;
  getWorkerMemory(workerId: string): Promise<WorkerPerformanceMemory | null>;
  getStrategyMemory(taskShape: string): Promise<StrategyMemory | null>;
  getUserMemory(userId: string): Promise<UserMemory | null>;
  getProfileMemory(profileId: string): Promise<ProfileMemory | null>;
  putEnvironmentMemory(memory: EnvironmentMemory): Promise<void>;
  putWorkerMemory(memory: WorkerPerformanceMemory): Promise<void>;
  putStrategyMemory(memory: StrategyMemory): Promise<void>;
  putUserMemory(memory: UserMemory): Promise<void>;
  putProfileMemory(memory: ProfileMemory): Promise<void>;
}

export interface MemoryStoreFactoryOptions {
  rootDir?: string;
  databaseUrl?: string;
  schemaName?: string;
  tableName?: string;
}

export function recordWorkerRun(
  existing: WorkerPerformanceMemory | null,
  update: WorkerRunObservation,
  options?: {
    maxFailureClasses?: number;
  },
): WorkerPerformanceMemory {
  const previousSamples = existing?.sampleCount ?? 0;
  const nextSamples = previousSamples + 1;
  const runtimeSec = update.durationMs === undefined ? undefined : update.durationMs / 1000;

  return {
    workerId: existing?.workerId ?? 'unknown-worker',
    sampleCount: nextSamples,
    successRate: weightedAverage(existing?.successRate, previousSamples, update.succeeded ? 1 : 0, nextSamples),
    avgCostUsd: weightedAverage(existing?.avgCostUsd, previousSamples, update.costUsd, nextSamples),
    avgRuntimeSec: weightedAverage(existing?.avgRuntimeSec, previousSamples, runtimeSec, nextSamples),
    commonFailureClasses: dedupeStrings(
      [
        ...(existing?.commonFailureClasses ?? []),
        ...(update.failureClasses ?? []),
      ],
      options?.maxFailureClasses ?? 12,
    ),
  };
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Pool, type PoolConfig } from 'pg';

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export class FilesystemMemoryStore implements MemoryStore {
  private root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async getEnvironmentMemory(target: string): Promise<EnvironmentMemory | null> {
    return readJson(join(this.root, 'environment', `${sanitize(target)}.json`));
  }

  async getWorkerMemory(workerId: string): Promise<WorkerPerformanceMemory | null> {
    return readJson(join(this.root, 'worker', `${sanitize(workerId)}.json`));
  }

  async getStrategyMemory(taskShape: string): Promise<StrategyMemory | null> {
    return readJson(join(this.root, 'strategy', `${sanitize(taskShape)}.json`));
  }

  async getUserMemory(userId: string): Promise<UserMemory | null> {
    return readJson(join(this.root, 'user', `${sanitize(userId)}.json`));
  }

  async getProfileMemory(profileId: string): Promise<ProfileMemory | null> {
    return readJson(join(this.root, 'profile', `${sanitize(profileId)}.json`));
  }

  async putEnvironmentMemory(memory: EnvironmentMemory): Promise<void> {
    await writeJson(join(this.root, 'environment', `${sanitize(memory.target)}.json`), memory);
  }

  async putWorkerMemory(memory: WorkerPerformanceMemory): Promise<void> {
    await writeJson(join(this.root, 'worker', `${sanitize(memory.workerId)}.json`), memory);
  }

  async putStrategyMemory(memory: StrategyMemory): Promise<void> {
    await writeJson(join(this.root, 'strategy', `${sanitize(memory.taskShape)}.json`), memory);
  }

  async putUserMemory(memory: UserMemory): Promise<void> {
    await writeJson(join(this.root, 'user', `${sanitize(memory.userId)}.json`), memory);
  }

  async putProfileMemory(memory: ProfileMemory): Promise<void> {
    await writeJson(join(this.root, 'profile', `${sanitize(memory.profileId)}.json`), memory);
  }
}

export class PostgresMemoryStore implements MemoryStore {
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
      throw new Error('PostgresMemoryStore requires connectionString or poolConfig');
    }
    this.pool = new Pool(input.poolConfig ?? { connectionString: input.connectionString });
    this.schemaName = sanitizeIdentifier(input.schemaName ?? 'foreman');
    this.tableName = sanitizeIdentifier(input.tableName ?? 'memory_items');
  }

  async getEnvironmentMemory(target: string): Promise<EnvironmentMemory | null> {
    return this.getItem<EnvironmentMemory>('environment', target);
  }

  async getWorkerMemory(workerId: string): Promise<WorkerPerformanceMemory | null> {
    return this.getItem<WorkerPerformanceMemory>('worker', workerId);
  }

  async getStrategyMemory(taskShape: string): Promise<StrategyMemory | null> {
    return this.getItem<StrategyMemory>('strategy', taskShape);
  }

  async getUserMemory(userId: string): Promise<UserMemory | null> {
    return this.getItem<UserMemory>('user', userId);
  }

  async getProfileMemory(profileId: string): Promise<ProfileMemory | null> {
    return this.getItem<ProfileMemory>('profile', profileId);
  }

  async putEnvironmentMemory(memory: EnvironmentMemory): Promise<void> {
    await this.putItem('environment', memory.target, memory);
  }

  async putWorkerMemory(memory: WorkerPerformanceMemory): Promise<void> {
    await this.putItem('worker', memory.workerId, memory);
  }

  async putStrategyMemory(memory: StrategyMemory): Promise<void> {
    await this.putItem('strategy', memory.taskShape, memory);
  }

  async putUserMemory(memory: UserMemory): Promise<void> {
    await this.putItem('user', memory.userId, memory);
  }

  async putProfileMemory(memory: ProfileMemory): Promise<void> {
    await this.putItem('profile', memory.profileId, memory);
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
        namespace TEXT NOT NULL,
        item_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (namespace, item_id)
      )
    `);
  }

  private async getItem<T>(namespace: string, itemId: string): Promise<T | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ payload: T }>(
      `SELECT payload FROM ${this.qualifiedTable()} WHERE namespace = $1 AND item_id = $2`,
      [namespace, itemId],
    );
    return result.rows[0]?.payload ?? null;
  }

  private async putItem(namespace: string, itemId: string, payload: unknown): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `
        INSERT INTO ${this.qualifiedTable()} (namespace, item_id, payload, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW())
        ON CONFLICT (namespace, item_id)
        DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
      `,
      [namespace, itemId, JSON.stringify(payload)],
    );
  }

  private qualifiedSchema(): string {
    return `"${this.schemaName}"`;
  }

  private qualifiedTable(): string {
    return `"${this.schemaName}"."${this.tableName}"`;
  }
}

export async function createMemoryStore(
  options: MemoryStoreFactoryOptions = {},
): Promise<MemoryStore> {
  const databaseUrl = options.databaseUrl
    ?? process.env.FOREMAN_MEMORY_DATABASE_URL
    ?? process.env.FOREMAN_POSTGRES_URL;
  if (databaseUrl) {
    const store = new PostgresMemoryStore({
      connectionString: databaseUrl,
      schemaName: options.schemaName ?? process.env.FOREMAN_MEMORY_DB_SCHEMA,
      tableName: options.tableName ?? process.env.FOREMAN_MEMORY_DB_TABLE,
    });
    await store.getProfileMemory('__foreman_healthcheck__').catch(() => null);
    return store;
  }

  if (!options.rootDir) {
    throw new Error('createMemoryStore requires rootDir when no memory database URL is configured');
  }
  return new FilesystemMemoryStore(options.rootDir);
}

export function recordRepairOutcome(
  existing: RepairRecipe[],
  pattern: string,
  succeeded: boolean,
): RepairRecipe[] {
  const recipes = [...existing];
  const idx = recipes.findIndex((r) => r.pattern === pattern);
  if (idx >= 0) {
    const recipe = recipes[idx]!;
    recipes[idx] = {
      ...recipe,
      successCount: recipe.successCount + (succeeded ? 1 : 0),
      failCount: recipe.failCount + (succeeded ? 0 : 1),
      confidence: (recipe.successCount + (succeeded ? 1 : 0)) /
        (recipe.successCount + recipe.failCount + 1),
      lastUsed: new Date().toISOString(),
    };
  } else {
    recipes.push({
      pattern,
      confidence: succeeded ? 1 : 0,
      successCount: succeeded ? 1 : 0,
      failCount: succeeded ? 0 : 1,
      lastUsed: new Date().toISOString(),
    });
  }
  return recipes.slice(0, 50);
}

export function findMatchingRecipe(
  recipes: RepairRecipe[],
  failureText: string,
): RepairRecipe | undefined {
  const lower = failureText.toLowerCase();
  return recipes
    .filter((r) => r.confidence >= 0.5 && lower.includes(r.pattern.toLowerCase().split(':').pop()?.trim() ?? ''))
    .sort((a, b) => b.confidence - a.confidence)[0];
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!sanitized) {
    throw new Error(`invalid SQL identifier: ${value}`);
  }
  return sanitized;
}

function weightedAverage(
  existingValue: number | undefined,
  previousSamples: number,
  nextValue: number | undefined,
  nextSamples: number,
): number | undefined {
  if (nextValue === undefined) {
    return existingValue;
  }
  if (existingValue === undefined || previousSamples <= 0) {
    return Number(nextValue.toFixed(4));
  }
  return Number((((existingValue * previousSamples) + nextValue) / nextSamples).toFixed(4));
}

function dedupeStrings(values: string[], maxItems: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, maxItems);
}

export { ConfidenceStore, type ConfidenceEntry, type ConfidenceSignal, type ConfidenceLevel, type ConfidenceOverride, type ActionType, ACTION_TYPES } from './confidence.js'
