# Decision 003: Rich Prompt Composition over Generic Dispatch

Date: 2026-03-22
Status: ACCEPTED
Origin: Human (Drew) identified the gap, AI (Claude) designed the solution

## Context

Drew mapped the flow: `/foreman do X` → Pi calls dispatch → service spawns claude → sends "do X" as a one-liner. The dispatched Claude session had no context about the project, past decisions, learned patterns, or operator taste.

## Decision

Build a `composePrompt()` function that assembles a 5,000+ character prompt from:
1. Task description + quality standards
2. Git workflow (worktree branch, PR instructions)
3. CLAUDE.md (project instructions)
4. README (what the project is)
5. Package manifest
6. Recent git history + uncommitted changes
7. Evolve/autoresearch state
8. Past Foreman decisions on this project
9. Other goal attempts
10. Taste model (learned from operator signals)
11. Dead ends (don't repeat)
12. Operator exemplars (from session mining)
13. Dispatch success patterns
14. Learned flows (from deep analysis)
15. Anti-patterns and skill preferences

## Origin Analysis

- **Human contribution**: Drew identified the fundamental gap by mapping the flow end-to-end. His reaction — "obviously we need this!" — was the forcing function.
- **AI contribution**: Claude designed the section ordering, context budget scaling (1500/3500/6000 by task complexity), and the specific content extraction logic.

## Result

Dispatched sessions now receive rich context. PiGraph run achieved 83% success rate with 7 dispatches — sessions knew what to build, why, and how.

## Key Insight for Paper

The prompt is the highest-leverage surface in the entire system. GEPA optimization of this prompt — measuring which composition patterns correlate with successful outcomes — is the path to self-improvement.
