import { runProfileBootstrap } from './profile-bootstrap.js';

interface CliArgs {
  profileId: string;
  profileName?: string;
  profileRoot: string;
  memoryRoot?: string;
  traceRoots: string[];
  transcriptRoots: string[];
  repoPaths: string[];
  userId?: string;
  maxTranscriptFiles?: number;
}

function parseArgs(argv: string[]): CliArgs {
  let profileId = '';
  let profileName: string | undefined;
  let profileRoot = '.foreman/profiles';
  let memoryRoot: string | undefined;
  const traceRoots: string[] = [];
  const transcriptRoots: string[] = [];
  const repoPaths: string[] = [];
  let userId: string | undefined;
  let maxTranscriptFiles: number | undefined;

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
      case '--profile-root':
        profileRoot = next ?? profileRoot;
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
      case '--repo':
        if (next) {
          repoPaths.push(next);
        }
        index += 1;
        break;
      case '--user-id':
        userId = next;
        index += 1;
        break;
      case '--max-transcript-files':
        maxTranscriptFiles = next ? Number(next) : undefined;
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
    profileRoot,
    memoryRoot,
    traceRoots,
    transcriptRoots,
    repoPaths,
    userId,
    maxTranscriptFiles,
  };
}

function printHelp(): void {
  console.log(`Foreman profile bootstrap

Usage:
  npm run bootstrap-profile -- --profile-id my-profile [options]

Options:
  --profile-name NAME        Human-readable profile name
  --profile-root PATH        Directory for stored profiles
  --memory-root PATH         Directory for profile/user memory
  --trace-root PATH          Import prior Foreman traces (repeatable)
  --transcript-root PATH     Import prior agent transcripts (repeatable)
  --repo PATH                Seed recurring repo/workspace context (repeatable)
  --user-id ID               Also seed user memory for this user
  --max-transcript-files N   Limit transcript files scanned (default 200)
  -h, --help                 Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runProfileBootstrap(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
