# Foreman Roadmap

## Architecture summary

Foreman = state + policy + actions. See VISION.md for the full rationale.

```
events (file watchers, webhooks, hooks, poll)
  → state snapshot (aggregate all knowledge)
  → policy (LLM: what should I do?)
  → confidence gate (am I allowed?)
  → action (spawn session, invoke skill, etc.)
  → outcome observation
  → confidence update + learning
  → repeat
```

## Current state (2026-03-21)

14 packages, 97 surface files, 22,923 lines in surfaces alone. 145 tests passing.

Most of the codebase is **state collection** and **action execution** — both useful. The missing piece is the **policy layer** (the brain) and the **event loop** (the nervous system). What exists as "policy" today is ~13 files of pre-decided workflows (~5,000 lines) that should be replaced by one LLM reasoning call (~200 lines).

### Package inventory

| Package | Files | Lines | Role | Status |
|---------|-------|-------|------|--------|
| core | 8 | 1,710 | Contracts, runtime loop, versioned store | KEEP |
| tracing | 1 | 546 | Trace store (fs/pg), search, bundles | KEEP |
| memory | 5 | 1,922 | Memory store, session index (FTS5), learning | KEEP |
| workers | 2 | 1,448 | Worker registry, adapters, capability scoring | KEEP |
| providers | 1 | 1,347 | Claude/Codex/Pi/Opencode drivers | KEEP |
| environments | 1 | 639 | Git/document/service observation | KEEP |
| profiles | 1 | 649 | Operator profiles, work discovery | KEEP |
| evals | 6 | 1,764 | Eval pipeline, judges, failure taxonomy | KEEP |
| optimizer | 1 | 1,029 | GEPA, variant scoring, policy store | KEEP + EXPAND |
| planning | 2 | 660 | Task hardening, prompt variants | CONSOLIDATE → optimizer |
| sandbox | 1 | 418 | Sandbox worker adapter | KEEP |
| tangle | 1 | 534 | Tangle sandbox integration | KEEP |
| sdk | 1 | 13 | Public re-exports | KEEP |
| surfaces | 97 | 22,923 | All CLIs, state collectors, actions, policy | RESTRUCTURE |

### Surfaces classification

**State collectors (9 files, ~2,500 lines) — KEEP as data sources:**
session-metrics, session-insights, session-analysis, session-registry, skill-tracker, intent-engine, cost-monitor, operator-adaptation, async-replan

**Action executors (10 files, ~3,000 lines) — KEEP as agent tools:**
ci-tools, ci-diagnosis, notify, engineering-tools, session-run, provider-session, retrieve-traces, sync-operator, schedule, golden-suite-generator

**Eval infrastructure (8 files, ~1,500 lines) — KEEP as self-improvement loop:**
benchmark-env, ci-repair-env, report-quality-env, eval-runner, judge-calibration, operator-learning-eval, golden-suite, worktree-experiment

**Pre-decided policy (13 files, ~5,000 lines) — REPLACE with policy agent:**
operator-loop, engineering-foreman, environment-foreman, hybrid-foreman, work-discovery, work-continuation, session-review, nightly-optimize (orchestration), variant-generator (selection), prompt-optimizer (selection), daily-report (selection), learn-operator (orchestration)

**CLIs (34 files, ~3,500 lines) — KEEP as thin wrappers:**
All *-cli.ts files. No logic, just arg parsing.

**Replay/benchmark (12 files, ~2,000 lines) — KEEP:**
session-replay, session-benchmark, browser-replay, browser-benchmark, browser-supervision, engineering-replay, engineering-benchmark, environment-observe, supervisor-run, supervisor-replay, supervisor-benchmark, trace-benchmark

**Profiles/learning (5 files, ~1,500 lines) — KEEP:**
user-profiles, profile-bootstrap, daily-report (rendering), learning-cli, api-server

**Infra (3 files, ~400 lines) — KEEP:**
index.ts, session-provider-args, run.ts

---

## Milestone 0: Foundation (this session, done)

- [x] Eval runner connecting 5 eval environments
- [x] Dead code cleanup (strategy-selector, claudemd-manager)
- [x] VISION.md rewrite — policy agent architecture
- [x] CLAUDE.md alignment — event-driven, confidence graduation
- [x] SOUL.md alignment — RL agent identity
- [x] Architecture audit — all 14 packages + 97 surface files classified
- [x] ROADMAP.md — this document

---

## Milestone 1: Confidence Store — DONE

