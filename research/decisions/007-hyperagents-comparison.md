---
# Decision 007: Hyperagents Comparison — Self-Referential Self-Improvement

Date: 2026-03-23
Status: RESEARCH
Origin: Human (Drew) brought the paper, AI (Claude) analyzed

## Context

Meta/FAIR published Hyperagents (arXiv 2603.19461) — DGM-Hyperagents extends the Darwin Gödel Machine framework. The meta-agent can modify ANY code in the repo, including its own code. Key finding: meta-level improvements (persistent memory, performance tracking) transfer across domains and accumulate across runs.

## What Foreman Could Adopt

1. **Self-referential modification**: dispatch sessions that modify Foreman's own service code (in a worktree/sandbox), test, and promote successful modifications
2. **Population-based search**: maintain multiple prompt template variants simultaneously instead of A/B testing one at a time
3. **Multi-domain generalization pressure**: check if improvements transfer across projects before promoting
4. **Docker/sandbox isolation**: required for self-modifying work — Tangle backend provides this

## What Foreman Already Has That Hyperagents Doesn't

1. Operator taste in the loop (human judgment, not just benchmarks)
2. Conversation-driven policy (can redirect mid-run)
3. Session mining (learns from 1,000+ operator sessions, not just own generations)
4. Goal-level operation (arbitrary goals, not predefined benchmarks)

## Key Insight

Hyperagents proves meta-level self-modification works and transfers. Foreman's universal agent shape (Input → Agent → Output → Store → Feed) already makes every pipeline pluggable. The architectural step from "GEPA optimizes prompts" to "Foreman dispatches sessions that modify Foreman itself" is small. The safety requirement: run self-modifications in Tangle sandbox, test there, only promote if all tests pass.

## Future Direction

Gen 5 pursuit: Foreman improves itself. Dispatch to sandbox → modify service code → run tests → if passing, create PR against Foreman repo → operator reviews → merge → service restarts with improvements.
