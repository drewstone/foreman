/**
 * Foreman learning loop — the write-back system.
 *
 * Turns session observations into persisted knowledge:
 *   1. Session patterns → repair recipes (check commands per repo type)
 *   2. User messages → operator profile (preferences, patterns, style)
 *   3. Heartbeat outcomes → recipe scoring (confidence up/down)
 *   4. Cross-repo patterns → environment facts
 *
 * This runs after each heartbeat or daily report generation.
 * All writes are dry-run by default — logs what it would persist.
 * Set dryRun=false to actually write.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import {
  FilesystemMemoryStore,
  type EnvironmentMemory,
  type MemoryStore,
  type RepairRecipe,
  type StrategyMemory,
  type UserMemory,
  recordRepairOutcome,
} from './index.js'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export interface LearningInput {
  /** Common commands per repo from session insights */
  repoCommands: Map<string, string[]>
  /** Common files per repo from session insights */
  repoFiles: Map<string, string[]>
  /** User messages from recent sessions */
  userMessages: Array<{ repo: string; text: string; timestamp: string }>
  /** Cross-repo patterns (e.g. "runs cargo clippy across 3 repos") */
  crossRepoPatterns: Array<{ pattern: string; repos: string[]; frequency: number }>
  /** Suggested CLAUDE.md rules from session analysis */
  suggestedRules: string[]
}

export interface LearningAction {
  type: 'recipe' | 'environment' | 'user-profile' | 'strategy'
  target: string
  description: string
  data: unknown
}

export interface LearningResult {
  actions: LearningAction[]
  recipesCreated: number
  factsLearned: number
  profileUpdates: number
}

// ─── Recipe extraction ──────────────────────────────────────────────

interface RepoTypeSignature {
  type: string
  indicators: string[]
  checkCommands: string[]
}

const REPO_TYPE_SIGNATURES: RepoTypeSignature[] = [
  {
    type: 'cargo',
    indicators: ['cargo test', 'cargo clippy', 'cargo fmt', 'cargo build', 'cargo check'],
    checkCommands: [
      'cargo fmt --check',
      'cargo clippy -- -D warnings',
      'cargo test',
    ],
  },
  {
    type: 'npm',
    indicators: ['npm run', 'npm test', 'npx', 'pnpm'],
    checkCommands: [
      'npm run check',
      'npm test',
    ],
  },
  {
    type: 'pnpm',
    indicators: ['pnpm build', 'pnpm test', 'pnpm --filter'],
    checkCommands: [
      'pnpm build',
      'pnpm test',
    ],
  },
]

function detectRepoType(commands: string[]): RepoTypeSignature | null {
  const cmdStr = commands.join(' ').toLowerCase()
  let bestMatch: RepoTypeSignature | null = null
  let bestScore = 0

  for (const sig of REPO_TYPE_SIGNATURES) {
    const score = sig.indicators.filter((ind) => cmdStr.includes(ind.toLowerCase())).length
    if (score > bestScore) {
      bestScore = score
      bestMatch = sig
    }
  }

  return bestScore >= 2 ? bestMatch : null
}

function extractCheckRecipes(commands: string[]): string[] {
  // Find compound check commands (the ones with && chains)
  const checks = commands.filter((cmd) =>
    cmd.includes('&&') && (
      cmd.includes('test') || cmd.includes('check') || cmd.includes('clippy') ||
      cmd.includes('lint') || cmd.includes('fmt') || cmd.includes('build')
    ),
  )

  // Deduplicate by normalizing
  const seen = new Set<string>()
  const unique: string[] = []
  for (const cmd of checks) {
    const normalized = cmd.replace(/\s+/g, ' ').replace(/2>&1.*$/, '').trim()
    if (normalized.length > 10 && !seen.has(normalized)) {
      seen.add(normalized)
      unique.push(normalized)
    }
  }

  return unique.slice(0, 5) // top 5 most common check patterns
}

// ─── User profile extraction ────────────────────────────────────────

