import { runJudgeCalibration } from './judge-calibration.js';

interface CliArgs {
  datasetPath: string;
  provider: 'codex' | 'claude';
  providerTimeoutMs?: number;
  outputPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let datasetPath = '';
  let provider: 'codex' | 'claude' = 'claude';
  let providerTimeoutMs: number | undefined;
  let outputPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--dataset':
        datasetPath = next ?? '';
        index += 1;
        break;
      case '--provider':
        provider = next === 'codex' ? 'codex' : 'claude';
        index += 1;
        break;
      case '--provider-timeout-ms':
        providerTimeoutMs = next ? Number(next) : undefined;
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

  if (!datasetPath) {
    printHelp();
    throw new Error('--dataset is required');
  }

  return {
    datasetPath,
    provider,
    providerTimeoutMs,
    outputPath,
  };
}

function printHelp(): void {
  console.log(`Foreman judge calibration

Usage:
  npm run calibrate-judge -- --dataset examples/judge-calibration.json --provider claude

Options:
  --dataset PATH             Judge calibration dataset JSON
  --provider NAME            codex or claude
  --provider-timeout-ms N    Provider timeout in milliseconds
  --output-path PATH         Write JSON result
  -h, --help                 Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runJudgeCalibration(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
