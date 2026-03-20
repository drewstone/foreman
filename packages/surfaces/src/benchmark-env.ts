/**
 * Benchmark evaluation environments for Foreman.
 *
 * Tests Foreman's ability to orchestrate agents (any combination of
 * claude/codex/pi/opencode) to solve standardized coding tasks.
 *
 * Unlike Hermes (which evaluates a single model), these benchmarks
 * evaluate the ORCHESTRATION STRATEGY:
 *   - Which harness(es) to use
 *   - What CLAUDE.md / system prompt to generate
 *   - Whether to use single-shot, repair loop, or parallel experiments
 *   - How to combine implement → review → fix cycles
 *
 * Same task, different strategies, different scores.
 * GEPA optimizes the strategy, not the model.
 *
 * Environments:
 *   TerminalTaskEnv   — file creation, shell commands, basic coding
 *   SWEBenchEnv       — real GitHub issues with test verification
 *   MultiHarnessEnv   — tests orchestration across multiple harnesses
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import {
  ForemanEvalEnv,
  rewardFromMetrics,
  type EvalTask,
  type EvalRunResult,
  type EvalScoreResult,
  type EvalSessionMetrics,
} from '@drew/foreman-evals/eval-env'
import type { RewardSignal } from '@drew/foreman-tracing'

const execFileAsync = promisify(execFile)
const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

// ─── Terminal Task Environment ──────────────────────────────────────

interface TerminalTask extends EvalTask {
  prompt: string
  verifyCommand: string
  expectedOutput: string
  workDir?: string
}

const TERMINAL_TASKS: TerminalTask[] = [
  {
    id: 'terminal:file-create',
    goal: 'Create a file at /tmp/foreman-test/greeting.txt containing exactly: Hello from Foreman',
    prompt: 'Create a file at /tmp/foreman-test/greeting.txt containing exactly the text: Hello from Foreman',
    verifyCommand: 'cat /tmp/foreman-test/greeting.txt',
    expectedOutput: 'Hello from Foreman',
    environmentKind: 'terminal',
  },
  {
    id: 'terminal:arithmetic',
    goal: 'Create a file with the result of 123 * 456 + 789',
    prompt: 'Create a file at /tmp/foreman-test/math.txt containing the result of 123 * 456 + 789',
    verifyCommand: 'cat /tmp/foreman-test/math.txt',
    expectedOutput: '56877',
    environmentKind: 'terminal',
  },
  {
    id: 'terminal:script',
    goal: 'Write a bash script that counts files in /usr and run it',
    prompt: 'Write a bash script at /tmp/foreman-test/count.sh that counts the number of files (not directories) in /usr recursively. Run it and save the output to /tmp/foreman-test/count.txt',
    verifyCommand: 'test -f /tmp/foreman-test/count.txt && test -f /tmp/foreman-test/count.sh && echo "OK"',
    expectedOutput: 'OK',
    environmentKind: 'terminal',
  },
  {
    id: 'terminal:git-init',
    goal: 'Initialize a git repo with a commit',
    prompt: 'Create a new git repo at /tmp/foreman-test/myrepo, add a README.md with "# Test Repo", and make an initial commit',
    verifyCommand: 'cd /tmp/foreman-test/myrepo && git log --oneline | head -1',
    expectedOutput: '', // just needs to not be empty
    environmentKind: 'terminal',
  },
  {
    id: 'terminal:json-transform',
    goal: 'Transform JSON data with jq',
    prompt: 'Create /tmp/foreman-test/data.json with {"users":[{"name":"Alice","age":30},{"name":"Bob","age":25}]}. Then use jq to extract just the names into /tmp/foreman-test/names.json as ["Alice","Bob"]',
    verifyCommand: 'cat /tmp/foreman-test/names.json',
    expectedOutput: '["Alice","Bob"]',
    environmentKind: 'terminal',
  },
]

export class TerminalTaskEnv extends ForemanEvalEnv {
  readonly name = 'terminal-tasks'
  private harness: 'claude' | 'codex' = 'claude'

  constructor(options?: { harness?: 'claude' | 'codex'; artifactRoot?: string; traceRoot?: string }) {
    super(options)
    this.harness = options?.harness ?? 'claude'
  }

  async loadTasks(): Promise<EvalTask[]> {
    return TERMINAL_TASKS
  }

  async resolveArtifacts() {
    const artifacts: Record<string, { kind: string; name: string; versionId: string; content: string }> = {}

    const claudeMd = await this.store.getActive('claudemd-template', 'terminal-tasks')
    if (claudeMd) {
      artifacts['claudemd'] = {
        kind: 'claudemd-template',
        name: 'terminal-tasks',
        versionId: claudeMd.version.id,
        content: claudeMd.content,
      }
    }

    return artifacts
  }

  async run(task: EvalTask, artifacts: Record<string, { kind: string; name: string; versionId: string; content: string }>): Promise<EvalRunResult> {
    const tt = task as TerminalTask

    // Clean up from previous runs
    try { await rm('/tmp/foreman-test', { recursive: true, force: true }) } catch {}
    await mkdir('/tmp/foreman-test', { recursive: true })

    const { spawnSession } = await import('./operator-loop.js')
    const { enrichMetrics } = await import('./session-metrics.js')

    const spawnResult = await spawnSession({
      repoPath: '/tmp/foreman-test',
      goal: tt.prompt,
      claudeMd: artifacts['claudemd']?.content,
      provider: this.harness,
      timeoutMs: 3 * 60 * 1000,
    })

    let metrics = spawnResult.metrics ?? {
      sessionId: spawnResult.sessionId,
      harness: this.harness,
      repo: 'foreman-test',
      goal: tt.prompt,
      timestamp: new Date().toISOString(),
      exitCode: spawnResult.exitCode,
      success: spawnResult.exitCode === 0,
      durationMs: spawnResult.durationMs,
    }

    metrics = await enrichMetrics(metrics, spawnResult.stdout)

    return { task, metrics, resultText: spawnResult.stdout, artifacts: {} }
  }

  async score(result: EvalRunResult): Promise<EvalScoreResult> {
    const tt = result.task as TerminalTask
    const rewards: RewardSignal[] = []

    rewards.push(...rewardFromMetrics(result.metrics))

    // Verify the task output
    let passed = false
    try {
      const { stdout } = await execFileAsync('bash', ['-c', tt.verifyCommand], { timeout: 10_000 })
      const output = stdout.trim()
      if (tt.expectedOutput === '') {
        passed = output.length > 0
      } else {
        passed = output.includes(tt.expectedOutput.trim())
      }
    } catch { /* verify failed */ }

    rewards.push({
      name: 'task_verified',
      value: passed ? 1 : 0,
      source: 'deterministic',
    })

    return {
      rewards,
      taskCompletion: passed ? 'completed' : 'failed',
      summary: passed ? 'Task output verified' : 'Verification failed',
    }
  }
}