function extractOperatorPatterns(messages: Array<{ text: string }>): string[] {
  const patterns: string[] = []
  const texts = messages.map((m) => m.text.toLowerCase())

  // Detect quality stance
  const qualityPhrases = texts.filter((t) =>
    t.includes('push to the limit') || t.includes('10/10') ||
    t.includes('worldclass') || t.includes('world-class') || t.includes('world class') ||
    t.includes('no mocked') || t.includes('avoid any mocked') ||
    t.includes('fully covered') || t.includes('no shortcuts') ||
    t.includes('like an expert') || t.includes('staff engineer') ||
    t.includes('senior engineer'),
  )
  if (qualityPhrases.length >= 2) {
    patterns.push('High quality bar: demands world-class, no mocks, full coverage, expert-level work')
  }

  // Detect push-to-ship behavior
  const shipPhrases = texts.filter((t) =>
    t.includes('push') || t.includes('merge') || t.includes('ship') ||
    t.includes('deploy') || t.includes('pr'),
  )
  if (shipPhrases.length >= 3) {
    patterns.push('Shipping-oriented: frequently pushes, creates PRs, deploys')
  }

  // Detect verification habits
  const verifyPhrases = texts.filter((t) =>
    t.includes('is this done') || t.includes('is everything') ||
    t.includes('did we') || t.includes('are we') ||
    t.includes('what\'s remaining') || t.includes('what needs'),
  )
  if (verifyPhrases.length >= 2) {
    patterns.push('Verification-driven: frequently checks completion status')
  }

  // Detect multi-project context switching
  const repos = new Set(messages.map((m) => (m as { text: string; repo?: string }).repo).filter(Boolean))
  if (repos.size >= 4) {
    patterns.push(`Heavy context-switcher: works across ${repos.size}+ repos in same time window`)
  }

  // Detect eval/measurement interest
  const evalPhrases = texts.filter((t) =>
    t.includes('eval') || t.includes('measure') || t.includes('benchmark') ||
    t.includes('score') || t.includes('metrics') || t.includes('optimize'),
  )
  if (evalPhrases.length >= 2) {
    patterns.push('Measurement-focused: emphasizes evals, benchmarks, metrics, optimization')
  }

  return patterns
}

function extractGoalPatterns(messages: Array<{ text: string }>): string[] {
  const goals: string[] = []
  for (const msg of messages) {
    const text = msg.text
    // Skip short or system messages
    if (text.length < 20 || text.startsWith('<') || text.startsWith('Base directory')) continue
    // Detect imperative goal statements
    if (/^(fix|build|add|implement|create|wire|update|deploy|test|review|check|push|merge)/i.test(text)) {
      goals.push(text.slice(0, 120))
    }
  }
  return goals.slice(0, 20)
}

// ─── Main learning function ─────────────────────────────────────────