**New file:** `packages/memory/src/confidence.ts` (169 lines, 17 tests)

- [x] ConfidenceStore class backed by SQLite (confidence.db)
- [x] Schema: confidence, overrides, confidence_log tables
- [x] getConfidence, getLevel, getLevelForScore, update, list, setOverride, getOverride, close
- [x] Signal weights: agree +0.1, disagree -0.15, success +0.05, failure -0.1, transfer +0.02
- [x] Score clamped to [0.0, 1.0], 4 confidence levels
- [x] Operator override support (never-auto / always-auto)
- [x] Full audit logging to confidence_log table
- [x] Export from packages/memory (index.ts + package.json export map)
- [x] 17 unit tests passing
- [x] npm run check + npm test pass (162 tests)

### Action types to register

```
spawn-session, resume-session, create-pr, invoke-skill, run-experiment,
cross-pollinate, send-notification, run-eval, continue-work, do-nothing
```

### Dependencies
- `better-sqlite3` (already in repo deps)
- `packages/memory` (co-locate with session index)

---

## Milestone 2: State Snapshot Builder — DONE

**New file:** `packages/surfaces/src/state-snapshot.ts` (278 lines)

- [x] ForemanState, ProjectState, ForemanEvent, BudgetState interfaces
- [x] buildStateSnapshot() — parallel calls to session-registry, cost-monitor, profiles, memory
- [x] Timeout protection (15s session registry, 10s costs, 5s profile)
- [x] formatStateForLLM() — structured text capped at 3000 chars, priority-based truncation
- [x] Graceful degradation (every call wrapped in try/catch)
- [x] Exported from surfaces/index.ts
- [x] npm run check passes

Previously planned `ForemanState` interface:
  ```
  {
    timestamp: string
    activeProjects: ProjectState[]      // from session-registry + git
    recentEvents: ForemanEvent[]        // last N events from event log
    operatorModel: OperatorModel        // from memory/learning
    experimentResults: ExperimentSummary[] // from traces/evals
    confidenceScores: ConfidenceEntry[] // from confidence store
    pendingSuggestions: Suggestion[]     // proposed but unapproved actions
    profile: OperatorProfile | null     // from user-profiles
    budget: BudgetState                 // from cost-monitor
  }
  ```
- [ ] `ProjectState`:
  ```
  {
    path: string
    name: string
    activeBranches: string[]
    lastSessionAt: string
    ciStatus: 'passing' | 'failing' | 'unknown'
    momentum: 'active' | 'stalled' | 'blocked'
    recentGoals: string[]
  }
  ```
- [ ] `buildStateSnapshot(): Promise<ForemanState>` — calls existing state collectors:
  - session-registry → active projects
  - session-insights → recent goals, operator patterns
  - cost-monitor → budget state
  - confidence store → confidence scores
  - user-profiles → active profile
  - Capped at ~4,000 tokens to fit in LLM context alongside policy prompt
- [ ] `formatStateForLLM(state: ForemanState): string` — renders state as structured text for the policy prompt
- [ ] Unit tests (mock state collectors, verify snapshot shape)
- [ ] `npm run check` passes

### Dependencies
- session-registry, session-insights, cost-monitor, user-profiles (existing)
- confidence store (Milestone 1)

---

## Milestone 3: Policy Function — DONE

**New file:** `packages/surfaces/src/policy.ts` (300 lines)

- [x] Action, ActionOutcome, PolicyDecision types
- [x] decideAction(state) — calls LLM (claude CLI), parses structured JSON
- [x] executeAction(action) — dispatches to session-run, ci-tools, notify, eval-runner
- [x] gateAndExecute(action, confidenceStore) — 4-level confidence gating
- [x] runPolicyCycle() — full cycle: snapshot → decide → gate → execute → log
- [x] Outcome → confidence update (success/failure signals)
- [x] Dry-run mode flag
- [x] Decision logging to ~/.foreman/traces/policy/
- [x] Exported from surfaces/index.ts
- [x] npm run check passes
- [ ] Unit tests with mock LLM (not yet written)
- [ ] Policy prompt versioned in VersionedStore for GEPA optimization (M7 prerequisite)

Previously planned `Action` type:
  ```
  {
    type: 'spawn-session' | 'resume-session' | 'invoke-skill' | 'run-experiment'
        | 'create-pr' | 'cross-pollinate' | 'send-notification' | 'run-eval'
        | 'continue-work' | 'do-nothing'
    project: string
    goal: string
    details: Record<string, string>  // harness, skill name, branch, etc.
    reasoning: string                // why this action (for logging + learning)
    estimatedConfidenceNeeded: number
  }
  ```
