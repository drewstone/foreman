import { runOperatorLearningEval } from './operator-learning-eval.js';

interface CliArgs {
  profileId: string;
  userId?: string;
  profileRoot: string;
  memoryRoot: string;
  outputPath?: string;
  markdownPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let profileId = '';
  let userId: string | undefined;
  let profileRoot = '.foreman/profiles';
  let memoryRoot = '.foreman/memory';
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
    userId,
    profileRoot,
    memoryRoot,
    outputPath,
    markdownPath,
  };
}

function printHelp(): void {
  console.log(`Foreman operator-learning-eval

Usage:
  npm run eval-operator-learning -- --profile-id my-profile [options]

Options:
  --user-id ID           Optional user memory scope
  --profile-root PATH    Directory for stored profiles
  --memory-root PATH     Directory for memory state
  --output-path PATH     Write JSON report
  --markdown-path PATH   Write Markdown report
  -h, --help             Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runOperatorLearningEval(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
