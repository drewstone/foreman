/**
 * Foreman extension for Pi Mono.
 *
 * Thin wrapper — calls Foreman CLI via bash, reads state files directly.
 * No Foreman library imports needed. Pi provides bash, read, write.
 *
 * Install:
 *   ln -s ~/code/foreman/extensions/pi/foreman.ts ~/.pi/agent/extensions/foreman.ts
 *
 * Tools registered:
 *   foreman_status   — show session portfolio across all repos
 *   foreman_resume   — resume a session by ID or repo/branch
 *   foreman_harden   — expand a goal into task envelope with checks
 *   foreman_validate — run CI checks + review on current work
 *   foreman_insights — deep analysis of recent session patterns
 *   foreman_memory   — read/write Foreman memory for a repo
 *
 * Commands:
 *   /foreman         — show status dashboard
 *   /heartbeat       — run a heartbeat scan now
 */

import { Type } from '@mariozechner/pi-ai';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const FOREMAN_DIR = process.env.FOREMAN_DIR ?? join(homedir(), 'code', 'foreman');
const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman');
const FOREMAN_STATE = join(FOREMAN_HOME, 'operator-state.json');

function run(cmd: string, timeoutMs = 30_000): string {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      cwd: FOREMAN_DIR,
      env: { ...process.env, PATH: process.env.PATH },
    }).trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return err.stdout?.trim() || err.stderr?.trim() || err.message || 'command failed';
  }
}

function loadState(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(FOREMAN_STATE, 'utf8'));
  } catch {
    return null;
  }
}

function formatSessions(state: Record<string, unknown> | null): string {
  if (!state) return 'No Foreman state found. Run /heartbeat first.';
  const sessions = (state.sessions ?? []) as Array<Record<string, unknown>>;
  if (sessions.length === 0) return 'No active sessions discovered.';

  const sorted = [...sessions]
    .filter((s) => s.status !== 'completed')
    .sort((a, b) => (b.priority as number ?? 0) - (a.priority as number ?? 0));

  return sorted.slice(0, 20).map((s, i) => {
    const ci = s.ciStatus ? ` [CI:${s.ciStatus}]` : '';
    const pr = s.prNumber ? ` PR#${s.prNumber}` : '';
    const blocker = s.blockerReason ? ` ⚠ ${s.blockerReason}` : '';
    const repo = String(s.repoPath ?? '').split('/').pop();
    return `${i + 1}. [${s.status}] ${repo}/${s.branch}${pr}${ci}${blocker}\n   ${s.goal}`;
  }).join('\n');
}

