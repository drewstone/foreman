import { runEnvironmentForeman } from './environment-foreman.js';

interface CliArgs {
  target?: string;
  goal?: string;
  successCriteria: string[];
  provider?: 'claude' | 'codex';
  taskId?: string;
  traceRoot?: string;
  memoryRoot?: string;
  artifactsRoot?: string;
  maxRounds?: number;
  filePatterns: string[];
  checklistPatterns: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    successCriteria: [],
    filePatterns: [],
    checklistPatterns: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--target':
        args.target = next;
        index += 1;
        break;
      case '--goal':
        args.goal = next;
        index += 1;
        break;
      case '--criterion':
        if (next) {
          args.successCriteria.push(next);
        }
        index += 1;
        break;
      case '--provider':
        args.provider = next === 'codex' ? 'codex' : next === 'claude' ? 'claude' : undefined;
        index += 1;
        break;
      case '--task-id':
        args.taskId = next;
        index += 1;
        break;
      case '--trace-root':
        args.traceRoot = next;
        index += 1;
        break;
      case '--memory-root':
        args.memoryRoot = next;
        index += 1;
        break;
      case '--artifacts-root':
        args.artifactsRoot = next;
        index += 1;
        break;
      case '--max-rounds':
        args.maxRounds = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--file-pattern':
        if (next) {
          args.filePatterns.push(next);
        }
        index += 1;
        break;
      case '--checklist-pattern':
        if (next) {
          args.checklistPatterns.push(next);
        }
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

  if (!args.target || !args.goal) {
    printHelp();
    throw new Error('--target and --goal are required');
  }

  return args;
}

function printHelp(): void {
  console.log(`Foreman document runner

Usage:
  npm run document-foreman -- --target /path/to/docs --goal "Audit the checklist" [options]

Options:
  --criterion TEXT            Success criterion (repeatable)
  --provider NAME             claude or codex
  --task-id ID                Override task id
  --trace-root PATH           Trace output root
  --memory-root PATH          Memory store root
  --artifacts-root PATH       Artifact output root
  --max-rounds N              Maximum rounds (default 2)
  --file-pattern GLOB         File patterns to include (repeatable)
  --checklist-pattern TEXT    Checklist-like patterns to flag (repeatable)
  -h, --help                  Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runEnvironmentForeman({
    domain: 'document',
    target: args.target!,
    goal: args.goal!,
    successCriteria: args.successCriteria,
    provider: args.provider,
    taskId: args.taskId,
    traceRoot: args.traceRoot,
    memoryRoot: args.memoryRoot,
    artifactsRoot: args.artifactsRoot,
    maxRounds: args.maxRounds,
    filePatterns: args.filePatterns.length > 0 ? args.filePatterns : undefined,
    checklistPatterns: args.checklistPatterns.length > 0 ? args.checklistPatterns : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
