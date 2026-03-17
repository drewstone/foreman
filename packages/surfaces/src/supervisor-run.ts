import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { classifySupervisorFailure, type FailureClass } from '@drew/foreman-evals';
import { createTraceStore } from '@drew/foreman-tracing';
import {
  SupervisorCommandWorkerAdapter,
  SupervisorServiceWorkerAdapter,
  type CommandWorkerTask,
  type ServiceWorkerTask,
  type SupervisorWorkerOutput,
} from '@drew/foreman-workers';

export interface SupervisorRunOptions {
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  label?: string;
  approvalMode?: 'auto' | 'required' | 'never';
  approve?: boolean;
  traceRoot?: string;
  taskId?: string;
  outputPath?: string;
  markdownPath?: string;
}

export interface SupervisorRunReport {
  label: string;
  executionStatus: 'completed' | 'failed' | 'needs-approval';
  summary: string;
  status: SupervisorWorkerOutput['status'] | 'failed';
  validated: boolean;
  approvalRequired?: boolean;
  approvalReason?: string;
  failureClasses?: FailureClass[];
  childRuns: SupervisorWorkerOutput['childRuns'];
  findings: SupervisorWorkerOutput['findings'];
  artifacts: SupervisorWorkerOutput['artifacts'];
  recommendedNextActions: string[];
  metadata?: Record<string, string>;
  evidence: Array<{
    kind: string;
    label: string;
    value: string;
    uri?: string;
    metadata?: Record<string, string>;
  }>;
}

export interface SupervisorRunResult {
  report: SupervisorRunReport;
  traceId?: string;
  outputPath?: string;
  markdownPath?: string;
}

export async function runSupervisorSurface(
  options: SupervisorRunOptions,
): Promise<SupervisorRunResult> {
  const label = options.label?.trim()
    || options.command?.trim()
    || options.url?.trim()
    || 'external-supervisor';
  const workerId = slugifyLabel(label);
  const approvalReason = resolveSupervisorApprovalReason(options);

  if (approvalReason && !options.approve) {
    const report: SupervisorRunReport = {
      label,
      executionStatus: 'needs-approval',
      summary: `Supervisor run requires approval: ${approvalReason}`,
      status: 'failed',
      validated: false,
      approvalRequired: true,
      approvalReason,
      failureClasses: ['approval-required'],
      childRuns: [],
      findings: [],
      artifacts: [],
      recommendedNextActions: ['Approve the supervisor run explicitly before execution.'],
      evidence: [
        {
          kind: 'note',
          label: 'approval',
          value: approvalReason,
        },
      ],
    };
    return finalizeSupervisorRunResult(report, options);
  }

  const run = options.command
    ? await new SupervisorCommandWorkerAdapter({
        id: workerId,
        name: label,
        capabilities: ['review', 'ops'],
        metadata: {
          outputContract: 'supervisor-v1',
        },
      }).run({
        task: {
          command: options.command,
          cwd: options.cwd,
          env: options.env,
        } satisfies CommandWorkerTask,
        context: {
          summary: `Run external supervisor command ${label}`,
        },
      })
    : await new SupervisorServiceWorkerAdapter({
        id: workerId,
        name: label,
        capabilities: ['review', 'ops'],
        metadata: {
          outputContract: 'supervisor-v1',
        },
      }).run({
        task: {
          url: requiredString(options.url, 'url'),
          method: options.method ?? 'POST',
          headers: options.headers,
          body: options.body,
          timeoutMs: options.timeoutMs,
        } satisfies ServiceWorkerTask,
        context: {
          summary: `Run external supervisor service ${label}`,
        },
      });

  const output = run.output;
  const validated = isSupervisorOutputValidated(output);
  const report: SupervisorRunReport = {
    label,
    executionStatus: output?.status === 'completed' ? 'completed' : 'failed',
    summary: output?.summary ?? run.summary,
    status: output?.status ?? 'failed',
    validated,
    failureClasses: classifySupervisorFailure({
      status: output?.status ?? 'failed',
      findings: output?.findings,
      childRuns: output?.childRuns,
      validated,
      evidence: run.evidence,
    }),
    childRuns: output?.childRuns ?? [],
    findings: output?.findings ?? [],
    artifacts: output?.artifacts ?? [],
    recommendedNextActions: output?.recommendedNextActions ?? [],
    metadata: output?.metadata,
    evidence: run.evidence,
  };
  return finalizeSupervisorRunResult(report, options);
}

function isSupervisorOutputValidated(output: SupervisorWorkerOutput | undefined): boolean {
  if (!output) {
    return false;
  }
  if (output.status !== 'completed') {
    return false;
  }
  return !output.findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical');
}

