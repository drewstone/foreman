import { runSupervisorReplay } from './supervisor-replay.js';

function parseArgs(argv: string[]): {
  traceRoot: string;
  traceId: string;
  traceOutputRoot?: string;
  approvalMode?: 'auto' | 'required' | 'never';
  approve?: boolean;
  outputPath?: string;
  markdownPath?: string;
} {
  let traceRoot = '';
  let traceId = '';
  let traceOutputRoot: string | undefined;
  let approvalMode: 'auto' | 'required' | 'never' | undefined;
  let approve = false;
  let outputPath: string | undefined;
  let markdownPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--trace-root':
        traceRoot = next ?? '';
        i += 1;
        break;
      case '--trace-id':
        traceId = next ?? '';
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
      case '--output-path':
        outputPath = next;
        i += 1;
        break;
      case '--markdown-path':
        markdownPath = next;
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

  if (!traceRoot || !traceId) {
    printHelp();
    throw new Error('--trace-root and --trace-id are required');
  }

  return {
    traceRoot,
    traceId,
    traceOutputRoot,
    approvalMode,
    approve,
    outputPath,
    markdownPath,
  };
}

function printHelp(): void {
  console.log(`Foreman supervisor replay

Usage:
  npm run replay-supervisor -- --trace-root /path/to/traces --trace-id TRACE_ID [options]

Options:
  --trace-output-root PATH   Where to write replay traces
  --approval-mode MODE       auto | required | never
  --approve                  Allow execution when approval would otherwise be required
  --output-path PATH         Write replay JSON result
  --markdown-path PATH       Write replay Markdown report
  -h, --help                 Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runSupervisorReplay(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
