# Foreman: Executive Summary

## What It Is

Foreman is an autonomous operating system for a solo operator managing work across domains — code, research, marketing, strategy. It takes goals expressed in natural language, decomposes them into dispatchable tasks, spawns Claude Code sessions via tmux with rich prompt composition (6,000+ chars of project context, decision history, operator exemplars), monitors execution, harvests outcomes, and feeds learnings back into future dispatches. The architecture separates policy from execution: a standalone service (3,200+ lines TypeScript, SQLite, 20+ API endpoints) handles state and sessions, while the LLM-in-conversation with the operator makes all judgment calls. Built through 8 pursuit generations in 3 days for ~$50 in API credits.

## What Works

**Dispatch infrastructure is solid.** 71 sessions dispatched across 4 concurrent goals, 91.5% session-level success rate. tmux session management, git worktree isolation, post-completion digest pipeline, and confidence graduation all function. After fixing three critical bugs (idle detection, prompt delivery, session lifecycle), sessions spawn, execute, complete, and get harvested reliably.

**Short, focused tasks succeed.** /verify and /critical-audit achieve 100% actual deliverable rates. /evolve achieves ~70%. The system excels when tasks are scoped, verifiable, and constrained.

**The autoresearch pattern translates.** Applying the dispatch-measure-keep/revert-learn loop at portfolio level — across goals, not just within a single codebase — is architecturally feasible and produces structured decision histories that enable honest retrospection.

## What Does Not Work

**The learning loop shows no measurable effect.** Taste learning, confidence graduation, cross-project transfer, and self-improvement produce zero evidence of improving dispatch quality. 71 dispatches across 4 goals is too sparse for optimization (AxGEPA needs 50+ examples per target).

**Self-improvement fails completely.** 0/18 self-targeting dispatches produced their stated deliverable. 0% PR merge rate. Dominant failure: scope creep — 8/18 sessions made the same watch.sh refactor regardless of assigned task. Without test gates or scope constraints, agents ignore instructions and pursue the most obvious local improvement.

**Activity does not equal achievement.** The harvester conflates "session ran" with "deliverable exists." The 91.5% session success rate drops to ~56% actual deliverable completion when verified manually. This gap — the central finding — means the entire learning signal is noise built on a false success metric.

**Rich prompts don't help on saturated tasks.** Prompt ablation (bare vs. full) shows no difference on coding tasks where Sonnet's capability exceeds task difficulty. "Full" prompts actually performed worse on SWE-bench (4/8 partial vs 7/9 partial for bare), suggesting rich context causes the model to overwork the wrong things.

## What Is Next

1. **Deliverable verification** — each dispatch declares an output path; the harvester checks existence and content. "Success" requires the deliverable, not just activity.
2. **Scope locks** — file/directory allowlists per dispatch. Diffs outside the allowlist are rejected, not auto-merged.
3. **Test gates** — run type checks and tests before/after. Regressions block success marking. Without this, self-improvement is structurally impossible (Hyperagents' key insight).
4. **Lean into analysis** — Foreman's highest-value outputs are analytical (experiment reports, session reflections, portfolio status), not generative code. The product should weight autonomous analysis over unsupervised code generation.
5. **Benchmarks** — complete SWE-bench and TerminalBench runs with verified results to establish a real baseline for prompt composition value on harder tasks and weaker models.
