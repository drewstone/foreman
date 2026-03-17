import { runSessionReview } from './session-review.js';
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
  outputPath?: string;
  markdownPath?: string;
  provider?: 'codex' | 'claude';
  providerTimeoutMs?: number;
  maxTranscriptFiles?: number;
  maxTranscriptSnippets?: number;
  maxTraceSummaries?: number;
  since?: string;
  lookbackDays?: number;
  applyMemoryUpdates?: boolean;
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
  let outputPath: string | undefined;
  let markdownPath: string | undefined;
  let provider: 'codex' | 'claude' | undefined;
  let providerTimeoutMs: number | undefined;
  let maxTranscriptFiles: number | undefined;
  let maxTranscriptSnippets: number | undefined;
  let maxTraceSummaries: number | undefined;
  let since: string | undefined;
  let lookbackDays: number | undefined;
  let applyMemoryUpdates: boolean | undefined;

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
      case '--repo':
        if (next) {
          repoPaths.push(next);
        }
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
      case '--provider':
        provider = next === 'codex' ? 'codex' : next === 'claude' ? 'claude' : undefined;
        index += 1;
        break;
      case '--provider-timeout-ms':
        providerTimeoutMs = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--max-transcript-files':
        maxTranscriptFiles = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--max-transcript-snippets':
        maxTranscriptSnippets = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--max-trace-summaries':
        maxTraceSummaries = next ? Number(next) : undefined;
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
    outputPath,
    markdownPath,
    provider,
    providerTimeoutMs,
    maxTranscriptFiles,
    maxTranscriptSnippets,
    maxTraceSummaries,
    since,
    lookbackDays,
    applyMemoryUpdates,
  };
}

function printHelp(): void {
  console.log(`Foreman session review

Usage:
  npm run review-sessions -- --profile-id my-profile [options]

Options:
  --profile-root PATH          Directory for stored profiles
  --memory-root PATH           Directory for memory state
  --user-id ID                 Optional user memory scope to update
  --trace-root PATH            Review Foreman traces (repeatable)
  --transcript-root PATH       Review prior session transcripts (repeatable)
  --session-provider NAME      Review resumable sessions from ${sessionProviderHelpText()}.
                               Accepts repeatable flags or comma-separated values.
  --session-cwd PATH           Working directory / project root for session-backed review
  --session-limit-per-provider N
                               Limit sessions loaded per provider
  --repo PATH                  Add repo context to bootstrap summary (repeatable)
  --output-path PATH           Write JSON report
  --markdown-path PATH         Write Markdown report
  --provider NAME              Review provider: codex or claude
  --provider-timeout-ms N      Provider timeout in milliseconds
  --max-transcript-files N     Limit transcript files scanned
  --max-transcript-snippets N  Limit transcript excerpts passed to the provider
  --max-trace-summaries N      Limit trace summaries passed to the provider
  --since ISO                  Only review material updated since this ISO timestamp
  --lookback-days N            Only review material from the last N days
  --apply-memory-updates       Persist profile/user memory updates
  --no-apply-memory-updates    Disable memory updates
  -h, --help                   Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runSessionReview(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
