import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { TextProvider } from '@drew/foreman-providers';
import { parseJsonOutput } from '@drew/foreman-providers';

export interface HardenedTask {
  goal: string;
  expandedGoal: string;
  successCriteria: string[];
  checkCommands: string[];
  executionNotes: string[];
  inferred: boolean;
}

export interface TaskHardenerInput {
  goal: string;
  repoPath?: string;
  successCriteria?: string[];
}

export interface TaskHardener {
  harden(input: TaskHardenerInput): Promise<HardenedTask>;
}

export type PromptRole =
  | 'hardener'
  | 'implementer'
  | 'reviewer'
  | 'researcher'
  | 'ops'
  | 'browser';

export type PromptStyle = 'minimal' | 'persona' | 'contract-heavy' | 'socratic';

export interface PromptVariant {
  id: string;
  label: string;
  role: PromptRole;
  taskShape: string;
  style: PromptStyle;
  systemPreamble: string;
  persona?: string;
  principles?: string[];
  outputContract?: string;
  metadata?: Record<string, string>;
}

export interface PromptPack {
  id: string;
  taskShape: string;
  defaultVariantId?: string;
  variants: PromptVariant[];
}

export interface PromptExperiment {
  id: string;
  packId: string;
  variantIds: string[];
  metrics: string[];
  notes?: string[];
}

