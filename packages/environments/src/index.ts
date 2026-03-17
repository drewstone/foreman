export interface EnvironmentRef {
  kind: string;
  target?: string;
  metadata?: Record<string, string>;
}

import type { Evidence } from '@drew/foreman-core';

export type EnvironmentEvidence = Evidence;

export interface Observation {
  summary: string;
  evidence?: EnvironmentEvidence[];
  metadata?: Record<string, string>;
}

export interface Intervention {
  kind: 'message' | 'retry' | 'cancel' | 'redirect' | 'escalate';
  summary: string;
  metadata?: Record<string, string>;
}

export interface EnvironmentAdapter<TState = unknown> {
  environment: EnvironmentRef;
  observe(): Promise<Observation & { state?: TState }>;
  verify?(goal: string): Promise<Observation>;
}

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CodeEnvironmentState {
  repoRoot: string;
  branch: string;
  headSha: string;
  changedFiles: string[];
  dirty: boolean;
}

export interface CommandCheckResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
}

export class GitCodeEnvironment implements EnvironmentAdapter<CodeEnvironmentState> {
  public readonly environment: EnvironmentRef;

  constructor(private readonly repoPath: string) {
    this.environment = {
      kind: 'code',
      target: repoPath,
    };
  }

  async observe(): Promise<Observation & { state?: CodeEnvironmentState }> {
    const repoRoot = await this.git(['rev-parse', '--show-toplevel']);
    const branch = await this.git(['symbolic-ref', '--short', 'HEAD'], true);
    const headSha = await this.git(['rev-parse', 'HEAD'], true);
    const status = await this.git(['status', '--porcelain'], true);
    const changedFiles = status.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

    return {
      summary: changedFiles.length > 0
        ? `${changedFiles.length} changed file(s) on ${branch.stdout.trim() || 'unborn'}`
        : `clean worktree on ${branch.stdout.trim() || 'unborn'}`,
      state: {
        repoRoot: repoRoot.stdout.trim(),
        branch: branch.stdout.trim() || 'unborn',
        headSha: headSha.stdout.trim() || 'unborn',
        changedFiles,
        dirty: changedFiles.length > 0,
      },
      evidence: [
        {
          kind: 'log',
          label: 'git-status',
          value: status.stdout.trim() || '(clean)',
        },
      ],
    };
  }

  async verify(goal: string): Promise<Observation> {
    const observation = await this.observe();
    return {
      summary: `verified code environment for goal: ${goal}`,
      evidence: observation.evidence,
      metadata: {
        branch: observation.state?.branch ?? '',
        headSha: observation.state?.headSha ?? '',
      },
    };
  }

  async runChecks(commands: string[]): Promise<CommandCheckResult[]> {
    const results: CommandCheckResult[] = [];
    for (const command of commands) {
      if (!command.trim()) {
        continue;
      }
      try {
        const output = await execFileAsync('bash', ['-lc', command], {
          cwd: this.repoPath,
          env: process.env,
          timeout: 10 * 60 * 1000,
        });
        results.push({
          command,
          exitCode: 0,
          stdout: output.stdout ?? '',
          stderr: output.stderr ?? '',
          passed: true,
        });
      } catch (error) {
        const err = error as NodeJS.ErrnoException & {
          code?: number | string;
          stdout?: string;
          stderr?: string;
        };
        results.push({
          command,
          exitCode: typeof err.code === 'number' ? err.code : 1,
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? String(error),
          passed: false,
        });
      }
    }
    return results;
  }

