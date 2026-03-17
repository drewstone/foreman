import { runEngineeringForeman } from './engineering-foreman.js';

interface CliTangleOptions {
  apiKey?: string;
  baseUrl?: string;
  backend?: 'codex' | 'claude-code';
  sessionRoot?: string;
  evidenceRoot?: string;
  gitUrl?: string;
  gitRef?: string;
  gitTokenEnvVar?: string;
  includeGitDiff?: boolean;
}

interface CliArgs {
  repoPath: string;
  goal: string;
  successCriteria: string[];
  checkCommands: string[];
  toolCommands: string[];
  profileRoot?: string;
  profileId?: string;
  promptPolicyRoot?: string;
  promptPolicyMode?: 'active' | 'shadow' | 'explicit';
  promptVariantIds?: Partial<Record<'hardener' | 'implementer' | 'reviewer', string>>;
  maxRounds?: number;
  sandboxMode?: 'local' | 'tangle';
  tangle?: CliTangleOptions;
}

function parseArgs(argv: string[]): CliArgs {
  let repoPath = '';
  let goal = '';
  const successCriteria: string[] = [];
  const checkCommands: string[] = [];
  const toolCommands: string[] = [];
  let profileRoot: string | undefined;
  let profileId: string | undefined;
  let promptPolicyRoot: string | undefined;
  let promptPolicyMode: 'active' | 'shadow' | 'explicit' | undefined;
  const promptVariantIds: Partial<Record<'hardener' | 'implementer' | 'reviewer', string>> = {};
  let maxRounds: number | undefined;
  let sandboxMode: 'local' | 'tangle' | undefined;
  const tangle: CliTangleOptions = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--repo':
        repoPath = next ?? '';
        i += 1;
        break;
      case '--goal':
        goal = next ?? '';
        i += 1;
        break;
      case '--criterion':
        if (next) {
          successCriteria.push(next);
        }
        i += 1;
        break;
      case '--check':
        if (next) {
          checkCommands.push(next);
        }
        i += 1;
        break;
      case '--tool':
        if (next) {
          toolCommands.push(next);
        }
        i += 1;
        break;
      case '--profile-root':
        profileRoot = next;
        i += 1;
        break;
      case '--profile-id':
        profileId = next;
        i += 1;
        break;
      case '--max-rounds':
        maxRounds = next ? Number(next) : undefined;
        i += 1;
        break;
      case '--sandbox-mode':
        sandboxMode = next === 'tangle' ? 'tangle' : next === 'local' ? 'local' : undefined;
        i += 1;
        break;
      case '--tangle-api-key':
        tangle.apiKey = next;
        i += 1;
        break;
      case '--tangle-base-url':
        tangle.baseUrl = next;
        i += 1;
        break;
      case '--tangle-backend':
        tangle.backend = next === 'claude-code' ? 'claude-code' : next === 'codex' ? 'codex' : undefined;
        i += 1;
        break;
      case '--tangle-session-root':
        tangle.sessionRoot = next;
        i += 1;
        break;
      case '--tangle-evidence-root':
        tangle.evidenceRoot = next;
        i += 1;
        break;
      case '--tangle-git-url':
        tangle.gitUrl = next;
        i += 1;
        break;
      case '--tangle-git-ref':
        tangle.gitRef = next;
        i += 1;
        break;
      case '--tangle-git-token-env':
        tangle.gitTokenEnvVar = next;
        i += 1;
        break;
      case '--tangle-no-git-diff':
        tangle.includeGitDiff = false;
        break;
      case '--prompt-policy-root':
        promptPolicyRoot = next;
        i += 1;
        break;
      case '--prompt-policy-mode':
        promptPolicyMode = next === 'shadow'
          ? 'shadow'
          : next === 'explicit'
            ? 'explicit'
            : next === 'active'
              ? 'active'
              : undefined;
        i += 1;
        break;
      case '--prompt-hardener':
        if (next) {
          promptVariantIds.hardener = next;
        }
        i += 1;
        break;
      case '--prompt-implementer':
        if (next) {
          promptVariantIds.implementer = next;
        }
        i += 1;
        break;
      case '--prompt-reviewer':
        if (next) {
          promptVariantIds.reviewer = next;
        }
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

  if (!repoPath || !goal) {
    printHelp();
    throw new Error('--repo and --goal are required');
  }

  return {
    repoPath,
    goal,
    successCriteria,
    checkCommands,
    toolCommands,
    profileRoot,
    profileId,
    promptPolicyRoot,
    promptPolicyMode,
    promptVariantIds,
    maxRounds,
    sandboxMode,
    tangle: Object.keys(tangle).length > 0 ? tangle : undefined,
  };
}

function printHelp(): void {
  console.log(`Foreman engineering runner

Usage:
  npm run engineering -- --repo /path/to/repo --goal "Implement X" [options]

Options:
  --criterion "..."     Add a success criterion (repeatable)
  --check "..."         Add a deterministic check command (repeatable)
  --tool "..."          Add a tool/audit command to run during validation (repeatable)
  --profile-root PATH   Load reusable profiles from this directory
  --profile-id ID       Run under this stored profile if present
  --sandbox-mode MODE   local or tangle
  --tangle-api-key KEY  Override Tangle API key (else TANGLE_API_KEY)
  --tangle-base-url URL Override Tangle base URL
  --tangle-backend ID   codex or claude-code
  --tangle-session-root Persist sandbox sessions here
  --tangle-evidence-root Store downloaded sandbox artifacts here
  --tangle-git-url URL  Repo URL to clone in remote sandbox
  --tangle-git-ref REF  Branch/tag/SHA for remote sandbox
  --tangle-git-token-env VAR
                        Env var name holding git auth token for remote clone
  --tangle-no-git-diff  Skip automatic remote git diff evidence
  --prompt-policy-root  Read/write prompt policy state from this directory
  --prompt-policy-mode  active, shadow, or explicit
  --prompt-hardener ID  Override the hardener prompt variant
  --prompt-implementer ID
  --prompt-reviewer ID
  --max-rounds N        Maximum rounds (default 3)
  -h, --help            Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runEngineeringForeman(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
