import { runTraceBenchmark } from './trace-benchmark.js';

function parseArgs(argv: string[]): {
  traceRoot: string;
  surface?: 'session' | 'supervisor' | 'engineering';
  provider?: string;
  maxCases?: number;
  reportPath?: string;
} {
  let traceRoot = '';
  let surface: 'session' | 'supervisor' | 'engineering' | undefined;
  let provider: string | undefined;
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
      case '--surface':
        surface = next === 'session' || next === 'supervisor' || next === 'engineering'
          ? next
          : undefined;
        i += 1;
        break;
      case '--provider':
        provider = next;
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
    surface,
    provider,
    maxCases,
    reportPath,
  };
}

function printHelp(): void {
  console.log(`Foreman trace benchmark

Usage:
  npm run benchmark-traces -- --trace-root /path/to/traces [options]

Options:
  --surface NAME          Filter to session | supervisor | engineering
  --provider NAME         Filter by provider metadata
  --max-cases N           Limit the number of traces included
  --report-path PATH      Write the benchmark report to this file
  -h, --help              Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runTraceBenchmark(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