function summarizeChildRuns(childRuns: SupervisorWorkerOutput['childRuns']): {
  total: number;
  completed: number;
  failed: number;
  blocked: number;
  pending: number;
  cancelled: number;
  unknown: number;
  workerIds: string[];
  backends: string[];
} {
  const workerIds = [...new Set(childRuns.map((child) => child.workerId).filter((value): value is string => Boolean(value)))];
  const backends = [...new Set(childRuns.map((child) => child.backend).filter((value): value is string => Boolean(value)))];
  return {
    total: childRuns.length,
    completed: childRuns.filter((child) => child.status === 'completed').length,
    failed: childRuns.filter((child) => child.status === 'failed').length,
    blocked: childRuns.filter((child) => child.status === 'blocked').length,
    pending: childRuns.filter((child) => child.status === 'pending' || child.status === 'running').length,
    cancelled: childRuns.filter((child) => child.status === 'cancelled').length,
    unknown: childRuns.filter((child) => child.status === 'unknown').length,
    workerIds,
    backends,
  };
}

function summarizeFindings(findings: SupervisorWorkerOutput['findings']): {
  total: number;
  highOrCritical: number;
  highestSeverity: string;
} {
  const severities = findings.map((finding) => finding.severity);
  const highestSeverity = severities.includes('critical')
    ? 'critical'
    : severities.includes('high')
      ? 'high'
      : severities.includes('medium')
        ? 'medium'
        : severities.includes('low')
          ? 'low'
          : 'none';
  return {
    total: findings.length,
    highOrCritical: findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical').length,
    highestSeverity,
  };
}

