# Foreman

Minimal harness for running evidence-backed agentic task completion.

`Foreman` sits one level above the worker agent. The human sets policy, success criteria, and operating constraints. `Foreman` handles worker selection, conversational steering, loop control, artifacts, traces, and stop/go decisions.

## Product

Foreman is a harness for driving worker agents to task completion with evidence, evals, and learnable traces.

It is intended to be generic and publishable: local tools, repos, and workflows should personalize Foreman through profiles, connectors, traces, and imports, not through hardcoded product assumptions.

The simplest explanation is:

- the human defines policy and success
- workers do specialist work
- Foreman manages the run, verifies completion, and records what happened

The preferred operating model is:

- profiles are long-lived
- runs are explicit and replayable
- surfaces invoke runs under profiles

## Why this exists

The current local references point to the right pattern but not the right product boundary:

- `pr-reviewer` has the best durable run model: typed-ish stages, immutable artifacts, mutable orchestration state, explicit validation.
- `ensemble-audit` has the right ambition but too much prompt-side-effect orchestration.
- `ralph-loop` proves the appetite for a persistent implement-audit cycle, but the shell/docs contract is brittle.
- `browser-agent-driver` proves the loop needs recovery, memory, artifacts, and hard reliability gates when the worker is interacting with a live system.

`Foreman` keeps the good parts and strips the theater.

## Core idea

Every serious agentic task should follow the same thin runtime shape:

1. Build context.
2. Plan work tracks.
3. Execute tracks.
4. Validate outputs and evidence.
5. Repair or stop on explicit gates.

The harness does not need to know whether the worker is:

- a coding agent in a repo
- a browser agent driving a web app
- a content agent drafting artifacts
- an ops agent running infrastructure playbooks
- a tax agent producing forms and audits

It only knows that task completion requires:

- explicit task envelopes
- structured stage outputs
- durable artifacts
- durable traces
- evidence-backed completion
- resumable rounds
- bounded retries and repair

## Core nouns

The product should stay anchored to a few stable concepts:

- `Foreman`
  The harness/control plane. Owns policy, orchestration, verification, artifacts, traces, and completion.
- `Worker`
  A specialist agent that performs work in some domain.
- `Environment`
  The world a worker acts in, such as `code`, `browser`, `shell`, `api`, `document`, or `hybrid`.
- `Trace`
  A structured record of what happened in a run. This is the unit for replay, evals, and future learning.
- `Policy`
  The human’s standing instructions: risk limits, escalation rules, budgets, completion thresholds.
- `Validation`
  The gate between worker claims and actual outcomes.
- `Outcome`
  The harness’s final determination of what happened.
- `Profile`
  A long-lived operator configuration containing memory, policy, defaults, and preferences.
- `Run`
  A concrete execution under a profile. Runs are the unit of trace, eval, and replay.
- `Connector`
  An adapter for a worker, local CLI, sandbox, service, or provider.

## What is in scope

- Generic run/task/plan/track/validation contracts
- A thin multi-round runtime
- Filesystem artifact persistence
- Structured trace persistence
- Parallel track execution
- Explicit stop gates
- Domain adapters for context, execution, validation, repair, and supervision

## What is not in scope

- A giant DAG/orchestration engine
- Product-specific prompts hardcoded into the core
- Hidden writes or magical local state
- “Success” based on vibes instead of artifacts and validation

## Design rules

- Artifacts are first-class.
- Traces are first-class.
- The wrapper writes artifacts, not prompts.
- Prompt variants are versioned policy inputs, not hidden inline strings.
- Every stage has a structured output contract.
- Validation is a real stage, not a paragraph in the worker prompt.
- Completion requires evidence tied to success criteria.
- Recovery and repair are explicit policies, not ad hoc retries.
- Worker claims and harness outcomes are separate.
- Every run should be convertible into eval or replay data.

## Current shape

The initial package is intentionally small:

