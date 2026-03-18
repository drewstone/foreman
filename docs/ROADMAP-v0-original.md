# Foreman Roadmap

This is the working checklist for turning `Foreman` from a solid harness scaffold into a self-improving orchestration layer.

Status keys:

- `[x]` done
- `[-]` in progress
- `[ ]` not started

## Product target

`Foreman` should replace the human operator at the orchestration layer:

- harden vague goals into executable task envelopes
- select and supervise workers and tools
- run validation, review, and repair loops
- record traces, memory, and outcomes
- improve prompt and policy choices over time

It should stay generic and publishable:

- profiles and runs should be first-class
- local scripts and org-specific tools should live behind connectors
- memory and bootstrap/import should personalize behavior without hardcoding local specifics

## Completed

- [x] Define the harness model around `Foreman`, `Worker`, `Environment`, `Trace`, `Policy`, `Validation`, and `Outcome`
- [x] Create workspace package layout under `packages/`
- [x] Implement core runtime, contracts, artifact store, and trace writing
- [x] Implement worker registry and provider-backed `codex` / `claude` worker adapters
- [x] Implement command worker adapter for tool and audit commands
- [x] Implement code environment adapter with git observation and deterministic checks
- [x] Implement evaluation pipeline
- [x] Implement filesystem memory and trace stores
- [x] Implement engineering surface CLI
- [x] Add task hardening package and engineering hardening flow
- [x] Add separate implementation and review/judge stages to engineering runs
- [x] Add tool-backed validation commands to engineering runs
- [x] Add prompt variants as typed runtime inputs
- [x] Record prompt variant IDs in engineering trace metadata
- [x] Add prompt-optimization sidecar package and CLI
- [x] Add reward-proxy extraction and prompt ranking from traces
- [x] Add embeddable SDK export surface
- [x] Add provider session drivers for Claude, Codex, and Opencode with recent-session listing and noninteractive continuation
- [x] Add OpenClaw as a first-class session provider with harness-aware continuation and session classification
- [x] Add traced session-run surfaces for resumable provider and browser continuations
- [x] Add a session registry and continuation-policy layer over provider sessions
- [x] Add browser-run session adapter support for manifest-backed browser agents with list/resume/fork flows
- [x] Add generic sandbox-backed remote worker adapter layer
- [x] Add first-class Tangle sandbox adapter package using the real SDK client directly
- [x] Add a sync gate so CLI entrypoints and SDK exports stay aligned
- [x] Add disk-backed sandbox session persistence
- [x] Add richer Tangle sandbox handles for resume/checkpoint/fork/artifact extraction
- [x] Add Tangle-backed engineering execution with repo clone inference and default sandbox evidence capture
- [x] Add a generic connector registry for local CLIs and HTTP services
- [x] Add a generic `supervisor-v1` worker output contract for external orchestrators and multi-agent tools
- [x] Add a generic bootstrap/import flow for prior traces, transcripts, and repo context
- [x] Add profile-backed engineering runs and a profile bootstrap CLI
- [x] Add one-command operator learning/onboarding over traces, sessions, memory, and next-run planning
- [x] Add an engineering benchmark suite runner over historical traces
- [x] Add generic work discovery over traces, imported transcripts, and resumable session substrates

## In Progress

- [-] Turn prompt optimization from reporting into controlled rollout
  Prompt policy state and thresholds now exist, but promotion still needs broader shadow-run volume and safer rollback logic.
- [-] Turn memory into stronger runtime behavior
  Memory now influences engineering worker selection, reviewer choice, validation command inference, evaluator ordering, discovery/continuation ranking, session-run provider resolution, and worker-performance-aware routing, but broader tool routing and runtime policy still do not depend on it enough.
- [-] Turn imported history into agentic operator learning
  Bootstrap, sync-operator, work discovery, session review, and proactive recommendations now exist, but deeper automated follow-through and richer multi-machine conflict resolution are still missing.
- [-] Tighten task-family taxonomy
  Engineering is the only serious vertical right now; broader task-shape classification is still light.
- [-] Keep the product surface generic and profile-first
  The architecture is mostly there, but some roadmap/docs still speak too locally or too narrowly.

## Next

### Prompt policy loop

- [x] Add `PromptPolicyStore`
- [x] Track `active`, `candidate`, `shadow`, `retired` prompt variants
- [x] Add promotion thresholds
- [x] Add shadow-run comparison hooks for candidate prompt variants
- [x] Add replay-based comparison for prompt candidates
- [x] Add `Ax` optimizer adapter in the sidecar
- [x] Export optimizer-ready datasets from traces
- [x] Add rollback thresholds and automatic rollback logic

### Engineering foreman maturity

- [x] Add prompt-variant selection flags to the engineering CLI
- [x] Add richer engineering reward signals: latency, repair count, check pass rate, escalation rate
- [x] Add stronger review output normalization and failure handling
- [x] Add explicit diff/file evidence to engineering traces
- [x] Add runtime accounting for worker runs
- [x] Add provider-side cost accounting for worker runs
- [x] Add replay runner for engineering traces
- [x] Add benchmark suite runner for engineering traces

### Connectors and publishing

