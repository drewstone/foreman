import { runEngineeringBenchmarkSuite } from './engineering-benchmark.js';

function parseArgs(argv: string[]): {
  traceRoot: string;
  traceIds: string[];
  artifactsRoot?: string;
  traceOutputRoot?: string;
  memoryRoot?: string;
  promptPolicyRoot?: string;
  promptPolicyMode?: 'active' | 'shadow' | 'explicit';
  promptVariantIds?: Partial<Record<'hardener' | 'implementer' | 'reviewer', string>>;
  maxRounds?: number;
  maxCases?: number;
  reportPath?: string;
} {
  let traceRoot = '';
  const traceIds: string[] = [];
  let artifactsRoot: string | undefined;
  let traceOutputRoot: string | undefined;
  let memoryRoot: string | undefined;
  let promptPolicyRoot: string | undefined;
  let promptPolicyMode: 'active' | 'shadow' | 'explicit' | undefined;
  const promptVariantIds: Partial<Record<'hardener' | 'implementer' | 'reviewer', string>> = {};
  let maxRounds: number | undefined;
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
      case '--artifacts-root':
        artifactsRoot = next;
        i += 1;
        break;
      case '--trace-output-root':
        traceOutputRoot = next;
        i += 1;
        break;
      case '--memory-root':
        memoryRoot = next;
        i += 1;
        break;
      case '--prompt-policy-root':
        promptPolicyRoot = next;
        i += 1;
        break;
      case '--prompt-policy-mode':
        promptPolicyMode = next === 'shadow'
          ? 'shadow'
          : next === 'explicit'
            ? 'explicit'
            : next === 'active'
              ? 'active'
              : undefined;
        i += 1;
        break;
      case '--prompt-hardener':
        if (next) {
          promptVariantIds.hardener = next;
        }
        i += 1;
        break;
      case '--prompt-implementer':
        if (next) {
          promptVariantIds.implementer = next;
        }
        i += 1;
        break;
      case '--prompt-reviewer':
        if (next) {
          promptVariantIds.reviewer = next;
        }
        i += 1;
        break;
      case '--max-rounds':
        maxRounds = next ? Number(next) : undefined;
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
    artifactsRoot,
    traceOutputRoot,
    memoryRoot,
    promptPolicyRoot,
    promptPolicyMode,
    promptVariantIds,
    maxRounds,
    maxCases,
    reportPath,
  };
}

function printHelp(): void {
  console.log(`Foreman engineering benchmark runner

Usage:
  npm run benchmark-engineering -- --trace-root /path/to/traces [options]

Options:
  --trace-id TRACE_ID        Replay only this trace (repeatable)
  --artifacts-root /path     Where to write benchmark replay artifacts
  --trace-output-root /path  Where to write benchmark replay traces
  --memory-root /path        Override memory root
  --prompt-policy-root /path Override prompt policy root
  --prompt-policy-mode MODE  active, shadow, or explicit
  --prompt-hardener ID       Override hardener prompt variant
  --prompt-implementer ID    Override implementer prompt variant
  --prompt-reviewer ID       Override reviewer prompt variant
  --max-rounds N             Override maximum rounds per replay
  --max-cases N              Limit the number of traces benchmarked
  --report-path /path        Write the benchmark report to this file
  -h, --help                 Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runEngineeringBenchmarkSuite(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
