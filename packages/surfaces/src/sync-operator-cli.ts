import { runSyncOperator } from './sync-operator.js';
import { parseSessionProviderList, sessionProviderHelpText, type SessionProviderName } from './session-provider-args.js';

interface CliArgs {
  profileId: string;
  profileName?: string;
  userId?: string;
  profileRoot?: string;
  memoryRoot?: string;
  traceRoots?: string[];
  transcriptRoots?: string[];
  repoPaths?: string[];
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
  const args: CliArgs = {
    profileId: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--profile-id':
        args.profileId = next ?? '';
        index += 1;
        break;
      case '--profile-name':
        args.profileName = next;
        index += 1;
        break;
      case '--user-id':
        args.userId = next;
        index += 1;
        break;
      case '--profile-root':
        args.profileRoot = next;
        index += 1;
        break;
      case '--memory-root':
        args.memoryRoot = next;
        index += 1;
        break;
      case '--trace-root':
        args.traceRoots = [...(args.traceRoots ?? []), ...(next ? [next] : [])];
        index += 1;
        break;
      case '--transcript-root':
        args.transcriptRoots = [...(args.transcriptRoots ?? []), ...(next ? [next] : [])];
        index += 1;
        break;
      case '--repo':
        args.repoPaths = [...(args.repoPaths ?? []), ...(next ? [next] : [])];
        index += 1;
        break;
      case '--session-provider':
        args.sessionProviders = [...new Set([...(args.sessionProviders ?? []), ...parseSessionProviderList(next)])];
        index += 1;
        break;
      case '--session-cwd':
        args.sessionCwd = next;
        index += 1;
        break;
      case '--session-limit-per-provider':
        args.sessionLimitPerProvider = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--max-transcript-files':
        args.maxTranscriptFiles = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--since':
        args.since = next;
        index += 1;
        break;
      case '--lookback-days':
        args.lookbackDays = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--provider':
        args.provider = next === 'codex' ? 'codex' : next === 'claude' ? 'claude' : undefined;
        index += 1;
        break;
      case '--provider-timeout-ms':
        args.providerTimeoutMs = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--output-path':
        args.outputPath = next;
        index += 1;
        break;
      case '--markdown-path':
        args.markdownPath = next;
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

  if (!args.profileId) {
    printHelp();
    throw new Error('--profile-id is required');
  }

  return args;
}

function printHelp(): void {
  console.log(`Foreman sync-operator

Usage:
  npm run sync-operator -- --profile-id my-profile [options]

This is the simple cross-machine refresh command.
It reviews the current machine's sessions and traces, updates memory,
and refreshes Foreman's understanding of how you work here.

Options:
  --profile-name NAME            Human-readable profile name
  --profile-root PATH            Profile store root (default .foreman/profiles)
  --memory-root PATH             Memory store root (default .foreman/memory, ignored when Postgres memory is configured)
  --user-id ID                   Optional user id
  --trace-root PATH              Foreman trace root (repeatable)
  --transcript-root PATH         Transcript export root (repeatable)
  --repo PATH                    Repo context (repeatable)
  --session-provider NAME        ${sessionProviderHelpText()}.
                                 Accepts repeatable flags or comma-separated values.
  --session-cwd PATH             Session-backed project root (defaults to current working directory)
  --session-limit-per-provider N Limit sessions loaded per provider
  --max-transcript-files N       Limit transcript files scanned
  --since ISO                    Only review material updated since this ISO timestamp
  --lookback-days N              Only review material from the last N days (default 7)
  --provider NAME                Review/planning provider: codex or claude
  --provider-timeout-ms N        Provider timeout in milliseconds
  --output-path PATH             Write JSON result
  --markdown-path PATH           Write Markdown result
  -h, --help                     Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runSyncOperator(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