  async discoverProductContext(options?: {
    maxFileBytes?: number;
    maxFiles?: number;
  }): Promise<{ summary: string; docs: Array<{ path: string; content: string }>; evidence: EnvironmentEvidence[] }> {
    const maxBytes = options?.maxFileBytes ?? 8000;
    const maxFiles = options?.maxFiles ?? 10;
    const docCandidates = [
      'CLAUDE.md',
      'README.md',
      'ARCHITECTURE.md',
      'CONTRIBUTING.md',
      'SPEC.md',
      'docs/ARCHITECTURE.md',
      'docs/SPEC.md',
      'docs/DESIGN.md',
      'docs/UI_INTEGRATION_SPEC.md',
    ];

    const docs: Array<{ path: string; content: string }> = [];
    for (const candidate of docCandidates) {
      if (docs.length >= maxFiles) {
        break;
      }
      try {
        const content = await readFile(joinPath(this.repoPath, candidate), 'utf8');
        if (content.trim()) {
          docs.push({
            path: candidate,
            content: content.length > maxBytes ? content.slice(0, maxBytes) + '\n...(truncated)' : content,
          });
        }
      } catch {
        continue;
      }
    }

    const ciPaths = ['.github/workflows/ci.yml', '.github/workflows/ci.yaml'];
    for (const ciPath of ciPaths) {
      if (docs.length >= maxFiles) {
        break;
      }
      try {
        const content = await readFile(joinPath(this.repoPath, ciPath), 'utf8');
        if (content.trim()) {
          docs.push({ path: ciPath, content: content.length > maxBytes ? content.slice(0, maxBytes) + '\n...(truncated)' : content });
          break;
        }
      } catch {
        continue;
      }
    }

    const configFiles = ['package.json', 'Cargo.toml', 'pyproject.toml'];
    for (const configFile of configFiles) {
      if (docs.length >= maxFiles) {
        break;
      }
      try {
        const content = await readFile(joinPath(this.repoPath, configFile), 'utf8');
        if (content.trim()) {
          docs.push({
            path: configFile,
            content: content.length > 2000 ? content.slice(0, 2000) + '\n...(truncated)' : content,
          });
        }
      } catch {
        continue;
      }
    }

    const summary = docs.length > 0
      ? `Product context from ${docs.length} file(s): ${docs.map((d) => d.path).join(', ')}`
      : 'No product documentation found in repository.';

    const evidence: EnvironmentEvidence[] = docs.map((doc) => ({
      kind: 'artifact',
      label: `doc:${doc.path}`,
      value: doc.content,
    }));

    return { summary, docs, evidence };
  }

  async collectRepoEvidence(): Promise<EnvironmentEvidence[]> {
    const status = await this.git(['status', '--porcelain'], true);
    const diffStat = await this.git(['diff', '--stat'], true);
    const changedFiles = await this.git(['diff', '--name-only'], true);

    return [
      {
        kind: 'log',
        label: 'git-status',
        value: status.stdout.trim() || '(clean)',
      },
      {
        kind: 'diff',
        label: 'git-diff-stat',
        value: diffStat.stdout.trim() || '(no diff stat)',
      },
      {
        kind: 'artifact',
        label: 'changed-files',
        value: changedFiles.stdout.trim() || '(no changed files)',
      },
    ];
  }

  private async git(args: string[], allowFailure = false): Promise<{ stdout: string; stderr: string }> {
    try {
      const output = await execFileAsync('git', args, {
        cwd: this.repoPath,
        env: process.env,
      });
      return {
        stdout: output.stdout ?? '',
        stderr: output.stderr ?? '',
      };
    } catch (error) {
      if (allowFailure) {
        const err = error as { stdout?: string; stderr?: string };
        return {
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? '',
        };
      }
      throw error;
    }
  }
}

export interface DocumentWorkspaceState {
  root: string;
  fileCount: number;
  recentFiles: string[];
  checklistHits: string[];
}

export interface ResearchCorpusState {
  root: string;
  sourceCount: number;
  citationLikeFiles: string[];
  noteLikeFiles: string[];
}

export interface ServiceEnvironmentState {
  label: string;
  healthy: boolean;
  endpointStatuses: Array<{ url: string; status: number; ok: boolean }>;
  checkResults: CommandCheckResult[];
}

export interface HybridEnvironmentState {
  environments: Array<{
    kind: string;
    target?: string;
    summary: string;
  }>;
}

export class FilesystemDocumentEnvironment implements EnvironmentAdapter<DocumentWorkspaceState> {
  public readonly environment: EnvironmentRef;

  constructor(
    private readonly rootPath: string,
    private readonly options?: {
      filePatterns?: string[];
      checklistPatterns?: string[];
    },
  ) {
    this.environment = {
      kind: 'document',
      target: rootPath,
    };
  }

  async observe(): Promise<Observation & { state?: DocumentWorkspaceState }> {
    const filePatterns = this.options?.filePatterns ?? ['*.md', '*.txt', '*.pdf', '*.docx', '*.csv', '*.json'];
    const checklistPatterns = this.options?.checklistPatterns ?? ['TODO', 'CHECKLIST', 'NEEDS', 'MISSING'];
    const files = await listFiles(this.rootPath, filePatterns);
    const recentFiles = await sortByMtime(this.rootPath, files);
    const checklistHits = await findPatternHits(this.rootPath, files, checklistPatterns);

    return {
      summary: files.length > 0
        ? `${files.length} document file(s), ${checklistHits.length} checklist-like signal(s)`
        : 'no matching document files found',
      state: {
        root: this.rootPath,
        fileCount: files.length,
        recentFiles: recentFiles.slice(0, 10),
        checklistHits: checklistHits.slice(0, 10),
      },
      evidence: [
        {
          kind: 'artifact',
          label: 'document-files',
          value: recentFiles.slice(0, 20).join('\n') || '(none)',
        },
        {
          kind: 'note',
          label: 'document-checklist-signals',
          value: checklistHits.slice(0, 20).join('\n') || '(none)',
        },
      ],
    };
  }

