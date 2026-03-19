/**
 * Foreman one-shot: dispatch worker + judges until 9.5+/10.
 *
 * Usage:
 *   node --import tsx packages/surfaces/src/one-shot.ts \
 *     --repo /path/to/repo \
 *     --goal "Build production-ready X" \
 *     --threshold 9.5
 *
 * Flow:
 *   1. Harden the goal (infer checks, criteria, context)
 *   2. Spawn worker session (claude -p) to implement
 *   3. Run deterministic checks (cargo test, clippy, fmt)
 *   4. Spawn judge sessions in parallel (domain-specific audits)
 *   5. If avg judge score < threshold → spawn repair session with findings
 *   6. Go to 3
 *   7. If avg judge score ≥ threshold → push, open PR, done
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface JudgeResult {
  name: string;
  score: number;
  findings: string[];
  raw: string;
}

interface OneShotResult {
  status: 'complete' | 'max_iterations' | 'failed';
  iterations: number;
  finalScores: Record<string, number>;
  avgScore: number;
  allFindings: string[];
}

async function claudeRun(prompt: string, cwd: string, timeoutMs = 15 * 60 * 1000): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await execFileAsync('claude', [
      '--dangerously-skip-permissions', '-p', '--output-format', 'json', prompt,
    ], { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    return { stdout, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; code?: number };
    return { stdout: err.stdout ?? '', exitCode: typeof err.code === 'number' ? err.code : 1 };
  }
}

function extractResult(jsonOutput: string): string {
  try {
    const parsed = JSON.parse(jsonOutput);
    return parsed?.result ?? jsonOutput;
  } catch {
    return jsonOutput;
  }
}

async function runChecks(repoPath: string, commands: string[]): Promise<{ allPass: boolean; results: Array<{ cmd: string; pass: boolean; output: string }> }> {
  const results: Array<{ cmd: string; pass: boolean; output: string }> = [];
  for (const cmd of commands) {
    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-lc', cmd], {
        cwd: repoPath, timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024,
      });
      results.push({ cmd, pass: true, output: (stdout + stderr).slice(-500) });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      results.push({ cmd, pass: false, output: ((err.stdout ?? '') + (err.stderr ?? '')).slice(-500) });
    }
  }
  return { allPass: results.every((r) => r.pass), results };
}

async function runJudge(name: string, prompt: string, cwd: string): Promise<JudgeResult> {
  const log = (msg: string) => process.stderr.write(`  [judge:${name}] ${msg}\n`);
  log('dispatching...');
  const { stdout } = await claudeRun(prompt, cwd, 3 * 60 * 1000);
  const result = extractResult(stdout);

  // Extract score and findings from JSON in the response
  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { score?: number; rating?: number; findings?: string[] };
      const score = parsed.score ?? parsed.rating ?? 5;
      const findings = parsed.findings ?? [];
      log(`score: ${score}/10, findings: ${findings.length}`);
      return { name, score, findings, raw: result.slice(0, 1000) };
    } catch { /* fall through */ }
  }

  // Try to extract numeric score from text
  const scoreMatch = result.match(/(\d+(?:\.\d+)?)\s*\/\s*10/);
  const score = scoreMatch ? parseFloat(scoreMatch[1]!) : 5;
  log(`score: ${score}/10 (extracted from text)`);
  return { name, score, findings: [], raw: result.slice(0, 1000) };
}

