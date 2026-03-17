import { runSupervisorSurface } from './supervisor-run.js';

interface CliOptions {
  command?: string;
  cwd?: string;
  env: Record<string, string>;
  url?: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  label?: string;
  approvalMode?: 'auto' | 'required' | 'never';
  approve?: boolean;
  traceRoot?: string;
  taskId?: string;
  outputPath?: string;
  markdownPath?: string;
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const result = await runSupervisorSurface({
    command: options.command,
    cwd: options.cwd,
    env: options.env,
    url: options.url,
    method: options.method,
    headers: options.headers,
    body: options.body,
    timeoutMs: options.timeoutMs,
    label: options.label,
    approvalMode: options.approvalMode,
    approve: options.approve,
    traceRoot: options.traceRoot,
    taskId: options.taskId,
    outputPath: options.outputPath,
    markdownPath: options.markdownPath,
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let command: string | undefined;
  let cwd: string | undefined;
  let url: string | undefined;
  let method: string | undefined;
  let body: string | undefined;
  let timeoutMs: number | undefined;
  let label: string | undefined;
  let approvalMode: CliOptions['approvalMode'];
  let approve = false;
  let traceRoot: string | undefined;
  let taskId: string | undefined;
  let outputPath: string | undefined;
  let markdownPath: string | undefined;

  while (args.length > 0) {
    const token = args.shift();
    const next = args[0];
    switch (token) {
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      case '--command':
        command = requireValue(token, args.shift());
        break;
      case '--cwd':
        cwd = requireValue(token, args.shift());
        break;
      case '--env': {
        const pair = requireValue(token, args.shift());
        const [key, ...rest] = pair.split('=');
        env[key ?? ''] = rest.join('=');
        break;
      }
      case '--url':
        url = requireValue(token, args.shift());
        break;
      case '--method':
        method = requireValue(token, args.shift());
        break;
      case '--header': {
        const pair = requireValue(token, args.shift());
        const [key, ...rest] = pair.split('=');
        headers[key ?? ''] = rest.join('=');
        break;
      }
      case '--body':
        body = requireValue(token, args.shift());
        break;
      case '--timeout-ms': {
        const value = Number(requireValue(token, args.shift()));
        if (!Number.isFinite(value)) {
          throw new Error('--timeout-ms must be numeric');
        }
        timeoutMs = value;
        break;
      }
      case '--label':
        label = requireValue(token, args.shift());
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
        if (token?.startsWith('-')) {
          throw new Error(`unknown flag ${token}`);
        }
        if (!command && !url && !next) {
          command = token;
        } else {
          throw new Error(`unexpected argument ${token}`);
        }
    }
  }

  if (!command && !url) {
    throw new Error('either --command or --url is required');
  }
  if (command && url) {
    throw new Error('use either --command or --url, not both');
  }

  return {
    command,
    cwd,
    env,
    url,
    method,
    headers,
    body,
    timeoutMs,
    label,
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
  console.log(`Foreman supervisor surface

Usage:
  npm run supervisor-run -- --command "some-tool --json" [options]
  npm run supervisor-run -- --url https://example/api [options]

Options:
  --command CMD                 Supervisor command that returns supervisor-v1 JSON
  --cwd PATH                    Working directory for command mode
  --env KEY=VALUE               Extra env for command mode (repeatable)
  --url URL                     Supervisor service endpoint that returns supervisor-v1 JSON
  --method METHOD               HTTP method for service mode
  --header KEY=VALUE            HTTP header for service mode (repeatable)
  --body TEXT                   HTTP request body for service mode
  --timeout-ms N                Request or command timeout in milliseconds
  --label TEXT                  Human-readable label
  --approval-mode MODE          auto | required | never
  --approve                     Allow execution when approval would otherwise be required
  --trace-root PATH             Write a Foreman trace for this supervisor run
  --task-id ID                  Explicit trace task id
  --output-path PATH            Write JSON report
  --markdown-path PATH          Write Markdown report
`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
