import { runObserveEnvironment } from './environment-observe.js';

interface CliArgs {
  kind?: 'code' | 'document' | 'research' | 'ops' | 'hybrid';
  target?: string;
  targets?: string[];
  healthUrls?: string[];
  checkCommands?: string[];
  verifyGoal?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--kind':
        if (next === 'code' || next === 'document' || next === 'research' || next === 'ops' || next === 'hybrid') {
          args.kind = next;
        }
        index += 1;
        break;
      case '--target':
        args.target = next;
        args.targets = [...(args.targets ?? []), ...(next ? [next] : [])];
        index += 1;
        break;
      case '--health-url':
        args.healthUrls = [...(args.healthUrls ?? []), ...(next ? [next] : [])];
        index += 1;
        break;
      case '--check-command':
        args.checkCommands = [...(args.checkCommands ?? []), ...(next ? [next] : [])];
        index += 1;
        break;
      case '--verify-goal':
        args.verifyGoal = next;
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

  if (!args.kind) {
    printHelp();
    throw new Error('--kind is required');
  }

  return args;
}

function printHelp(): void {
  console.log(`Foreman observe-environment

Usage:
  npm run observe-environment -- --kind KIND [options]

Kinds:
  code | document | research | ops | hybrid

Options:
  --target PATH_OR_URL         Primary target. Repeat for hybrid.
  --health-url URL             Health endpoint for ops environments (repeatable)
  --check-command CMD          Command check for ops environments (repeatable)
  --verify-goal TEXT           Run environment verification for a goal
  -h, --help                   Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runObserveEnvironment({
    ...args,
    kind: args.kind!,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
