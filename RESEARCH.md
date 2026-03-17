# Foreman Research

This document captures the most relevant adjacent architectures and what they imply for `Foreman`.

## What Foreman is not

Foreman is not:

- a single coding agent CLI
- a personal messaging assistant
- a monolithic workflow engine
- a raw browser automation package

Foreman should be the harness above those systems.

## Key references

### OpenAI: Harness engineering

Reference:

- https://openai.com/index/harness-engineering/

Relevance:

- strongest articulation of the shift from prompt craft to environment and harness quality
- aligns with Foreman as a control plane, not just an agent wrapper
- supports the idea that repo knowledge, legibility, and workflow boundaries matter more as agents get stronger

Implication for Foreman:

- optimize for harness quality, not prompt cleverness
- make runs inspectable
- keep environment state legible to workers and validators
- emit traces that improve evals over time

### NanoClaw

Reference:

- https://github.com/qwibitai/nanoclaw

What stands out:

- very strong thesis around security via real container isolation
- intentionally small single-process architecture
- strong “fork it and make it your own” philosophy
- skills-over-features approach
- per-group memory and scheduled tasks
- messaging-centric orchestration

Useful ideas:

- bespoke over bloated
- code customization over config sprawl
- secure-by-isolation default
- small enough to understand

Not the right product target for Foreman:

- NanoClaw is closer to a secure personal assistant substrate than a general multi-worker supervisory harness
- its orchestration model is channel/message centric, not task/eval/trace centric
- memory appears closer to operational conversation memory than to a structured replay/eval substrate

Foreman implication:

- borrow the bias toward small understandable systems
- borrow the secure sandbox posture
- do not collapse Foreman into a personal assistant/chat router

### Pi Mono / Pi coding agent

References:

- https://github.com/badlogic/pi-mono
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md

What stands out:

- excellent extensibility story: extensions, skills, prompt templates, themes, packages
- strong session model: JSONL sessions with tree branching, compaction, resume, fork
- multiple execution surfaces: interactive, JSON/print, RPC, SDK
- clear worker-platform posture
- intentionally minimal core with workflow customization pushed outward

Useful ideas:

- session tree and branching
- compaction while preserving full history
- SDK + RPC + CLI coexistence
- package-based extension model
- minimal core plus strong extension points

Not the right product target for Foreman:

- Pi is primarily a worker harness, especially for coding
- it is intentionally unopinionated about higher-level supervision concerns like validator stacks, multi-worker orchestration, task-level outcomes, or replay/eval pipelines

Foreman implication:

- Foreman should integrate with systems like Pi, not compete by becoming another coding CLI
- a `pi` worker adapter would be strategically valuable

## Local references that matter more than external “competitors”

### `pr-reviewer`

Most important reusable idea:

- immutable artifacts + mutable orchestration state

Why it matters:

- this is the best local example of a thin but serious agentic runtime with stage boundaries

### `browser-agent-driver`

Most important reusable idea:

- recovery, evidence, and reliability are first-class for live environments

Why it matters:

- browser work makes failure modes visible; Foreman needs that same seriousness in every environment

### `ralph-loop`

Most important reusable idea:

- appetite for persistent completion loops

Why it matters:

- users clearly want a system that replaces the human as operator

What not to copy:

- prompt-side-effect contracts as the main control mechanism

## Competitor analysis

There is no clean direct competitor if Foreman is scoped correctly.

The field splits into adjacent categories:

### Worker harnesses

Examples:

- Pi
- Claude Code-style wrappers
- coding CLIs

Foreman relation:

- Foreman should drive these, not clone them

### Personal assistant substrates

Examples:

- NanoClaw
- OpenClaw-like systems

Foreman relation:

- Foreman can learn from their memory/scheduling/sandbox ideas
- Foreman should not become messaging-first product software

### Agent memory systems

Examples:

- standalone long-term memory kits
- retrieval-heavy memory substrates

Foreman relation:

- useful as infrastructure
- not enough on their own without supervision, evaluation, and outcome control

## Product implication: one Foreman or many?

Foreman should support both:

### Reusable Foreman profiles

A user should be able to define persistent Foreman profiles such as:

- `engineering-foreman`
- `tax-foreman`
- `ops-foreman`
- `research-foreman`

These profiles encode:

- worker preferences
- policy defaults
- evaluation style
- escalation rules
- memory scopes

### Many task-specific runs

Each task run should still be separate and traceable.

The clean model is:

- one user may have multiple long-lived Foreman profiles
- each profile supervises many runs
- each run may use many workers
- memory is scoped by user, profile, project, and environment

## What Foreman should learn across all projects

Foreman should accumulate a higher-level, human-like model of how the user works:

- preferred risk tolerance
- favored worker stacks
- recurring environments
- preferred validation rigor
- common failure patterns
- habitual escalation points

This is the beginning of “replacing the current human operating level.”

## Recommended memory hierarchy

### User memory

Cross-project preferences and operating style.

### Profile memory

Domain-specific operating style for a Foreman profile.

### Project memory

Architecture, invariants, commands, routes, failure modes.

### Environment memory

What is true of the current repo/app/system target.

### Run memory

The full trace and derived summaries for one execution.

## Strategic conclusion

Foreman should be the harness that can supervise many kinds of workers across many projects while gradually learning how the user operates.

That is more ambitious and more valuable than:

- another coding agent
- another personal assistant bot
- another memory plugin

The product stays simple if the sentence stays simple:

Foreman manages worker agents across environments, verifies outcomes with evidence, and learns from traces over time.
