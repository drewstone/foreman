/**
 * Foreman extension for Pi Mono.
 *
 * Registers Foreman's supervision tools as Pi tools so an agent can
 * orchestrate work through conversation: harden goals, dispatch workers,
 * validate outcomes, and persist learnings — all as tool calls visible
 * in the TUI.
 *
 * Install: symlink or copy to ~/.pi/agent/extensions/foreman.ts
 *
 * Usage: the agent decides when to call each tool based on conversation.
 * Typical flow:
 *   1. User says "finish the openclaw blueprint"
 *   2. Agent calls foreman_harden to expand the goal
 *   3. Agent calls foreman_observe to read the repo + docs
 *   4. Agent calls foreman_dispatch to send work to a provider
 *   5. Agent calls foreman_validate to check the result
 *   6. If validation fails, agent uses bash to fix, then re-validates
 *   7. Agent uses bash for git push, gh pr create, gh pr checks
 *   8. Agent calls foreman_memory to persist learnings
 *
 * The agent has full control over ordering, retries, and decisions.
 * Foreman tools provide supervision intelligence; Pi provides the UX.
 */

// NOTE: This file defines the extension shape. To actually run inside Pi,
// it needs to be compiled/bundled with Foreman's dependencies or Pi needs
// to resolve the @drew/foreman-* imports. For development, symlink the
// built output into ~/.pi/agent/extensions/.

import { Type } from '@mariozechner/pi-ai';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import {
  hardenTask,
  observeEnvironment,
  dispatchWorker,
  validateWork,
  updateMemory,
} from './engineering-tools.js';
import {
  createClaudeProvider,
  createCodexProvider,
} from '@drew/foreman-providers';
import { createMemoryStore } from '@drew/foreman-memory';
import { GitCodeEnvironment } from '@drew/foreman-environments';
import {
  ProviderWorkerAdapter,
  type ProviderWorkerTask,
} from '@drew/foreman-workers';
import type { PromptVariant } from '@drew/foreman-planning';

// Default prompt variant for dispatch — can be overridden via Pi settings
const DEFAULT_VARIANT: PromptVariant = {
  id: 'pi-foreman:operator-v1',
  label: 'Pi Foreman Operator',
  role: 'implementer',
  taskShape: 'engineering',
  style: 'persona',
  systemPreamble: 'You are a staff-level engineer executing under Foreman supervision via Pi.',
  principles: [
    'Complete the full scope. No partial implementations.',
    'Run every check. Fix what breaks.',
    'Evidence over assertion.',
  ],
};

const REVIEWER_VARIANT: PromptVariant = {
  id: 'pi-foreman:reviewer-v1',
  label: 'Pi Foreman Reviewer',
  role: 'reviewer',
  taskShape: 'engineering',
  style: 'persona',
  systemPreamble: 'You are a principal engineer reviewing work under Foreman supervision.',
  principles: [
    'Only approve production-ready work.',
    'Check every criterion explicitly.',
    'Incomplete implementations are automatic fails.',
  ],
};

