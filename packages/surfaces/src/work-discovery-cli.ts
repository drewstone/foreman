import { runWorkDiscovery } from './work-discovery.js';
import { parseSessionProviderList, sessionProviderHelpText, type SessionProviderName } from './session-provider-args.js';

interface CliArgs {
  profileId?: string;
  userId?: string;
  profileRoot?: string;
  memoryRoot?: string;
  traceRoots: string[];
  transcriptRoots: string[];
  sessionProviders?: SessionProviderName[];
  sessionCwd?: string;
  sessionLimitPerProvider?: number;
  maxTranscriptFiles?: number;
  maxItems?: number;
}

function parseArgs(argv: string[]): CliArgs {
  let profileId: string | undefined;
  let userId: string | undefined;
  let profileRoot: string | undefined;
  let memoryRoot: string | undefined;
  const traceRoots: string[] = [];
  const transcriptRoots: string[] = [];
  let sessionProviders: SessionProviderName[] | undefined;
  let sessionCwd: string | undefined;
  let sessionLimitPerProvider: number | undefined;
  let maxTranscriptFiles: number | undefined;
  let maxItems: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--profile-id':
        profileId = next;
        index += 1;
        break;
      case '--user-id':
        userId = next;
        index += 1;
        break;
      case '--profile-root':
        profileRoot = next;
        index += 1;
        break;
      case '--memory-root':
        memoryRoot = next;
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
      case '--max-transcript-files':
        maxTranscriptFiles = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--max-items':
        maxItems = next ? Number(next) : undefined;
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
    maxTranscriptFiles,
    maxItems,
  };
}

function printHelp(): void {
  console.log(`Foreman work discovery

Usage:
  npm run discover-work -- [options]

Options:
  --profile-id ID           Associate results with this profile
  --user-id ID              Load user memory for adaptive ranking
  --profile-root PATH       Load stored profile for adaptive ranking
  --memory-root PATH        Load profile/user memory for adaptive ranking
  --trace-root PATH         Scan Foreman traces for open/stalled work (repeatable)
  --transcript-root PATH    Scan prior agent transcripts for open/stalled work (repeatable)
  --session-provider NAME   Include resumable sessions from ${sessionProviderHelpText()}.
                            Accepts repeatable flags or comma-separated values.
  --session-cwd PATH        Working directory / project root for session-backed discovery
  --session-limit-per-provider N
                            Limit sessions loaded per provider
  --max-transcript-files N  Limit transcript files scanned (default 200)
  --max-items N             Limit work items returned (default 25)
  -h, --help                Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runWorkDiscovery(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
