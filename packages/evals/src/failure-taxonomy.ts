export type FailureClass =
  | 'approval-required'
  | 'provider-runtime'
  | 'provider-model-resolution'
  | 'provider-timeout'
  | 'session-not-found'
  | 'contract-invalid'
  | 'child-run-failed'
  | 'high-severity-findings'
  | 'external-command-failed'
  | 'service-request-failed'
  | 'validation-failed'
  | 'unknown';

export function classifySessionFailure(input: {
  detectedFailureReason?: string;
  stderr?: string;
  exitCode?: number;
}): FailureClass[] {
  const classes = new Set<FailureClass>();
  const stderr = input.stderr ?? '';
  const reason = input.detectedFailureReason ?? '';

  if (reason || input.exitCode && input.exitCode !== 0) {
    classes.add('provider-runtime');
  }
  if (/ProviderModelNotFoundError|ModelNotFoundError|provider or model resolution failed/i.test(`${reason}\n${stderr}`)) {
    classes.add('provider-model-resolution');
  }
  if (/timeout|timed out/i.test(`${reason}\n${stderr}`)) {
    classes.add('provider-timeout');
  }
  if (/session not found|no recent .* found|run not found|unknown session/i.test(stderr)) {
    classes.add('session-not-found');
  }

  if (classes.size === 0 && (input.exitCode ?? 0) !== 0) {
    classes.add('unknown');
  }

  return [...classes];
}

export function classifySupervisorFailure(input: {
  status: string;
  findings?: Array<{ severity: string }>;
  childRuns?: Array<{ status: string }>;
  validated?: boolean;
  evidence?: Array<{ label: string; value: string }>;
}): FailureClass[] {
  const classes = new Set<FailureClass>();

  if (input.status !== 'completed') {
    classes.add('external-command-failed');
  }
  if ((input.findings ?? []).some((finding) => finding.severity === 'high' || finding.severity === 'critical')) {
    classes.add('high-severity-findings');
  }
  if ((input.childRuns ?? []).some((child) => child.status !== 'completed')) {
    classes.add('child-run-failed');
  }
  if (input.validated === false) {
    classes.add('validation-failed');
  }
  if ((input.evidence ?? []).some((item) => item.label === 'stdout' && /invalid supervisor-v1|did not return valid supervisor-v1/i.test(item.value))) {
    classes.add('contract-invalid');
  }

  if (classes.size === 0 && input.status !== 'completed') {
    classes.add('unknown');
  }

  return [...classes];
}
