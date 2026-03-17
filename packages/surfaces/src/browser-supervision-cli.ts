import { runBrowserSupervision } from './browser-supervision.js';

interface CliArgs {
  cwd?: string;
  profileId?: string;
  userId?: string;
  profileRoot?: string;
  memoryRoot?: string;
  limit?: number;
  activeWindowMinutes?: number;
  staleAfterHours?: number;
  outputPath?: string;
  markdownPath?: string;
  continueTopRun?: boolean;
  forkTopRun?: boolean;
  goal?: string;
  approve?: boolean;
  traceRoot?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--cwd':
        args.cwd = next;
        index += 1;
        break;
      case '--profile-id':
        args.profileId = next;
        index += 1;
        break;
      case '--user-id':
        args.userId = next;
        index += 1;
        break;
      case '--profile-root':
        args.profileRoot = next;
        index += 1;
        break;
      case '--memory-root':
        args.memoryRoot = next;
        index += 1;
        break;
      case '--limit':
        args.limit = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--active-window-minutes':
        args.activeWindowMinutes = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--stale-after-hours':
        args.staleAfterHours = next ? Number(next) : undefined;
        index += 1;
        break;
      case '--output-path':
        args.outputPath = next;
        index += 1;
        break;
      case '--markdown-path':
        args.markdownPath = next;
        index += 1;
        break;
      case '--continue-top-run':
        args.continueTopRun = true;
        break;
      case '--fork-top-run':
        args.forkTopRun = true;
        break;
      case '--goal':
        args.goal = next;
        index += 1;
        break;
      case '--approve':
        args.approve = true;
        break;
      case '--trace-root':
        args.traceRoot = next;
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
  return args;
}

function printHelp(): void {
  console.log(`Foreman browser supervision

Usage:
  npm run supervise-browser -- --cwd ~/code/some-app [options]

Options:
  --cwd PATH                   Browser project / run registry root
  --profile-id ID              Optional profile id for memory-aware ranking
  --user-id ID                 Optional user id for memory-aware ranking
  --profile-root PATH          Profile store root
  --memory-root PATH           Memory store root
  --limit N                    Max browser runs to inspect
  --active-window-minutes N    Override active window policy
  --stale-after-hours N        Override stale threshold policy
  --continue-top-run           Continue the top resumable browser run
  --fork-top-run               Fork the top resumable browser run
  --goal TEXT                  Optional override goal for continue/fork
  --approve                    Approve execution when continuation would otherwise gate
  --trace-root PATH            Write trace for executed continuation/fork
  --output-path PATH           Write JSON report
  --markdown-path PATH         Write Markdown report
  -h, --help                   Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runBrowserSupervision(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