- [ ] `decideAction(state: ForemanState): Promise<Action | null>` — the core policy call:
  - Build prompt from state snapshot + policy directive
  - Call LLM (use existing TextProvider from providers package)
  - Parse structured output into Action
  - Return null if "do nothing" is best
- [ ] Policy prompt (versioned in VersionedStore so GEPA can optimize it):
  - System: "You are Foreman, an autonomous agent that decides what to do across the operator's projects."
  - Context: formatted state snapshot
  - Directive: "Given this state, what is the single highest-value action to take right now? If nothing, say so."
  - Output format: JSON matching Action type
- [ ] `executeAction(action: Action): Promise<ActionOutcome>` — dispatches to existing action executors:
  - spawn-session → session-run
  - resume-session → session-run (continue mode)
  - invoke-skill → provider-session with skill invocation
  - run-experiment → worktree-experiment or autoresearch
  - create-pr → ci-tools
  - send-notification → notify
  - run-eval → eval-runner
  - do-nothing → log only
- [ ] `ActionOutcome`:
  ```
  { success: boolean, summary: string, evidence: string[] }
  ```
- [ ] Confidence gate integration:
  ```
  const confidence = store.getConfidence(action.type, action.project)
  const level = store.getConfidenceLevel(confidence)
  if (level === 'dry-run') → log only
  if (level === 'propose') → queue for operator approval
  if (level === 'act-notify') → execute + notify
  if (level === 'autonomous') → execute silently
  ```
- [ ] Outcome → confidence update:
  ```
  if (executed && outcome.success) → updateConfidence('success')
  if (executed && !outcome.success) → updateConfidence('failure')
  if (proposed && operator approved) → updateConfidence('agree')
  if (proposed && operator rejected) → updateConfidence('disagree')
  ```
- [ ] Dry-run mode flag (`--dry-run` forces all actions to dry-run regardless of confidence)
- [ ] Action log: persist every decision (action + reasoning + confidence + outcome) to `~/.foreman/traces/policy/`
- [ ] Unit tests (mock LLM, verify dispatch routing, confidence gating, outcome handling)
- [ ] `npm run check` passes

### Dependencies
- state-snapshot (Milestone 2)
- confidence store (Milestone 1)
- providers/TextProvider (existing)
- core/VersionedStore (existing, for policy prompt versioning)
- All action executors (existing surfaces)

---

## Milestone 4: Event Loop / Daemon — DONE

**New files:** `packages/surfaces/src/foreman-daemon.ts` (225 lines), `foreman-daemon-cli.ts` (30 lines)

- [x] ForemanEvent type (11 event types)
- [x] Phase A: Poll timer (configurable interval, default 5 min)
- [x] Phase B: File watchers on session dirs (~/.claude, ~/.pi, ~/.codex)
- [x] Event loop: event → state → policy → confidence gate → execute/log
- [x] Debouncing (5s batching of rapid events)
- [x] Deduplication (identical events within 1s collapsed)
- [x] Rate limiting (1 policy call/min, 10 actions/hour)
- [x] Graceful shutdown (SIGTERM/SIGINT)
- [x] Logging to ~/.foreman/logs/daemon.log
- [x] CLI: `npm run foreman:daemon` (dry-run default, --live to enable)
- [x] --watch flag for git repo monitoring
- [x] VERIFIED: first live dry-run produced reasonable policy decision
- [x] Exported from surfaces/index.ts, script in package.json
- [ ] Phase C: GitHub webhook receiver (wire into api-server)
- [ ] Phase D: Pi/Claude Code hook integration
- [ ] Systemd unit file
- [ ] Integration tests

Previously planned `ForemanEvent` type:
  ```
  {
    type: 'session-started' | 'session-ended' | 'ci-status-changed' | 'git-push'
        | 'experiment-completed' | 'operator-message' | 'webhook' | 'timer'
        | 'file-changed' | 'approval-received' | 'rejection-received'
    project: string
    timestamp: string
    data: Record<string, string>
  }
  ```
- [ ] Event sources (implement incrementally):
  - **Phase A (minimum viable):** Poll-based timer (every 5 min, check git status + CI across managed repos)
  - **Phase B:** File watchers on session dirs (~/.claude/, ~/.pi/) using `fs.watch` or chokidar
  - **Phase C:** GitHub webhook receiver (reuse existing api-server webhook endpoint)
  - **Phase D:** Pi/Claude Code hook integration (PostToolUse, Notification hooks)
