# Foreman Spec

## Problem

Current agent workflows in this environment are strong but fragmented:

- `pr-reviewer` is close to the right abstraction for review/repair.
- `ensemble-audit` is the wrong implementation shape for a reusable core.
- `ralph-loop` demonstrates the operator pattern, but too much behavior is encoded in prompt text and shell glue.
- `browser-agent-driver` proves that real task completion needs observation, recovery, memory, and reliability scoring.

The missing library is the minimal reusable layer that can drive any worker agent to completion while replacing the human as the conversational operator.

## Product statement

`Foreman` is a lightweight harness for building agentic task-completion services.

It generalizes:

- code implementation loops
- review/repair loops
- browser-driven completion loops
- content/research/rewrite loops
- data/ops automation loops
- domain-specific systems like tax preparation

The one-line product target is:

`Foreman` is a harness that manages worker agents across environments, verifies task completion with evidence, and emits traces for evals and future learning.

## Hard requirements

1. The loop must be evidence-backed.
2. Completion must be validated against explicit criteria.
3. Every run must be inspectable after the fact.
4. The runtime must remain thin and adapter-driven.
5. The core must not assume a single provider, app type, or interaction surface.
6. Every run must emit structured traces suitable for replay and evaluation.

## Architectural stance

Use a narrow kernel with pluggable adapters.

Core runtime:

- task envelope
- round state
- stage contracts
- artifact writing
- trace writing
- stop/repair policy
- parallel track execution

Adapters:

- worker adapters
- environment adapters
- context builders
- planners
- worker executors
- validators
- repair planners
- publishers
- memory stores
- trigger sources
- eval sinks

## Prompt stance

Prompts should be first-class runtime inputs, but not core control flow.

The rule is:

- keep prompts versioned and selectable
- treat persona as one tunable dimension, not the main abstraction
- record prompt variant IDs in traces
- compare variants with task-level evals
- keep optimization loops outside the hot path

Foreman should support:

- prompt packs by task shape and worker role
- minimal vs persona-heavy vs contract-heavy variants
- offline prompt experiments and replay-based comparison
- optional optimizer backends that propose variants from trace/eval data

This keeps the runtime agentic and simple while still making prompt strategy measurable.

## First-class concepts

### `Foreman`

The harness/control plane.

Owns:

- policy enforcement
- worker selection
- orchestration
- supervision
- validation
- artifacts
- traces
- final outcome

### `Worker`

A specialist agent that performs work.

Examples:

- code worker
- browser worker
- review worker
- research worker
- operations worker

### `Environment`

The world a worker acts in.

Examples:

- `code`
- `browser`
- `shell`
- `api`
- `document`
- `hybrid`

### `Trace`

The structured run record used for:

- replay
- evals
- failure analysis
- ranking and comparison
- future RL-style learning

### `Policy`

Standing human instructions that Foreman enforces.

Examples:

- budget
- time limit
- escalation mode
- allowed actions
- publication rules
- required evidence

### `Validation`

The gate separating worker claims from verified outcomes.

### `Outcome`

The harness’s final determination of what happened.

## Core contracts

### Task envelope

Contains:

- stable task ID
- goal statement
- success criteria
- environment
- policy
- constraints
- optional persona/instructions
- metadata

### Context snapshot

Represents the current world state before a round:

- repo/app/system summary
- prior round summary
- relevant observations
- attached evidence

### Plan

Represents decomposition for the round:

- summary
- tracks
- risks
- open questions

### Track result

Represents one worker lane:

- track ID
- status
- summary
- evidence
- typed output payload
- findings/issues

### Validation

Represents gatekeeping:

- pass/warn/fail
- recommendation: complete/repair/escalate/abort
- findings
- scores
- unmet criteria
- summary

### Trace record

Represents the learnable record of the run:

- task and policy
- environment
- selected worker(s)
- observations
- actions/messages
- evidence
- validation results
- final outcome
- time/cost metadata
- intervention history

## Loop model

Per round:

