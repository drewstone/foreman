# CLAUDE.md

## Purpose

Foreman is an autonomous operating system for the operator. It takes goals in any domain — code, research, marketing, strategy — decomposes them, dispatches work to agent sessions, tracks outcomes, learns taste, and drives everything to completion.

See `VISION.md` for the full vision.

## Architecture

```
Operator ↔ Conversation (Pi/Claude) ↔ Foreman Service ↔ Execution backends
```

**Service** (`service/`): Standalone daemon. SQLite state store, session manager (tmux), event detection, HTTP API. Runs 24/7. Never makes policy decisions.

**Pi Extension** (`pi-package/`): Thin client. 6 tools (portfolio_status, dispatch_skill, check_session, log_outcome, project_context, search_history) + dashboard widget + /foreman command. The conversation IS the policy.

**Skill** (`pi-package/skills/foreman/`): Behavioral instructions that teach Pi how to be an autonomous operator — first-principles thinking, taste learning, skill selection.

**Legacy packages** (`packages/`): Session index, confidence store, cost monitor, CI tools. Infrastructure the service wraps.

## The autoresearch pattern

Everything follows autoresearch: dispatch work (experiment), measure outcome (metric), keep what works, discard what doesn't, log learnings, never stop. Applied at the goal level across all domains.

## What belongs where

**Service (deterministic):** session management, state storage, event detection, cost tracking, API endpoints. No judgment calls.

**Conversation (LLM reasoning):** what to work on, which skill to use, whether to continue or pivot, what the operator would do, whether an outcome is good enough. The operator + LLM in conversation = the policy.

**Skill (behavioral knowledge):** how to think about goals, when to use /evolve vs /pursue, how taste works, the meta-autoresearch loop.

If you're writing `if/else` branches that make judgment calls, stop — that's conversation work for the LLM.

## Goals, not projects

The unit of work is a goal, not a git repo. "Drive phony to SOTA" is a goal. "Run the GTM launch" is a goal. "Write a latex paper from experiment results" is a goal. Goals decompose into tasks dispatched to different backends.

## Taste

Foreman learns operator judgment from approval/rejection signals, goal language, correction patterns, and priority signals. The taste model is injected into conversation context.

## Confidence graduation

Actions earn autonomy through evidence. Per goal, per action type:
- 0.0–0.3: dry-run
- 0.3–0.6: propose and wait
- 0.6–0.8: act and notify
- 0.8–1.0: autonomous

## Execution stance

Never stop. If something fails, diagnose and fix. Keep going until independently verified as complete.

When working in this repo:
- Build the service and its API
- Build the Pi extension as a thin client
- Don't add pre-decided workflows — the conversation decides
- Don't assume git repos — goals span domains
- Keep the autoresearch pattern: dispatch, measure, keep/revert, learn, repeat

## Anti-goals

- Policy decisions in the service (service executes, conversation decides)
- Code-only thinking (goals span all domains)
- Pre-decided workflows disguised as intelligence
- More infrastructure without depth
- Hardcoded strategies where the LLM should reason
