import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createMemoryStore } from '@drew/foreman-memory';
import { FilesystemProfileStore } from '@drew/foreman-profiles';
import {
  createClaudeProvider,
  createCodexProvider,
  parseJsonOutput,
  type TextProvider,
} from '@drew/foreman-providers';

import { runEngineeringForeman, type EngineeringForemanRunResult } from './engineering-foreman.js';
import { loadOperatorRuntimeContext, scoreOperatorPreference } from './operator-adaptation.js';
import { runSessionSurface, type SessionRunResult } from './session-run.js';
import { runSessionReview, type SessionReviewOptions, type SessionReviewReport } from './session-review.js';
import { runSupervisorSurface, type SupervisorRunResult } from './supervisor-run.js';
import { runWorkDiscovery } from './work-discovery.js';

type ContinuationSurface = 'engineering' | 'connector' | 'manual' | 'research' | 'review' | 'ops' | 'session' | 'supervisor';
type ContinuationCapability = 'code' | 'browser' | 'review' | 'research' | 'ops' | 'document' | 'hybrid';
type ContinuationPriority = 'low' | 'medium' | 'high' | 'critical';

export interface WorkContinuationOptions {
  profileId: string;
  userId?: string;
  profileRoot: string;
  memoryRoot: string;
  traceRoots?: string[];
  transcriptRoots?: string[];
  sessionProviders?: Array<'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw'>;
  sessionCwd?: string;
  sessionLimitPerProvider?: number;
  repoPaths?: string[];
  provider?: 'codex' | 'claude';
  providerTimeoutMs?: number;
  sessionReviewProvider?: 'codex' | 'claude';
  sessionReviewTimeoutMs?: number;
  sessionReviewOutputPath?: string;
  sessionReviewMarkdownPath?: string;
  outputPath?: string;
  markdownPath?: string;
  maxTranscriptFiles?: number;
  maxWorkItems?: number;
  maxProposals?: number;
  since?: string;
  lookbackDays?: number;
  executeTopEngineeringProposal?: boolean;
  executeTopSessionProposal?: boolean;
  executeTopSupervisorProposal?: boolean;
  engineeringArtifactsRoot?: string;
  engineeringTraceRoot?: string;
  engineeringPromptPolicyRoot?: string;
  engineeringMaxRounds?: number;
  applyMemoryUpdates?: boolean;
  approveExecution?: boolean;
}

export interface WorkContinuationProposal {
  id: string;
  title: string;
  priority: ContinuationPriority;
  surface: ContinuationSurface;
  capability: ContinuationCapability;
  goal: string;
  rationale: string;
  repoPath?: string;
  successCriteria: string[];
  checkCommands: string[];
  nextStep: string;
  sourceRefs: string[];
  requiresApproval: boolean;
  sessionProvider?: 'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw';
  sessionId?: string;
  sessionCwd?: string;
  sessionAction?: 'continue' | 'fork' | 'continue-last';
  supervisorCommand?: string;
  supervisorUrl?: string;
  supervisorMethod?: string;
  supervisorBody?: string;
  adaptiveScore?: number;
  adaptiveReasons?: string[];
}

export interface WorkContinuationPlan {
  summary: string;
  proposals: WorkContinuationProposal[];
  doNowIds: string[];
  deferIds: string[];
  openQuestions: string[];
}

export interface WorkContinuationResult {
  profileId: string;
  providerId: string;
  summary: string;
  discoverySummary: string;
  reviewSummary: string;
  plan: WorkContinuationPlan;
  executedEngineeringRun?: {
    proposalId: string;
    result: EngineeringForemanRunResult;
  };
  executedSessionRun?: {
    proposalId: string;
    result: SessionRunResult;
  };
  executedSupervisorRun?: {
    proposalId: string;
    result: SupervisorRunResult;
  };
  approvalRequiredProposal?: {
    proposalId: string;
    reason: string;
  };
  outputPath?: string;
  markdownPath?: string;
}

