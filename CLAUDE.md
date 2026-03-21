# CLAUDE.md

## Purpose

This repo builds `Foreman`, an autonomous agent that learns from its operator and acts across their projects.

Foreman = state + policy + actions. The policy function is the product. Everything else is infrastructure.

See `VISION.md` for the full architecture, confidence graduation system, and event-driven design.

## Architecture

```
event → state update → policy (LLM reasoning) → confidence gate → action → outcome → learn
```

**State:** Session index, traces, memory, operator model, experiment results, confidence scores.
**Policy:** LLM call that reasons about what to do given current state. ~200 lines. This is the brain.
**Actions:** Spawn sessions, run experiments, invoke skills, create PRs, send notifications.

The policy function replaces all pre-decided workflows. The agent reasons, it doesn't follow scripts.

## What belongs where

**Deterministic code** handles: file discovery, timestamp filtering, schema validation, trace loading, report formatting, artifact collection, event routing, confidence math.

**LLM reasoning** handles: what to work on next, which skill to invoke, whether to continue or abandon, how to repair a failure, what the operator would do, whether an outcome is good enough.

If you're writing `if/else` branches that make judgment calls, stop — that's policy work for the LLM.

## Confidence graduation

Every action type starts in dry-run mode. Confidence grows from evidence:

- 0.0–0.3: **dry-run** — log what you would do
- 0.3–0.6: **propose** — show operator, wait for approval
- 0.6–0.8: **act-notify** — execute, notify immediately
- 0.8–1.0: **autonomous** — execute silently, report in digest

Per-action-type, per-project. The operator never flips a switch — the system graduates itself.

## Event-driven, not cron-driven

Primary triggers are file watchers and webhooks, not polling. Cron is a fallback for things that genuinely lack push events (CI status).

## What Foreman learns from

- User messages and task goals
- Prior agent sessions and traces
- Experiment results (autoresearch, eval, skill outcomes)
- Recurring operator patterns across projects
- Approval/rejection signals (confidence updates)
- Observed completion behavior

The goal is to model how the operator works, predict what they'd do, and do it better.

## Product boundary

Foreman is a general, publishable product. It must not hardcode one user's machine, one repo, one vendor, or one local workflow into the kernel. Personalization comes from data and profiles, not code.

## Execution stance

Never stop. Never ask "should I continue?" — yes, always. If something fails, diagnose it, fix it, and re-run. Keep going until independently verified as complete.

When working in this repo:

- Prefer building the policy layer and its supporting infrastructure
- Don't add more pre-decided workflows or foreman variants
- Don't add standalone CLIs — add tools the policy agent can invoke
- Keep pushing the next highest-ROI gap
- Treat "what should Foreman do next?" as part of the job

## Anti-goals

- Pre-decided workflows disguised as intelligence
- Keyword-matching heuristics for judgment calls
- Prompt theater without evidence and validation
- More surface area without depth (we have 80+ surface files already)
- Cron jobs where events would work
- Hardcoded strategies where the agent should reason
