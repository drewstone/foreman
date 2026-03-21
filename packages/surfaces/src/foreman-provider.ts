/**
 * Foreman-as-provider.
 *
 * Spawns a child Foreman daemon scoped to a single project.
 * The parent Foreman can manage multiple child instances,
 * each with their own confidence scores and policy state.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

export interface ForemanChildInstance {
  project: string
  pid: number | null
  status: 'running' | 'stopped' | 'failed'
  startedAt: string
  decisionCount: number
}

export interface ForemanProviderOptions {
  project: string
  dryRun?: boolean
  pollIntervalMs?: number
}

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

const children = new Map<string, {
  instance: ForemanChildInstance
  process: ChildProcess
}>()

export async function spawnChild(options: ForemanProviderOptions): Promise<ForemanChildInstance> {
  const existing = children.get(options.project)
  if (existing && existing.instance.status === 'running') {
    return existing.instance
  }

  const dryRun = options.dryRun ?? true
  const logDir = join(FOREMAN_HOME, 'logs')
  await mkdir(logDir, { recursive: true })

  const projectName = basename(options.project) || options.project
  const logFile = join(logDir, `child-${projectName}.log`)

  const args = [
    '--import', 'tsx',
    join(import.meta.dirname ?? '.', 'foreman-daemon-cli.ts'),
    '--watch', options.project,
    ...(dryRun ? [] : ['--live']),
    ...(options.pollIntervalMs ? ['--poll', String(options.pollIntervalMs)] : []),
  ]

  const child = spawn('node', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      FOREMAN_LOG_FILE: logFile,
    },
  })

  const instance: ForemanChildInstance = {
    project: options.project,
    pid: child.pid ?? null,
    status: child.pid ? 'running' : 'failed',
    startedAt: new Date().toISOString(),
    decisionCount: 0,
  }

  if (child.pid) {
    children.set(options.project, { instance, process: child })

    child.on('exit', () => {
      const entry = children.get(options.project)
      if (entry) {
        entry.instance.status = 'stopped'
      }
    })

    child.on('error', () => {
      const entry = children.get(options.project)
      if (entry) {
        entry.instance.status = 'failed'
      }
    })

    child.unref()
  }

  return instance
}

export function listChildren(): ForemanChildInstance[] {
  return Array.from(children.values()).map((entry) => entry.instance)
}

export function stopChild(project: string): void {
  const entry = children.get(project)
  if (!entry) return
  try {
    entry.process.kill('SIGTERM')
  } catch { /* already dead */ }
  entry.instance.status = 'stopped'
  children.delete(project)
}

export function stopAll(): void {
  for (const project of Array.from(children.keys())) {
    stopChild(project)
  }
}