export async function learn(input: LearningInput, options?: {
  dryRun?: boolean
  memoryRoot?: string
  onAction?: (action: LearningAction) => void
}): Promise<LearningResult> {
  const dryRun = options?.dryRun ?? true
  const memoryRoot = options?.memoryRoot ?? join(FOREMAN_HOME, 'memory')
  const log = options?.onAction ?? (() => {})

  const result: LearningResult = {
    actions: [],
    recipesCreated: 0,
    factsLearned: 0,
    profileUpdates: 0,
  }

  const store = new FilesystemMemoryStore(memoryRoot)

  // 1. Extract repair recipes per repo type
  for (const [repo, commands] of input.repoCommands) {
    const repoType = detectRepoType(commands)
    if (!repoType) continue

    const checkRecipes = extractCheckRecipes(commands)
    if (checkRecipes.length === 0 && repoType.checkCommands.length > 0) {
      // Use the default check commands for this repo type
      checkRecipes.push(...repoType.checkCommands)
    }

    if (checkRecipes.length > 0) {
      const existing = await store.getStrategyMemory(repoType.type) ?? {
        taskShape: repoType.type,
        successfulPatterns: [],
        scoredRecipes: [],
      }

      // Add new recipes that don't already exist
      let newRecipes = 0
      for (const recipe of checkRecipes) {
        const alreadyExists = existing.scoredRecipes?.some((r) =>
          r.pattern.toLowerCase() === recipe.toLowerCase(),
        )
        if (!alreadyExists) {
          existing.scoredRecipes = recordRepairOutcome(
            existing.scoredRecipes ?? [],
            `${repoType.type}: ${recipe}`,
            true, // assume success since the operator runs it
          )
          newRecipes++
        }
      }

      if (newRecipes > 0) {
        const action: LearningAction = {
          type: 'recipe',
          target: repoType.type,
          description: `${newRecipes} new check recipes for ${repoType.type} repos from ${repo}: ${checkRecipes.slice(0, 2).join(', ')}`,
          data: existing,
        }
        result.actions.push(action)
        log(action)
        result.recipesCreated += newRecipes

        if (!dryRun) {
          await store.putStrategyMemory(existing)

          // Also write per-repo strategy memory with taskShape='engineering'
          // so operator-loop's findMatchingRecipe can find it at {repoPath}/.foreman/memory/strategy/engineering.json
          const repoPath = join(homedir(), 'code', repo)
          const repoMemRoot = join(repoPath, '.foreman', 'memory')
          const repoStore = new FilesystemMemoryStore(repoMemRoot)
          const repoStrategy = await repoStore.getStrategyMemory('engineering') ?? {
            taskShape: 'engineering',
            successfulPatterns: [],
            scoredRecipes: [],
          }
          for (const recipe of checkRecipes) {
            const alreadyInRepo = repoStrategy.scoredRecipes?.some((r) =>
              r.pattern.toLowerCase() === recipe.toLowerCase(),
            )
            if (!alreadyInRepo) {
              repoStrategy.scoredRecipes = recordRepairOutcome(
                repoStrategy.scoredRecipes ?? [],
                `${repoType.type}: ${recipe}`,
                true,
              )
            }
          }
          await repoStore.putStrategyMemory(repoStrategy)
        }
      }
    }
  }

  // 2. Extract environment facts per repo
  for (const [repo, files] of input.repoFiles) {
    const existing = await store.getEnvironmentMemory(repo)
    const newFacts: string[] = []

    // Key files become environment facts
    if (files.length > 0) {
      const topFiles = files.slice(0, 5)
      const fact = `Key files: ${topFiles.join(', ')}`
      if (!existing?.facts.includes(fact)) {
        newFacts.push(fact)
      }
    }

    // Commands become facts
    const commands = input.repoCommands.get(repo)
    if (commands && commands.length > 0) {
      const repoType = detectRepoType(commands)
      if (repoType) {
        const fact = `Repo type: ${repoType.type}`
        if (!existing?.facts.includes(fact)) {
          newFacts.push(fact)
        }
      }
    }

    if (newFacts.length > 0) {
      const memory: EnvironmentMemory = {
        target: repo,
        facts: [...(existing?.facts ?? []), ...newFacts],
        invariants: existing?.invariants,
        failureModes: existing?.failureModes,
      }
      const action: LearningAction = {
        type: 'environment',
        target: repo,
        description: `${newFacts.length} new facts for ${repo}: ${newFacts.join('; ')}`,
        data: memory,
      }
      result.actions.push(action)
      log(action)
      result.factsLearned += newFacts.length

      if (!dryRun) {
        await store.putEnvironmentMemory(memory)
      }
    }
  }

  // 3. Extract operator profile
  if (input.userMessages.length > 0) {
    const operatorPatterns = extractOperatorPatterns(input.userMessages)
    const goalPatterns = extractGoalPatterns(input.userMessages)

    const existing = await store.getUserMemory('operator')

    // Only update if we found new patterns
    const newPatterns = operatorPatterns.filter((p) =>
      !(existing?.operatorPatterns ?? []).includes(p),
    )
    const newGoals = goalPatterns.filter((g) =>
      !(existing?.goalPatterns ?? []).some((eg) => eg.slice(0, 50) === g.slice(0, 50)),
    )

    if (newPatterns.length > 0 || newGoals.length > 0) {
      const memory: UserMemory = {
        userId: 'operator',
        preferences: existing?.preferences ?? [],
        operatorPatterns: [...new Set([...(existing?.operatorPatterns ?? []), ...newPatterns])].slice(0, 20),
        goalPatterns: [...new Set([...(existing?.goalPatterns ?? []), ...newGoals])].slice(0, 30),
        recurringEnvironments: existing?.recurringEnvironments,
        escalationHabits: existing?.escalationHabits,
      }
      const action: LearningAction = {
        type: 'user-profile',
        target: 'operator',
        description: `${newPatterns.length} new patterns, ${newGoals.length} new goals`,
        data: { newPatterns, newGoals: newGoals.slice(0, 5) },
      }
      result.actions.push(action)
      log(action)
      result.profileUpdates += newPatterns.length + newGoals.length

      if (!dryRun) {
        await store.putUserMemory(memory)
      }
    }
  }

  // 4. Persist cross-repo patterns as strategy memory
  if (input.crossRepoPatterns.length > 0) {
    const existing = await store.getStrategyMemory('cross-repo') ?? {
      taskShape: 'cross-repo',
      successfulPatterns: [],
    }

    const newPatterns = input.crossRepoPatterns
      .filter((p) => p.frequency >= 5 && p.repos.length >= 2)
      .map((p) => `${p.pattern} (${p.frequency}x across ${p.repos.join(', ')})`)
      .filter((p) => !existing.successfulPatterns.includes(p))

    if (newPatterns.length > 0) {
      existing.successfulPatterns = [
        ...existing.successfulPatterns,
        ...newPatterns,
      ].slice(0, 30)

      const action: LearningAction = {
        type: 'strategy',
        target: 'cross-repo',
        description: `${newPatterns.length} cross-repo patterns: ${newPatterns.slice(0, 2).join('; ')}`,
        data: existing,
      }
      result.actions.push(action)
      log(action)
      result.factsLearned += newPatterns.length

      if (!dryRun) {
        await store.putStrategyMemory(existing)
      }
    }
  }

  // Save learning trace (always, even in dry-run)
  try {
    const traceDir = join(FOREMAN_HOME, 'traces', 'learning')
    await mkdir(traceDir, { recursive: true })
    await writeFile(
      join(traceDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        dryRun,
        result,
        actions: result.actions.map((a) => ({
          type: a.type,
          target: a.target,
          description: a.description,
        })),
      }, null, 2) + '\n',
      'utf8',
    )
  } catch { /* best effort */ }

  return result
}

