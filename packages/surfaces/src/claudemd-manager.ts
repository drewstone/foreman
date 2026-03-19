/**
 * CLAUDE.md version manager.
 *
 * Swaps CLAUDE.md files without overwriting. Each version is tracked.
 * Enables A/B testing: generate CLAUDE.md v1, run task, score.
 * Generate v2, run same task, score. Compare. Promote the winner.
 *
 * Storage: .foreman/claudemd-versions/
 *   v001.md, v002.md, v003.md, ...
 *   active -> symlink to current version
 *   scores.json -> { "v001": 4.0, "v002": 7.5, "v003": 9.2 }
 */

import { existsSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const VERSIONS_DIR = '.foreman/claudemd-versions';
const SCORES_FILE = 'scores.json';

export interface ClaudeMdVersion {
  id: string;
  path: string;
  score?: number;
  createdAt: string;
  source?: string;
}

function versionsDir(repoPath: string): string {
  return join(resolve(repoPath), VERSIONS_DIR);
}

function scoresPath(repoPath: string): string {
  return join(versionsDir(repoPath), SCORES_FILE);
}

function nextVersionId(repoPath: string): string {
  const dir = versionsDir(repoPath);
  try {
    const files = readdirSync(dir).filter((f) => /^v\d+\.md$/.test(f));
    const nums = files.map((f) => parseInt(f.replace(/\D/g, ''), 10));
    const max = nums.length > 0 ? Math.max(...nums) : 0;
    return `v${String(max + 1).padStart(3, '0')}`;
  } catch {
    return 'v001';
  }
}

function loadScores(repoPath: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(scoresPath(repoPath), 'utf8'));
  } catch {
    return {};
  }
}

export async function saveVersion(repoPath: string, content: string, source?: string): Promise<ClaudeMdVersion> {
  const dir = versionsDir(repoPath);
  await mkdir(dir, { recursive: true });

  const id = nextVersionId(repoPath);
  const path = join(dir, `${id}.md`);
  await writeFile(path, content, 'utf8');

  return { id, path, createdAt: new Date().toISOString(), source };
}

export async function activateVersion(repoPath: string, versionId: string): Promise<void> {
  const dir = versionsDir(repoPath);
  const versionPath = join(dir, `${versionId}.md`);
  const claudeMdPath = join(resolve(repoPath), 'CLAUDE.md');

  if (!existsSync(versionPath)) {
    throw new Error(`Version ${versionId} not found at ${versionPath}`);
  }

  // Back up current CLAUDE.md if it exists and isn't already tracked
  if (existsSync(claudeMdPath)) {
    const current = readFileSync(claudeMdPath, 'utf8');
    const existing = listVersions(repoPath);
    const alreadyTracked = existing.some((v) => {
      try { return readFileSync(v.path, 'utf8') === current; } catch { return false; }
    });
    if (!alreadyTracked) {
      await saveVersion(repoPath, current, 'backup-before-swap');
    }
  }

  // Copy version content to CLAUDE.md (not symlink — some tools don't follow symlinks)
  await copyFile(versionPath, claudeMdPath);
}

export function listVersions(repoPath: string): ClaudeMdVersion[] {
  const dir = versionsDir(repoPath);
  const scores = loadScores(repoPath);

  try {
    return readdirSync(dir)
      .filter((f) => /^v\d+\.md$/.test(f))
      .sort()
      .map((f) => {
        const id = f.replace('.md', '');
        return {
          id,
          path: join(dir, f),
          score: scores[id],
          createdAt: '', // Could stat the file but keeping it simple
        };
      });
  } catch {
    return [];
  }
}

export async function scoreVersion(repoPath: string, versionId: string, score: number): Promise<void> {
  const dir = versionsDir(repoPath);
  await mkdir(dir, { recursive: true });
  const scores = loadScores(repoPath);
  scores[versionId] = score;
  await writeFile(scoresPath(repoPath), JSON.stringify(scores, null, 2) + '\n', 'utf8');
}

export function bestVersion(repoPath: string): ClaudeMdVersion | undefined {
  const versions = listVersions(repoPath);
  const scored = versions.filter((v) => v.score !== undefined);
  if (scored.length === 0) return undefined;
  return scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
}

export async function diffVersions(repoPath: string, v1: string, v2: string): Promise<string> {
  const dir = versionsDir(repoPath);
  const content1 = await readFile(join(dir, `${v1}.md`), 'utf8');
  const content2 = await readFile(join(dir, `${v2}.md`), 'utf8');
  const lines1 = content1.split('\n');
  const lines2 = content2.split('\n');

  const added = lines2.filter((l) => !lines1.includes(l));
  const removed = lines1.filter((l) => !lines2.includes(l));

  return [
    `${v1} → ${v2}:`,
    added.length > 0 ? `Added (${added.length} lines):\n${added.slice(0, 10).map((l) => `+ ${l}`).join('\n')}` : '',
    removed.length > 0 ? `Removed (${removed.length} lines):\n${removed.slice(0, 10).map((l) => `- ${l}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