const JUDGE_PROMPTS: Record<string, (goal: string, checkResults: string) => string> = {
  billing_security: (goal, checkResults) => `You are auditing a vLLM inference operator for BILLING AND PAYMENT SECURITY. The goal was: "${goal}"

Deterministic check results:
${checkResults}

Read the billing.rs and server.rs files. Check:
- Is the charge amount based on actual token usage, not pre-auth amount?
- Is the spend auth signature verified against the credit account?
- Are gas costs bounded?
- Are billing failures retried or logged?
- Is max_spend_per_request enforced?

Return JSON: {"score": N, "findings": ["issue1", "issue2"]}
Score 1-10 where 10 = no billing bugs, ready for real money.`,

  reliability: (goal, checkResults) => `You are auditing a vLLM inference operator for PRODUCTION RELIABILITY. The goal was: "${goal}"

Deterministic check results:
${checkResults}

Read vllm.rs, lib.rs, server.rs. Check:
- Does the vLLM subprocess drain stdout/stderr (or will pipes deadlock)?
- Is there crash recovery if vLLM dies?
- Are there .expect()/.unwrap() calls that can panic in production paths?
- Are request timeouts implemented?
- Is the semaphore/concurrency limiting correct?

Return JSON: {"score": N, "findings": ["issue1", "issue2"]}
Score 1-10 where 10 = will survive a week of production traffic without operator intervention.`,

  code_quality: (goal, checkResults) => `You are a principal engineer reviewing code quality. The goal was: "${goal}"

Deterministic check results:
${checkResults}

Read all operator/src/*.rs files. Check:
- Is the architecture clean and idiomatic Rust?
- Are error types well-defined?
- Is there dead code, duplicated logic, or TODO comments?
- Are the tests meaningful (not just "it compiles")?
- Does the streaming implementation handle edge cases?

Return JSON: {"score": N, "findings": ["issue1", "issue2"]}
Score 1-10 where 10 = a senior Rust engineer would approve this without comments.`,
};

async function oneShot(options: {
  repoPath: string;
  goal: string;
  threshold: number;
  maxIterations: number;
  checkCommands: string[];
}): Promise<OneShotResult> {
  const { repoPath, goal, threshold, maxIterations, checkCommands } = options;
  const traceDir = join(repoPath, '.foreman', 'one-shot');
  await mkdir(traceDir, { recursive: true });

  let allFindings: string[] = [];
  let prevAvg = 0;
  const prevScores: number[] = [];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const log = (msg: string) => process.stderr.write(`[iter ${iteration}/${maxIterations}] ${msg}\n`);

    // Step 1: Implement (or repair)
    const topFindings = allFindings.slice(0, 10);
    const workerPrompt = iteration === 1
      ? `${goal}\n\nAfter ALL changes, run: ${checkCommands.join(' && ')}`
      : `The previous implementation was reviewed by independent judges and scored ${prevAvg.toFixed(1)}/${threshold}/10. Fix the top findings below. Focus on the highest severity first.\n\n${topFindings.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nAfter ALL changes, run: ${checkCommands.join(' && ')}`;

    log(`dispatching worker: ${workerPrompt.slice(0, 80)}...`);
    const worker = await claudeRun(workerPrompt, repoPath);
    log(`worker completed (exit ${worker.exitCode})`);

    // Step 2: Run deterministic checks
    log('running checks...');
    const checks = await runChecks(repoPath, checkCommands);
    const checkSummary = checks.results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}: ${r.cmd}`).join('\n');
    log(`checks: ${checks.results.filter((r) => r.pass).length}/${checks.results.length} pass`);

    if (!checks.allPass) {
      log('checks failed — will retry with findings');
      allFindings = checks.results.filter((r) => !r.pass).map((r) => `Check failed: ${r.cmd}\n${r.output}`);
      continue;
    }

    // Step 3: Dispatch judges in parallel
    log('dispatching judges...');
    const judgeResults = await Promise.all(
      Object.entries(JUDGE_PROMPTS).map(([name, promptFn]) =>
        runJudge(name, promptFn(goal, checkSummary), repoPath),
      ),
    );

    const scores: Record<string, number> = {};
    allFindings = [];
    for (const judge of judgeResults) {
      scores[judge.name] = judge.score;
      allFindings.push(...judge.findings.map((f) => `[${judge.name}] ${f}`));
    }

    const avgScore = Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length;
    prevAvg = avgScore;
    log(`scores: ${Object.entries(scores).map(([k, v]) => `${k}=${v}`).join(', ')} | avg=${avgScore.toFixed(1)}`);

    // Save iteration trace
    await writeFile(join(traceDir, `iteration-${iteration}.json`), JSON.stringify({
      iteration,
      workerExitCode: worker.exitCode,
      checks: checks.results.map((r) => ({ cmd: r.cmd, pass: r.pass })),
      judges: judgeResults.map((j) => ({ name: j.name, score: j.score, findings: j.findings })),
      avgScore,
      threshold,
    }, null, 2) + '\n', 'utf8');

    // Step 4: Check threshold
    if (avgScore >= threshold) {
      log(`🏁 COMPLETE — avg score ${avgScore.toFixed(1)} ≥ ${threshold}`);
      return { status: 'complete', iterations: iteration, finalScores: scores, avgScore, allFindings: [] };
    }

    // Stall detection: if score didn't improve from last judged iteration, stop
    if (iteration > 2 && prevScores.length >= 2) {
      const last2 = prevScores.slice(-2);
      if (last2.every((s) => Math.abs(s - avgScore) < 0.5)) {
        log(`stalled — score hasn't improved in 2 cycles (${last2.map((s) => s.toFixed(1)).join(', ')}, ${avgScore.toFixed(1)})`);
        return { status: 'max_iterations', iterations: iteration, finalScores: scores, avgScore, allFindings };
      }
    }
    prevScores.push(avgScore);

    log(`avg ${avgScore.toFixed(1)} < ${threshold} — repairing with ${allFindings.length} findings (top 10 sent to worker)`);
  }

  return { status: 'max_iterations', iterations: maxIterations, finalScores: {}, avgScore: prevAvg, allFindings };
}

