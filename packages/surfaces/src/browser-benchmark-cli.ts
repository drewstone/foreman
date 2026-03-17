import { runBrowserBenchmark } from './browser-benchmark.js';

interface CliArgs {
  traceRoot: string;
  traceOutputRoot?: string;
  approvalMode?: 'auto' | 'required' | 'never';
  approve?: boolean;
  profileId?: string;
  userId?: string;
  profileRoot?: string;
  memoryRoot?: string;
  maxCases?: number;
  reportPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let traceRoot = '';
  let traceOutputRoot: string | undefined;
  let approvalMode: CliArgs['approvalMode'];
  let approve = false;
  let profileId: string | undefined;
  let userId: string | undefined;
  let profileRoot: string | undefined;
  let memoryRoot: string | undefined;
  let maxCases: number | undefined;
  let reportPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--trace-root':
        traceRoot = next ?? '';
        index += 1;
        break;
      case '--trace-output-root':
        traceOutputRoot = next;
        index += 1;
        break;
      case '--approval-mode':
        approvalMode = next === 'auto' || next === 'required' || next === 'never' ? next : undefined;
        index += 1;
        break;
      case '--approve':
        approve = true;
        break;
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
      case '--max-cases':
        maxCases = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--report-path':
        reportPath = next;
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

  if (!traceRoot) {
    printHelp();
    throw new Error('--trace-root is required');
  }

  return {
    traceRoot,
    traceOutputRoot,
    approvalMode,
    approve,
    profileId,
    userId,
    profileRoot,
    memoryRoot,
    maxCases,
    reportPath,
  };
}

function printHelp(): void {
  console.log(`Foreman browser benchmark

Usage:
  npm run benchmark-browser -- --trace-root PATH

Options:
  --trace-root PATH         Source trace root
  --trace-output-root PATH  Where replay traces should be written
  --approval-mode MODE      auto | required | never
  --approve                 Allow execution when approval would otherwise block it
  --profile-id ID           Profile for adaptive provider selection
  --user-id ID              User memory scope
  --profile-root PATH       Profile store root
  --memory-root PATH        Memory store root
  --max-cases N             Maximum browser traces to replay
  --report-path PATH        Write JSON report
  -h, --help                Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runBrowserBenchmark(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
