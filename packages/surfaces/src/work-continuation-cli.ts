import { runWorkContinuation } from './work-continuation.js';
import { parseSessionProviderList, sessionProviderHelpText, type SessionProviderName } from './session-provider-args.js';

interface CliArgs {
  profileId: string;
  userId?: string;
  profileRoot: string;
  memoryRoot: string;
  traceRoots: string[];
  transcriptRoots: string[];
  sessionProviders?: SessionProviderName[];
  sessionCwd?: string;
  sessionLimitPerProvider?: number;
  repoPaths: string[];
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

function parseArgs(argv: string[]): CliArgs {
  let profileId = '';
  let userId: string | undefined;
  let profileRoot = '.foreman/profiles';
  let memoryRoot = '.foreman/memory';
  const traceRoots: string[] = [];
  const transcriptRoots: string[] = [];
  let sessionProviders: SessionProviderName[] | undefined;
  let sessionCwd: string | undefined;
  let sessionLimitPerProvider: number | undefined;
  const repoPaths: string[] = [];
  let provider: 'codex' | 'claude' | undefined;
  let providerTimeoutMs: number | undefined;
  let sessionReviewProvider: 'codex' | 'claude' | undefined;
  let sessionReviewTimeoutMs: number | undefined;
  let sessionReviewOutputPath: string | undefined;
  let sessionReviewMarkdownPath: string | undefined;
  let outputPath: string | undefined;
  let markdownPath: string | undefined;
  let maxTranscriptFiles: number | undefined;
  let maxWorkItems: number | undefined;
  let maxProposals: number | undefined;
  let since: string | undefined;
  let lookbackDays: number | undefined;
  let executeTopEngineeringProposal = false;
  let executeTopSessionProposal = false;
  let executeTopSupervisorProposal = false;
  let engineeringArtifactsRoot: string | undefined;
  let engineeringTraceRoot: string | undefined;
  let engineeringPromptPolicyRoot: string | undefined;
  let engineeringMaxRounds: number | undefined;
  let applyMemoryUpdates: boolean | undefined;
  let approveExecution = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--profile-id':
        profileId = next ?? '';
        index += 1;
        break;
      case '--user-id':
        userId = next;
        index += 1;
        break;
      case '--profile-root':
        profileRoot = next ?? profileRoot;
        index += 1;
        break;
      case '--memory-root':
        memoryRoot = next ?? memoryRoot;
        index += 1;
        break;
      case '--trace-root':
        if (next) {
          traceRoots.push(next);
        }
        index += 1;
        break;
      case '--transcript-root':
        if (next) {
          transcriptRoots.push(next);
        }
        index += 1;
        break;
      case '--repo':
        if (next) {
          repoPaths.push(next);
        }
        index += 1;
        break;
      case '--session-provider':
        sessionProviders = [...new Set([...(sessionProviders ?? []), ...parseSessionProviderList(next)])];
        index += 1;
        break;
      case '--session-cwd':
        sessionCwd = next;
        index += 1;
        break;
      case '--session-limit-per-provider':
        sessionLimitPerProvider = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--provider':
        provider = next === 'codex' ? 'codex' : next === 'claude' ? 'claude' : undefined;
        index += 1;
        break;
      case '--provider-timeout-ms':
        providerTimeoutMs = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--session-review-provider':
        sessionReviewProvider = next === 'codex' ? 'codex' : next === 'claude' ? 'claude' : undefined;
        index += 1;
        break;
      case '--session-review-timeout-ms':
        sessionReviewTimeoutMs = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--session-review-output-path':
        sessionReviewOutputPath = next;
        index += 1;
        break;
      case '--session-review-markdown-path':
        sessionReviewMarkdownPath = next;
        index += 1;
        break;
      case '--output-path':
        outputPath = next;
        index += 1;
        break;
      case '--markdown-path':
        markdownPath = next;
        index += 1;
        break;
      case '--max-transcript-files':
        maxTranscriptFiles = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--max-work-items':
        maxWorkItems = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--max-proposals':
        maxProposals = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--since':
        since = next;
        index += 1;
        break;
      case '--lookback-days':
        lookbackDays = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--execute-top-engineering':
        executeTopEngineeringProposal = true;
        break;
      case '--execute-top-session':
        executeTopSessionProposal = true;
        break;
      case '--execute-top-supervisor':
        executeTopSupervisorProposal = true;
        break;
      case '--engineering-artifacts-root':
        engineeringArtifactsRoot = next;
        index += 1;
        break;
      case '--engineering-trace-root':
        engineeringTraceRoot = next;
        index += 1;
        break;
      case '--engineering-prompt-policy-root':
        engineeringPromptPolicyRoot = next;
        index += 1;
        break;
      case '--engineering-max-rounds':
        engineeringMaxRounds = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--approve-execution':
        approveExecution = true;
        break;
      case '--apply-memory-updates':
        applyMemoryUpdates = true;
        break;
      case '--no-apply-memory-updates':
        applyMemoryUpdates = false;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        break;
    }
  }

  if (!profileId) {
    printHelp();
    throw new Error('--profile-id is required');
  }

  if (traceRoots.length === 0 && transcriptRoots.length === 0 && (sessionProviders?.length ?? 0) === 0) {
    printHelp();
    throw new Error('at least one --trace-root, --transcript-root, or --session-provider is required');
  }

  return {
    profileId,
    userId,
    profileRoot,
    memoryRoot,
    traceRoots,
    transcriptRoots,
    sessionProviders,
    sessionCwd,
    sessionLimitPerProvider,
    repoPaths,
    provider,
    providerTimeoutMs,
    sessionReviewProvider,
    sessionReviewTimeoutMs,
    sessionReviewOutputPath,
    sessionReviewMarkdownPath,
    outputPath,
    markdownPath,
    maxTranscriptFiles,
    maxWorkItems,
    maxProposals,
    since,
    lookbackDays,
    executeTopEngineeringProposal,
    executeTopSessionProposal,
    executeTopSupervisorProposal,
    engineeringArtifactsRoot,
    engineeringTraceRoot,
    engineeringPromptPolicyRoot,
    engineeringMaxRounds,
    applyMemoryUpdates,
    approveExecution,
  };
}