// ── CLI ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let repoPath = '';
  let goal = '';
  let threshold = 9.5;
  let maxIterations = 20;
  const checkCommands: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--repo': repoPath = argv[++i] ?? ''; break;
      case '--goal': goal = argv[++i] ?? ''; break;
      case '--threshold': threshold = parseFloat(argv[++i] ?? '9.5'); break;
      case '--max-iterations': maxIterations = parseInt(argv[++i] ?? '5', 10); break;
      case '--check': checkCommands.push(argv[++i] ?? ''); break;
    }
  }

  if (!repoPath || !goal) {
    console.error('Usage: one-shot --repo PATH --goal "..." [--threshold 9.5] [--max-iterations 5] [--check "cmd"]');
    process.exit(1);
  }

  // Auto-discover checks if none provided
  if (checkCommands.length === 0) {
    const abs = resolve(repoPath);
    try { await readFile(join(abs, 'Cargo.toml')); checkCommands.push(`cd ${abs} && cargo fmt --check`, `cd ${abs} && cargo clippy --workspace -- -D warnings`, `cd ${abs} && cargo test --workspace`); } catch {}
    try { const pkg = JSON.parse(await readFile(join(abs, 'package.json'), 'utf8')); if (pkg.scripts?.test) checkCommands.push(`cd ${abs} && npm test`); } catch {}
  }

  process.stderr.write(`Foreman one-shot\n  Repo: ${repoPath}\n  Goal: ${goal.slice(0, 100)}\n  Threshold: ${threshold}/10\n  Max iterations: ${maxIterations}\n  Checks: ${checkCommands.length}\n\n`);

  const result = await oneShot({ repoPath: resolve(repoPath), goal, threshold, maxIterations, checkCommands });

  console.log(JSON.stringify(result, null, 2));

  if (result.status === 'complete') {
    process.stderr.write(`\n✅ Complete in ${result.iterations} iteration(s). Avg score: ${result.avgScore.toFixed(1)}/10\n`);
  } else {
    process.stderr.write(`\n❌ ${result.status} after ${result.iterations} iteration(s)\n`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
