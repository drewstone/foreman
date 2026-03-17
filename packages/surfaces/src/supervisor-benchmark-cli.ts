import { runSupervisorBenchmark } from './supervisor-benchmark.js';

function parseArgs(argv: string[]): {
  traceRoot: string;
  traceIds: string[];
  traceOutputRoot?: string;
  approvalMode?: 'auto' | 'required' | 'never';
  approve?: boolean;
  maxCases?: number;
  reportPath?: string;
} {
  let traceRoot = '';
  const traceIds: string[] = [];
  let traceOutputRoot: string | undefined;
  let approvalMode: 'auto' | 'required' | 'never' | undefined;
  let approve = false;
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
    maxCases,
    reportPath,
  };
}

function printHelp(): void {
  console.log(`Foreman supervisor benchmark

Usage:
  npm run benchmark-supervisor -- --trace-root /path/to/traces [options]

Options:
  --trace-id TRACE_ID        Replay only this supervisor trace (repeatable)
  --trace-output-root PATH   Where to write replay traces
  --approval-mode MODE       auto | required | never
  --approve                  Allow execution when approval would otherwise be required
  --max-cases N              Limit benchmark cases
  --report-path PATH         Write benchmark JSON report
  -h, --help                 Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runSupervisorBenchmark(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