- [`packages/core/src/contracts.ts`](./packages/core/src/contracts.ts): core types and stage interfaces
- [`packages/planning/src/index.ts`](./packages/planning/src/index.ts): task hardening and prompt-pack types
- [`packages/profiles/src/index.ts`](./packages/profiles/src/index.ts): reusable profile storage plus generic bootstrap/import from traces, transcripts, and repo context
- [`packages/sdk/src/index.ts`](./packages/sdk/src/index.ts): embeddable programmatic SDK surface
- [`packages/workers/src/index.ts`](./packages/workers/src/index.ts): workers plus generic connector registry for local CLIs and HTTP services
- [`packages/sandbox/src/index.ts`](./packages/sandbox/src/index.ts): sandbox-backed remote worker adapter layer
- [`packages/tangle/src/index.ts`](./packages/tangle/src/index.ts): first-class Tangle sandbox worker adapter package
- [`packages/core/src/artifacts.ts`](./packages/core/src/artifacts.ts): filesystem artifact store
- [`packages/core/src/runtime.ts`](./packages/core/src/runtime.ts): generic loop runtime
- [`VISION.md`](./VISION.md): north-star product boundary and decision filter
- [`ROADMAP.md`](./ROADMAP.md): working project checklist and priorities
- [`REPO_PLAN.md`](./REPO_PLAN.md): repo organization, environment semantics, memory/eval model
- [`RESEARCH.md`](./RESEARCH.md): research review of adjacent architectures

It is meant to be extended with adapters, not rewritten.

That means:

- local scripts are connectors, not product assumptions
- user-specific workflows belong in profiles and memory, not the kernel
- publishable defaults should remain generic

## Example

```ts
import {
  createFilesystemArtifacts,
  runTaskLoop,
  type TaskSpec,
} from "@drew/foreman-core";

const task: TaskSpec = {
  id: "build-todo-app",
  goal: "Drive the app agent until a working todo app exists.",
  successCriteria: [
    "app boots successfully",
    "todo create works",
    "todo complete works",
    "artifacts include screenshots and test output",
  ],
  environment: {
    kind: "browser",
    target: "http://localhost:3000",
  },
  policy: {
    maxCostUsd: 20,
    maxRuntimeSec: 900,
    escalationMode: "ask-human",
  },
};

const result = await runTaskLoop({
  task,
  maxRounds: 4,
  artifacts: createFilesystemArtifacts("./.foreman/runs/build-todo-app"),
  context: async () => ({
    summary: "Live project + latest screenshots + prior notes",
  }),
  plan: async () => ({
    summary: "Single worker track",
    tracks: [{ id: "main", goal: "Drive the worker to completion" }],
  }),
  executeTrack: async ({ track }) => ({
    trackId: track.id,
    status: "completed",
    summary: "Worker advanced the app build",
    evidence: [{ kind: "log", label: "stdout", value: "tests passed" }],
  }),
  validate: async ({ task, trackResults }) => ({
    status: "pass",
    recommendation: "complete",
    summary: `Validated ${trackResults.length} track(s) against ${task.successCriteria.length} criteria`,
    findings: [],
  }),
});
```

## Intended next adapters

- `packages/core`: kernel runtime and contracts
- `packages/workers`: specialist worker contracts and adapters
- `packages/environments`: environment contracts and supervision hooks
- `packages/tracing`: replay, trace export, reward proxies
- `packages/evals`: scorecards, failure taxonomies, reliability baselines
- `packages/memory`: project/user/environment memory
- `packages/surfaces`: CLI, webhook, cron, queue consumers

## Current runnable slice

The repo now includes a first engineering profile runner in
[`packages/surfaces/src/engineering-foreman.ts`](./packages/surfaces/src/engineering-foreman.ts)
with a minimal CLI in
[`packages/surfaces/src/cli.ts`](./packages/surfaces/src/cli.ts).

