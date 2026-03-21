import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface ManagedSession {
  id: string;
  repoPath: string;
  branch: string;
  goal: string;
  status: 'active' | 'waiting' | 'blocked' | 'stale' | 'completed';
  provider: 'claude' | 'codex' | 'pi';
  sessionId?: string;
  prNumber?: number;
  lastResumedAt?: string;
  lastCheckedAt?: string;
  ciStatus?: 'pass' | 'fail' | 'pending' | 'unknown';
  blockerReason?: string;
  priority: number;
  metadata?: Record<string, string>;
}

export async function generateClaudeMd(options: {
  repoPath: string;
  session: ManagedSession;
  memory?: Record<string, unknown>;
  ciFailures?: string[];
  sessionInsights?: {
    commonCommands?: string[];
    commonFiles?: string[];
    suggestedRules?: string[];
    recentGoals?: string[];
  };
}): Promise<string> {
  const { repoPath, session, memory, ciFailures, sessionInsights } = options;

  // Read existing CLAUDE.md if present
  let existingClaudeMd = '';
  try {
    existingClaudeMd = await readFile(join(repoPath, 'CLAUDE.md'), 'utf8');
  } catch { /* no existing file */ }

  const sections: string[] = [];

  // Preserve existing CLAUDE.md content
  if (existingClaudeMd.trim()) {
    sections.push(existingClaudeMd.trim());
  }

  // Add Foreman-generated context
  sections.push('');
  sections.push('## Foreman Context (auto-generated)');
  sections.push('');
  sections.push(`**Current goal:** ${session.goal}`);
  sections.push(`**Branch:** ${session.branch}`);
  sections.push(`**Status:** ${session.status}`);

  if (session.prNumber) {
    sections.push(`**PR:** #${session.prNumber} (CI: ${session.ciStatus ?? 'unknown'})`);
  }

  if (session.blockerReason) {
    sections.push(`**Blocker:** ${session.blockerReason}`);
  }

  // Load learning data from Foreman memory stores
  const repoName = repoPath.split('/').pop() ?? '';
  let operatorPatterns: string[] = [];
  let repoFacts: string[] = [];
  let repoRecipes: Array<{ pattern: string; confidence: number }> = [];
  try {
    const { readFile: rf } = await import('node:fs/promises');
    const { join: j } = await import('node:path');
    const { homedir: hd } = await import('node:os');
    const fhome = process.env.FOREMAN_HOME ?? j(hd(), '.foreman');

    // Operator profile
    try {
      const profile = JSON.parse(await rf(j(fhome, 'memory', 'user', 'operator.json'), 'utf8'));
      operatorPatterns = profile.operatorPatterns ?? [];
    } catch {}

    // Repo environment facts
    try {
      const env = JSON.parse(await rf(j(fhome, 'memory', 'environment', `${repoName}.json`), 'utf8'));
      repoFacts = env.facts ?? [];
    } catch {}

    // Repo repair recipes
    try {
      const strategy = JSON.parse(await rf(j(repoPath, '.foreman', 'memory', 'strategy', 'engineering.json'), 'utf8'));
      repoRecipes = (strategy.scoredRecipes ?? [])
        .filter((r: { confidence: number }) => r.confidence >= 0.5)
        .map((r: { pattern: string; confidence: number }) => ({ pattern: r.pattern, confidence: r.confidence }));
    } catch {}
  } catch {}

  // Inject operator profile (compact — Hermes-style)
  if (operatorPatterns.length > 0) {
    sections.push('');
    sections.push(`**Operator:** ${operatorPatterns.slice(0, 3).join('. ')}.`);
  }

  // Inject repo facts from learning
  if (repoFacts.length > 0) {
    sections.push('');
    sections.push('### Repo facts (learned)');
    for (const fact of repoFacts.slice(0, 5)) {
      sections.push(`- ${fact}`);
    }
  }

  // Inject repair recipes
  if (repoRecipes.length > 0) {
    sections.push('');
    sections.push('### Known repair patterns');
    for (const r of repoRecipes.slice(0, 5)) {
      sections.push(`- ${r.pattern} (${(r.confidence * 100).toFixed(0)}% confidence)`);
    }
  }

  // Memory-derived instructions (legacy — from passed-in memory param)
  const facts = (memory as { facts?: string[] })?.facts ?? [];
  const ciReqs = facts.filter((f: string) => f.startsWith('ci-requirement:'));
  const checkCmds = facts.filter((f: string) => f.startsWith('check-command:'));

  // Session insight-derived instructions
  const insightCommands = (sessionInsights?.commonCommands ?? [])
    .filter((cmd) => /^(cargo|npm|pnpm|yarn|forge|make)\s/.test(cmd));
  const allCheckCmds = [...new Set([
    ...checkCmds.map((c) => c.replace('check-command: ', '')),
    ...insightCommands,
  ])];

  if (allCheckCmds.length > 0) {
    sections.push('');
    sections.push('### Required checks');
    sections.push('Run ALL of these before declaring done:');
    for (const cmd of allCheckCmds) {
      sections.push(`- \`${cmd}\``);
    }
  }

  if (ciReqs.length > 0 || ciFailures?.length) {
    sections.push('');
    sections.push('### CI requirements (learned from failures)');
    for (const req of ciReqs) {
      sections.push(`- ${req.replace('ci-requirement: ', '')}`);
    }
    for (const failure of ciFailures ?? []) {
      sections.push(`- ${failure}`);
    }
  }

  // Key files from session insights — front-load in context
  const keyFiles = sessionInsights?.commonFiles?.slice(0, 5) ?? [];
  if (keyFiles.length > 0) {
    sections.push('');
    sections.push('### Key files (read first)');
    sections.push('The operator frequently starts by reading these files:');
    for (const file of keyFiles) {
      sections.push(`- \`${file}\``);
    }
  }

  // Recent goals — show what's been worked on
  const recentGoals = sessionInsights?.recentGoals?.slice(0, 3) ?? [];
  if (recentGoals.length > 0) {
    sections.push('');
    sections.push('### Recent work context');
    for (const goal of recentGoals) {
      sections.push(`- ${goal}`);
    }
  }

  // Operator-learned rules from session patterns
  const rules = (sessionInsights?.suggestedRules ?? [])
    .filter((r) => !r.includes('git diff') && !r.includes('git log') && !r.includes('git status'));
  if (rules.length > 0) {
    sections.push('');
    sections.push('### Learned rules (from operator behavior)');
    for (const rule of rules.slice(0, 5)) {
      sections.push(`- ${rule}`);
    }
  }

  // Skill recommendations based on repo type
  const skillHints: string[] = [];
  try {
    const cargoContent = await readFile(join(repoPath, 'Cargo.toml'), 'utf8').catch(() => '');
    const pkgContent = await readFile(join(repoPath, 'package.json'), 'utf8').catch(() => '');
    const hasSolidity = await readdir(join(repoPath, 'contracts', 'src')).catch(() => []);

    if (cargoContent.includes('blueprint-sdk')) {
      skillHints.push('Use /tangle-blueprint-expert skill for blueprint architecture guidance');
      skillHints.push('Use `cargo tangle` CLI for blueprint registration and testing');
    }
    if (cargoContent.includes('sandbox-runtime') || cargoContent.includes('ai-agent-sandbox')) {
      skillHints.push('Use /sandbox-blueprint skill for container lifecycle and operator API patterns');
    }
    if (Array.isArray(hasSolidity) && hasSolidity.some((f: { name?: string } | string) => (typeof f === 'string' ? f : f.name ?? '').endsWith('.sol'))) {
      skillHints.push('Use /solidity-auditor skill before finalizing contract changes');
    }
    if (pkgContent.includes('react') || pkgContent.includes('next')) {
      skillHints.push('Use /vercel-react-best-practices skill for React/Next.js patterns');
    }
  } catch { /* best effort */ }

  if (skillHints.length > 0) {
    sections.push('');
    sections.push('### Recommended skills');
    for (const hint of skillHints) {
      sections.push(`- ${hint}`);
    }
  }

  // Quality bar
  sections.push('');
  sections.push('### Completion standard');
  sections.push('- Run ALL check commands before declaring done');
  sections.push('- Push to a branch, never to main directly');
  sections.push('- If CI fails after push, read the logs (`gh run view --log-failed`), fix, and push again');
  sections.push('- Do not declare done until CI is green');
  sections.push('- Self-review your work before finishing');

  return sections.join('\n');
}
