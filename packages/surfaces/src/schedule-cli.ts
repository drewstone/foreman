import { runScheduledJobs } from './schedule.js';

function parseArgs(argv: string[]): {
  manifestPath: string;
  jobId?: string;
} {
  let manifestPath = '';
  let jobId: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--manifest':
        manifestPath = next ?? '';
        i += 1;
        break;
      case '--job-id':
        jobId = next;
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

  if (!manifestPath) {
    printHelp();
    throw new Error('--manifest is required');
  }

  return {
    manifestPath,
    jobId,
  };
}

function printHelp(): void {
  console.log(`Foreman schedule runner

Usage:
  npm run run-schedule -- --manifest /path/to/foreman-schedule.json [options]

Options:
  --job-id ID    Run one job from the manifest
  -h, --help     Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runScheduledJobs(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