It also includes a profile bootstrap surface in
[`packages/surfaces/src/profile-bootstrap.ts`](./packages/surfaces/src/profile-bootstrap.ts)
and CLI in
[`packages/surfaces/src/profile-bootstrap-cli.ts`](./packages/surfaces/src/profile-bootstrap-cli.ts)
for seeding reusable profiles from prior traces, transcripts, and repo context.
It also includes a work discovery surface in
[`packages/surfaces/src/work-discovery.ts`](./packages/surfaces/src/work-discovery.ts)
and CLI in
[`packages/surfaces/src/work-discovery-cli.ts`](./packages/surfaces/src/work-discovery-cli.ts)
for scanning traces, imported transcripts, and resumable session substrates for likely open, stalled, or blocked work. When given a profile root, memory root, and user id, discovery reranks candidates using learned worker, capability, environment, and operator-pattern memory.
It also includes a learn-operator surface in
[`packages/surfaces/src/learn-operator.ts`](./packages/surfaces/src/learn-operator.ts)
and CLI in
[`packages/surfaces/src/learn-operator-cli.ts`](./packages/surfaces/src/learn-operator-cli.ts)
for the one-command onboarding path: bootstrap a profile, review how the user drives agents, write memory, and propose next runs.
It also includes an operator-learning-eval surface in
[`packages/surfaces/src/operator-learning-eval.ts`](./packages/surfaces/src/operator-learning-eval.ts)
and CLI in
[`packages/surfaces/src/operator-learning-eval-cli.ts`](./packages/surfaces/src/operator-learning-eval-cli.ts)
for scoring how much useful operator state Foreman has actually learned from prior runs.
It also includes an agentic session-review surface in
[`packages/surfaces/src/session-review.ts`](./packages/surfaces/src/session-review.ts)
and CLI in
[`packages/surfaces/src/session-review-cli.ts`](./packages/surfaces/src/session-review-cli.ts)
for reviewing traces, resumable provider sessions, and imported sessions, generating operator-level reports, and writing profile/user memory updates.
It also includes a work-continuation surface in
[`packages/surfaces/src/work-continuation.ts`](./packages/surfaces/src/work-continuation.ts)
and CLI in
[`packages/surfaces/src/work-continuation-cli.ts`](./packages/surfaces/src/work-continuation-cli.ts)
for turning discovery plus session review into concrete next runs, with optional execution paths for engineering, session, and supervisor proposals. Proposal execution now respects explicit approval requirements instead of blindly running everything it plans.
It also includes an environment-observation surface in
[`packages/surfaces/src/environment-observe.ts`](./packages/surfaces/src/environment-observe.ts)
and CLI in
[`packages/surfaces/src/environment-observe-cli.ts`](./packages/surfaces/src/environment-observe-cli.ts)
for grounded inspection and verification of code, document, research, ops, and hybrid environments.
Supervisor traces with failed child runs or high-severity findings now also surface as blocked work items during discovery, so external orchestrators become resumable work targets instead of dead reports.
It also includes a supervisor-run surface in
[`packages/surfaces/src/supervisor-run.ts`](./packages/surfaces/src/supervisor-run.ts)
and CLI in
[`packages/surfaces/src/supervisor-run-cli.ts`](./packages/surfaces/src/supervisor-run-cli.ts)
for driving external orchestrators that emit the generic `supervisor-v1` contract and publishing JSON or Markdown reports from those runs. Mutating service-mode supervisor calls can now stop behind an approval gate instead of executing immediately.
Supervisor runs can also emit traces for later reliability analysis.
It also includes supervisor replay and benchmark surfaces in
[`packages/surfaces/src/supervisor-replay.ts`](./packages/surfaces/src/supervisor-replay.ts),
[`packages/surfaces/src/supervisor-replay-cli.ts`](./packages/surfaces/src/supervisor-replay-cli.ts),
[`packages/surfaces/src/supervisor-benchmark.ts`](./packages/surfaces/src/supervisor-benchmark.ts),
and
[`packages/surfaces/src/supervisor-benchmark-cli.ts`](./packages/surfaces/src/supervisor-benchmark-cli.ts)
for rerunning traced supervisor executions and comparing blocked/completed/validated outcomes over time, including child-run counts and high-severity finding counts for external orchestrators that emit `supervisor-v1`.
It also includes golden-suite and judge-calibration surfaces in
[`packages/surfaces/src/golden-suite.ts`](./packages/surfaces/src/golden-suite.ts),
[`packages/surfaces/src/golden-suite-cli.ts`](./packages/surfaces/src/golden-suite-cli.ts),
[`packages/surfaces/src/judge-calibration.ts`](./packages/surfaces/src/judge-calibration.ts),
and
[`packages/surfaces/src/judge-calibration-cli.ts`](./packages/surfaces/src/judge-calibration-cli.ts)
for replay-backed regression checks over curated trace sets and provider-backed scoring over labeled evaluation cases.
It also includes a provider-session surface in
[`packages/surfaces/src/provider-session.ts`](./packages/surfaces/src/provider-session.ts)
and CLI in
[`packages/surfaces/src/provider-session-cli.ts`](./packages/surfaces/src/provider-session-cli.ts)
for listing and continuing real `claude`, `codex`, `opencode`, and `openclaw` sessions noninteractively, plus browser-run sessions exposed by `browser-agent-driver` style run registries. The browser adapter targets the `bad` CLI from `browser-agent-driver` `0.10.x` by default, with binary override support when needed. OpenClaw is treated as an assistant-style harness rather than a plain coding session, so Foreman classifies cron-owned and system-owned OpenClaw sessions differently from human-driven Claude/Codex work.
It also includes a session-run surface in
[`packages/surfaces/src/session-run.ts`](./packages/surfaces/src/session-run.ts)
and CLI in
[`packages/surfaces/src/session-run-cli.ts`](./packages/surfaces/src/session-run-cli.ts)
for executing resumable provider/browser session continuations as traced Foreman runs. `session-run` can now auto-resolve the provider from existing sessions or learned operator memory and will fail closed on known runtime-level provider/model errors even when a session binary exits `0`.
It also applies approval gates to risky session takeover paths, such as continuing a session classified as `human-active`.
Successful and failed session runs now also feed worker-performance memory so later routing can bias away from weak providers and toward workers that have actually been succeeding.
It also includes session replay and benchmark surfaces in
[`packages/surfaces/src/session-replay.ts`](./packages/surfaces/src/session-replay.ts),
[`packages/surfaces/src/session-replay-cli.ts`](./packages/surfaces/src/session-replay-cli.ts),
[`packages/surfaces/src/session-benchmark.ts`](./packages/surfaces/src/session-benchmark.ts),
and
[`packages/surfaces/src/session-benchmark-cli.ts`](./packages/surfaces/src/session-benchmark-cli.ts)
for rerunning traced session executions and comparing blocked/completed/validated outcomes and provider selection over time.
It also includes browser-first replay and benchmark surfaces in
[`packages/surfaces/src/browser-replay.ts`](./packages/surfaces/src/browser-replay.ts),
[`packages/surfaces/src/browser-replay-cli.ts`](./packages/surfaces/src/browser-replay-cli.ts),
[`packages/surfaces/src/browser-benchmark.ts`](./packages/surfaces/src/browser-benchmark.ts),
and
[`packages/surfaces/src/browser-benchmark-cli.ts`](./packages/surfaces/src/browser-benchmark-cli.ts)
so browser runs can be treated as their own evaluable surface rather than generic sessions.
It also includes a browser-supervision surface in
[`packages/surfaces/src/browser-supervision.ts`](./packages/surfaces/src/browser-supervision.ts)
and CLI in
[`packages/surfaces/src/browser-supervision-cli.ts`](./packages/surfaces/src/browser-supervision-cli.ts)
for ranking resumable browser runs with browser-specific context like domain and URLs, and optionally continuing or forking the top candidate under Foreman policy.
It also includes a session-registry surface in
[`packages/surfaces/src/session-registry.ts`](./packages/surfaces/src/session-registry.ts)
and CLI in
[`packages/surfaces/src/session-registry-cli.ts`](./packages/surfaces/src/session-registry-cli.ts)
for classifying provider sessions and browser runs as agent-active, human-active, idle-resumable, or stale and recommending observe/recommend/continue modes under a simple continuation policy.