// ─── SWE-Bench Style Environment ────────────────────────────────────

interface SWETask extends EvalTask {
  repoUrl: string
  issueDescription: string
  testCommand: string
  setupCommand?: string
}

export class SWEBenchEnv extends ForemanEvalEnv {
  readonly name = 'swe-bench'
  private tasks: SWETask[] = []

  constructor(options?: { tasks?: SWETask[]; artifactRoot?: string; traceRoot?: string }) {
    super(options)
    if (options?.tasks) this.tasks = options.tasks
  }

  async loadTasks(): Promise<EvalTask[]> {
    if (this.tasks.length > 0) return this.tasks

    // Load from a local dataset file if available
    try {
      const dataPath = join(FOREMAN_HOME, 'benchmarks', 'swe-bench.json')
      const data = JSON.parse(await readFile(dataPath, 'utf8')) as SWETask[]
      this.tasks = data
    } catch { /* no dataset */ }

    return this.tasks
  }

  async resolveArtifacts() {
    const artifacts: Record<string, { kind: string; name: string; versionId: string; content: string }> = {}

    const claudeMd = await this.store.getActive('claudemd-template', 'swe-bench')
    if (claudeMd) {
      artifacts['claudemd'] = {
        kind: 'claudemd-template',
        name: 'swe-bench',
        versionId: claudeMd.version.id,
        content: claudeMd.content,
      }
    }

    return artifacts
  }

