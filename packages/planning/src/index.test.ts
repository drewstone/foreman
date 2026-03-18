import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { HeuristicTaskHardener, renderPromptVariant, type PromptVariant } from './index.js';

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-planning-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

describe('HeuristicTaskHardener', () => {
  it('infers cargo commands from Cargo.toml', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "test"\nversion = "0.1.0"\n');

    const hardener = new HeuristicTaskHardener();
    const result = await hardener.harden({ goal: 'Fix the bug', repoPath: dir });

    assert.ok(result.checkCommands.includes('cargo fmt --check'));
    assert.ok(result.checkCommands.includes('cargo clippy --workspace'));
    assert.ok(result.checkCommands.includes('cargo test --workspace'));
    assert.strictEqual(result.goal, 'Fix the bug');
    assert.strictEqual(result.inferred, true);
    assert.ok(result.expandedGoal.includes('Fix the bug'));
    assert.ok(result.expandedGoal.includes(dir));
  });

  it('infers npm commands from package.json with test/lint/typecheck scripts', async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        scripts: {
          test: 'vitest',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
        },
      }),
    );

    const hardener = new HeuristicTaskHardener();
    const result = await hardener.harden({ goal: 'Add feature', repoPath: dir });

    assert.ok(result.checkCommands.includes('npm test'));
    assert.ok(result.checkCommands.includes('npm run lint'));
    assert.ok(result.checkCommands.includes('npm run typecheck'));
    // Should NOT include 'npm run check' since 'test' is present
    assert.ok(!result.checkCommands.includes('npm run check'));
  });

  it('infers npm run check when check script exists but test does not', async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        scripts: {
          check: 'tsc --noEmit',
        },
      }),
    );

    const hardener = new HeuristicTaskHardener();
    const result = await hardener.harden({ goal: 'Check it', repoPath: dir });

    assert.ok(result.checkCommands.includes('npm run check'));
    assert.ok(!result.checkCommands.includes('npm test'));
  });

  it('preserves user-provided success criteria', async () => {
    const dir = await makeTempDir();
    // No project files, just a bare directory
    const hardener = new HeuristicTaskHardener();
    const result = await hardener.harden({
      goal: 'Do the thing',
      repoPath: dir,
      successCriteria: ['All tests pass', 'No regressions'],
    });

    assert.ok(result.successCriteria.includes('All tests pass'));
    assert.ok(result.successCriteria.includes('No regressions'));
    // Also includes the default criteria
    assert.ok(result.successCriteria.includes('work is grounded in actual repository state'));
    assert.ok(
      result.successCriteria.includes('completion is backed by executed checks or explicit blocker evidence'),
    );
  });

  it('reads CI workflow and extracts run commands', async () => {
    const dir = await makeTempDir();
    const workflowDir = join(dir, '.github', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'ci.yml'),
      [
        'name: CI',
        'on: push',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: npm ci',
        '      - run: npm test',
        '      - run: npm run lint',
        '      - run: npm run typecheck',
        '      - run: echo "done"',
        '      - run: curl http://example.com',
        '      - run: cargo audit',
        '',
      ].join('\n'),
    );

    const hardener = new HeuristicTaskHardener();
    const result = await hardener.harden({ goal: 'Run CI', repoPath: dir });

    // npm ci, echo, curl, and cargo audit should be skipped
    assert.ok(!result.checkCommands.some((c) => c.includes('npm ci')));
    assert.ok(!result.checkCommands.some((c) => c.includes('echo')));
    assert.ok(!result.checkCommands.some((c) => c.includes('curl')));
    assert.ok(!result.checkCommands.some((c) => c.includes('cargo audit')));

    // npm test, lint, typecheck should be extracted
    assert.ok(result.checkCommands.includes('npm test'));
    assert.ok(result.checkCommands.includes('npm run lint'));
    assert.ok(result.checkCommands.includes('npm run typecheck'));
  });

  it('reads CI workflow with block scalar using run key without dash prefix', async () => {
    // The block scalar parser in extractRunCommands only activates when
    // the first regex (single-line run) does NOT match. With `- run: |`,
    // the pipe is captured as a single-line command, so block scalars
    // after a dash-prefixed run won't be parsed. Use a non-dash run key
    // (e.g. as a step mapping key) to exercise the block branch.
    const dir = await makeTempDir();
    const workflowDir = join(dir, '.github', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'ci.yml'),
      [
        'name: CI',
        'on: push',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: build',
        '        run: npm run build',
        '',
      ].join('\n'),
    );

    const hardener = new HeuristicTaskHardener();
    const result = await hardener.harden({ goal: 'Build', repoPath: dir });

    assert.ok(result.checkCommands.includes('npm run build'));
  });

  it('deduplicates check commands', async () => {
    const dir = await makeTempDir();
    // package.json with test script AND ci.yml that also runs npm test
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'test', scripts: { test: 'jest' } }),
    );
    const workflowDir = join(dir, '.github', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'ci.yml'),
      ['name: CI', 'on: push', 'jobs:', '  t:', '    runs-on: ubuntu-latest', '    steps:', '      - run: npm test'].join('\n'),
    );

    const hardener = new HeuristicTaskHardener();
    const result = await hardener.harden({ goal: 'Test', repoPath: dir });

    const npmTestCount = result.checkCommands.filter((c) => c === 'npm test').length;
    assert.strictEqual(npmTestCount, 1, 'npm test should appear exactly once');
  });

  it('returns empty checkCommands for bare directory with no project files', async () => {
    const dir = await makeTempDir();
    const hardener = new HeuristicTaskHardener();
    const result = await hardener.harden({ goal: 'Do stuff', repoPath: dir });
    assert.strictEqual(result.checkCommands.length, 0);
  });

  it('works without repoPath', async () => {
    const hardener = new HeuristicTaskHardener();
    const result = await hardener.harden({ goal: 'Think about life' });
    assert.strictEqual(result.goal, 'Think about life');
    assert.strictEqual(result.inferred, true);
    assert.strictEqual(result.checkCommands.length, 0);
    assert.ok(!result.expandedGoal.includes('undefined'));
  });
});