export async function runWorkContinuation(
  options: WorkContinuationOptions,
): Promise<WorkContinuationResult> {
  const providers = {
    codex: createCodexProvider(),
    claude: createClaudeProvider(),
  } satisfies Record<'codex' | 'claude', TextProvider>;
  const provider = providers[options.provider ?? 'claude'];

  const profileRoot = resolve(options.profileRoot);
  const memoryRoot = resolve(options.memoryRoot);
  await mkdir(profileRoot, { recursive: true });
  await mkdir(memoryRoot, { recursive: true });

  const profileStore = new FilesystemProfileStore(profileRoot);
  const memoryStore = await createMemoryStore({
    rootDir: memoryRoot,
  });
  const [profileRecord, profileMemory, userMemory] = await Promise.all([
    profileStore.get(options.profileId),
    memoryStore.getProfileMemory(options.profileId),
    options.userId ? memoryStore.getUserMemory(options.userId) : Promise.resolve(null),
  ]);

  const discovery = await runWorkDiscovery({
    profileId: options.profileId,
    userId: options.userId,
    profileRoot,
    memoryRoot,
    traceRoots: options.traceRoots,
    transcriptRoots: options.transcriptRoots,
    sessionProviders: options.sessionProviders,
    sessionCwd: options.sessionCwd,
    sessionLimitPerProvider: options.sessionLimitPerProvider,
    maxTranscriptFiles: options.maxTranscriptFiles,
    maxItems: options.maxWorkItems ?? 16,
  });

  const sessionReview = await runSessionReview({
    profileId: options.profileId,
    userId: options.userId,
    profileRoot,
    memoryRoot,
    traceRoots: options.traceRoots,
    transcriptRoots: options.transcriptRoots,
    sessionProviders: options.sessionProviders,
    sessionCwd: options.sessionCwd,
    sessionLimitPerProvider: options.sessionLimitPerProvider,
    repoPaths: options.repoPaths,
    provider: options.sessionReviewProvider ?? options.provider ?? 'claude',
    providerTimeoutMs: options.sessionReviewTimeoutMs ?? options.providerTimeoutMs,
    maxTranscriptFiles: options.maxTranscriptFiles,
    since: options.since,
    lookbackDays: options.lookbackDays,
    applyMemoryUpdates: options.applyMemoryUpdates,
    outputPath: options.sessionReviewOutputPath,
    markdownPath: options.sessionReviewMarkdownPath,
  });

  const prompt = buildWorkContinuationPrompt({
    profileId: options.profileId,
    userId: options.userId,
    profileRecord,
    profileMemory,
    userMemory,
    discovery,
    sessionReview: sessionReview.report,
    maxProposals: options.maxProposals ?? 6,
  });
  const execution = await provider.run(prompt, {
    timeoutMs: options.providerTimeoutMs ?? 20 * 60 * 1000,
  });
  const rawPlan = normalizeWorkContinuationPlan(parseJsonOutput(execution.stdout));
  const operatorContext = await loadOperatorRuntimeContext({
    profileId: options.profileId,
    userId: options.userId,
    profileRoot,
    memoryRoot,
    workerIds: collectProposalWorkerIds(rawPlan.proposals),
    taskShapes: collectProposalTaskShapes(rawPlan.proposals),
  });
  const plan = applyAdaptivePlanRanking(rawPlan, operatorContext);

  let executedEngineeringRun:
    | {
        proposalId: string;
        result: EngineeringForemanRunResult;
      }
    | undefined;
  let approvalRequiredProposal:
    | {
        proposalId: string;
        reason: string;
      }
    | undefined;

  if (options.executeTopEngineeringProposal) {
    const proposal = selectExecutableEngineeringProposal(plan);
    if (proposal?.requiresApproval && !options.approveExecution) {
      approvalRequiredProposal = {
        proposalId: proposal.id,
        reason: 'selected engineering proposal requires approval before execution',
      };
    } else if (proposal) {
      if (!proposal.repoPath) {
        throw new Error(`proposal ${proposal.id} is missing repoPath`);
      }
      executedEngineeringRun = {
        proposalId: proposal.id,
        result: await runEngineeringForeman({
          repoPath: proposal.repoPath,
          goal: proposal.goal,
          successCriteria: proposal.successCriteria.length > 0
            ? proposal.successCriteria
            : ['task is completed with evidence'],
          checkCommands: proposal.checkCommands,
          profileRoot,
          profileId: options.profileId,
          memoryRoot,
          promptPolicyRoot: options.engineeringPromptPolicyRoot,
          artifactsRoot: options.engineeringArtifactsRoot,
          traceRoot: options.engineeringTraceRoot,
          maxRounds: options.engineeringMaxRounds,
          taskId: `continuation-${proposal.id}`,
        }),
      };
    }
  }

  let executedSessionRun:
    | {
        proposalId: string;
        result: SessionRunResult;
      }
    | undefined;
  let executedSupervisorRun:
    | {
        proposalId: string;
        result: SupervisorRunResult;
      }
    | undefined;

  if (options.executeTopSessionProposal) {
    const proposal = selectExecutableSessionProposal(plan);
    if (proposal?.requiresApproval && !options.approveExecution) {
      approvalRequiredProposal = {
        proposalId: proposal.id,
        reason: 'selected session proposal requires approval before execution',
      };
    } else if (proposal?.sessionProvider) {
      executedSessionRun = {
        proposalId: proposal.id,
        result: await runSessionSurface({
          provider: proposal.sessionProvider,
          action: proposal.sessionAction ?? 'continue',
          sessionId: proposal.sessionId,
          cwd: proposal.sessionCwd ?? proposal.repoPath,
          prompt: proposal.goal,
          approvalMode: proposal.requiresApproval ? 'required' : 'auto',
          approve: options.approveExecution,
          traceRoot: options.engineeringTraceRoot,
          taskId: `continuation-session-${proposal.id}`,
        }),
      };
    }
  }

  if (options.executeTopSupervisorProposal) {
    const proposal = selectExecutableSupervisorProposal(plan);
    if (proposal?.requiresApproval && !options.approveExecution) {
      approvalRequiredProposal = {
        proposalId: proposal.id,
        reason: 'selected supervisor proposal requires approval before execution',
      };
    } else if (proposal) {
      executedSupervisorRun = {
        proposalId: proposal.id,
        result: await runSupervisorSurface({
          command: proposal.supervisorCommand,
          cwd: proposal.repoPath,
          url: proposal.supervisorUrl,
          method: proposal.supervisorMethod,
          body: proposal.supervisorBody,
          approvalMode: proposal.requiresApproval ? 'required' : 'auto',
          approve: options.approveExecution,
          traceRoot: options.engineeringTraceRoot,
          taskId: `continuation-supervisor-${proposal.id}`,
          label: proposal.title,
        }),
      };
    }
  }

  let outputPath: string | undefined;
  if (options.outputPath) {
    outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify({
      plan,
      discoverySummary: discovery.summary,
      reviewSummary: sessionReview.summary,
      executedEngineeringRun,
      executedSessionRun,
      executedSupervisorRun,
      approvalRequiredProposal,
    }, null, 2)}\n`, 'utf8');
  }

  let markdownPath: string | undefined;
  if (options.markdownPath) {
    markdownPath = resolve(options.markdownPath);
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, renderWorkContinuationMarkdown({
      plan,
      discoverySummary: discovery.summary,
      reviewSummary: sessionReview.summary,
      executedEngineeringRun,
      executedSessionRun,
      executedSupervisorRun,
      approvalRequiredProposal,
    }), 'utf8');
  }

  return {
    profileId: options.profileId,
    providerId: provider.id,
    summary: plan.summary,
    discoverySummary: discovery.summary,
    reviewSummary: sessionReview.summary,
    plan,
    executedEngineeringRun,
    executedSessionRun,
    executedSupervisorRun,
    approvalRequiredProposal,
    outputPath,
    markdownPath,
  };
}

function buildWorkContinuationPrompt(input: {
  profileId: string;
  userId?: string;
  profileRecord: Awaited<ReturnType<FilesystemProfileStore['get']>>;
  profileMemory: Awaited<ReturnType<Awaited<ReturnType<typeof createMemoryStore>>['getProfileMemory']>>;
  userMemory: Awaited<ReturnType<Awaited<ReturnType<typeof createMemoryStore>>['getUserMemory']>>;
  discovery: Awaited<ReturnType<typeof runWorkDiscovery>>;
  sessionReview: SessionReviewReport;
  maxProposals: number;
}): string {
  const proposalsHint = Math.max(1, input.maxProposals);

  return [
    'You are Foreman continuation planner, a world-class operator deciding what work should actually move forward next.',
    '',
    'Your job is to convert discovered work and session-review insights into concrete next runs.',
    'Be selective. Prefer a small number of high-leverage proposals over a long backlog dump.',
    'Make proposals specific enough that Foreman could invoke them as real runs.',
    'If a proposal looks like engineering execution in a repo, mark surface=engineering and include concrete successCriteria and checkCommands when justified.',
    'If a proposal should run an external harness or audit orchestrator, mark surface=supervisor and provide either supervisorCommand or supervisorUrl.',
    'Avoid generic productivity advice. Ground everything in the supplied discovery and session-review evidence.',
    '',
    'Return JSON only with this exact schema:',
    `{"summary":"...","proposals":[{"id":"short-kebab-id","title":"...","priority":"low|medium|high|critical","surface":"engineering|connector|manual|research|review|ops|session|supervisor","capability":"code|browser|review|research|ops|document|hybrid","goal":"...","rationale":"...","repoPath":"...","successCriteria":["..."],"checkCommands":["..."],"nextStep":"...","sourceRefs":["..."],"requiresApproval":true,"sessionProvider":"claude|codex|browser|opencode|openclaw","sessionId":"...","sessionCwd":"...","sessionAction":"continue|fork|continue-last","supervisorCommand":"...","supervisorUrl":"https://...","supervisorMethod":"POST","supervisorBody":"..."}],"doNowIds":["..."],"deferIds":["..."],"openQuestions":["..."]}`,
    '',
    `Profile id: ${input.profileId}`,
    input.userId ? `User id: ${input.userId}` : '',
    '',
    'Stored profile:',
    JSON.stringify(input.profileRecord, null, 2),
    '',
    'Profile memory:',
    JSON.stringify(input.profileMemory, null, 2),
    '',
    'User memory:',
    JSON.stringify(input.userMemory, null, 2),
    '',
    'Discovery summary:',
    input.discovery.summary,
    '',
    'Discovered work items:',
    JSON.stringify(input.discovery.items, null, 2),
    '',
    'Session review report:',
    JSON.stringify(input.sessionReview, null, 2),
    '',
    `Return at most ${proposalsHint} proposals.`,
  ].filter(Boolean).join('\n');
}

function normalizeWorkContinuationPlan(value: unknown): WorkContinuationPlan {
  const record = isRecord(value) ? value : {};
  const proposals = Array.isArray(record.proposals)
    ? record.proposals.filter(isRecord).map((proposal, index) => ({
        id: stringValue(proposal.id, `proposal-${index + 1}`),
        title: stringValue(proposal.title, 'Continuation proposal'),
        priority: normalizePriority(proposal.priority),
        surface: normalizeSurface(proposal.surface),
        capability: normalizeCapability(proposal.capability),
        goal: stringValue(proposal.goal, 'Continue the identified work.'),
        rationale: stringValue(proposal.rationale, 'No rationale provided.'),
        repoPath: optionalString(proposal.repoPath),
        successCriteria: stringArray(proposal.successCriteria),
        checkCommands: stringArray(proposal.checkCommands),
        nextStep: stringValue(proposal.nextStep, 'Review and decide whether to run this proposal.'),
        sourceRefs: stringArray(proposal.sourceRefs),
        requiresApproval: typeof proposal.requiresApproval === 'boolean' ? proposal.requiresApproval : false,
        sessionProvider: normalizeSessionProvider(proposal.sessionProvider),
        sessionId: optionalString(proposal.sessionId),
        sessionCwd: optionalString(proposal.sessionCwd),
        sessionAction: normalizeSessionAction(proposal.sessionAction),
        supervisorCommand: optionalString(proposal.supervisorCommand),
        supervisorUrl: optionalString(proposal.supervisorUrl),
        supervisorMethod: optionalString(proposal.supervisorMethod),
        supervisorBody: optionalString(proposal.supervisorBody),
      }))
    : [];

  return {
    summary: stringValue(record.summary, 'Continuation planning completed.'),
    proposals,
    doNowIds: stringArray(record.doNowIds).filter((id) => proposals.some((proposal) => proposal.id === id)),
    deferIds: stringArray(record.deferIds).filter((id) => proposals.some((proposal) => proposal.id === id)),
    openQuestions: stringArray(record.openQuestions),
  };
}

function selectExecutableEngineeringProposal(plan: WorkContinuationPlan): WorkContinuationProposal | undefined {
  const preferredIds = new Set(plan.doNowIds);
  return plan.proposals.find((proposal) =>
    proposal.surface === 'engineering'
      && Boolean(proposal.repoPath)
      && (preferredIds.size === 0 || preferredIds.has(proposal.id)),
  );
}

function selectExecutableSessionProposal(plan: WorkContinuationPlan): WorkContinuationProposal | undefined {
  const preferredIds = new Set(plan.doNowIds);
  return plan.proposals.find((proposal) =>
    proposal.surface === 'session'
      && Boolean(proposal.sessionProvider)
      && (
        proposal.sessionAction === 'continue-last'
        || Boolean(proposal.sessionId)
      )
      && (preferredIds.size === 0 || preferredIds.has(proposal.id)),
  );
}

function selectExecutableSupervisorProposal(plan: WorkContinuationPlan): WorkContinuationProposal | undefined {
  const preferredIds = new Set(plan.doNowIds);
  return plan.proposals.find((proposal) =>
    proposal.surface === 'supervisor'
      && (Boolean(proposal.supervisorCommand) || Boolean(proposal.supervisorUrl))
      && (preferredIds.size === 0 || preferredIds.has(proposal.id)),
  );
}

function applyAdaptivePlanRanking(
  plan: WorkContinuationPlan,
  context: Awaited<ReturnType<typeof loadOperatorRuntimeContext>>,
): WorkContinuationPlan {
  const proposals = plan.proposals
    .map((proposal) => {
      const preference = scoreOperatorPreference({
        providerOrWorker: proposal.sessionProvider,
        capability: proposal.capability,
        taskShape: inferProposalTaskShape(proposal),
        environmentHints: [proposal.repoPath, proposal.sessionCwd, ...proposal.sourceRefs].filter((value): value is string => Boolean(value)),
        text: [proposal.title, proposal.goal, proposal.rationale, proposal.nextStep].filter(Boolean).join(' '),
      }, context);

      return preference.score > 0
        ? {
            ...proposal,
            adaptiveScore: preference.score,
            adaptiveReasons: preference.reasons,
          }
        : proposal;
    })
    .sort((left, right) =>
      compareDoNowMembership(left, right, plan.doNowIds)
      || comparePriority(right.priority, left.priority)
      || (right.adaptiveScore ?? 0) - (left.adaptiveScore ?? 0)
      || left.title.localeCompare(right.title),
    );

  const doNowIds = plan.doNowIds.length > 0
    ? proposals
      .filter((proposal) => plan.doNowIds.includes(proposal.id))
      .map((proposal) => proposal.id)
    : proposals
      .filter((proposal) => !proposal.requiresApproval)
      .slice(0, Math.min(3, proposals.length))
      .map((proposal) => proposal.id);

  return {
    ...plan,
    proposals,
    doNowIds,
  };
}

function inferProposalTaskShape(proposal: WorkContinuationProposal): string {
  if (proposal.surface === 'session') {
    return proposal.sessionProvider === 'browser'
      ? 'browser'
      : proposal.sessionProvider === 'openclaw'
        ? 'hybrid'
        : 'session';
  }
  if (proposal.surface === 'engineering') {
    return 'engineering';
  }
  if (proposal.surface === 'review') {
    return 'review';
  }
  if (proposal.surface === 'research') {
    return 'research';
  }
  if (proposal.surface === 'ops') {
    return 'ops';
  }
  if (proposal.surface === 'supervisor') {
    return 'ops';
  }
  return proposal.capability === 'document' ? 'document' : proposal.surface;
}

function collectProposalWorkerIds(proposals: WorkContinuationProposal[]): string[] {
  return [...new Set(proposals
    .map((proposal) => proposal.sessionProvider)
    .filter((value): value is NonNullable<WorkContinuationProposal['sessionProvider']> => Boolean(value)))];
}

function collectProposalTaskShapes(proposals: WorkContinuationProposal[]): string[] {
  return [...new Set(proposals.map((proposal) => inferProposalTaskShape(proposal)).filter(Boolean))];
}

function compareDoNowMembership(
  left: WorkContinuationProposal,
  right: WorkContinuationProposal,
  doNowIds: string[],
): number {
  const preferredIds = new Set(doNowIds);
  const leftPreferred = preferredIds.has(left.id) ? 1 : 0;
  const rightPreferred = preferredIds.has(right.id) ? 1 : 0;
  return rightPreferred - leftPreferred;
}

function comparePriority(left: ContinuationPriority, right: ContinuationPriority): number {
  const scores: Record<ContinuationPriority, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  return scores[left] - scores[right];
}

function renderWorkContinuationMarkdown(input: {
  plan: WorkContinuationPlan;
  discoverySummary: string;
  reviewSummary: string;
  executedEngineeringRun?: {
    proposalId: string;
    result: EngineeringForemanRunResult;
  };
  executedSessionRun?: {
    proposalId: string;
    result: SessionRunResult;
  };
  executedSupervisorRun?: {
    proposalId: string;
    result: SupervisorRunResult;
  };
  approvalRequiredProposal?: {
    proposalId: string;
    reason: string;
  };
}): string {
  const lines: string[] = [
    '# Foreman Work Continuation',
    '',
    input.plan.summary,
    '',
    '## Discovery Summary',
    '',
    input.discoverySummary,
    '',
    '## Session Review Summary',
    '',
    input.reviewSummary,
    '',
    '## Proposals',
  ];

  if (input.plan.proposals.length === 0) {
    lines.push('', '- None');
  } else {
    for (const proposal of input.plan.proposals) {
      lines.push('');
      lines.push(`- [${proposal.priority}] ${proposal.title}`);
      lines.push(`  Surface: ${proposal.surface}`);
      lines.push(`  Capability: ${proposal.capability}`);
      lines.push(`  Goal: ${proposal.goal}`);
      lines.push(`  Rationale: ${proposal.rationale}`);
      if (proposal.repoPath) {
        lines.push(`  Repo: ${proposal.repoPath}`);
      }
      if (proposal.successCriteria.length > 0) {
        lines.push(`  Success criteria: ${proposal.successCriteria.join(' | ')}`);
      }
      if (proposal.checkCommands.length > 0) {
        lines.push(`  Checks: ${proposal.checkCommands.join(' | ')}`);
      }
      lines.push(`  Next step: ${proposal.nextStep}`);
      if (proposal.sourceRefs.length > 0) {
        lines.push(`  Sources: ${proposal.sourceRefs.join(', ')}`);
      }
      if (proposal.sessionProvider) {
        lines.push(`  Session provider: ${proposal.sessionProvider}`);
      }
      if (proposal.sessionId) {
        lines.push(`  Session id: ${proposal.sessionId}`);
      }
      if (proposal.sessionAction) {
        lines.push(`  Session action: ${proposal.sessionAction}`);
      }
      if (proposal.supervisorCommand) {
        lines.push(`  Supervisor command: ${proposal.supervisorCommand}`);
      }
      if (proposal.supervisorUrl) {
        lines.push(`  Supervisor URL: ${proposal.supervisorUrl}`);
      }
      if (proposal.adaptiveScore) {
        lines.push(`  Adaptive score: ${proposal.adaptiveScore}`);
      }
      if (proposal.adaptiveReasons?.length) {
        lines.push(`  Adaptive reasons: ${proposal.adaptiveReasons.join(' | ')}`);
      }
      lines.push(`  Requires approval: ${proposal.requiresApproval ? 'yes' : 'no'}`);
    }
  }

  lines.push('', '## Do Now');
  lines.push(...renderBulletSection(input.plan.doNowIds));
  lines.push('', '## Defer');
  lines.push(...renderBulletSection(input.plan.deferIds));
  lines.push('', '## Open Questions');
  lines.push(...renderBulletSection(input.plan.openQuestions));

  if (input.executedEngineeringRun) {
    lines.push('', '## Executed Engineering Run');
    lines.push(`- Proposal: ${input.executedEngineeringRun.proposalId}`);
    lines.push(`- Trace id: ${input.executedEngineeringRun.result.traceId}`);
    lines.push(`- Worker: ${input.executedEngineeringRun.result.selectedWorkerId}`);
  }

  if (input.executedSessionRun) {
    lines.push('', '## Executed Session Run');
    lines.push(`- Proposal: ${input.executedSessionRun.proposalId}`);
    lines.push(`- Provider: ${input.executedSessionRun.result.provider}`);
    lines.push(`- Session id: ${input.executedSessionRun.result.sessionId ?? 'n/a'}`);
    lines.push(`- Trace id: ${input.executedSessionRun.result.traceId ?? 'n/a'}`);
  }

  if (input.executedSupervisorRun) {
    lines.push('', '## Executed Supervisor Run');
    lines.push(`- Proposal: ${input.executedSupervisorRun.proposalId}`);
    lines.push(`- Trace id: ${input.executedSupervisorRun.result.traceId ?? 'n/a'}`);
    lines.push(`- Status: ${input.executedSupervisorRun.result.report.executionStatus}`);
  }

  if (input.approvalRequiredProposal) {
    lines.push('', '## Approval Required');
    lines.push(`- Proposal: ${input.approvalRequiredProposal.proposalId}`);
    lines.push(`- Reason: ${input.approvalRequiredProposal.reason}`);
  }

  return `${lines.join('\n')}\n`;
}

function renderBulletSection(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ['- None'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function normalizePriority(value: unknown): ContinuationPriority {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
    ? value
    : 'medium';
}

function normalizeSurface(value: unknown): ContinuationSurface {
  return value === 'engineering'
    || value === 'connector'
    || value === 'manual'
    || value === 'research'
    || value === 'review'
    || value === 'ops'
    || value === 'session'
    || value === 'supervisor'
    ? value
    : 'manual';
}

function normalizeSessionProvider(value: unknown): WorkContinuationProposal['sessionProvider'] {
  return value === 'claude'
    || value === 'codex'
    || value === 'browser'
    || value === 'opencode'
    || value === 'openclaw'
    ? value
    : undefined;
}

function normalizeSessionAction(value: unknown): WorkContinuationProposal['sessionAction'] {
  return value === 'continue'
    || value === 'fork'
    || value === 'continue-last'
    ? value
    : undefined;
}

function normalizeCapability(value: unknown): ContinuationCapability {
  return value === 'code'
    || value === 'browser'
    || value === 'review'
    || value === 'research'
    || value === 'ops'
    || value === 'document'
    || value === 'hybrid'
    ? value
    : 'hybrid';
}