function renderSupervisorRunMarkdown(report: SupervisorRunReport): string {
  const lines: string[] = [
    '# Foreman Supervisor Run',
    '',
    `- Label: ${report.label}`,
    `- Execution status: ${report.executionStatus}`,
    `- Status: ${report.status}`,
    `- Validated: ${report.validated ? 'yes' : 'no'}`,
    ...(report.approvalReason ? [`- Approval reason: ${report.approvalReason}`] : []),
    ...(report.failureClasses?.length ? [`- Failure classes: ${report.failureClasses.join(', ')}`] : []),
    '',
    report.summary,
    '',
    '## Child Runs',
  ];

  if (report.childRuns.length === 0) {
    lines.push('- None');
  } else {
    for (const child of report.childRuns) {
      lines.push(`- [${child.status}] ${child.id}: ${child.summary}`);
      if (child.workerId) {
        lines.push(`  Worker: ${child.workerId}`);
      }
      if (child.backend) {
        lines.push(`  Backend: ${child.backend}`);
      }
      if (child.sessionId) {
        lines.push(`  Session: ${child.sessionId}`);
      }
      if (child.sandboxId) {
        lines.push(`  Sandbox: ${child.sandboxId}`);
      }
      if (child.traceId) {
        lines.push(`  Trace: ${child.traceId}`);
      }
    }
  }

  lines.push('', '## Findings');
  if (report.findings.length === 0) {
    lines.push('- None');
  } else {
    for (const finding of report.findings) {
      lines.push(`- [${finding.severity}] ${finding.title}`);
      lines.push(`  ${finding.body}`);
      if (finding.evidence) {
        lines.push(`  Evidence: ${finding.evidence}`);
      }
    }
  }

  lines.push('', '## Recommended Next Actions');
  lines.push(...renderBulletSection(report.recommendedNextActions));

  if (report.artifacts.length > 0) {
    lines.push('', '## Artifacts');
    for (const artifact of report.artifacts) {
      lines.push(`- ${artifact.label} (${artifact.kind})`);
      if (artifact.path) {
        lines.push(`  Path: ${artifact.path}`);
      }
      if (artifact.uri) {
        lines.push(`  URI: ${artifact.uri}`);
      }
      if (artifact.value) {
        lines.push(`  Value: ${artifact.value}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderBulletSection(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ['- None'];
}

function slugifyLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'external-supervisor';
}

function requiredString(value: string | undefined, label: string): string {
  if (!value?.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function resolveSupervisorApprovalReason(options: SupervisorRunOptions): string | undefined {
  const approvalMode = options.approvalMode ?? 'auto';
  if (approvalMode === 'never' || options.approve) {
    return undefined;
  }
  if (approvalMode === 'required') {
    return 'explicit approval mode requires confirmation before supervisor execution';
  }
  if (options.url) {
    const method = (options.method ?? 'POST').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return `service supervisor uses mutating HTTP method ${method}`;
    }
  }
  return undefined;
}

async function finalizeSupervisorRunResult(
  report: SupervisorRunReport,
  options: SupervisorRunOptions,
): Promise<SupervisorRunResult> {
  const traceId = options.traceRoot
    ? await writeSupervisorTrace(report, options)
    : undefined;
  let outputPath: string | undefined;
  if (options.outputPath) {
    outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  let markdownPath: string | undefined;
  if (options.markdownPath) {
    markdownPath = resolve(options.markdownPath);
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, renderSupervisorRunMarkdown(report), 'utf8');
  }

  return {
    report,
    traceId,
    outputPath,
    markdownPath,
  };
}

async function writeSupervisorTrace(
  report: SupervisorRunReport,
  options: SupervisorRunOptions,
): Promise<string> {
  const store = await createTraceStore({
    rootDir: resolve(options.traceRoot!),
  });
  const childRunSummary = summarizeChildRuns(report.childRuns);
  const findingSummary = summarizeFindings(report.findings);
  return store.put({
    task: {
      id: options.taskId ?? `supervisor-${slugifyLabel(report.label)}`,
      goal: report.summary,
      environmentKind: 'hybrid',
    },
    events: [
      {
        at: new Date().toISOString(),
        kind: report.executionStatus === 'completed' ? 'supervisor.completed' : report.executionStatus === 'needs-approval' ? 'supervisor.blocked' : 'supervisor.failed',
        workerId: slugifyLabel(report.label),
        summary: report.summary,
        metadata: {
          surface: 'supervisor',
          label: report.label,
          status: report.status,
          executionStatus: report.executionStatus,
          approvalReason: report.approvalReason ?? '',
          failureClasses: (report.failureClasses ?? []).join(','),
          childRunCount: String(childRunSummary.total),
          childRunFailedCount: String(childRunSummary.failed),
          childRunBlockedCount: String(childRunSummary.blocked),
          childRunCancelledCount: String(childRunSummary.cancelled),
          childRunUnknownCount: String(childRunSummary.unknown),
          findingCount: String(findingSummary.total),
          highSeverityFindingCount: String(findingSummary.highOrCritical),
          highestFindingSeverity: findingSummary.highestSeverity,
        },
      },
      ...report.childRuns.map((child) => ({
        at: child.finishedAt ?? child.startedAt ?? new Date().toISOString(),
        kind: child.status === 'completed' ? 'supervisor.child.completed' : 'supervisor.child.failed',
        workerId: child.workerId ?? slugifyLabel(report.label),
        summary: child.summary,
        metadata: {
          surface: 'supervisor',
          childRunId: child.id,
          childStatus: child.status,
          backend: child.backend ?? '',
          sessionId: child.sessionId ?? '',
          sandboxId: child.sandboxId ?? '',
          traceId: child.traceId ?? '',
        },
      })),
    ],
    evidence: report.evidence.map((item) => ({
      ...item,
      metadata: {
        surface: 'supervisor',
        ...(item.metadata ?? {}),
        failureClasses: (report.failureClasses ?? []).join(','),
      },
    })),
    outcome: {
      status: report.executionStatus === 'needs-approval'
        ? 'blocked'
        : report.executionStatus === 'completed'
          ? 'completed'
          : 'failed',
      summary: report.summary,
      validated: report.validated,
    },
    metadata: {
      surface: 'supervisor',
      label: report.label,
      status: report.status,
      executionStatus: report.executionStatus,
      command: options.command ?? '',
      url: options.url ?? '',
      method: options.method ?? '',
      body: options.body ?? '',
      cwd: options.cwd ?? '',
      approvalMode: options.approvalMode ?? 'auto',
      approvalReason: report.approvalReason ?? '',
      failureClasses: (report.failureClasses ?? []).join(','),
      childRunCount: String(childRunSummary.total),
      childRunCompletedCount: String(childRunSummary.completed),
      childRunFailedCount: String(childRunSummary.failed),
      childRunBlockedCount: String(childRunSummary.blocked),
      childRunPendingCount: String(childRunSummary.pending),
      childRunCancelledCount: String(childRunSummary.cancelled),
      childRunUnknownCount: String(childRunSummary.unknown),
      childRunWorkerIds: childRunSummary.workerIds.join(','),
      childRunBackends: childRunSummary.backends.join(','),
      findingCount: String(findingSummary.total),
      highSeverityFindingCount: String(findingSummary.highOrCritical),
      highestFindingSeverity: findingSummary.highestSeverity,
      artifactCount: String(report.artifacts.length),
    },
  });
}