- [ ] Event loop:
  ```
  while (running) {
    event = await nextEvent()       // from any source
    state = await buildSnapshot()   // incorporate event
    action = await decideAction(state)
    if (action) await gateAndExecute(action)
  }
  ```
- [ ] Debouncing: batch rapid events (e.g., many file changes) into single policy call
- [ ] Rate limiting: max 1 policy call per minute (configurable), max 10 actions per hour
- [ ] Health endpoint: `/health` returns last event time, last action, uptime
- [ ] Graceful shutdown (SIGTERM/SIGINT)
- [ ] Logging to `~/.foreman/logs/daemon.log` (rotate daily)
- [ ] CLI: `npm run foreman:daemon` (foreground) and `npm run foreman:daemon -- --background` (daemonize)
- [ ] Systemd unit file: `scripts/foreman-daemon.service`
- [ ] Integration test: start daemon, inject mock event, verify policy called, verify action dispatched or logged
- [ ] `npm run check` passes

### Dependencies
- policy (Milestone 3)
- state-snapshot (Milestone 2)
- confidence store (Milestone 1)
- api-server (existing, for webhook receiver)

---

## Milestone 5: Dry-Run Validation — IN PROGRESS

**Goal:** Run the full pipeline in dry-run for 48+ hours. Verify it makes sensible decisions without acting. Build trust before graduation.

**First run completed 2026-03-21.** Policy read skill performance data (5% success rate) and decided "run-experiment on foreman — fix skill reliability before anything else." Confidence gate correctly blocked execution (score 0.00, dry-run). Decision logged.

### Checklist

- [x] Start daemon with `--dry-run` flag
- [x] Verify events arrive from: session dir watchers
- [x] Verify state snapshots are well-formed (inspect `~/.foreman/traces/policy/`)
- [ ] Verify policy decisions are reasonable (manual review of action log):
  - Does it identify stalled work correctly?
  - Does it suggest the right action type?
  - Does it pick the right project?
  - Would the operator have done this?
- [ ] Count: how many decisions per day? (target: 10-50)
- [ ] Count: how many would the operator agree with? (target: >60% for initial)
- [ ] Verify no side effects (no sessions spawned, no PRs created, no notifications sent)
- [ ] Identify policy prompt improvements from the log
- [ ] Verify confidence scores start at 0.0 and don't change (no actions executed)
- [ ] Fix any event loop stability issues (crashes, memory leaks, hung watchers)
- [ ] Document findings in `~/.foreman/traces/policy/dry-run-report.md`

### Success criteria
- Daemon runs 48h without crash
- Policy log shows ≥30 reasonable decisions
- ≥60% of decisions match what operator would have chosen
- Zero side effects

---

## Milestone 6: Confidence Graduation

**Goal:** Allow the system to graduate from dry-run to proposing. Start with one action type on one project.

### Checklist

- [ ] Pick safest action type to graduate first: `send-notification` (reversible, low-stakes)
- [ ] Pick most familiar project (highest session count in index)
- [ ] Manually seed confidence to 0.3 (propose threshold) for that pair
- [ ] Daemon proposes notifications → operator approves/rejects
- [ ] Verify confidence updates correctly on each signal
- [ ] After ≥10 approvals, confidence should reach ~0.6 (act-notify zone)
- [ ] Verify act-notify mode works (sends notification, logs immediately)
- [ ] Repeat with next action type: `resume-session`
- [ ] Repeat with next action type: `invoke-skill`
- [ ] After 1 week: review confidence distribution across all action-type/project pairs
- [ ] Verify no action type graduated to autonomous without ≥20 positive signals

### Success criteria
- ≥3 action types graduated past dry-run on ≥1 project
- Zero actions taken that operator would have rejected
- Confidence scores track actual reliability

---

## Milestone 7: Self-Improvement Loop

**Goal:** Close the RL loop. Policy improves from outcomes.

### Checklist

- [ ] Wire policy prompt into VersionedStore (kind: 'policy', name: 'main')
- [ ] After N actions with outcomes, generate policy prompt variant via LLM
- [ ] Score variants by: operator agreement rate, action success rate, cost efficiency
- [ ] GEPA optimization on policy prompt (reuse existing optimizer infrastructure)
- [ ] Auto-promote winning policy variant (same mechanism as nightly-optimize)
- [ ] Track meta-metrics: decisions/day, agreement rate, success rate, cost/decision
- [ ] Skill generation: when the policy repeatedly suggests similar action patterns, propose a new skill
- [ ] Cross-pollination: when confidence is high for (actionType, projectA), seed (actionType, projectB) with transfer signal
- [ ] Weekly self-assessment: policy reviews its own decision log and identifies improvements