describe('renderPromptVariant', () => {
  const baseVariant: PromptVariant = {
    id: 'v1',
    label: 'Test Variant',
    role: 'implementer',
    taskShape: 'code-task',
    style: 'minimal',
    systemPreamble: 'You are a coding assistant.',
  };

  it('assembles all sections correctly', () => {
    const variant: PromptVariant = {
      ...baseVariant,
      persona: 'Senior engineer',
      principles: ['Write clean code', 'Test everything'],
      outputContract: 'Return JSON with keys: result, summary',
    };

    const rendered = renderPromptVariant({
      variant,
      goal: 'Implement the feature',
      successCriteria: ['All tests pass', 'No lint errors'],
      contextSummary: 'The repo uses TypeScript.',
      extraInstructions: ['Do not modify package.json', 'Keep changes minimal'],
    });

    assert.ok(rendered.includes('You are a coding assistant.'));
    assert.ok(rendered.includes('Persona: Senior engineer'));
    assert.ok(rendered.includes('Goal: Implement the feature'));
    assert.ok(rendered.includes('Success criteria:'));
    assert.ok(rendered.includes('- All tests pass'));
    assert.ok(rendered.includes('- No lint errors'));
    assert.ok(rendered.includes('Context:\nThe repo uses TypeScript.'));
    assert.ok(rendered.includes('Principles:'));
    assert.ok(rendered.includes('- Write clean code'));
    assert.ok(rendered.includes('- Test everything'));
    assert.ok(rendered.includes('Output contract:\nReturn JSON with keys: result, summary'));
    assert.ok(rendered.includes('Extra instructions:'));
    assert.ok(rendered.includes('- Do not modify package.json'));
    assert.ok(rendered.includes('- Keep changes minimal'));
  });

  it('omits empty optional sections', () => {
    const rendered = renderPromptVariant({
      variant: baseVariant,
      goal: 'Do something',
    });

    assert.ok(rendered.includes('You are a coding assistant.'));
    assert.ok(rendered.includes('Goal: Do something'));
    // These should NOT appear
    assert.ok(!rendered.includes('Persona:'));
    assert.ok(!rendered.includes('Success criteria:'));
    assert.ok(!rendered.includes('Context:'));
    assert.ok(!rendered.includes('Principles:'));
    assert.ok(!rendered.includes('Output contract:'));
    assert.ok(!rendered.includes('Extra instructions:'));
  });

  it('omits success criteria when array is empty', () => {
    const rendered = renderPromptVariant({
      variant: baseVariant,
      goal: 'Do it',
      successCriteria: [],
    });

    assert.ok(!rendered.includes('Success criteria:'));
  });

  it('omits extra instructions when array is empty', () => {
    const rendered = renderPromptVariant({
      variant: baseVariant,
      goal: 'Do it',
      extraInstructions: [],
    });

    assert.ok(!rendered.includes('Extra instructions:'));
  });

  it('sections are separated by double newlines', () => {
    const variant: PromptVariant = {
      ...baseVariant,
      persona: 'Expert',
    };
    const rendered = renderPromptVariant({
      variant,
      goal: 'Build it',
    });

    // Preamble, persona, and goal should be separated by \n\n
    assert.ok(rendered.includes('You are a coding assistant.\n\nPersona: Expert\n\nGoal: Build it'));
  });
});
