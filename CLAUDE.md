# CLAUDE.md

## Purpose

This repo builds `Foreman`, an agentic orchestration layer.

`Foreman` should behave like a strong operator above other agents and tools. It should not collapse into a pile of heuristics, brittle templates, or one-off local automations.

## Agentic-first default

For text-heavy and judgment-heavy work, the default should be agentic.

That includes work such as:

- searching across sessions, traces, repos, and transcripts
- reviewing prior work and identifying what matters
- researching options and synthesizing recommendations
- deciding what should happen next
- proposing repairs, improvements, and follow-up actions
- learning the operator's goals, patterns, and preferences over time

If a task requires intelligent reading, comparison, synthesis, prioritization, or decision-making, prefer agentic execution over heuristic pipelines.

## When heuristics are acceptable

Heuristics are allowed only when the path is genuinely narrow, deterministic, and easy to verify.

Examples:

- file discovery
- timestamp filtering
- schema validation
- trace loading
- report formatting
- artifact collection
- deterministic gating and safety checks

Heuristics should support agentic workflows, not replace them.

The rule is:

- use deterministic code to gather, filter, validate, and persist
- use agents to interpret, reason, review, recommend, and decide

## What Foreman should learn from

`Foreman` should learn from more than code and project state.

It should learn from:

- user messages
- task goals and constraints
- prior agent sessions
- traces and transcripts
- review and audit loops
- recurring operator patterns across projects
- observed completion behavior

The goal is to model how the operator works, not just what files changed.

## Session review and background learning

`Foreman` should be able to review prior sessions and traces on a recurring basis.

Examples:

- review the last two days of sessions
- review all available sessions and infer working patterns
- identify stale, blocked, or unfinished work
- propose what should be resumed next
- suggest improvements to prompts, skills, tools, and workflow structure
- generate memory and summary documents that improve future runs

This should be done through agentic review passes, optionally scheduled by cron or other surfaces, not by shallow keyword heuristics pretending to be intelligence.

## Product boundary

`Foreman` is still a general, publishable product.

It must not hardcode one user's machine, one repo layout, one vendor, or one local workflow into the kernel.

Local tools, local transcripts, and local session stores belong behind:

- profiles
- connectors
- importers
- memory stores
- surfaces

The kernel stays generic. Personalization comes from data and profiles.

## Decision rule

When choosing between a heuristic implementation and an agentic implementation:

- choose the agentic path if the task depends on interpretation, judgment, prioritization, or synthesis
- choose the deterministic path only if the problem is truly templated and confidence is high

Do not ship heuristic shortcuts for tasks that are central to the product's claim of intelligent orchestration.

## Execution stance

Take the lead.

When working in this repo:

- keep pushing the next highest-ROI product gap unless a real blocker or ambiguity makes that unsafe
- prefer implementing the missing capability over merely listing what is still missing
- if you notice a gap, encode it in code, docs, memory, or a runnable surface before you summarize it
- treat "what should Foreman do next?" as part of the job, not as work to defer back to the user

Questions are appropriate only when a missing answer creates real product risk or would force a fake abstraction.

If the path is clear enough to build, build it.

## Anti-goals

Avoid:

- fake intelligence built from keyword rules
- prompt theater without evidence and validation
- repo-specific assumptions in the core product
- replacing real review with shallow summarization
- using heuristics where the operator would obviously use judgment

## Practical standard

`Foreman` should act like an agentic supervisor that can:

- inspect sessions and traces
- infer what the operator is trying to achieve
- identify what is unfinished or worth improving
- recommend or initiate the next best actions
- keep learning from repeated use

If a proposed implementation does not move Foreman toward that standard, it is probably the wrong abstraction.
