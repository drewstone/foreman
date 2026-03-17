import { runLearnOperator } from './learn-operator.js';
import { parseSessionProviderList, sessionProviderHelpText, type SessionProviderName } from './session-provider-args.js';

interface CliArgs {
  profileId: string;
  profileName?: string;
  userId?: string;
  profileRoot: string;
  memoryRoot: string;
  traceRoots: string[];
  transcriptRoots: string[];
  repoPaths: string[];
  sessionProviders?: SessionProviderName[];
  sessionCwd?: string;
  sessionLimitPerProvider?: number;
  maxTranscriptFiles?: number;
  since?: string;
  lookbackDays?: number;
  provider?: 'codex' | 'claude';
  providerTimeoutMs?: number;
  outputPath?: string;
  markdownPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let profileId = '';
  let profileName: string | undefined;
  let userId: string | undefined;
  let profileRoot = '.foreman/profiles';
  let memoryRoot = '.foreman/memory';
  const traceRoots: string[] = [];
  const transcriptRoots: string[] = [];
  const repoPaths: string[] = [];
  let sessionProviders: SessionProviderName[] | undefined;
  let sessionCwd: string | undefined;
  let sessionLimitPerProvider: number | undefined;
  let maxTranscriptFiles: number | undefined;
  let since: string | undefined;
  let lookbackDays: number | undefined;
  let provider: 'codex' | 'claude' | undefined;
  let providerTimeoutMs: number | undefined;
  let outputPath: string | undefined;
  let markdownPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--profile-id':
        profileId = next ?? '';
        index += 1;
        break;
      case '--profile-name':
        profileName = next;
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
      case '--max-transcript-files':
        maxTranscriptFiles = next ? Number(next) : undefined;
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
      case '--provider':
        provider = next === 'codex' ? 'codex' : next === 'claude' ? 'claude' : undefined;
        index += 1;
        break;
      case '--provider-timeout-ms':
        providerTimeoutMs = next ? Number(next) : undefined;
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

  return {
    profileId,
    profileName,
    userId,
    profileRoot,
    memoryRoot,
    traceRoots,
    transcriptRoots,
    repoPaths,
    sessionProviders,
    sessionCwd,
    sessionLimitPerProvider,
    maxTranscriptFiles,
    since,
    lookbackDays,
    provider,
    providerTimeoutMs,
    outputPath,
    markdownPath,
  };
}

function printHelp(): void {
  console.log(`Foreman learn-operator

Usage:
  npm run learn-operator -- --profile-id my-profile [options]

This is the easiest way to bootstrap Foreman from prior traces and sessions.
It creates or updates a profile, reviews how the user drives agents, writes memory,
and proposes the next work Foreman should move forward.

Options:
  --profile-name NAME            Human-readable profile name
  --profile-root PATH            Directory for stored profiles
  --memory-root PATH             Directory for memory state
  --user-id ID                   Optional user memory scope
  --trace-root PATH              Prior Foreman traces (repeatable)
  --transcript-root PATH         Prior transcript exports (repeatable)
  --repo PATH                    Repo context (repeatable)
  --session-provider NAME        ${sessionProviderHelpText()}.
                                 Accepts repeatable flags or comma-separated values.
  --session-cwd PATH             Working directory / project root for session-backed learning
  --session-limit-per-provider N Limit sessions loaded per provider
  --max-transcript-files N       Limit transcript files scanned
  --since ISO                    Only review material updated since this ISO timestamp
  --lookback-days N              Only review material from the last N days
  --provider NAME                Review/planning provider: codex or claude
  --provider-timeout-ms N        Provider timeout in milliseconds
  --output-path PATH             Write JSON result
  --markdown-path PATH           Write Markdown summary
  -h, --help                     Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runLearnOperator(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