- [x] Add a generic connector registry for local CLIs, services, and internal tools
- [x] Define a `tool worker` registry pattern for audit/review/ops commands
- [x] Add cron/job surface for recurring org workflows
- [x] Add publication/reporting surfaces for recurring task outputs
- [x] Add generic bootstrap/import flows for prior agent sessions, traces, and repo histories
- [x] Add generic work discovery for open, blocked, and stale work across traces, transcripts, and resumable sessions
- [x] Add agentic session-review surfaces for traces, transcripts, and imported histories
- [x] Add memory/report generation from recurring session reviews
- [x] Add continuation recommendation surfaces that turn discovered work into actionable next runs
- [-] Add higher-level supervisor flows for external orchestrators and multi-agent tools
  The reusable worker/output contract, generic supervisor-run/report surface, replay/benchmark loops, supervisor-aware discovery, and continuation-time supervisor proposal execution now exist, including child-run and high-severity-finding comparisons. Cross-run orchestration and richer supervisor-specific planning are still thin.
- [-] Add more external session providers where stable list/continue contracts exist
  OpenClaw is now a first-class session provider. Pi Mono remains pending until its session surface is concrete enough to normalize cleanly.
- [-] Add profile-first surfaces for reusable invoked runs
  Profile bootstrap and engineering profile loading exist, but more surfaces still need to load profiles cleanly.

## After That

### More environments and workers

- [-] Browser worker/environment
  Browser session-driver integration, browser replay/benchmark surfaces, and a dedicated browser-supervision surface now exist for manifest-backed list/resume/fork flows; remaining work is richer browser-specific policy, validation, and production trace coverage.
- [-] Research worker/environment
  Research corpus observation and a first research runner now exist; remaining work is source-quality judges, citation-grounded eval datasets, and deeper synthesis/research planning.
- [-] Tax/document worker/environment
  Document workspace observation and a first document runner now exist; remaining work is form/document-specific workers, structured extraction, and deeper checklist/audit validation.
- [-] Ops/service worker/environment
  Service environment observation and a first ops runner now exist with health endpoint and command checks; remaining work is deployment/log/metric-specific workers, incident loops, and richer failure policy.
- [-] Hybrid environment composition
  Hybrid observation, verification, and a first multi-track hybrid runner now exist; remaining work is deeper cross-environment repair policy, worker specialization per node, and stronger global completion gates.

### Reliability and evals

- [-] Failure taxonomy by task shape
  Session-run and supervisor-run now emit normalized failure classes, but broader task-shape coverage is still missing.
- [-] Golden task suites
  Golden-suite manifests and replay-backed verification now exist across engineering, session, browser, and supervisor traces; broader curated suites over production traces are still missing.
- [-] Benchmark and replay harness
  Engineering replay and benchmark runners exist, generic trace benchmarking now covers session/supervisor/engineering traces, and both supervisor and session replay/benchmark loops now exist; deeper replay coverage across more environments is still missing.
- [-] Judge calibration flows
  A provider-backed calibration surface now exists for labeled cases, but broader task-shape coverage and production-grade calibration datasets are still missing.
- [-] Human escalation and approval gates
  Session-run, work-continuation execution, and supervisor-run now support approval gates, but the broader runtime still needs more policy coverage.
- [-] Eval supervisor-style runs over external orchestrators, not just single-worker runs
  Supervisor runs now emit traces, participate in generic trace benchmarking, and support replay/benchmark loops; richer replay/eval loops over supervisor child runs are still missing.

### Learning and memory

- [-] Better worker-performance memory
  Engineering and session runs now record worker success/cost/runtime tendencies and routing can consume them, but broader surfaces and richer per-task statistics are still missing.
- [-] Better strategy memory and repair recipes
  Engineering strategy memory now feeds runtime context and adaptive scoring can consult task-shape strategy memory, but non-engineering strategy capture is still thin.
- [-] Cross-project memory scopes and profile memory
  Profile/user memory can now be backed by shared Postgres, refreshed with a single sync command across machines, and scheduled via the built-in manifest runner, but broader multi-project retrieval and conflict-resolution policy are still missing.
- [-] Retrieval from trace history, not just compact memory summaries
  Shared Postgres-backed trace storage and lexical retrieval now exist for engineering, session, and supervisor traces, and profile/bootstrap flows can read from the shared trace store; richer retrieval quality, embeddings, and broader surface coverage are still missing.
- [ ] Learn operator intent and recurring goals from messages, traces, and session review outputs
- [-] Feed session-review outputs back into profiles, memory, and continuation planning
  Session review now writes profile/user memory and continuation consumes that memory, but broader runtime routing still needs more of that signal.

## Current priorities

If we are optimizing for leverage, the next order should be:

1. run benchmark/replay suites on real remote and local traces
2. higher-level supervisor flows for external multi-agent tools and orchestrators
3. deeper memory-driven routing across sessions, tools, and validation policy
4. higher-level browser supervision and continuation policy
5. broader environment and memory maturity
6. deepen golden suites and judge calibration on real production traces

## What not to do

- [ ] Do not move optimizer logic into the hot path
- [ ] Do not make prompt personas the main abstraction
- [ ] Do not let worker self-report count as completion
- [ ] Do not collapse Foreman into another coding CLI or personal assistant bot
- [ ] Do not hardcode one operator's local setup into the product surface
- [ ] Do not add heavy workflow-engine complexity before the adapter and eval layers are mature
