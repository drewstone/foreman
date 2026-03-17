import { runRetrieveTraces } from './retrieve-traces.js';

interface CliArgs {
  query?: string;
  traceRoot?: string;
  taskId?: string;
  limit?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--query':
        args.query = next;
        index += 1;
        break;
      case '--trace-root':
        args.traceRoot = next;
        index += 1;
        break;
      case '--task-id':
        args.taskId = next;
        index += 1;
        break;
      case '--limit':
        args.limit = next ? Number(next) : undefined;
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

  if (!args.query) {
    printHelp();
    throw new Error('--query is required');
  }
  return args;
}

function printHelp(): void {
  console.log(`Foreman retrieve-traces

Usage:
  npm run retrieve-traces -- --query "your search" [options]

Options:
  --trace-root PATH    Filesystem trace root fallback when no shared trace DB is configured
  --task-id ID         Filter to one task id
  --limit N            Maximum results (default 10)
  -h, --help           Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runRetrieveTraces({
    query: args.query!,
    traceRoot: args.traceRoot,
    taskId: args.taskId,
    limit: args.limit,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