### Dependencies
- optimizer/GEPA (existing)
- versioned store (existing)
- eval infrastructure (existing)

---

## Milestone 8: Recursion + Multi-Project

**Goal:** Foreman can manage multiple projects simultaneously and spawn sub-Foreman instances.

### Checklist

- [ ] Register `foreman` as a provider in packages/providers (alongside claude, codex, pi, opencode)
- [ ] ForemanProvider spawns a child Foreman daemon scoped to one project
- [ ] Child maintains its own confidence scores, state, policy log
- [ ] Parent cross-pollinates: high-confidence learnings from child A → transfer signal to child B
- [ ] Parent policy decides at portfolio level: which project needs attention?
- [ ] Verify: parent spawns child → child runs autonomously → parent reads child outcomes
- [ ] Resource management: max N concurrent children (budget-aware)

---

## Future milestones (unscheduled)

**Pi Extension Integration:**
- Foreman daemon ↔ Pi extension bidirectional communication
- Pi extension sends events (session start/end, tool calls, skill invocations)
- Foreman daemon sends context (operator model, confidence, suggestions)
- TUI widget showing Foreman's current state and next proposed action

**Autoresearch Integration:**
- Foreman watches autoresearch.jsonl files across projects
- Learns which experiment patterns produce real improvements
- Autonomously starts autoresearch loops in projects where it has confidence
- Cross-pollinates optimization patterns across projects

**Skill Generation:**
- When policy repeatedly suggests similar action sequences, crystallize into a skill
- Test skill in eval environment
- Promote if it outperforms the raw action sequence
- Deprecate skills that stop producing value

**AxLLM Meta-Optimization:**
- GEPA optimizes the policy prompt
- GEPA optimizes the state snapshot format
- GEPA optimizes confidence signal weights
- Outer loop: GEPA optimizes GEPA's own parameters

---

## Directory structure (target)

```
packages/
  core/           — contracts, runtime, versioned store (KEEP)
  tracing/        — trace store, search (KEEP)
  memory/         — memory store, session index, learning, confidence store (KEEP + ADD)
  workers/        — worker registry, adapters (KEEP)
  providers/      — claude/codex/pi/opencode/foreman drivers (KEEP + ADD foreman)
  environments/   — git/document/service observation (KEEP)
  profiles/       — operator modeling, work discovery (KEEP)
  evals/          — eval pipeline, judges, failure taxonomy (KEEP)
  optimizer/      — GEPA, variant scoring, policy store, task hardening (KEEP + ABSORB planning)
  sandbox/        — sandbox adapter (KEEP)
  tangle/         — tangle integration (KEEP)
  sdk/            — public re-exports (KEEP)
  surfaces/src/
    # NEW — the policy agent
    policy.ts               — decideAction(state) → Action (THE PRODUCT)
    state-snapshot.ts       — buildStateSnapshot() → ForemanState
    foreman-daemon.ts       — event loop + confidence gating
    foreman-daemon-cli.ts   — CLI entry point for daemon

    # EXISTING — state collectors (data sources for policy)
    session-metrics.ts      — extract metrics from sessions
    session-insights.ts     — extract patterns from session histories
    session-analysis.ts     — deep cross-repo analysis
    session-registry.ts     — track active sessions
    skill-tracker.ts        — skill invocation tracking
    intent-engine.ts        — campaign/intent modeling
    cost-monitor.ts         — spend tracking
    operator-adaptation.ts  — operator runtime context
    async-replan.ts         — replan trigger detection

    # EXISTING — action executors (tools for policy)
    ci-tools.ts             — git/gh operations
    ci-diagnosis.ts         — CI failure analysis
    notify.ts               — telegram/slack/webhook
    engineering-tools.ts    — harden, dispatch, observe, validate
    session-run.ts          — spawn/continue sessions
    provider-session.ts     — low-level provider dispatch
    retrieve-traces.ts      — download remote traces
    sync-operator.ts        — persist operator state
    schedule.ts             — job scheduling
    golden-suite-generator.ts — extract golden test cases

    # EXISTING — eval/self-improvement
    benchmark-env.ts        — TerminalTaskEnv, SWEBenchEnv, MultiHarnessEnv
    ci-repair-env.ts        — CIRepairEnv
    report-quality-env.ts   — ReportQualityEnv
    eval-runner.ts          — unified eval runner
    worktree-experiment.ts  — isolated experiments
    judge-calibration.ts    — calibrate judges
    operator-learning-eval.ts — eval operator modeling

    # EXISTING — replay/benchmark (keep for diagnostics)
    session-replay.ts, session-benchmark.ts
    browser-replay.ts, browser-benchmark.ts, browser-supervision.ts
    engineering-replay.ts, engineering-benchmark.ts
    supervisor-run.ts, supervisor-replay.ts, supervisor-benchmark.ts
    trace-benchmark.ts, environment-observe.ts

    # EXISTING — support
    user-profiles.ts        — profile management
    profile-bootstrap.ts    — bootstrap from sessions
    daily-report.ts         — report rendering
    api-server.ts           — HTTP API + webhook receiver
    index.ts                — exports
    run.ts, session-provider-args.ts

    # EXISTING — all *-cli.ts thin wrappers (keep)

    # DEPRECATED — pre-decided policy (replace over time, don't delete yet)
    operator-loop.ts        — replaced by daemon + policy
    engineering-foreman.ts  — replaced by policy
    environment-foreman.ts  — replaced by policy
    hybrid-foreman.ts       — replaced by policy
    work-discovery.ts       — replaced by policy
    work-continuation.ts    — replaced by policy
    session-review.ts       — replaced by policy
    nightly-optimize.ts     — orchestration replaced by policy (utilities kept)
    variant-generator.ts    — selection replaced by policy (generation kept)
    prompt-optimizer.ts     — selection replaced by policy

scripts/
  run-heartbeat.sh          — DEPRECATED by daemon (keep until daemon stable)
  run-daily-report.sh       — DEPRECATED by daemon
  run-nightly-optimize.sh   — DEPRECATED by daemon
  foreman-daemon.service    — NEW: systemd unit for daemon
```