  async run(task: EvalTask, artifacts: Record<string, { kind: string; name: string; versionId: string; content: string }>): Promise<EvalRunResult> {
    const swe = task as SWETask

    // Clone repo to temp dir — git clone requires target dir to not exist
    const workDir = join('/tmp', `foreman-swe-${Date.now()}`)

    try {
      await execFileAsync('git', ['clone', '--depth', '1', swe.repoUrl, workDir], { timeout: 60_000 })
    } catch (e) {
      return {
        task,
        metrics: {
          sessionId: 'clone-failed',
          harness: 'claude',
          repo: swe.repoUrl.split('/').pop() ?? '',
          goal: swe.issueDescription,
          timestamp: new Date().toISOString(),
          exitCode: 1,
          success: false,
          durationMs: 0,
        },
        resultText: `Clone failed: ${e}`,
        artifacts: {},
      }
    }

    // Setup
    if (swe.setupCommand) {
      try {
        await execFileAsync('bash', ['-c', swe.setupCommand], { cwd: workDir, timeout: 120_000 })
      } catch { /* setup failed — still try */ }
    }

    const { spawnSession } = await import('./operator-loop.js')
    const { enrichMetrics } = await import('./session-metrics.js')

    const spawnResult = await spawnSession({
      repoPath: workDir,
      goal: swe.issueDescription,
      claudeMd: artifacts['claudemd']?.content,
      provider: 'claude',
      timeoutMs: 10 * 60 * 1000,
    })

    let metrics = spawnResult.metrics ?? {
      sessionId: spawnResult.sessionId,
      harness: 'claude' as const,
      repo: swe.repoUrl.split('/').pop() ?? '',
      goal: swe.issueDescription,
      timestamp: new Date().toISOString(),
      exitCode: spawnResult.exitCode,
      success: spawnResult.exitCode === 0,
      durationMs: spawnResult.durationMs,
    }

    metrics = await enrichMetrics(metrics, spawnResult.stdout)

    return { task, metrics, resultText: spawnResult.stdout, artifacts: {}, metadata: { workDir } }
  }

  async score(result: EvalRunResult): Promise<EvalScoreResult> {
    const swe = result.task as SWETask
    const rewards: RewardSignal[] = []

    rewards.push(...rewardFromMetrics(result.metrics))

    // Run tests in the work dir from the run phase
    let testPassed = false
    try {
      const workDir = result.metadata?.workDir as string | undefined ?? '/tmp'
      const { stdout } = await execFileAsync('bash', ['-c', swe.testCommand], {
        cwd: workDir,
        timeout: 120_000,
      })
      testPassed = true
    } catch { /* tests failed */ }

    rewards.push({
      name: 'tests_pass',
      value: testPassed ? 1 : 0,
      source: 'deterministic',
    })

    return {
      rewards,
      taskCompletion: testPassed ? 'completed' : 'failed',
      summary: testPassed ? 'All tests pass' : 'Tests failed',
    }
  }
}

// ─── Multi-Harness Orchestration Environment ────────────────────────

export interface OrchestrationStrategy {
  name: string
  steps: Array<{
    harness: 'claude' | 'codex' | 'pi' | 'opencode'
    role: 'implement' | 'review' | 'fix' | 'audit' | 'validate'
    claudeMdTemplate?: string
    goal: string
    dependsOn?: string
  }>
}

export class MultiHarnessEnv extends ForemanEvalEnv {
  readonly name = 'multi-harness'
  private tasks: EvalTask[] = []
  private strategies: OrchestrationStrategy[] = []

  constructor(options?: {
    tasks?: EvalTask[]
    strategies?: OrchestrationStrategy[]
    artifactRoot?: string
    traceRoot?: string
  }) {
    super(options)
    if (options?.tasks) this.tasks = options.tasks
    this.strategies = options?.strategies ?? DEFAULT_STRATEGIES
  }

  async loadTasks(): Promise<EvalTask[]> {
    if (this.tasks.length > 0) return this.tasks

    // Use terminal tasks as the base — each gets run with each strategy
    const baseTasks = TERMINAL_TASKS.slice(0, 3) // first 3 for speed
    for (const strategy of this.strategies) {
      for (const base of baseTasks) {
        this.tasks.push({
          ...base,
          id: `multi:${strategy.name}:${base.id}`,
          metadata: {
            ...(base.metadata ?? {}),
            strategy: strategy.name,
          },
        })
      }
    }
    return this.tasks
  }

  async resolveArtifacts() {
    const artifacts: Record<string, { kind: string; name: string; versionId: string; content: string }> = {}

    // Load orchestration strategy from versioned store
    const strategy = await this.store.getActive('orchestration-strategy', 'multi-harness')
    if (strategy) {
      artifacts['strategy'] = {
        kind: 'orchestration-strategy',
        name: 'multi-harness',
        versionId: strategy.version.id,
        content: strategy.content,
      }
    }

    return artifacts
  }