It also includes a prompt-optimization sidecar in
[`packages/optimizer/src/index.ts`](./packages/optimizer/src/index.ts)
with a CLI surface in
[`packages/surfaces/src/prompt-optimizer-cli.ts`](./packages/surfaces/src/prompt-optimizer-cli.ts).
It also includes replay and benchmark surfaces in
[`packages/surfaces/src/engineering-replay.ts`](./packages/surfaces/src/engineering-replay.ts)
and
[`packages/surfaces/src/engineering-benchmark.ts`](./packages/surfaces/src/engineering-benchmark.ts)
for rerunning and scoring engineering traces over historical task sets.
It also includes a generic trace benchmark surface in
[`packages/surfaces/src/trace-benchmark.ts`](./packages/surfaces/src/trace-benchmark.ts)
and CLI in
[`packages/surfaces/src/trace-benchmark-cli.ts`](./packages/surfaces/src/trace-benchmark-cli.ts)
for measuring session, supervisor, or engineering traces by outcome, approval rate, provider, and failure class.
An example schedule manifest lives at
[`examples/foreman-schedule.json`](./examples/foreman-schedule.json).

Foreman is also exportable as a library surface through
[`packages/sdk/src/index.ts`](./packages/sdk/src/index.ts),
and memory can now be backed either by local JSON files or a shared Postgres database through
[`packages/memory/src/index.ts`](./packages/memory/src/index.ts)
using `FOREMAN_MEMORY_DATABASE_URL` or `FOREMAN_POSTGRES_URL`.
That makes the same profile and user memory portable across multiple machines.
It also includes a simple cross-machine refresh surface in
[`packages/surfaces/src/sync-operator.ts`](./packages/surfaces/src/sync-operator.ts)
and CLI in
[`packages/surfaces/src/sync-operator-cli.ts`](./packages/surfaces/src/sync-operator-cli.ts)
for “review what happened here, update memory, and refresh what Foreman knows” in one command.
Foreman is also exportable as a library surface through
[`packages/sdk/src/index.ts`](./packages/sdk/src/index.ts),
and it now includes a generic sandbox-worker adapter in
[`packages/sandbox/src/index.ts`](./packages/sandbox/src/index.ts)
and a first-class Tangle adapter in
[`packages/tangle/src/index.ts`](./packages/tangle/src/index.ts)
for driving remote `codex` and `claude-code` workers through the local sandbox SDK.
The sandbox layer now also includes a disk-backed session store and post-run evidence hooks, and the Tangle package exposes a richer handle for `resume`, `checkpoint`, `fork`, `exec`, `read`, `download`, and git inspection.

