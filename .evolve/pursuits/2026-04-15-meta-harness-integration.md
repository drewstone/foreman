# Pursuit: Meta-Harness Native Integration
Generation: 10
Status: building
Started: 2026-04-15

## Thesis

Meta-harness code evolution integrates into Foreman as a native `runTaskLoop` provider + `OptimizationSurface` implementation, reusing 100% of existing infrastructure. Zero new infrastructure — session manager (tmux/tangle backends), TraceStore (filesystem/postgres), optimization surface registry, worktree creation. The standalone meta-harness.ts/parallel-dispatch.ts/trace-injector.ts/meta-harness-cli.ts are deleted.

## Moonshot considered

Replace all of Foreman's optimization (prompt lab, surface experiments, GEPA) with meta-harness as the single optimization engine — code AND prompts optimized via the same CC proposer + Pareto frontier + hypothesis discipline loop.

**Half-adopted.** The Pareto frontier and hypothesis contract extend the existing surface model. But GEPA still handles prompt-level optimization (it's good at it, and meta-harness CC proposers are overkill for prompt tuning). Code-level evolution is the new capability.

## System Audit — what exists and I must reuse

| Infrastructure | File | How meta-harness uses it |
|---|---|---|
| Session management (tmux + tangle backends) | `service/lib/session-manager.ts` | `spawnSession({ backend: 'tangle' or 'tmux', ... })` for proposers |
| Worktree creation | `service/lib/prompt-composer.ts:createWorktree()` | Isolate each parallel proposer |
| TraceStore (filesystem + postgres) | `packages/tracing/src/index.ts` | Store + read eval traces. Proposer reads TraceStore filesystem root directly |
| OptimizationSurface | `service/lib/optimization-surface.ts` | CodeSurface implements this interface |
| runTaskLoop | `packages/core/src/runtime.ts` | Each iteration = round, each proposer = track |
| EvaluationPipeline | `packages/evals/src/index.ts` | Benchmark runner for variants |
| Claude runner | `service/lib/claude-runner.ts` | `callClaude()` for proposer sessions |
| Harvester | `service/lib/harvester.ts` | Harvest outcomes from proposer sessions |
| State (SQLite, log, emit) | `service/lib/state.ts` | All state operations |

## Changes (6, all coupled)

### 1. DELETE duplicated service files

Remove: `service/lib/meta-harness.ts`, `service/lib/parallel-dispatch.ts`, `service/lib/trace-injector.ts`, `service/lib/meta-harness-cli.ts`

### 2. REWRITE code-surface.ts → implements OptimizationSurface

CodeSurface implements the existing interface. Adds Pareto frontier as an extension (not replacing binary experiments — both coexist). Uses TraceStore for trace access, not a custom injector.

### 3. ADD meta-harness loop as runTaskLoop provider

`service/lib/code-evolution.ts` — a function that returns `LoopOptions` for `runTaskLoop`. Each round = one iteration. Each track = one parallel proposer dispatched via `spawnSession`. Validation = hypothesis check + compile. The existing loop handles concurrency, abort, trace persistence.

### 4. ADD API endpoint POST /api/evolve-code

Accepts: `{ repo, harness, eval, iterations, parallelism, dimensions }`. Creates a goal, dispatches the code-evolution loop. Returns the frontier when done.

### 5. ADD meta-harness-propose to model routing

`selectModel()` in session-manager.ts returns 'opus' for meta-harness-propose skill.

### 6. KEEP pure modules

pareto.ts, hypothesis.ts, SKILL.md — no changes needed.

## Build Status

| # | Change | Status | Files |
|---|---|---|---|
| 1 | Delete duplicates | not started | -4 files |
| 2 | Rewrite code-surface | not started | packages/optimizer/src/code-surface.ts |
| 3 | Code evolution loop | not started | service/lib/code-evolution.ts |
| 4 | API endpoint | not started | service/index.ts |
| 5 | Model routing | not started | service/lib/session-manager.ts |
| 6 | Keep pure modules | done | pareto.ts, hypothesis.ts, SKILL.md |