export default function foremanExtension(pi: ExtensionAPI) {

  // ── Tool: foreman_status ─────────────────────────────────────────

  pi.registerTool({
    name: 'foreman_status',
    label: 'Foreman: Session Status',
    description: 'Show the current session portfolio across all managed repos. Shows branches, CI status, PRs, blockers, and priorities.',
    promptSnippet: 'foreman_status — show all active sessions across repos with CI status',
    parameters: Type.Object({}),

    async execute(_id, _params, _signal, onUpdate) {
      const state = loadState();
      const text = formatSessions(state);
      const lastHeartbeat = state?.lastHeartbeatAt ? `Last heartbeat: ${state.lastHeartbeatAt}` : '';
      const result = [text, '', lastHeartbeat].filter(Boolean).join('\n');
      onUpdate?.({ content: [{ type: 'text', text: result }] });
      return { content: [{ type: 'text', text: result }] };
    },
  });

  // ── Tool: foreman_resume ─────────────────────────────────────────

  pi.registerTool({
    name: 'foreman_resume',
    label: 'Foreman: Resume Session',
    description: 'Resume a discovered session by ID (repo:branch format) or partial match. Spawns a Claude session with Foreman-generated CLAUDE.md context.',
    promptSnippet: 'foreman_resume — resume a session with full Foreman context',
    parameters: Type.Object({
      sessionId: Type.String({ description: 'Session ID (repo/branch) or partial match' }),
      goal: Type.Optional(Type.String({ description: 'Override the session goal' })),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const { sessionId, goal } = params as { sessionId: string; goal?: string };
      onUpdate?.({ content: [{ type: 'text', text: `Resuming session: ${sessionId}...` }] });
      const goalFlag = goal ? `--goal "${goal.replace(/"/g, '\\"')}"` : '';
      const output = run(
        `npx tsx packages/surfaces/src/operator-cli.ts --resume "${sessionId}" ${goalFlag} -v`,
        5 * 60_000,
      );
      return { content: [{ type: 'text', text: output }] };
    },
  });

  // ── Tool: foreman_harden ─────────────────────────────────────────

  pi.registerTool({
    name: 'foreman_harden',
    label: 'Foreman: Harden Task',
    description: 'Expand a vague goal into an executable task envelope. Reads repo CI config, package manifests, and product docs to infer success criteria and check commands.',
    promptSnippet: 'foreman_harden — expand goal into task with checks and criteria',
    parameters: Type.Object({
      goal: Type.String({ description: 'The goal to harden' }),
      repoPath: Type.String({ description: 'Absolute path to the repo' }),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const { goal, repoPath } = params as { goal: string; repoPath: string };
      onUpdate?.({ content: [{ type: 'text', text: `Hardening: ${goal.slice(0, 80)}...` }] });
      const escaped = JSON.stringify({ goal, repoPath });
      const output = run(
        `npx tsx -e "
const { hardenTask } = require('./packages/surfaces/src/engineering-tools.ts');
const { createClaudeProvider } = require('./packages/providers/src/index.ts');
const opts = ${escaped};
hardenTask({ ...opts, provider: createClaudeProvider() }).then(r => console.log(JSON.stringify(r, null, 2)));
"`,
        2 * 60_000,
      );
      return { content: [{ type: 'text', text: output }] };
    },
  });

  // ── Tool: foreman_validate ───────────────────────────────────────

  pi.registerTool({
    name: 'foreman_validate',
    label: 'Foreman: Validate Work',
    description: 'Run the full validation pipeline: deterministic checks from CI config, then LLM review. Returns pass/warn/fail with specific findings.',
    promptSnippet: 'foreman_validate — run CI checks + LLM review on current repo',
    parameters: Type.Object({
      repoPath: Type.String({ description: 'Absolute path to the repo' }),
      goal: Type.String({ description: 'What was being implemented' }),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const { repoPath, goal } = params as { repoPath: string; goal: string };
      onUpdate?.({ content: [{ type: 'text', text: 'Running validation pipeline...' }] });
      const escaped = goal.replace(/"/g, '\\"');
      const output = run(
        `npx tsx packages/surfaces/src/cli.ts --repo "${repoPath}" --goal "${escaped}" --max-rounds 1`,
        10 * 60_000,
      );
      try {
        const parsed = JSON.parse(output);
        const v = parsed.validation;
        if (v) {
          const findings = (v.findings ?? []).map((f: Record<string, string>) => `- [${f.severity}] ${f.title}`).join('\n');
          const text = `**${v.status}** | ${v.recommendation}\n${v.summary}\n${findings}`;
          return { content: [{ type: 'text', text }], details: v };
        }
      } catch { /* not JSON */ }
      return { content: [{ type: 'text', text: output.slice(0, 2000) }] };
    },
  });

  // ── Tool: foreman_insights ───────────────────────────────────────

  pi.registerTool({
    name: 'foreman_insights',
    label: 'Foreman: Session Insights',
    description: 'Analyze recent Claude/Codex session patterns across repos. Shows recurring commands, key files, cross-repo themes, and suggested CLAUDE.md rules.',
    promptSnippet: 'foreman_insights — analyze session patterns for workflow improvements',
    parameters: Type.Object({
      repoPaths: Type.Array(Type.String(), { description: 'Repos to analyze' }),
      hoursBack: Type.Optional(Type.Number({ description: 'Hours to look back (default 72)' })),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const { repoPaths, hoursBack } = params as { repoPaths: string[]; hoursBack?: number };
      onUpdate?.({ content: [{ type: 'text', text: 'Analyzing sessions...' }] });
      const escaped = JSON.stringify({ repoPaths, hoursBack: hoursBack ?? 72 });
      const output = run(
        `npx tsx -e "
const { extractDeepSessionInsights } = require('./packages/surfaces/src/session-insights.ts');
const opts = ${escaped};
extractDeepSessionInsights(opts).then(r => console.log(JSON.stringify(r, null, 2)));
"`,
        60_000,
      );
      return { content: [{ type: 'text', text: output }] };
    },
  });

  // ── Tool: foreman_memory ─────────────────────────────────────────

  pi.registerTool({
    name: 'foreman_memory',
    label: 'Foreman: Read Memory',
    description: 'Read what Foreman knows about a repo — environment facts, CI requirements, worker performance, repair recipes.',
    promptSnippet: 'foreman_memory — read what Foreman remembers about a repo',
    parameters: Type.Object({
      repoPath: Type.String({ description: 'Absolute path to the repo' }),
    }),

    async execute(_id, params) {
      const { repoPath } = params as { repoPath: string };
      const memDir = join(repoPath, '.foreman', 'memory');
      if (!existsSync(memDir)) {
        return { content: [{ type: 'text', text: `No Foreman memory at ${memDir}` }] };
      }
      const parts: string[] = [];
      for (const type of ['environment', 'worker', 'strategy', 'profile']) {
        const typeDir = join(memDir, type);
        try {
          for (const file of readdirSync(typeDir)) {
            if (!file.endsWith('.json')) continue;
            try {
              const data = readFileSync(join(typeDir, file), 'utf8');
              parts.push(`### ${type}/${file}\n\`\`\`json\n${data.trim()}\n\`\`\``);
            } catch { continue; }
          }
        } catch { continue; }
      }
      const text = parts.length > 0 ? parts.join('\n\n') : 'Memory exists but is empty.';
      return { content: [{ type: 'text', text }] };
    },
  });

  // ── Command: /foreman ────────────────────────────────────────────

  pi.registerCommand('foreman', {
    description: 'Show Foreman session portfolio',
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatSessions(loadState()), 'info');
    },
  });

  // ── Command: /heartbeat ──────────────────────────────────────────

  pi.registerCommand('heartbeat', {
    description: 'Run Foreman heartbeat scan now',
    handler: async (_args, ctx) => {
      ctx.ui.notify('Running heartbeat...', 'info');
      const output = run(
        'npx tsx packages/surfaces/src/operator-cli.ts --heartbeat --dry-run -v',
        60_000,
      );
      ctx.ui.notify(output.slice(0, 1000), 'info');
    },
  });

  // ── Inject context on session start ──────────────────────────────

  pi.on('before_agent_start', async () => {
    const state = loadState();
    if (!state) return;
    const sessions = (state.sessions ?? []) as Array<Record<string, unknown>>;
    const blocked = sessions.filter((s) => s.status === 'blocked');
    const active = sessions.filter((s) => s.status === 'active');
    if (blocked.length > 0 || active.length > 0) {
      pi.sendMessage({
        customType: 'foreman-context',
        content: [
          `[Foreman] ${sessions.length} sessions tracked.`,
          blocked.length > 0 ? `⚠ ${blocked.length} blocked` : '',
          active.length > 0 ? `${active.length} active` : '',
          'Use foreman_status for details.',
        ].filter(Boolean).join(' '),
        display: false,
      });
    }
  });
}
