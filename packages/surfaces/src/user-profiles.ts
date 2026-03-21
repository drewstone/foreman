/**
 * Multi-user profile management.
 *
 * Each operator profile encodes preferences, worker choices, evaluation
 * style, and memory scopes. Profiles are stored in the versioned store
 * so they can be optimized over time.
 *
 * Profiles drive:
 *   - Which harness to prefer (claude/codex/pi)
 *   - How aggressive auto-resume should be (confidence threshold)
 *   - Which skills to suggest
 *   - Review rigor (how strict the judge is)
 *   - Cost budget per day
 *   - Notification preferences
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')
const PROFILES_DIR = join(FOREMAN_HOME, 'profiles')

export interface OperatorProfile {
  id: string
  name: string
  active: boolean

  // Preferences
  preferredHarness: 'claude' | 'codex' | 'pi' | 'opencode'
  autoResumeConfidence: number
  maxResumesPerCycle: number
  costBudgetUsd: number

  // Evaluation
  judgeModel: string
  judgeSeverity: 'lenient' | 'standard' | 'strict'

  // Notifications
  telegramChatId?: string
  slackWebhook?: string
  notifyOn: Array<'heartbeat-action' | 'daily-report' | 'degradation' | 'promotion' | 'ci-failure' | 'budget-exceeded'>

  // Repos
  managedRepos: string[]
  excludedRepos: string[]

  // Skills
  preferredSkills: string[]
  disabledSkills: string[]

  // Learning
  learningMode: 'dry-run' | 'live'
  autoOptimize: boolean

  // Metadata
  createdAt: string
  updatedAt: string
}

const DEFAULT_PROFILE: Omit<OperatorProfile, 'id' | 'name' | 'createdAt' | 'updatedAt'> = {
  active: true,
  preferredHarness: 'claude',
  autoResumeConfidence: 0.5,
  maxResumesPerCycle: 1,
  costBudgetUsd: 10,
  judgeModel: 'claude-opus-4-6',
  judgeSeverity: 'standard',
  notifyOn: ['heartbeat-action', 'daily-report', 'degradation', 'ci-failure'],
  managedRepos: [],
  excludedRepos: [],
  preferredSkills: ['evolve', 'polish', 'verify', 'critical-audit'],
  disabledSkills: [],
  learningMode: 'live',
  autoOptimize: true,
}

export async function createProfile(id: string, name: string, overrides?: Partial<OperatorProfile>): Promise<OperatorProfile> {
  const now = new Date().toISOString()
  const profile: OperatorProfile = {
    ...DEFAULT_PROFILE,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }

  await mkdir(PROFILES_DIR, { recursive: true })
  await writeFile(join(PROFILES_DIR, `${id}.json`), JSON.stringify(profile, null, 2) + '\n', 'utf8')
  return profile
}

export async function loadProfile(id: string): Promise<OperatorProfile | null> {
  try {
    return JSON.parse(await readFile(join(PROFILES_DIR, `${id}.json`), 'utf8'))
  } catch {
    return null
  }
}

export async function saveProfile(profile: OperatorProfile): Promise<void> {
  profile.updatedAt = new Date().toISOString()
  await mkdir(PROFILES_DIR, { recursive: true })
  await writeFile(join(PROFILES_DIR, `${profile.id}.json`), JSON.stringify(profile, null, 2) + '\n', 'utf8')
}

export async function listProfiles(): Promise<OperatorProfile[]> {
  try {
    const files = (await readdir(PROFILES_DIR)).filter((f) => f.endsWith('.json'))
    const profiles: OperatorProfile[] = []
    for (const file of files) {
      try {
        profiles.push(JSON.parse(await readFile(join(PROFILES_DIR, file), 'utf8')))
      } catch { continue }
    }
    return profiles.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export async function getActiveProfile(): Promise<OperatorProfile | null> {
  const profiles = await listProfiles()
  return profiles.find((p) => p.active) ?? profiles[0] ?? null
}

/**
 * Bootstrap the default profile from existing memory if no profiles exist.
 */
export async function bootstrapDefaultProfile(): Promise<OperatorProfile> {
  const existing = await getActiveProfile()
  if (existing) return existing

  // Read operator memory to seed the profile
  let operatorPatterns: string[] = []
  try {
    const mem = JSON.parse(await readFile(join(FOREMAN_HOME, 'memory', 'user', 'operator.json'), 'utf8'))
    operatorPatterns = mem.operatorPatterns ?? []
  } catch { /* no memory */ }

  // Detect repos from session index
  let repos: string[] = []
  try {
    const { SessionIndex } = await import('@drew/foreman-memory/session-index')
    const idx = new SessionIndex()
    repos = Object.keys(idx.stats().byRepo)
      .filter((r) => r.length > 2)
      .map((r) => join(homedir(), 'code', r))
    idx.close()
  } catch { /* no index */ }

  return createProfile('default', 'Default Operator', {
    managedRepos: repos.slice(0, 20),
    // Infer preferences from patterns
    judgeSeverity: operatorPatterns.some((p) => p.includes('quality')) ? 'strict' : 'standard',
  })
}
