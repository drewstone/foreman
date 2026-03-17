import { runGoldenSuite } from './golden-suite.js';

interface CliArgs {
  manifestPath: string;
  traceOutputRoot?: string;
  outputPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let manifestPath = '';
  let traceOutputRoot: string | undefined;
  let outputPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--manifest':
        manifestPath = next ?? '';
        index += 1;
        break;
      case '--trace-output-root':
        traceOutputRoot = next;
        index += 1;
        break;
      case '--output-path':
        outputPath = next;
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

  if (!manifestPath) {
    printHelp();
    throw new Error('--manifest is required');
  }

  return {
    manifestPath,
    traceOutputRoot,
    outputPath,
  };
}

function printHelp(): void {
  console.log(`Foreman golden suite runner

Usage:
  npm run golden-suite -- --manifest examples/golden-suite.json

Options:
  --manifest PATH           Golden suite manifest JSON
  --trace-output-root PATH  Root for replay traces
  --output-path PATH        Write JSON result
  -h, --help                Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runGoldenSuite(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