export function renderPromptVariant(input: {
  variant: PromptVariant;
  goal: string;
  successCriteria?: string[];
  contextSummary?: string;
  extraInstructions?: string[];
}): string {
  return [
    input.variant.systemPreamble,
    input.variant.persona ? `Persona: ${input.variant.persona}` : '',
    `Goal: ${input.goal}`,
    input.successCriteria?.length
      ? `Success criteria:\n${input.successCriteria.map((criterion) => `- ${criterion}`).join('\n')}`
      : '',
    input.contextSummary ? `Context:\n${input.contextSummary}` : '',
    input.variant.principles?.length
      ? `Principles:\n${input.variant.principles.map((principle) => `- ${principle}`).join('\n')}`
      : '',
    input.variant.outputContract ? `Output contract:\n${input.variant.outputContract}` : '',
    input.extraInstructions?.length
      ? `Extra instructions:\n${input.extraInstructions.map((instruction) => `- ${instruction}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');
}

export class HeuristicTaskHardener implements TaskHardener {
  async harden(input: TaskHardenerInput): Promise<HardenedTask> {
    const repoPath = input.repoPath ? resolve(input.repoPath) : undefined;
    const pkg = repoPath ? await maybeReadJson<Record<string, unknown>>(join(repoPath, 'package.json')) : null;
    const pyproject = repoPath ? await maybeReadText(join(repoPath, 'pyproject.toml')) : null;
    const cargo = repoPath ? await maybeReadText(join(repoPath, 'Cargo.toml')) : null;

    const criteria = dedupe([
      ...(input.successCriteria ?? []),
      'work is grounded in actual repository state',
      'completion is backed by executed checks or explicit blocker evidence',
    ]);

    const checks: string[] = [];
    if (pkg && typeof pkg === 'object') {
      const scripts = isRecord(pkg.scripts) ? pkg.scripts : undefined;
      if (scripts?.test) {
        checks.push('npm test');
      } else if (scripts?.check) {
        checks.push('npm run check');
      }
      if (scripts?.lint) {
        checks.push('npm run lint');
      }
      if (scripts?.typecheck) {
        checks.push('npm run typecheck');
      }
    }
    if (pyproject) {
      if (await fileExists(join(repoPath!, 'setup.cfg')) || pyproject.includes('[tool.pytest')) {
        checks.push('pytest');
      }
      if (pyproject.includes('[tool.ruff') || pyproject.includes('[tool.flake8')) {
        checks.push('ruff check .');
      }
      if (pyproject.includes('[tool.mypy')) {
        checks.push('mypy .');
      }
    }
    if (cargo) {
      checks.push('cargo fmt --check');
      checks.push('cargo clippy --workspace');
      checks.push('cargo test --workspace');
    }

    if (repoPath) {
      const ciChecks = await inferCiCheckCommands(repoPath);
      checks.push(...ciChecks);
    }

    return {
      goal: input.goal,
      expandedGoal: [
        input.goal,
        repoPath ? `Work inside ${repoPath}.` : '',
        'Complete the full scope to production quality.',
        'Treat review, formatting, linting, and validation as part of completion.',
      ].filter(Boolean).join(' '),
      successCriteria: criteria,
      checkCommands: dedupe(checks),
      executionNotes: [
        'Run ALL check commands before declaring done, including formatting and lint.',
        'If checks fail, fix the issues — do not skip them.',
        'If the task is ambiguous, preserve the original goal and add inferred criteria separately.',
      ],
      inferred: true,
    };
  }
}

export class ProviderTaskHardener implements TaskHardener {
  constructor(
    private readonly provider: TextProvider,
    private readonly fallback: TaskHardener = new HeuristicTaskHardener(),
    private readonly promptBuilder: (input: TaskHardenerInput) => string = buildDefaultHardenerPrompt,
  ) {}

  async harden(input: TaskHardenerInput): Promise<HardenedTask> {
    try {
      const execution = await this.provider.run(this.promptBuilder(input), {
        cwd: input.repoPath,
      });
      if (execution.exitCode !== 0) {
        throw new Error(execution.stderr || execution.stdout || `provider exited ${execution.exitCode}`);
      }
      const payload = parseJsonOutput(execution.stdout) as Partial<HardenedTask>;
      return {
        goal: payload.goal ?? input.goal,
        expandedGoal: payload.expandedGoal ?? input.goal,
        successCriteria: Array.isArray(payload.successCriteria) ? payload.successCriteria.map(String) : [],
        checkCommands: Array.isArray(payload.checkCommands) ? payload.checkCommands.map(String) : [],
        executionNotes: Array.isArray(payload.executionNotes) ? payload.executionNotes.map(String) : [],
        inferred: true,
      };
    } catch {
      return this.fallback.harden(input);
    }
  }
}

function buildDefaultHardenerPrompt(input: TaskHardenerInput): string {
  return [
    'Harden this task into an executable engineering task envelope.',
    'Return JSON only with keys: goal, expandedGoal, successCriteria, checkCommands, executionNotes, inferred.',
    '',
    `Goal: ${input.goal}`,
    input.repoPath ? `Repo: ${resolve(input.repoPath)}` : '',
    input.successCriteria?.length
      ? `Existing criteria:\n${input.successCriteria.map((criterion) => `- ${criterion}`).join('\n')}`
      : 'Existing criteria: (none)',
  ].filter(Boolean).join('\n');
}

async function inferCiCheckCommands(repoPath: string): Promise<string[]> {
  const ciPaths = [
    join(repoPath, '.github', 'workflows', 'ci.yml'),
    join(repoPath, '.github', 'workflows', 'ci.yaml'),
    join(repoPath, '.github', 'workflows', 'check.yml'),
    join(repoPath, '.github', 'workflows', 'test.yml'),
    join(repoPath, '.github', 'workflows', 'lint.yml'),
  ];

  const checks: string[] = [];
  for (const ciPath of ciPaths) {
    const content = await maybeReadText(ciPath);
    if (!content) {
      continue;
    }
    checks.push(...extractRunCommands(content, repoPath));
  }

  return checks;
}

const CI_SKIP_PATTERNS = [
  /^(sudo\s+)?apt-get\b/,
  /^(sudo\s+)?apt\b/,
  /^(sudo\s+)?brew\b/,
  /^(sudo\s+)?yum\b/,
  /^ln\s+-/,
  /^mkdir\b/,
  /^cp\b/,
  /^mv\b/,
  /^echo\b/,
  /^export\b/,
  /^cd\b/,
  /^cat\b/,
  /^chmod\b/,
  /^docker\s+(login|push|build|tag)\b/,
  /^gh\s/,
  /^git\s+(push|fetch|remote|clone)\b/,
  /deploy/i,
  /^curl\b/,
  /^wget\b/,
  /^pip\s+install\b/,
  /^npm\s+(ci|install)\b/,
  /^pnpm\s+install\b/,
  /^yarn\s+install\b/,
  /^cargo\s+install\b/,
  /^rustup\b/,
];

const CI_AUDIT_PATTERNS = [
  /cargo\s+audit/,
  /npm\s+audit/,
  /snyk\b/,
];

function extractRunCommands(yamlContent: string, repoPath: string): string[] {
  const commands: string[] = [];
  const lines = yamlContent.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const runMatch = line.match(/^\s+-?\s*run:\s*(.+)/);
    if (!runMatch) {
      const blockRunMatch = line.match(/^\s+-?\s*run:\s*[|>]-?\s*$/);
      if (blockRunMatch) {
        const indent = line.search(/\S/);
        const blockLines: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j]!;
          if (nextLine.trim() === '') {
            blockLines.push('');
            continue;
          }
          const nextIndent = nextLine.search(/\S/);
          if (nextIndent <= indent) {
            break;
          }
          blockLines.push(nextLine.trim());
        }
        const blockCommand = blockLines
          .filter(Boolean)
          .join(' && ');
        if (blockCommand) {
          const resolved = resolveCommand(blockCommand, repoPath);
          if (resolved) {
            commands.push(resolved);
          }
        }
      }
      continue;
    }

    const rawCommand = runMatch[1]!.trim();
    const resolved = resolveCommand(rawCommand, repoPath);
    if (resolved) {
      commands.push(resolved);
    }
  }

  return commands;
}

function resolveCommand(raw: string, repoPath: string): string | null {
  let command = raw
    .replace(/\$\{\{[^}]*\}\}/g, '')
    .replace(/\$[A-Z_]+/g, '')
    .trim();

  if (!command || command.length < 3) {
    return null;
  }
  if (CI_SKIP_PATTERNS.some((pattern) => pattern.test(command))) {
    return null;
  }
  if (CI_AUDIT_PATTERNS.some((pattern) => pattern.test(command))) {
    return null;
  }
  if (command.startsWith('./')) {
    command = `cd ${repoPath} && ${command}`;
  }

  return command;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function isRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null;
}

async function maybeReadJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function maybeReadText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