The repo check now includes a sync gate in
[`scripts/check-sync.ts`](./scripts/check-sync.ts)
backed by
[`scripts/sync-manifest.ts`](./scripts/sync-manifest.ts)
so CLI entrypoints and SDK exports fail fast if they drift.

Workers and connectors can also use a generic `supervisor-v1` output contract through
[`packages/workers/src/index.ts`](./packages/workers/src/index.ts)
so external orchestrators that spawn subagents can return normalized child runs, findings, artifacts, and next actions back into Foreman.

The next general-product steps are not about one local machine. They are about:

- richer connector usage across arbitrary local CLIs and services
- bootstrap/import from prior agent sessions and histories
- stronger replay/eval loops across real runs
- reusable profiles that accumulate memory over time
- memory that affects actual reviewer choice, validation ordering, and routing instead of only generating reports

## Session review example

```bash
cd /home/drew/code/foreman

npm run review-sessions -- \
  --profile-id daily-operator \
  --user-id drew \
  --profile-root .foreman/profiles \
  --memory-root .foreman/memory \
  --trace-root ~/code/some-repo/.foreman/traces \
  --session-provider claude \
  --session-provider codex \
  --session-provider opencode \
  --transcript-root ~/exports/agent-sessions \
  --lookback-days 2 \
  --provider claude \
  --output-path .foreman/reports/session-review.json \
  --markdown-path .foreman/reports/session-review.md
```

## Learn operator example

```bash
cd /home/drew/code/foreman

npm run learn-operator -- \
  --profile-id daily-operator \
  --user-id drew \
  --profile-root .foreman/profiles \
  --memory-root .foreman/memory \
  --trace-root ~/code/some-repo/.foreman/traces \
  --transcript-root ~/exports/agent-sessions \
  --session-provider claude \
  --session-provider codex \
  --session-provider opencode \
  --session-cwd ~/code/some-repo \
  --lookback-days 7 \
  --provider claude \
  --output-path .foreman/reports/learn-operator.json \
  --markdown-path .foreman/reports/learn-operator.md
```

```bash
npm run eval-operator-learning -- \
  --profile-id daily-operator \
  --user-id drew \
  --profile-root .foreman/profiles \
  --memory-root .foreman/memory \
  --output-path .foreman/reports/operator-learning-eval.json \
  --markdown-path .foreman/reports/operator-learning-eval.md
```

## Cross-machine sync example

```bash
cd /home/drew/code/foreman

export FOREMAN_MEMORY_DATABASE_URL=postgres://user:pass@host:5432/foreman

npm run sync-operator -- \
  --profile-id drew-operator \
  --user-id drew \
  --session-provider claude,codex,opencode,openclaw,browser \
  --session-cwd ~/code \
  --trace-root ~/code/some-repo/.foreman/traces \
  --repo ~/code/some-repo \
  --output-path .foreman/reports/sync-operator.json \
  --markdown-path .foreman/reports/sync-operator.md
```

This is the intended "refresh yourself here" command for a laptop, server, or sandbox host.
If `FOREMAN_MEMORY_DATABASE_URL` is set, the learned profile and user memory are shared across machines.
If `FOREMAN_TRACE_DATABASE_URL` is set, new engineering, session, and supervisor traces are also shared across machines and become queryable for retrieval.
Copy [`.env.example`](./.env.example) to `.env` or export the variables in your shell.