  async run(task: EvalTask, artifacts: Record<string, { kind: string; name: string; versionId: string; content: string }>): Promise<EvalRunResult> {
    const strategyName = task.metadata?.strategy ?? 'single-claude'
    const strategy = this.strategies.find((s) => s.name === strategyName) ?? this.strategies[0]

    // Clean workspace
    try { await rm('/tmp/foreman-test', { recursive: true, force: true }) } catch {}
    await mkdir('/tmp/foreman-test', { recursive: true })

    const { spawnSession } = await import('./operator-loop.js')
    const { enrichMetrics } = await import('./session-metrics.js')

    let lastResult: Awaited<ReturnType<typeof spawnSession>> | null = null
    let totalDurationMs = 0
    let totalCost = 0
    let totalTurns = 0
    const stepResults: string[] = []

    for (const step of strategy.steps) {
      const stepGoal = step.role === 'implement' ? task.goal
        : step.role === 'review' ? `Review the code changes and check for correctness. Goal was: ${task.goal}`
        : step.role === 'fix' ? `Fix any issues found in the review. Original goal: ${task.goal}`
        : step.role === 'audit' ? `Audit the implementation for security and quality. Goal: ${task.goal}`
        : step.role === 'validate' ? `Verify the implementation works correctly. Goal: ${task.goal}`
        : task.goal

      const result = await spawnSession({
        repoPath: '/tmp/foreman-test',
        goal: stepGoal,
        claudeMd: step.claudeMdTemplate,
        provider: step.harness === 'pi' || step.harness === 'opencode' ? 'claude' : step.harness,
        timeoutMs: 5 * 60 * 1000,
      })

      lastResult = result
      totalDurationMs += result.durationMs

      if (result.metrics) {
        totalCost += result.metrics.costUsd ?? 0
        totalTurns += result.metrics.numTurns ?? 0
      }

      stepResults.push(`[${step.harness}:${step.role}] exit=${result.exitCode} ${(result.durationMs / 1000).toFixed(1)}s`)

      // If implementation failed, skip remaining steps
      if (step.role === 'implement' && result.exitCode !== 0) break
    }

    const metrics: EvalSessionMetrics = {
      sessionId: lastResult?.sessionId ?? 'unknown',
      harness: strategy.steps[0]?.harness ?? 'claude',
      repo: 'foreman-test',
      goal: task.goal,
      timestamp: new Date().toISOString(),
      exitCode: lastResult?.exitCode ?? 1,
      success: lastResult?.exitCode === 0,
      durationMs: totalDurationMs,
      costUsd: totalCost > 0 ? totalCost : undefined,
      numTurns: totalTurns,
    }

    return {
      task,
      metrics,
      resultText: stepResults.join('\n') + '\n' + (lastResult?.stdout ?? ''),
      artifacts: {},
    }
  }

  async score(result: EvalRunResult): Promise<EvalScoreResult> {
    const tt = result.task as TerminalTask
    const rewards: RewardSignal[] = []

    rewards.push(...rewardFromMetrics(result.metrics))

    // Verify if available
    if (tt.verifyCommand) {
      let passed = false
      try {
        const { stdout } = await execFileAsync('bash', ['-c', tt.verifyCommand], { timeout: 10_000 })
        const output = stdout.trim()
        passed = tt.expectedOutput === '' ? output.length > 0 : output.includes(tt.expectedOutput.trim())
      } catch {}

      rewards.push({
        name: 'task_verified',
        value: passed ? 1 : 0,
        source: 'deterministic',
      })

      return {
        rewards,
        taskCompletion: passed ? 'completed' : 'failed',
        summary: `${result.task.metadata?.strategy}: ${passed ? 'PASS' : 'FAIL'}`,
      }
    }

    return {
      rewards,
      taskCompletion: result.metrics.success ? 'completed' : 'failed',
      summary: `${result.task.metadata?.strategy}: exit ${result.metrics.exitCode}`,
    }
  }
}

const DEFAULT_STRATEGIES: OrchestrationStrategy[] = [
  {
    name: 'single-claude',
    steps: [
      { harness: 'claude', role: 'implement', goal: '' },
    ],
  },
  {
    name: 'single-codex',
    steps: [
      { harness: 'codex', role: 'implement', goal: '' },
    ],
  },
  {
    name: 'claude-then-review',
    steps: [
      { harness: 'claude', role: 'implement', goal: '' },
      { harness: 'claude', role: 'review', goal: '', claudeMdTemplate: 'You are reviewing another agent\'s work. Trust nothing. Verify everything.' },
    ],
  },
  {
    name: 'claude-implement-codex-review',
    steps: [
      { harness: 'claude', role: 'implement', goal: '' },
      { harness: 'codex', role: 'review', goal: '' },
    ],
  },
  {
    name: 'claude-implement-review-fix',
    steps: [
      { harness: 'claude', role: 'implement', goal: '' },
      { harness: 'claude', role: 'review', goal: '', claudeMdTemplate: 'You are a skeptical reviewer. Find real bugs, not style nits.' },
      { harness: 'claude', role: 'fix', goal: '' },
    ],
  },
]