1. `context`
2. `plan`
3. `executeTrack` x N
4. `validate`
5. `repair` or `stop`

Default stop policy:

- stop on `recommendation=complete`
- stop on `recommendation=abort`
- continue on `repair`
- force stop at `maxRounds`

## Supervision model

Foreman may supervise workers at different depths:

1. Dispatch-only
   Foreman assigns work and waits for completion.
2. Milestone supervision
   Foreman checks progress at explicit boundaries.
3. Live supervision
   Foreman observes a worker while it operates and can intervene.

Browser environments are the clearest example where live supervision may be valuable: Foreman may not click buttons itself, but it may observe a browser worker’s progress and decide whether that worker is actually advancing toward the real criterion.

## Reliability rules

The following rules come directly from the working local systems and session history:

1. Do not declare success from the worker’s self-report alone.
2. Preserve raw outputs next to normalized outputs.
3. Separate immutable run artifacts from mutable orchestration state.
4. Distinguish observation phases from completion phases.
5. Failure classes should be explicit and learnable.
6. Traces must be rich enough for replay and benchmark scoring.

Example:

- In browser flows, “green discovery agent responded” is not success when the real criterion is “purple blueprint agent generated code.”
- In coding flows, “agent said done” is not success if tests were not actually run and captured.

## Human in the loop, elevated

The human moves up from turn steering to policy control.

The driver replaces the human in:

- deciding next prompts
- gathering context for the worker
- checking whether the worker is stuck
- asking for retries or strategy changes
- deciding when the task is actually complete

The human remains responsible for:

- choosing objectives
- setting risk tolerance
- defining completion criteria
- approving sensitive actions where required
- monitoring system-wide performance and economics

## Library modules

### `contracts`

Portable TypeScript types and stage interfaces.

### `runtime`

The generic loop executor with bounded concurrency and artifact hooks.

### `artifacts`

Filesystem-backed run storage with predictable paths and JSON/text helpers.

### `tracing`

Trace schema, replay support, reward proxies, and export formats.

### `workers`

Worker contracts and adapters for specialist agents.

### `environments`

Environment contracts and environment-specific observation/action semantics.

### Future `providers`

Thin wrappers around Codex, Claude, browser-agent workers, or internal services.

### Future `surfaces`

CLI, webhook, cron, queue, and service entrypoints.

## Testing strategy

### Unit

- stop policy
- artifact paths
- round transitions
- parallel track behavior
- resume semantics

### Contract

- planner output validation
- validator output validation
- evidence normalization
- trace integrity

### Adapter

- provider wrappers
- worker wrappers
- code/test gates
- browser observation/recovery

### Replay / Eval

- replay determinism where possible
- failure taxonomy scoring
- benchmark suites by environment
- reward proxy generation

### Reliability

- golden scenario suites
- failure classification scorecards
- regression baselines by adapter

## What to keep from local references

Keep:

- `pr-reviewer` artifact discipline
- `pr-reviewer` fallback planning/validation pattern
- `browser-agent-driver` recovery and reliability mindset
- `ralph` appetite for multi-round completion loops
- shared provider adapter pattern from `tools/packages/agentic`

Reject:

- shell-driven prompt side effects
- hidden doc-updating contracts as core control flow
- completion based on stop tokens alone
- repo- or product-specific logic in the library kernel

## MVP roadmap

### Phase 1

- contracts
- filesystem artifacts
- generic runtime
- simple stop policy
- trace schema

### Phase 2

- provider adapter package
- codex/claude task worker adapters
- explicit validation schemas
- worker/environment contracts

### Phase 3

- browser and code worker adapters
- resumable orchestration state
- failure taxonomy and recovery policies
- replayable traces and eval exports

### Phase 4

- webhook/cron/service surfaces
- metrics and replay tooling
- domain memory packs
- offline reward and ranking pipelines

## Success metric

The library is successful when a new app-specific harness can be built mostly by writing worker/environment adapters and policies, not by rebuilding orchestration again.