## Scheduled sync example

You can also make this the default recurring behavior:

```bash
cd /home/drew/code/foreman

npm run run-schedule -- --manifest examples/foreman-schedule.json --job-id daily-operator-sync
```

## Trace retrieval example

```bash
cd /home/drew/code/foreman

export FOREMAN_TRACE_DATABASE_URL=postgres://user:pass@host:5432/foreman

npm run retrieve-traces -- \
  --query "session review improvements for codex orchestration" \
  --limit 5
```

## Work continuation example

```bash
cd /home/drew/code/foreman

npm run continue-work -- \
  --profile-id daily-operator \
  --user-id drew \
  --profile-root .foreman/profiles \
  --memory-root .foreman/memory \
  --trace-root ~/code/some-repo/.foreman/traces \
  --transcript-root ~/exports/agent-sessions \
  --session-provider browser \
  --session-cwd ~/code/some-app \
  --lookback-days 2 \
  --provider claude \
  --session-review-provider claude \
  --output-path .foreman/reports/work-continuation.json \
  --markdown-path .foreman/reports/work-continuation.md
```

## Environment observation examples

```bash
cd /home/drew/code/foreman

npm run observe-environment -- \
  --kind research \
  --target ~/code/some-repo/research \
  --verify-goal "Confirm this workspace has enough source material for a product brief"

npm run observe-environment -- \
  --kind ops \
  --target ~/code/some-service \
  --health-url http://localhost:3000/health \
  --check-command "npm test"

npm run observe-environment -- \
  --kind hybrid \
  --target ~/code/some-repo \
  --target ~/code/some-repo/docs \
  --target http://localhost:3000/health \
  --verify-goal "Check whether the codebase, docs, and service are aligned for release"
```

## Ops and document runner examples

```bash
cd /home/drew/code/foreman

npm run ops-foreman -- \
  --target ~/code/some-service \
  --goal "Stabilize the service and identify the next operational actions" \
  --health-url http://localhost:3000/health \
  --check "npm test" \
  --criterion "health checks are passing" \
  --criterion "deterministic service checks are passing"

npm run document-foreman -- \
  --target ~/code/some-repo/docs \
  --goal "Audit this document workspace and identify unresolved checklist work" \
  --criterion "document gaps are surfaced clearly" \
  --criterion "checklist-like unresolved work is identified"

npm run research-foreman -- \
  --target ~/code/some-repo/research \
  --goal "Audit the research corpus and identify missing sourcing or synthesis gaps" \
  --criterion "source coverage is assessed" \
  --criterion "citation or sourcing gaps are surfaced"

npm run hybrid-foreman -- \
  --goal "Check release readiness across code, docs, and service health" \
  --env code:~/code/some-repo \
  --env document:~/code/some-repo/docs \
  --env ops:http://localhost:3000/health \
  --check "npm test" \
  --criterion "code workspace is in a good state" \
  --criterion "docs are aligned" \
  --criterion "service checks pass"
```

## Provider session example

```bash
cd /home/drew/code/foreman

# install browser-agent-driver once if you want browser session supervision
BAD_VERSION=0.10.0 curl -fsSL https://raw.githubusercontent.com/tangle-network/browser-agent-driver/main/scripts/install.sh | bash

npm run provider-session -- \
  --provider claude \
  --action list \
  --limit 5

npm run provider-session -- \
  --provider codex \
  --action continue \
  --session-id SESSION_ID \
  --prompt "Continue the work, review what remains, and drive it to completion."

npm run provider-session -- \
  --provider opencode \
  --action list \
  --limit 5

npm run provider-session -- \
  --provider browser \
  --action continue \
  --run-id RUN_ID \
  --prompt "Continue the flow, inspect the final app state, and finish the task."
```

## Session run example

```bash
cd /home/drew/code/foreman

npm run session-run -- \
  --provider auto \
  --action continue \
  --session-id SESSION_ID \
  --prompt "Continue the work, review what remains, and drive it to completion." \
  --profile-id daily-operator \
  --user-id drew \
  --profile-root .foreman/profiles \
  --memory-root .foreman/memory \
  --trace-root ~/code/some-repo/.foreman/traces \
  --output-path ~/code/some-repo/.foreman/reports/session-run.json
```