export default function foremanExtension(pi: ExtensionAPI) {
  // ── Status widget ──────────────────────────────────────────────────

  let lastStatus = '';
  function setStatus(text: string) {
    lastStatus = text;
    try {
      pi.sendMessage({
        customType: 'foreman-status',
        content: text,
        display: false,
      });
    } catch {
      // Ignore if UI not available
    }
  }

  // ── Tool: foreman_harden ───────────────────────────────────────────

  pi.registerTool({
    name: 'foreman_harden',
    label: 'Foreman: Harden Task',
    description: 'Expand a vague goal into an executable task envelope with success criteria, check commands, and execution notes. Reads repo structure, CI config, and package manifests to infer verification gates.',
    promptSnippet: 'foreman_harden - expand a goal into a hardened task with checks and criteria',
    parameters: Type.Object({
      goal: Type.String({ description: 'The task goal to harden' }),
      repoPath: Type.String({ description: 'Absolute path to the repository' }),
      successCriteria: Type.Optional(Type.Array(Type.String(), { description: 'Explicit success criteria' })),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const { goal, repoPath, successCriteria } = params as {
        goal: string;
        repoPath: string;
        successCriteria?: string[];
      };
      setStatus(`Hardening: ${goal.slice(0, 60)}...`);

      const provider = createClaudeProvider();
      const result = await hardenTask({
        goal,
        repoPath,
        successCriteria,
        provider,
      });

      const summary = [
        `**Goal:** ${result.expandedGoal}`,
        '',
        `**Success criteria:** ${result.successCriteria.length}`,
        ...result.successCriteria.map((c) => `- ${c}`),
        '',
        `**Check commands:** ${result.checkCommands.length}`,
        ...result.checkCommands.map((c) => `- \`${c}\``),
        '',
        `**Execution notes:** ${result.executionNotes.length}`,
        ...result.executionNotes.map((n) => `- ${n}`),
      ].join('\n');

      onUpdate?.({ content: [{ type: 'text', text: summary }] });
      setStatus('');
      return {
        content: [{ type: 'text', text: summary }],
        details: result,
      };
    },
  });

  // ── Tool: foreman_observe ──────────────────────────────────────────

  pi.registerTool({
    name: 'foreman_observe',
    label: 'Foreman: Observe Environment',
    description: 'Read repository state, product documentation (CLAUDE.md, README, ARCHITECTURE.md, CI configs), and memory from prior runs. Returns a context snapshot for planning.',
    promptSnippet: 'foreman_observe - read repo state, docs, and memory for context',
    parameters: Type.Object({
      repoPath: Type.String({ description: 'Absolute path to the repository' }),
      profileId: Type.Optional(Type.String({ description: 'Foreman profile ID' })),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const { repoPath, profileId } = params as { repoPath: string; profileId?: string };
      setStatus('Observing environment...');

      const memoryStore = await createMemoryStore({ rootDir: `${repoPath}/.foreman/memory` }).catch(() => undefined);
      const result = await observeEnvironment({
        repoPath,
        memoryStore,
        profileId,
      });

      const text = `**Environment:** ${result.summary}\n\n**Evidence:** ${(result.evidence ?? []).length} item(s)`;
      onUpdate?.({ content: [{ type: 'text', text }] });
      setStatus('');
      return {
        content: [{ type: 'text', text: result.summary }],
        details: { evidenceCount: (result.evidence ?? []).length },
      };
    },
  });

  // ── Tool: foreman_dispatch ─────────────────────────────────────────

  pi.registerTool({
    name: 'foreman_dispatch',
    label: 'Foreman: Dispatch Worker',
    description: 'Send a task to Claude or Codex worker for implementation. Includes automatic fallback if the primary worker is unavailable (rate limited, quota exceeded). Returns the worker output and evidence.',
    promptSnippet: 'foreman_dispatch - send implementation task to a worker (claude/codex) with fallback',
    parameters: Type.Object({
      goal: Type.String({ description: 'What the worker should accomplish' }),
      repoPath: Type.String({ description: 'Absolute path to the repository' }),
      worker: Type.Optional(Type.String({ description: 'Worker ID: claude or codex (default: claude)' })),
      successCriteria: Type.Optional(Type.Array(Type.String())),
      extraInstructions: Type.Optional(Type.String({ description: 'Additional instructions for the worker' })),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const {
        goal,
        repoPath,
        worker: workerId = 'claude',
        successCriteria,
        extraInstructions,
      } = params as {
        goal: string;
        repoPath: string;
        worker?: string;
        successCriteria?: string[];
        extraInstructions?: string;
      };
      setStatus(`Dispatching to ${workerId}...`);

      const providers = {
        claude: createClaudeProvider(),
        codex: createCodexProvider(),
      };
      const primaryId = workerId === 'codex' ? 'codex' : 'claude';
      const fallbackId = primaryId === 'claude' ? 'codex' : 'claude';

      const makeAdapter = (id: string) =>
        new ProviderWorkerAdapter(
          { id, name: id, capabilities: ['code', 'review'] },
          providers[id as 'claude' | 'codex'],
          ({ task, context }) =>
            [
              DEFAULT_VARIANT.systemPreamble,
              `Goal: ${task.goal}`,
              successCriteria?.length ? `Criteria:\n${successCriteria.map((c) => `- ${c}`).join('\n')}` : '',
              `Context: ${context.summary}`,
              task.extraInstructions || '',
            ].filter(Boolean).join('\n\n'),
        );

      const result = await dispatchWorker({
        worker: makeAdapter(primaryId),
        fallbackWorker: makeAdapter(fallbackId),
        task: {
          goal,
          repoPath,
          successCriteria,
          extraInstructions,
        },
        context: { summary: `Working in ${repoPath}` },
      });

      const text = `**${result.status}**: ${result.summary}`;
      onUpdate?.({ content: [{ type: 'text', text }] });
      setStatus('');
      return {
        content: [{ type: 'text', text }],
        details: {
          status: result.status,
          workerId: result.metadata?.workerId,
          fallbackFrom: result.metadata?.fallbackFrom,
          evidenceCount: result.evidence.length,
        },
      };
    },
  });

  // ── Tool: foreman_validate ─────────────────────────────────────────

  pi.registerTool({
    name: 'foreman_validate',
    label: 'Foreman: Validate Work',
    description: 'Run the full validation pipeline: deterministic checks (cargo test, clippy, fmt), tool commands, and LLM judge review with provider fallback. Returns pass/warn/fail with findings.',
    promptSnippet: 'foreman_validate - run checks + LLM review to validate work quality',
    parameters: Type.Object({
      repoPath: Type.String({ description: 'Absolute path to the repository' }),
      goal: Type.String({ description: 'The task goal being validated' }),
      checkCommands: Type.Array(Type.String(), { description: 'Commands to run as deterministic checks' }),
      successCriteria: Type.Optional(Type.Array(Type.String())),
      trackSummary: Type.Optional(Type.String({ description: 'Summary of what was implemented' })),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const {
        repoPath,
        goal,
        checkCommands,
        successCriteria,
        trackSummary,
      } = params as {
        repoPath: string;
        goal: string;
        checkCommands: string[];
        successCriteria?: string[];
        trackSummary?: string;
      };
      setStatus('Validating...');

      const environment = new GitCodeEnvironment(repoPath);
      const providers = {
        claude: createClaudeProvider(),
        codex: createCodexProvider(),
      };

      const task = {
        id: 'pi-foreman-validate',
        goal,
        successCriteria: successCriteria ?? [],
        environment: { kind: 'code' as const, target: repoPath },
      };

      const context = {
        summary: trackSummary ?? 'Validation requested',
        evidence: [],
      };

      const trackResults = [{
        trackId: 'implement',
        status: 'completed' as const,
        summary: trackSummary ?? 'Implementation complete',
        evidence: [],
      }];

      const result = await validateWork({
        task,
        context,
        trackResults,
        environment,
        checkCommands,
        reviewProvider: providers.claude,
        fallbackReviewProvider: providers.codex,
        reviewWorkerId: 'claude',
        fallbackReviewWorkerId: 'codex',
        reviewerVariant: REVIEWER_VARIANT,
      });

      const text = [
        `**Status:** ${result.status} | **Recommendation:** ${result.recommendation}`,
        `**Summary:** ${result.summary}`,
        result.findings.length > 0 ? `\n**Findings:**` : '',
        ...result.findings.map((f) => `- [${f.severity}] ${f.title}: ${f.body}`),
      ].filter(Boolean).join('\n');

      onUpdate?.({ content: [{ type: 'text', text }] });
      setStatus('');
      return {
        content: [{ type: 'text', text }],
        details: {
          status: result.status,
          recommendation: result.recommendation,
          findingCount: result.findings.length,
          scores: result.scores,
        },
      };
    },
  });

  // ── Tool: foreman_memory ───────────────────────────────────────────

  pi.registerTool({
    name: 'foreman_memory',
    label: 'Foreman: Update Memory',
    description: 'Persist learnings from a run into Foreman memory: environment facts, worker performance, strategy patterns, and CI requirements. Called after validation to close the learning loop.',
    promptSnippet: 'foreman_memory - save learnings from this run for future improvement',
    parameters: Type.Object({
      repoPath: Type.String({ description: 'Absolute path to the repository' }),
      goal: Type.String({ description: 'The task goal' }),
      workerId: Type.String({ description: 'Which worker implemented (claude/codex)' }),
      succeeded: Type.Boolean({ description: 'Whether validation passed' }),
      checkCommands: Type.Optional(Type.Array(Type.String())),
      ciFailures: Type.Optional(Type.Array(Type.String(), { description: 'CI failure lessons to remember' })),
    }),

    async execute(_id, params, _signal, onUpdate) {
      const {
        repoPath,
        goal,
        workerId,
        succeeded,
        checkCommands,
        ciFailures,
      } = params as {
        repoPath: string;
        goal: string;
        workerId: string;
        succeeded: boolean;
        checkCommands?: string[];
        ciFailures?: string[];
      };
      setStatus('Updating memory...');

      const memoryStore = await createMemoryStore({ rootDir: `${repoPath}/.foreman/memory` });

      await updateMemory({
        memoryStore,
        repoPath,
        profileId: 'pi-foreman',
        implementationWorkerId: workerId,
        reviewWorkerId: 'claude',
        plannerWorkerId: 'claude',
        goal,
        expandedGoal: goal,
        successCriteria: [],
        checkCommands: checkCommands ?? [],
        toolCommands: [],
        ciFailures,
        validation: succeeded
          ? { status: 'pass', recommendation: 'complete', summary: 'Validated', findings: [] }
          : { status: 'fail', recommendation: 'repair', summary: 'Failed', findings: [] },
      });

      const text = ciFailures?.length
        ? `Memory updated. Learned ${ciFailures.length} CI requirement(s) for next time.`
        : 'Memory updated.';
      onUpdate?.({ content: [{ type: 'text', text }] });
      setStatus('');
      return { content: [{ type: 'text', text }] };
    },
  });

  // ── Command: /foreman ──────────────────────────────────────────────

  pi.registerCommand('foreman', {
    description: 'Show Foreman status and available tools',
    handler: async (_args, ctx) => {
      const tools = [
        'foreman_harden  - expand goal into task envelope',
        'foreman_observe - read repo state + docs + memory',
        'foreman_dispatch - send work to claude/codex',
        'foreman_validate - run checks + review',
        'foreman_memory  - persist learnings',
      ];
      ctx.ui.notify(
        `Foreman tools:\n${tools.join('\n')}\n\nLast status: ${lastStatus || 'idle'}`,
        'info',
      );
    },
  });

  // ── Guidelines for the agent ───────────────────────────────────────

  pi.registerTool({
    name: 'foreman_harden',
    label: 'Foreman: Harden Task',
    description: 'Expand a vague goal into an executable task envelope with success criteria, check commands, and execution notes.',
    promptGuidelines: [
      'Call foreman_harden first when given a new task to understand the full scope.',
      'Call foreman_observe to understand the repo before implementing.',
      'Use foreman_dispatch only for complex tasks that benefit from a dedicated worker session.',
      'Call foreman_validate after implementation to get structured quality assessment.',
      'Call foreman_memory after completing work to persist learnings for next time.',
      'Use bash directly for git, gh, and simple commands — don\'t over-engineer.',
      'If foreman_validate finds issues, fix them yourself (you have bash/write), then re-validate.',
      'If CI fails after push, read the logs with bash (gh run view --log-failed), fix, and push again.',
    ],
  } as any); // Guidelines-only registration
}
