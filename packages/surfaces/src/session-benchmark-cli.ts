import { runSessionBenchmark } from './session-benchmark.js';

function parseArgs(argv: string[]): {
  traceRoot: string;
  traceIds: string[];
  traceOutputRoot?: string;
  approvalMode?: 'auto' | 'required' | 'never';
  approve?: boolean;
  profileId?: string;
  userId?: string;
  profileRoot?: string;
  memoryRoot?: string;
  maxCases?: number;
  reportPath?: string;
} {
  let traceRoot = '';
  const traceIds: string[] = [];
  let traceOutputRoot: string | undefined;
  let approvalMode: 'auto' | 'required' | 'never' | undefined;
  let approve = false;
  let profileId: string | undefined;
  let userId: string | undefined;
  let profileRoot: string | undefined;
  let memoryRoot: string | undefined;
  let maxCases: number | undefined;
  let reportPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--trace-root':
        traceRoot = next ?? '';
        i += 1;
        break;
      case '--trace-id':
        if (next) {
          traceIds.push(next);
        }
        i += 1;
        break;
      case '--trace-output-root':
        traceOutputRoot = next;
        i += 1;
        break;
      case '--approval-mode':
        approvalMode = next === 'required' ? 'required' : next === 'never' ? 'never' : next === 'auto' ? 'auto' : undefined;
        i += 1;
        break;
      case '--approve':
        approve = true;
        break;
      case '--profile-id':
        profileId = next;
        i += 1;
        break;
      case '--user-id':
        userId = next;
        i += 1;
        break;
      case '--profile-root':
        profileRoot = next;
        i += 1;
        break;
      case '--memory-root':
        memoryRoot = next;
        i += 1;
        break;
      case '--max-cases':
        maxCases = next ? Number(next) : undefined;
        i += 1;
        break;
      case '--report-path':
        reportPath = next;
        i += 1;
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
    traceIds,
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
  console.log(`Foreman session benchmark

Usage:
  npm run benchmark-session -- --trace-root /path/to/traces [options]

Options:
  --trace-id TRACE_ID        Replay only this session trace (repeatable)
  --trace-output-root PATH   Where to write replay traces
  --approval-mode MODE       auto | required | never
  --approve                  Allow execution when approval would otherwise be required
  --profile-id ID            Profile for adaptive routing
  --user-id ID               User memory scope for adaptive routing
  --profile-root PATH        Profile store root
  --memory-root PATH         Memory store root
  --max-cases N              Limit benchmark cases
  --report-path PATH         Write benchmark JSON report
  -h, --help                 Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runSessionBenchmark(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