## Trace benchmark example

```bash
cd /home/drew/code/foreman

npm run benchmark-traces -- \
  --trace-root ~/code/some-repo/.foreman/traces \
  --surface session
```

## Supervisor replay example

```bash
cd /home/drew/code/foreman

npm run replay-supervisor -- \
  --trace-root ~/code/some-repo/.foreman/traces \
  --trace-id TRACE_ID

npm run benchmark-supervisor -- \
  --trace-root ~/code/some-repo/.foreman/traces \
  --max-cases 20
```

## Session replay example

```bash
cd /home/drew/code/foreman

npm run replay-session -- \
  --trace-root ~/code/some-repo/.foreman/traces \
  --trace-id TRACE_ID

npm run benchmark-session -- \
  --trace-root ~/code/some-repo/.foreman/traces \
  --max-cases 20

npm run replay-browser -- \
  --trace-root ~/code/some-repo/.foreman/traces \
  --trace-id TRACE_ID

npm run benchmark-browser -- \
  --trace-root ~/code/some-repo/.foreman/traces \
  --max-cases 20

npm run golden-suite -- \
  --manifest examples/golden-suite.json \
  --output-path .foreman/reports/golden-suite.json

npm run calibrate-judge -- \
  --dataset examples/judge-calibration.json \
  --provider claude \
  --output-path .foreman/reports/judge-calibration.json
```

## Supervisor run example

```bash
cd /home/drew/code/foreman

npm run supervisor-run -- \
  --command "~/tools/some-audit-tool --json" \
  --cwd ~/code/some-repo \
  --label "nightly-audit" \
  --output-path .foreman/reports/nightly-audit.json \
  --markdown-path .foreman/reports/nightly-audit.md
```

## Session registry example

```bash
cd /home/drew/code/foreman

npm run session-registry -- \
  --provider browser \
  --session-cwd ~/code/some-app \
  --max-items 10 \
  --active-window-minutes 30 \
  --stale-after-hours 24
```

Example:

```bash
npm run engineering -- \
  --repo ~/code/some-repo \
  --goal "Implement the requested feature and verify it" \
  --criterion "tests pass" \
  --criterion "behavior matches the request" \
  --check "npm test"

npm run optimize-prompts -- \
  --trace-root ~/code/some-repo/.foreman/traces \
  --task-shape engineering \
  --min-runs 3

npm run replay-engineering -- \
  --trace-root ~/code/some-repo/.foreman/traces \
  --trace-id TRACE_ID \
  --prompt-policy-mode shadow

npm run benchmark-engineering -- \
  --trace-root ~/code/some-repo/.foreman/traces \
  --max-cases 20 \
  --report-path ~/code/some-repo/.foreman/reports/engineering-benchmark.json

npm run engineering -- \
  --repo ~/code/some-repo \
  --goal "Implement the requested feature in a remote sandbox" \
  --criterion "tests pass" \
  --sandbox-mode tangle \
  --tangle-backend codex

npm run bootstrap-profile -- \
  --profile-id daily-operator \
  --trace-root ~/code/some-repo/.foreman/traces \
  --transcript-root ~/exports/agent-sessions \
  --repo ~/code/some-repo

npm run engineering -- \
  --repo ~/code/some-repo \
  --profile-id daily-operator \
  --goal "Implement the requested feature and verify it" \
  --criterion "tests pass"

npm run discover-work -- \
  --profile-id daily-operator \
  --user-id drew \
  --profile-root .foreman/profiles \
  --memory-root .foreman/memory \
  --trace-root ~/code/some-repo/.foreman/traces \
  --transcript-root ~/exports/agent-sessions \
  --session-provider claude,codex,browser,openclaw \
  --session-cwd ~/code/some-app

npm run run-schedule -- \
  --manifest ~/code/some-repo/.foreman/foreman-schedule.json
```

## Human abstraction shift

The human should not spend time nudging the worker turn by turn.

The human should define:

- objective
- success criteria
- acceptable risk
- escalation policy
- cost/time budgets
- publication surface

Foreman should handle the rest.

## Why traces matter

The harness should emit runs that are immediately usable for:

- replay
- offline evals
- benchmark suites
- failure classification
- future ranking or RL-style learning

That means traces need to capture:

- task and policy
- worker selection
- environment
- observations
- actions/messages
- evidence
- validation
- outcome
- cost/time metadata
