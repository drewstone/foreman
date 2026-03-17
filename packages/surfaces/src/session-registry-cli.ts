import { runSessionRegistry } from './session-registry.js';

interface CliArgs {
  providers?: Array<'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw'>;
  cwd?: string;
  limitPerProvider?: number;
  maxItems?: number;
  activeWindowMinutes?: number;
  staleAfterHours?: number;
}

function parseArgs(argv: string[]): CliArgs {
  let providers: Array<'claude' | 'codex' | 'browser' | 'opencode' | 'openclaw'> | undefined;
  let cwd: string | undefined;
  let limitPerProvider: number | undefined;
  let maxItems: number | undefined;
  let activeWindowMinutes: number | undefined;
  let staleAfterHours: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--provider':
        if (next === 'claude' || next === 'codex' || next === 'browser' || next === 'opencode' || next === 'openclaw') {
          providers = [...(providers ?? []), next];
        }
        index += 1;
        break;
      case '--cwd':
        cwd = next;
        index += 1;
        break;
      case '--limit-per-provider':
        limitPerProvider = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--max-items':
        maxItems = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--active-window-minutes':
        activeWindowMinutes = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--stale-after-hours':
        staleAfterHours = next ? Number(next) : undefined;
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

  return {
    providers,
    cwd,
    limitPerProvider,
    maxItems,
    activeWindowMinutes,
    staleAfterHours,
  };
}

function printHelp(): void {
  console.log(`Foreman session registry

Usage:
  npm run session-registry -- [options]

Options:
  --provider NAME              Provider to include: claude, codex, browser, opencode, or openclaw (repeatable)
  --cwd PATH                   Filter sessions to this working directory when supported
  --limit-per-provider N       Limit recent sessions loaded from each provider
  --max-items N                Limit final registry items returned
  --active-window-minutes N    Threshold for classifying a session as human-active
  --stale-after-hours N        Threshold for classifying a session as stale
  -h, --help                   Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runSessionRegistry(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
