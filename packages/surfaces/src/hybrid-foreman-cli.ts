import { runHybridForeman, type HybridEnvironmentKind } from './hybrid-foreman.js';

interface CliArgs {
  goal?: string;
  successCriteria: string[];
  environments: Array<{ kind: HybridEnvironmentKind; target: string }>;
  provider?: 'claude' | 'codex';
  taskId?: string;
  traceRoot?: string;
  memoryRoot?: string;
  artifactsRoot?: string;
  maxRounds?: number;
  healthUrls: string[];
  checkCommands: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    successCriteria: [],
    environments: [],
    healthUrls: [],
    checkCommands: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
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
      case '--env':
        if (next) {
          const [kind, ...targetParts] = next.split(':');
          const target = targetParts.join(':');
          if ((kind === 'code' || kind === 'document' || kind === 'research' || kind === 'ops') && target) {
            args.environments.push({ kind, target });
          }
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
      case '--health-url':
        if (next) {
          args.healthUrls.push(next);
        }
        index += 1;
        break;
      case '--check':
        if (next) {
          args.checkCommands.push(next);
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
  if (!args.goal || args.environments.length === 0) {
    printHelp();
    throw new Error('--goal and at least one --env are required');
  }
  return args;
}

function printHelp(): void {
  console.log(`Foreman hybrid runner

Usage:
  npm run hybrid-foreman -- --goal "Ship the feature" --env code:/repo --env document:/repo/docs [options]

Options:
  --criterion TEXT      Success criterion (repeatable)
  --env KIND:TARGET     Add an environment node. KIND is code, document, research, or ops. Repeatable.
  --provider NAME       claude or codex
  --task-id ID          Override task id
  --trace-root PATH     Trace output root
  --memory-root PATH    Memory store root
  --artifacts-root PATH Artifact output root
  --max-rounds N        Maximum rounds (default 2)
  --health-url URL      Health endpoint for ops nodes (repeatable)
  --check CMD           Deterministic check for ops nodes (repeatable)
  -h, --help            Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runHybridForeman({
    goal: args.goal!,
    successCriteria: args.successCriteria,
    environments: args.environments,
    provider: args.provider,
    taskId: args.taskId,
    traceRoot: args.traceRoot,
    memoryRoot: args.memoryRoot,
    artifactsRoot: args.artifactsRoot,
    maxRounds: args.maxRounds,
    healthUrls: args.healthUrls,
    checkCommands: args.checkCommands,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
