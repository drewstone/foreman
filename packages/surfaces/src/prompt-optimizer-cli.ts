import { runPromptOptimizerSidecar } from './prompt-optimizer.js';

function parseArgs(argv: string[]): {
  traceRoot: string;
  outputRoot?: string;
  policyRoot?: string;
  taskId?: string;
  taskShape?: string;
  minimumRunsPerVariant?: number;
  exportDatasetJsonl?: boolean;
  autoPromoteShadows?: boolean;
  autoRollbackActives?: boolean;
  adapter?: 'heuristic' | 'ax';
  axProvider?: 'openai' | 'anthropic';
  axModel?: string;
  axTeacherModel?: string;
  axApiKeyEnv?: string;
} {
  let traceRoot = '';
  let outputRoot: string | undefined;
  let policyRoot: string | undefined;
  let taskId: string | undefined;
  let taskShape: string | undefined;
  let minimumRunsPerVariant: number | undefined;
  let exportDatasetJsonl = false;
  let autoPromoteShadows = false;
  let autoRollbackActives = false;
  let adapter: 'heuristic' | 'ax' | undefined;
  let axProvider: 'openai' | 'anthropic' | undefined;
  let axModel: string | undefined;
  let axTeacherModel: string | undefined;
  let axApiKeyEnv: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--trace-root':
        traceRoot = next ?? '';
        i += 1;
        break;
      case '--output-root':
        outputRoot = next;
        i += 1;
        break;
      case '--policy-root':
        policyRoot = next;
        i += 1;
        break;
      case '--task-id':
        taskId = next;
        i += 1;
        break;
      case '--task-shape':
        taskShape = next;
        i += 1;
        break;
      case '--min-runs':
        minimumRunsPerVariant = next ? Number(next) : undefined;
        i += 1;
        break;
      case '--export-dataset':
        exportDatasetJsonl = true;
        break;
      case '--auto-promote-shadows':
        autoPromoteShadows = true;
        break;
      case '--auto-rollback-actives':
        autoRollbackActives = true;
        break;
      case '--adapter':
        adapter = next === 'ax' ? 'ax' : next === 'heuristic' ? 'heuristic' : undefined;
        i += 1;
        break;
      case '--ax-provider':
        axProvider = next === 'anthropic' ? 'anthropic' : next === 'openai' ? 'openai' : undefined;
        i += 1;
        break;
      case '--ax-model':
        axModel = next;
        i += 1;
        break;
      case '--ax-teacher-model':
        axTeacherModel = next;
        i += 1;
        break;
      case '--ax-api-key-env':
        axApiKeyEnv = next;
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
    outputRoot,
    policyRoot,
    taskId,
    taskShape,
    minimumRunsPerVariant,
    exportDatasetJsonl,
    autoPromoteShadows,
    autoRollbackActives,
    adapter,
    axProvider,
    axModel,
    axTeacherModel,
    axApiKeyEnv,
  };
}

function printHelp(): void {
  console.log(`Foreman prompt optimizer sidecar

Usage:
  npm run optimize-prompts -- --trace-root /path/to/traces [options]

Options:
  --output-root /path      Where to write optimizer outputs
  --policy-root /path      Where to store prompt policy state
  --task-id ID             Filter to one task id
  --task-shape NAME        Filter to one task shape
  --min-runs N             Minimum runs per prompt variant
  --export-dataset         Export optimizer-ready JSONL dataset
  --auto-promote-shadows   Promote shadow variants when thresholds are met
  --auto-rollback-actives  Roll back active variants when rollback thresholds are met
  --adapter NAME           Optimizer adapter: heuristic or ax
  --ax-provider NAME       Ax provider: openai or anthropic
  --ax-model NAME          Ax student model
  --ax-teacher-model NAME  Ax teacher model
  --ax-api-key-env NAME    Env var holding the Ax provider API key
  -h, --help               Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPromptOptimizerSidecar(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
