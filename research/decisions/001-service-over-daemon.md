# Decision 001: Standalone Service over Daemon Architecture

Date: 2026-03-22
Status: ACCEPTED
Origin: Human (Drew) + AI (Claude) conversation

## Context

The original Foreman was a daemon (`foreman-daemon.ts`) that polled every 60 seconds, called an LLM with a state snapshot, and asked "what should I do?" Over 1,857 decisions in a 24-hour proof run, 98.4% of decisions were "do nothing." When it did act, it sent generic prompts like "make this real" that produced low-quality results.

## Decision

Replace the daemon with a standalone HTTP service that manages state and sessions but NEVER makes policy decisions. The conversation between the operator and an LLM (via Pi extension, Slack, or any client) IS the policy function.

## Rationale

The daemon failed because:
1. Cold LLM calls with state snapshots lack taste and context
2. No feedback loop — outcomes weren't tracked or learned from
3. Generic prompts produce generic results
4. The operator was removed from the loop

The conversation model works because:
1. The operator provides taste, priority, and direction in real-time
2. The LLM in conversation has full context of what's been discussed
3. Rich prompts can be composed from project state + past decisions + learned patterns
4. The operator can redirect instantly when something is wrong

## Alternatives Considered

1. **Fix the daemon's policy function** — rejected because the fundamental issue is removing the operator from the loop, not the quality of the LLM call
2. **Hook-based chaining** — rejected because hooks are reactive (post-event), not proactive (goal-directed)
3. **Shell script orchestration** — rejected because no shared context between sessions, no learning, no taste

## Origin Analysis

- **Human contribution**: Drew identified that the daemon approach was fundamentally wrong ("98.4% do nothing"). Drew pushed for conversation-as-policy.
- **AI contribution**: Claude designed the service architecture, HTTP API, prompt composition system. Claude built the implementation.
- **Interaction**: The architecture emerged from Drew's critique of the daemon + Claude's proposal of the service model. Neither would have arrived at this alone — Drew's insight was "the conversation is the policy" and Claude's was "the service should never think."

## Outcome

Service built (2,366 lines), 20 API endpoints, SQLite state, session management, learning loop, deep analysis. 83% dispatch success rate vs daemon's ~1.6% action rate.

## Metrics

| Metric | Daemon | Service |
|---|---|---|
| Action rate | 1.6% | 100% (every dispatch is an action) |
| Success rate | unmeasured | 83% (10/12 dispatches) |
| Prompt quality | generic one-liners | 5K+ chars, context-loaded |
| Learning | none | 180 learnings from 437 sessions |
| Taste signals | 0 | 21 |
| Outcome tracking | none | automatic harvest |
