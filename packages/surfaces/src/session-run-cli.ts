import { runSessionSurface } from './session-run.js';

interface CliOptions {
  provider: 'codex' | 'claude' | 'browser' | 'opencode' | 'openclaw' | 'auto';
  action: 'start' | 'continue' | 'continue-last' | 'fork';
  prompt?: string;
  sessionId?: string;
  cwd?: string;
  timeoutMs?: number;
  targetUrl?: string;
  profileId?: string;
  userId?: string;
  profileRoot?: string;
  memoryRoot?: string;
  approvalMode?: 'auto' | 'required' | 'never';
  approve?: boolean;
  traceRoot?: string;
  taskId?: string;
  outputPath?: string;
  markdownPath?: string;
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const result = await runSessionSurface(options);
  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  let provider: CliOptions['provider'] = 'auto';
  let action: CliOptions['action'] = 'continue-last';
  let prompt: string | undefined;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let timeoutMs: number | undefined;
  let targetUrl: string | undefined;
  let profileId: string | undefined;
  let userId: string | undefined;
  let profileRoot: string | undefined;
  let memoryRoot: string | undefined;
  let approvalMode: CliOptions['approvalMode'];
  let approve = false;
  let traceRoot: string | undefined;
  let taskId: string | undefined;
  let outputPath: string | undefined;
  let markdownPath: string | undefined;

  while (args.length > 0) {
    const token = args.shift();
    switch (token) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--provider':
        provider = requireValue(token, args.shift()) as CliOptions['provider'];
        break;
      case '--action':
        action = requireValue(token, args.shift()) as CliOptions['action'];
        break;
      case '--prompt':
        prompt = requireValue(token, args.shift());
        break;
      case '--session-id':
      case '--run-id':
        sessionId = requireValue(token, args.shift());
        break;
      case '--cwd':
        cwd = requireValue(token, args.shift());
        break;
      case '--timeout-ms': {
        const value = Number(requireValue(token, args.shift()));
        if (!Number.isFinite(value)) {
          throw new Error('--timeout-ms must be numeric');
        }
        timeoutMs = value;
        break;
      }
      case '--target-url':
        targetUrl = requireValue(token, args.shift());
        break;
      case '--profile-id':
        profileId = requireValue(token, args.shift());
        break;
      case '--user-id':
        userId = requireValue(token, args.shift());
        break;
      case '--profile-root':
        profileRoot = requireValue(token, args.shift());
        break;
      case '--memory-root':
        memoryRoot = requireValue(token, args.shift());
        break;
      case '--approval-mode':
        approvalMode = requireValue(token, args.shift()) as CliOptions['approvalMode'];
        break;
      case '--approve':
        approve = true;
        break;
      case '--trace-root':
        traceRoot = requireValue(token, args.shift());
        break;
      case '--task-id':
        taskId = requireValue(token, args.shift());
        break;
      case '--output-path':
        outputPath = requireValue(token, args.shift());
        break;
      case '--markdown-path':
        markdownPath = requireValue(token, args.shift());
        break;
      default:
        throw new Error(`unknown flag ${token}`);
    }
  }

  return {
    provider,
    action,
    prompt,
    sessionId,
    cwd,
    timeoutMs,
    targetUrl,
    profileId,
    userId,
    profileRoot,
    memoryRoot,
    approvalMode,
    approve,
    traceRoot,
    taskId,
    outputPath,
    markdownPath,
  };
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Foreman session run

Usage:
  npm run session-run -- --provider auto --action continue --session-id SESSION --prompt "Continue the work"

Options:
  --provider NAME               auto | claude | codex | browser | opencode | openclaw
  --action NAME                 start | continue | continue-last | fork
  --prompt TEXT                 Prompt or continuation instruction
  --session-id ID               Session id or browser run id
  --run-id ID                   Alias for --session-id
  --cwd PATH                    Working directory
  --timeout-ms N                Timeout in milliseconds
  --target-url URL              Required for browser start
  --profile-id ID               Profile to use for adaptive provider selection
  --user-id ID                  User memory to use for adaptive provider selection
  --profile-root PATH           Profile store root for adaptive provider selection
  --memory-root PATH            Memory store root for adaptive provider selection
  --approval-mode MODE          auto | required | never
  --approve                     Allow execution when approval would otherwise be required
  --trace-root PATH             Write a Foreman trace for the session run
  --task-id ID                  Explicit task id for tracing
  --output-path PATH            Write JSON report
  --markdown-path PATH          Write Markdown report
`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