  async verify(goal: string): Promise<Observation> {
    const observation = await this.observe();
    return {
      summary: `verified document environment for goal: ${goal}`,
      evidence: observation.evidence,
      metadata: {
        fileCount: String(observation.state?.fileCount ?? 0),
      },
    };
  }
}

export class ResearchCorpusEnvironment implements EnvironmentAdapter<ResearchCorpusState> {
  public readonly environment: EnvironmentRef;

  constructor(
    private readonly rootPath: string,
    private readonly options?: {
      sourcePatterns?: string[];
      notePatterns?: string[];
    },
  ) {
    this.environment = {
      kind: 'document',
      target: rootPath,
      metadata: {
        mode: 'research',
      },
    };
  }

  async observe(): Promise<Observation & { state?: ResearchCorpusState }> {
    const sourcePatterns = this.options?.sourcePatterns ?? ['*.md', '*.pdf', '*.html', '*.json', '*.txt'];
    const notePatterns = this.options?.notePatterns ?? ['*note*', '*summary*', '*brief*', '*.md'];
    const sourceFiles = await listFiles(this.rootPath, sourcePatterns);
    const noteLikeFiles = await listFiles(this.rootPath, notePatterns);
    const citationLikeFiles = await findPatternHits(this.rootPath, sourceFiles, ['http://', 'https://', 'doi', '[1]', '(source)']);

    return {
      summary: sourceFiles.length > 0
        ? `${sourceFiles.length} research source file(s), ${citationLikeFiles.length} citation-like signal(s)`
        : 'no research sources found',
      state: {
        root: this.rootPath,
        sourceCount: sourceFiles.length,
        citationLikeFiles: citationLikeFiles.slice(0, 10),
        noteLikeFiles: noteLikeFiles.slice(0, 10),
      },
      evidence: [
        {
          kind: 'artifact',
          label: 'research-sources',
          value: sourceFiles.slice(0, 20).join('\n') || '(none)',
        },
        {
          kind: 'note',
          label: 'research-citation-signals',
          value: citationLikeFiles.slice(0, 20).join('\n') || '(none)',
        },
      ],
    };
  }

  async verify(goal: string): Promise<Observation> {
    const observation = await this.observe();
    return {
      summary: `verified research environment for goal: ${goal}`,
      evidence: observation.evidence,
      metadata: {
        sourceCount: String(observation.state?.sourceCount ?? 0),
      },
    };
  }
}

export class ServiceEnvironment implements EnvironmentAdapter<ServiceEnvironmentState> {
  public readonly environment: EnvironmentRef;

  constructor(
    private readonly label: string,
    private readonly options?: {
      healthUrls?: string[];
      checkCommands?: string[];
      cwd?: string;
    },
  ) {
    this.environment = {
      kind: 'api',
      target: label,
    };
  }

  async observe(): Promise<Observation & { state?: ServiceEnvironmentState }> {
    const endpointStatuses = await Promise.all(
      (this.options?.healthUrls ?? []).map(async (url) => {
        try {
          const response = await fetch(url);
          return { url, status: response.status, ok: response.ok };
        } catch {
          return { url, status: 0, ok: false };
        }
      }),
    );
    const checkResults = await runCommands(this.options?.checkCommands ?? [], this.options?.cwd);
    const healthy = endpointStatuses.every((item) => item.ok)
      && checkResults.every((result) => result.passed);

    return {
      summary: healthy
        ? `${this.label} healthy across ${endpointStatuses.length} endpoint(s) and ${checkResults.length} check(s)`
        : `${this.label} has failing endpoints or checks`,
      state: {
        label: this.label,
        healthy,
        endpointStatuses,
        checkResults,
      },
      evidence: [
        {
          kind: 'metric',
          label: 'service-endpoints',
          value: endpointStatuses.map((item) => `${item.status} ${item.url}`).join('\n') || '(none)',
        },
        {
          kind: 'log',
          label: 'service-checks',
          value: checkResults.map((item) => `${item.passed ? 'PASS' : 'FAIL'} ${item.command}`).join('\n') || '(none)',
        },
      ],
    };
  }