---

## Dependency graph (build order)

```
Milestone 1: confidence store
  depends on: memory package (existing), better-sqlite3 (existing)

Milestone 2: state snapshot
  depends on: confidence store (M1), existing state collectors

Milestone 3: policy function
  depends on: state snapshot (M2), confidence store (M1),
              providers/TextProvider, core/VersionedStore,
              all action executors (existing)

Milestone 4: daemon
  depends on: policy (M3), state snapshot (M2), confidence store (M1),
              api-server (existing)

Milestone 5: dry-run validation
  depends on: daemon (M4), running for 48h

Milestone 6: confidence graduation
  depends on: dry-run validation (M5), operator interaction

Milestone 7: self-improvement
  depends on: graduation (M6), optimizer/GEPA (existing)

Milestone 8: recursion
  depends on: self-improvement (M7), new foreman provider
```

---

## What to hope for

**If this works:**
- Foreman starts as a silent observer logging what it would do
- After a week of operator feedback, it graduates to proposing actions
- After a month, it autonomously resumes sessions, invokes skills, and manages CI
- After three months, it discovers new optimization patterns the operator didn't think of
- Eventually, it runs the explore-exploit loop better than the operator alone

**If this partially works:**
- The state snapshot alone is valuable (portfolio-level awareness)
- The confidence system alone is valuable (no more "flip the switch" anxiety)
- The policy log alone is valuable (see what an agent would recommend)
- Dry-run mode alone is valuable (learn from the gap between agent decisions and operator decisions)

**If this doesn't work:**
- The policy LLM makes garbage decisions → the confidence system prevents harm (stays in dry-run)
- The state snapshot is too large for context → we learn what information actually matters
- Events arrive too fast → the rate limiter prevents thrashing
- The confidence math is wrong → we observe and recalibrate from the log

The design is deliberately fail-safe. The worst case is "a really good logging system."

---

## What not to do

- Don't add more pre-decided workflows (operator-loop, foreman variants)
- Don't add standalone CLIs — add tools the policy agent can invoke
- Don't optimize prompts before the signal quality is validated
- Don't build the Pi extension integration before the daemon is stable
- Don't skip the dry-run validation (Milestone 5) — this is where we learn if the architecture works
- Don't manually seed confidence above 0.3 — let it graduate from evidence
- Don't delete the deprecated files yet — keep them as reference until the policy agent covers their functionality