function printHelp(): void {
  console.log(`Foreman work continuation

Usage:
  npm run continue-work -- --profile-id my-profile [options]

Options:
  --profile-root PATH               Directory for stored profiles
  --memory-root PATH                Directory for memory state
  --user-id ID                      Optional user memory scope
  --trace-root PATH                 Scan Foreman traces (repeatable)
  --transcript-root PATH            Scan imported session transcripts (repeatable)
  --session-provider NAME           Include resumable sessions from ${sessionProviderHelpText()}.
                                    Accepts repeatable flags or comma-separated values.
  --session-cwd PATH                Working directory / project root for session-backed discovery
  --session-limit-per-provider N    Limit sessions loaded per provider
  --repo PATH                       Add repo context (repeatable)
  --provider NAME                   Planner provider: codex or claude
  --provider-timeout-ms N           Planner timeout in milliseconds
  --session-review-provider NAME    Session-review provider: codex or claude
  --session-review-timeout-ms N     Session-review timeout in milliseconds
  --session-review-output-path PATH Write intermediate session-review JSON
  --session-review-markdown-path PATH
                                     Write intermediate session-review Markdown
  --output-path PATH                Write continuation plan JSON
  --markdown-path PATH              Write continuation plan Markdown
  --max-transcript-files N          Limit transcript files scanned
  --max-work-items N                Limit discovered work items
  --max-proposals N                 Limit proposed next runs
  --since ISO                       Only review material updated since this ISO timestamp
  --lookback-days N                 Only review material from the last N days
  --execute-top-engineering         Execute the top engineering proposal immediately
  --execute-top-session             Execute the top session proposal immediately
  --execute-top-supervisor          Execute the top supervisor proposal immediately
  --approve-execution               Allow execution for proposals that require approval
  --engineering-artifacts-root PATH Override artifacts root for executed engineering runs
  --engineering-trace-root PATH     Override trace root for executed engineering runs
  --engineering-prompt-policy-root PATH
                                     Override prompt policy root for executed engineering runs
  --engineering-max-rounds N        Override max rounds for executed engineering runs
  --apply-memory-updates            Persist memory updates from session review
  --no-apply-memory-updates         Disable memory updates from session review
  -h, --help                        Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runWorkContinuation(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