  async verify(goal: string): Promise<Observation> {
    const observation = await this.observe();
    return {
      summary: `verified service environment for goal: ${goal}`,
      evidence: observation.evidence,
      metadata: {
        healthy: String(observation.state?.healthy ?? false),
      },
    };
  }
}

export class HybridEnvironment implements EnvironmentAdapter<HybridEnvironmentState> {
  public readonly environment: EnvironmentRef = {
    kind: 'hybrid',
  };

  constructor(private readonly adapters: EnvironmentAdapter[]) {}

  async observe(): Promise<Observation & { state?: HybridEnvironmentState }> {
    const observations = await Promise.all(this.adapters.map((adapter) => adapter.observe()));
    return {
      summary: observations.map((item) => item.summary).join(' | '),
      state: {
        environments: observations.map((item, index) => ({
          kind: this.adapters[index]?.environment.kind ?? 'unknown',
          target: this.adapters[index]?.environment.target,
          summary: item.summary,
        })),
      },
      evidence: observations.flatMap((item) => item.evidence ?? []),
    };
  }

  async verify(goal: string): Promise<Observation> {
    const verification = await Promise.all(
      this.adapters.map(async (adapter) => (adapter.verify ? adapter.verify(goal) : adapter.observe())),
    );
    return {
      summary: verification.map((item) => item.summary).join(' | '),
      evidence: verification.flatMap((item) => item.evidence ?? []),
    };
  }
}

async function listFiles(rootPath: string, patterns: string[]): Promise<string[]> {
  const rgArgs = ['--files', ...patterns.flatMap((pattern) => ['-g', pattern])];
  const rg = await execCommand('rg', rgArgs, rootPath, true);
  if (rg.stdout.trim()) {
    return rg.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  const find = await execCommand('bash', ['-lc', 'find . -type f | sed "s#^./##"'], rootPath, true);
  return find.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => patterns.some((pattern) => fileMatchesPattern(file, pattern)));
}

async function sortByMtime(rootPath: string, files: string[]): Promise<string[]> {
  const stats = await Promise.all(
    files.map(async (file) => {
      try {
        const output = await execCommand('bash', ['-lc', `stat -c '%Y %n' "${file.replace(/"/g, '\\"')}"`], rootPath, true);
        const [mtimeRaw, ...nameParts] = output.stdout.trim().split(' ');
        return {
          file,
          mtime: Number(mtimeRaw) || 0,
          name: nameParts.join(' ') || file,
        };
      } catch {
        return {
          file,
          mtime: 0,
          name: file,
        };
      }
    }),
  );
  return stats.sort((left, right) => right.mtime - left.mtime).map((item) => item.name);
}

async function findPatternHits(rootPath: string, files: string[], patterns: string[]): Promise<string[]> {
  const hits: string[] = [];
  for (const file of files.slice(0, 200)) {
    try {
      const content = await readFile(joinPath(rootPath, file), 'utf8');
      if (patterns.some((pattern) => content.toLowerCase().includes(pattern.toLowerCase()))) {
        hits.push(file);
      }
    } catch {
      continue;
    }
  }
  return hits;
}

async function runCommands(commands: string[], cwd?: string): Promise<CommandCheckResult[]> {
  const results: CommandCheckResult[] = [];
  for (const command of commands) {
    if (!command.trim()) {
      continue;
    }
    const output = await execCommand('bash', ['-lc', command], cwd, true);
    results.push({
      command,
      exitCode: output.exitCode,
      stdout: output.stdout,
      stderr: output.stderr,
      passed: output.exitCode === 0,
    });
  }
  return results;
}

async function execCommand(
  command: string,
  args: string[],
  cwd?: string,
  allowFailure = false,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const output = await execFileAsync(command, args, {
      cwd,
      env: process.env,
    });
    return {
      stdout: output.stdout ?? '',
      stderr: output.stderr ?? '',
      exitCode: 0,
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number | string };
    if (!allowFailure) {
      throw error;
    }
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

function fileMatchesPattern(file: string, pattern: string): boolean {
  if (pattern.startsWith('*')) {
    return file.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith('*')) {
    return file.startsWith(pattern.slice(0, -1));
  }
  return file.includes(pattern.replace(/\*/g, ''));
}

function joinPath(rootPath: string, relativePath: string): string {
  return `${rootPath.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}`;
}
