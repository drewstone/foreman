/**
 * Deep session insight extraction.
 *
 * Reads actual Claude Code JSONL session content to extract:
 * - What tools/commands the operator runs repeatedly
 * - What files they read first in new sessions
 * - What patterns recur across repos
 * - What goals get abandoned vs completed
 * - Cross-repo context that should be shared
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface SessionPattern {
  pattern: string;
  frequency: number;
  repos: string[];
  examples: string[];
}

export interface SessionInsightReport {
  totalSessions: number;
  totalMessages: number;
  repoActivity: Array<{
    repo: string;
    sessionCount: number;
    lastActive: string;
    commonCommands: string[];
    commonFiles: string[];
    inferredGoals: string[];
  }>;
  recurringPatterns: SessionPattern[];
  crossRepoInsights: string[];
  suggestedClaudeMdRules: string[];
  abandonedWork: Array<{
    repo: string;
    branch?: string;
    lastPrompt: string;
    daysStale: number;
  }>;
}

export async function extractDeepSessionInsights(options: {
  repoPaths: string[];
  hoursBack?: number;
  maxSessionsPerRepo?: number;
}): Promise<SessionInsightReport> {
  const hoursBack = options.hoursBack ?? 72;
  const maxPerRepo = options.maxSessionsPerRepo ?? 10;
  const cutoff = Date.now() - (hoursBack * 3600 * 1000);

  const root = join(homedir(), '.claude', 'projects');
  const repoSet = new Set(options.repoPaths.map((p) => resolve(p)));

  const report: SessionInsightReport = {
    totalSessions: 0,
    totalMessages: 0,
    repoActivity: [],
    recurringPatterns: [],
    crossRepoInsights: [],
    suggestedClaudeMdRules: [],
    abandonedWork: [],
  };

  // Command frequency across all sessions
  const commandCounts = new Map<string, { count: number; repos: Set<string> }>();
  const fileReadCounts = new Map<string, { count: number; repos: Set<string> }>();
  const goalsByRepo = new Map<string, string[]>();

  // Claude Code encodes project paths: /home/drew/code/foo → -home-drew-code-foo
  // This encoding is lossy (hyphens in dir names), so we go forward: encode each
  // repo path and check if the dir exists.
  function encodeProjectDir(repoPath: string): string {
    return repoPath.replace(/\//g, '-');
  }

  const repoDirMap = new Map<string, string>(); // encoded dir → repo path
  for (const repo of repoSet) {
    const encoded = encodeProjectDir(repo);
    repoDirMap.set(encoded, repo);
  }

  let projectDirs: string[] = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return report;
  }

  for (const dirName of projectDirs) {
    const repoPath = repoDirMap.get(dirName);
    if (!repoPath) continue;
    const dir = join(root, dirName);
    const projectName = repoPath.split('/').pop() ?? dirName;

    // Find recent JSONL files
    const sessionFiles: Array<{ path: string; mtime: number }> = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.name.endsWith('.jsonl')) continue;
        try {
          const fileStat = await stat(join(dir, entry.name));
          if (fileStat.mtimeMs > cutoff) {
            sessionFiles.push({ path: join(dir, entry.name), mtime: fileStat.mtimeMs });
          }
        } catch { continue; }
      }
    } catch { continue; }

    sessionFiles.sort((a, b) => b.mtime - a.mtime);
    const repoCommands: string[] = [];
    const repoFiles: string[] = [];
    const repoGoals: string[] = [];

    for (const sessionFile of sessionFiles.slice(0, maxPerRepo)) {
      report.totalSessions++;
      const { commands, filesRead, goals, messageCount } = await parseSessionContent(sessionFile.path);
      report.totalMessages += messageCount;

      for (const cmd of commands) {
        repoCommands.push(cmd);
        const normalized = normalizeCommand(cmd);
        if (!normalized) continue;
        const existing = commandCounts.get(normalized) ?? { count: 0, repos: new Set() };
        existing.count++;
        existing.repos.add(projectName);
        commandCounts.set(normalized, existing);
      }

      for (const file of filesRead) {
        repoFiles.push(file);
        const existing = fileReadCounts.get(file) ?? { count: 0, repos: new Set() };
        existing.count++;
        existing.repos.add(projectName);
        fileReadCounts.set(file, existing);
      }

      repoGoals.push(...goals);
    }

    if (sessionFiles.length > 0) {
      report.repoActivity.push({
        repo: projectName,
        sessionCount: sessionFiles.length,
        lastActive: new Date(sessionFiles[0]!.mtime).toISOString(),
        commonCommands: topN(repoCommands, 5),
        commonFiles: topN(repoFiles, 5),
        inferredGoals: repoGoals.slice(0, 5),
      });
    }

    goalsByRepo.set(projectName, repoGoals);
  }

  // Find recurring patterns across repos
  for (const [cmd, data] of commandCounts) {
    if (data.count >= 3 && data.repos.size >= 2) {
      report.recurringPatterns.push({
        pattern: `Runs \`${cmd}\` frequently`,
        frequency: data.count,
        repos: [...data.repos],
        examples: [],
      });
    }
  }

  for (const [file, data] of fileReadCounts) {
    if (data.count >= 3 && data.repos.size >= 2) {
      report.recurringPatterns.push({
        pattern: `Reads \`${file}\` early in sessions`,
        frequency: data.count,
        repos: [...data.repos],
        examples: [],
      });
    }
  }

  // Generate CLAUDE.md suggestions from patterns
  for (const [cmd, data] of commandCounts) {
    if (data.count >= 5) {
      report.suggestedClaudeMdRules.push(
        `Always run \`${cmd}\` as part of verification (seen ${data.count}x across ${data.repos.size} repo(s))`,
      );
    }
  }

  for (const [file, data] of fileReadCounts) {
    if (data.count >= 3 && data.repos.size >= 2) {
      report.suggestedClaudeMdRules.push(
        `Read \`${file}\` at the start of every session (operator reads this ${data.count}x across repos)`,
      );
    }
  }

  // Cross-repo insights
  const allGoals = [...goalsByRepo.entries()];
  for (const [repo1, goals1] of allGoals) {
    for (const [repo2, goals2] of allGoals) {
      if (repo1 >= repo2) continue;
      const shared = findSharedThemes(goals1, goals2);
      if (shared.length > 0) {
        report.crossRepoInsights.push(
          `${repo1} and ${repo2} share work themes: ${shared.join(', ')}`,
        );
      }
    }
  }

  return report;
}

async function parseSessionContent(jsonlPath: string): Promise<{
  commands: string[];
  filesRead: string[];
  goals: string[];
  messageCount: number;
}> {
  const commands: string[] = [];
  const filesRead: string[] = [];
  const goals: string[] = [];
  let messageCount = 0;

  const maxCommands = 500;
  const maxFiles = 200;
  const maxGoals = 50;

  try {
    const { createReadStream } = await import('node:fs');
    const { createInterface } = await import('node:readline');
    const stream = createReadStream(jsonlPath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        messageCount++;

        if (entry.type === 'user' && goals.length < maxGoals) {
          const msg = entry.message as { content?: string } | undefined;
          if (typeof msg?.content === 'string' && msg.content.length > 10 && msg.content.length < 500) {
            let text = msg.content.trim()
            // Strip XML tags from local commands, system reminders, etc.
            if (text.includes('<local-command-caveat>') || text.includes('<command-name>') || text.includes('<system-reminder>')) continue
            text = text.replace(/<[^>]+>/g, '').trim()
            if (text.length > 10) goals.push(text.slice(0, 150))
          }
        }

        if (entry.type === 'assistant' && (commands.length < maxCommands || filesRead.length < maxFiles)) {
          const msg = entry.message as { content?: unknown[] } | undefined;
          if (Array.isArray(msg?.content)) {
            for (const block of msg.content) {
              const b = block as Record<string, unknown>;
              if (b.type === 'tool_use' && b.name === 'Bash' && commands.length < maxCommands) {
                const input = b.input as { command?: string } | undefined;
                if (input?.command) commands.push(input.command);
              }
              if (b.type === 'tool_use' && (b.name === 'Read' || b.name === 'Glob') && filesRead.length < maxFiles) {
                const input = b.input as { file_path?: string; pattern?: string } | undefined;
                if (input?.file_path) filesRead.push(basename(input.file_path));
                if (input?.pattern) filesRead.push(input.pattern);
              }
            }
          }
        }
      } catch { continue; }
    }
  } catch { /* can't read */ }

  return { commands, filesRead, goals, messageCount };
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function normalizeCommand(cmd: string): string | undefined {
  // Strip paths and args, keep the base command pattern
  const trimmed = cmd.trim();
  if (trimmed.length < 3 || trimmed.length > 200) return undefined;

  // Common patterns to track
  if (/^cargo\s+(test|check|clippy|fmt|build)/.test(trimmed)) {
    return trimmed.match(/^cargo\s+\S+/)?.[0] ?? undefined;
  }
  if (/^(npm|pnpm|yarn)\s+(test|run|build)/.test(trimmed)) {
    return trimmed.match(/^(npm|pnpm|yarn)\s+\S+(\s+\S+)?/)?.[0] ?? undefined;
  }
  if (/^git\s+(push|pull|checkout|commit|diff|log|status)/.test(trimmed)) {
    return trimmed.match(/^git\s+\S+/)?.[0] ?? undefined;
  }
  if (/^gh\s+(pr|run|issue)/.test(trimmed)) {
    return trimmed.match(/^gh\s+\S+\s+\S+/)?.[0] ?? undefined;
  }
  if (/^docker\s+(build|run|compose)/.test(trimmed)) {
    return trimmed.match(/^docker\s+\S+/)?.[0] ?? undefined;
  }
  return undefined;
}

function topN(items: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([item]) => item);
}

function findSharedThemes(goals1: string[], goals2: string[]): string[] {
  const themes: string[] = [];
  const keywords1 = new Set(goals1.flatMap((g) => g.toLowerCase().split(/\s+/).filter((w) => w.length > 4)));
  const keywords2 = new Set(goals2.flatMap((g) => g.toLowerCase().split(/\s+/).filter((w) => w.length > 4)));
  const shared = [...keywords1].filter((k) => keywords2.has(k));
  // Only surface meaningful shared keywords
  const meaningful = shared.filter((k) =>
    !['should', 'would', 'could', 'about', 'there', 'their', 'these', 'those', 'which', 'where', 'after', 'before'].includes(k),
  );
  if (meaningful.length >= 3) {
    themes.push(meaningful.slice(0, 5).join(', '));
  }
  return themes;
}
