import { runProviderSessionSurface } from './provider-session.js';

interface CliArgs {
  provider: 'codex' | 'claude' | 'browser' | 'opencode' | 'openclaw';
  action: 'list' | 'start' | 'continue' | 'continue-last' | 'fork';
  prompt?: string;
  sessionId?: string;
  cwd?: string;
  timeoutMs?: number;
  model?: string;
  limit?: number;
  binary?: string;
  targetUrl?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let provider: 'codex' | 'claude' | 'browser' | 'opencode' | 'openclaw' = 'claude';
  let action: CliArgs['action'] = 'list';
  let prompt: string | undefined;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let timeoutMs: number | undefined;
  let model: string | undefined;
  let limit: number | undefined;
  let binary: string | undefined;
  let targetUrl: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--provider':
        provider = next === 'codex'
          ? 'codex'
          : next === 'browser'
            ? 'browser'
            : next === 'opencode'
              ? 'opencode'
              : next === 'openclaw'
                ? 'openclaw'
            : 'claude';
        index += 1;
        break;
      case '--action':
        action = next === 'start'
          || next === 'continue'
          || next === 'continue-last'
          || next === 'fork'
          || next === 'list'
          ? next
          : action;
        index += 1;
        break;
      case '--prompt':
        prompt = next;
        index += 1;
        break;
      case '--session-id':
      case '--run-id':
        sessionId = next;
        index += 1;
        break;
      case '--cwd':
        cwd = next;
        index += 1;
        break;
      case '--timeout-ms':
        timeoutMs = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--model':
        model = next;
        index += 1;
        break;
      case '--limit':
        limit = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--binary':
        binary = next;
        index += 1;
        break;
      case '--target-url':
        targetUrl = next;
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

  if ((action === 'start' || action === 'continue-last' || action === 'fork') && !prompt) {
    printHelp();
    throw new Error(`--prompt is required for action ${action}`);
  }

  if (action === 'continue' && provider !== 'browser' && !prompt) {
    printHelp();
    throw new Error(`--prompt is required for action ${action}`);
  }

  if ((action === 'continue' || action === 'fork') && !sessionId) {
    printHelp();
    throw new Error(`--session-id is required for action ${action}`);
  }

  if (provider === 'browser' && action === 'start' && !targetUrl) {
    printHelp();
    throw new Error('--target-url is required for browser start');
  }

  return {
    provider,
    action,
    prompt,
    sessionId,
    cwd,
    timeoutMs,
    model,
    limit,
    binary,
    targetUrl,
  };
}

function printHelp(): void {
  console.log(`Foreman provider session surface

Usage:
  npm run provider-session -- [options]

Options:
  --provider NAME     Provider: claude, codex, browser, opencode, or openclaw (default claude)
  --action NAME       Action: list, start, continue, continue-last, fork
  --prompt TEXT       Prompt to send for start/continue/fork actions
  --session-id ID     Session id, or browser run id for continue/fork
  --run-id ID         Alias for --session-id when using browser runs
  --cwd PATH          Working directory / session cwd filter
  --timeout-ms N      Command timeout in milliseconds
  --model NAME        Override model for the provider
  --limit N           Limit listed sessions
  --binary PATH       Override the session CLI binary, especially for browser runs
  --target-url URL    Browser start URL for provider=browser action=start
  -h, --help          Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runProviderSessionSurface(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
