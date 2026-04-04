---
# Decision 009: Hermes, Hyperagents, and autoresearch — What Foreman Should Copy vs Avoid

Date: 2026-03-26
Status: RESEARCH
Origin: Human request for a refreshed roadmap grounded in current agent systems

## Sources

- Hermes Agent repo and README: https://github.com/NousResearch/hermes-agent
- Hyperagents paper: https://arxiv.org/abs/2603.19461
- Hyperagents code: https://github.com/facebookresearch/HyperAgents
- autoresearch repo and README: https://github.com/karpathy/autoresearch

## Executive Take

Foreman should not try to "become Hermes", "replicate Hyperagents", or "turn into autoresearch".

It should do three narrower things:

1. Copy Hermes on product UX, installation, diagnostics, backends, and operator-facing ergonomics.
2. Copy autoresearch on narrow, measurable, replayable optimization loops.
3. Copy Hyperagents only at the meta-architecture level: editable improvement logic, cross-run transfer, and self-improvement as a first-class object.

It should avoid copying:

1. Hermes-scale feature sprawl before the core execution and telemetry paths are fully hardened.
2. Hyperagents-style open-ended self-modification on the whole Foreman repo before sandboxing, replay, and promotion gates are strong.
3. autoresearch's "single benchmark is the whole world" bias when Foreman's product surface is multi-goal, multi-repo, and human-in-the-loop.

## Comparative Read

### Hermes

What stands out from the current Hermes repo:

- The repo is large and productized: 13.6k stars, 2,708 commits, many sub-systems, multiple backends, gateways, docs, tests, and setup surfaces.
- It is explicitly framed around DX and continuity:
  - built-in learning loop and persistent memory
  - multi-platform gateway
  - multiple terminal backends
  - `hermes setup`
  - `hermes doctor`
- The README emphasizes "run anywhere", "choose any model", "gateway + CLI", and "full setup wizard".

What matters for Foreman:

- Hermes is strongest as a product benchmark, not as a research benchmark.
- Hermes demonstrates that good agent products are not just "agent loops"; they are installable, diagnosable, reconfigurable systems.

What Foreman should copy:

- Setup wizard
- Doctor command
- Strong backend abstraction
- Explicit docs for config and security
- Clear user-facing capability boundaries
- Gateway support as an optional extension, not a hidden assumption

What Foreman should avoid copying:

- Massive surface area before the core Foreman loop is truly stable
- Broad model/provider abstraction too early if the telemetry and policy logic do not yet use it well
- Memory/skills sprawl without strong measurement of user value

Confidence:

- 90-95%: Hermes-style onboarding/doctor/backends improve adoption and reduce support burden.
- 80-90%: Hermes-style multi-backend support matters for Foreman's long-term product viability.
- 70-80%: copying Hermes-level gateway breadth now would be premature.

### Hyperagents

What stands out from the current paper and repo:

- The paper's central claim is editable self-improvement:
  - task agent and meta agent are part of one editable program
  - the modification procedure is itself editable
  - meta-level improvements transfer across domains and accumulate across runs
- The public repo is research-oriented, not product-oriented:
  - limited commit history
  - heavy setup
  - explicit warning about executing untrusted model-generated code
  - outputs/log archives and domain scripts

What matters for Foreman:

- Hyperagents is the strongest current argument for making the improvement process itself a first-class, editable target.
- It is not a plug-and-play architecture for a user-facing agent product.
- The safety story is still research-grade, not production-grade.

What Foreman should copy:

- Treat self-improvement policy as code, not magic
- Make improvement loops replayable and inspectable
- Preserve artifacts across runs
- Evaluate whether improvements transfer across projects, not just within one repo

What Foreman should avoid copying:

- Open-ended self-modification on the service code path right now
- Letting the same live production process both mutate and promote itself
- Assuming that research wins on synthetic tasks will automatically map to operator value

Confidence:

- 80-90%: Hyperagents is the right long-term conceptual direction for Foreman's self-improvement layer.
- 75-85%: Foreman should adopt "editable improvement logic" sooner than full repo self-modification.
- 85-95%: full Hyperagents-style self-modification now would create more instability than value.

### autoresearch

What stands out from the current repo:

- Extreme narrowness:
  - one main file the agent edits
  - one human-controlled `program.md`
  - one metric
  - one fixed time budget
  - one bounded experiment loop
- The design is intentionally constrained to keep the optimization problem legible.
- The system is easy to reason about because success and failure are sharply defined.

What matters for Foreman:

- autoresearch is the cleanest design reference for "self-improvement without chaos".
- It proves that narrow scope plus fast accept/reject loops can still produce meaningful agent-driven iteration.
- Its strongest lesson is not "train models overnight"; it is "make the improvement target small enough to trust."

What Foreman should copy:

- One-surface-at-a-time optimization
- Fixed-budget experiment loops
- Stable evaluation harnesses
- Keep/discard promotion discipline
- Human edits the program of the optimizer, not the task code every time

What Foreman should avoid copying:

- Single-metric thinking for a multi-goal orchestration system
- Assuming a single edit surface is enough for portfolio orchestration
- Overfitting to local improvements that do not generalize to operator workflows

Confidence:

- 90-95%: autoresearch-style narrow loops are the best immediate template for Foreman's self-improvement work.
- 80-90%: Foreman should optimize one bounded subsystem at a time, not the full stack at once.
- 70-80%: Foreman can reuse this pattern for prompt policy, dispatch policy, and verifier tuning.

## Direct Proposals

### Proposal A: Make replay and evaluation the core self-improvement substrate

Build a replay harness over historical dispatches and outcomes:

- input: archived decision context, repo metadata, prior operator state
- output: proposed action, selected skill, model/backend choice, expected deliverable
- score against:
  - verified deliverable outcome
  - operator feedback
  - cost
  - intervention rate

Why:

- This is the safest bridge between today's Foreman and Hyperagents-style improvement.
- It turns policy changes into offline-evaluable artifacts before they touch live repos.

Avoid:

- live self-modification without replay
- reward functions defined only by session completion

Confidence:

- 85-92% that this is the highest-leverage next research substrate.

### Proposal B: Finish telemetry producer wiring before broadening model/backend choice

The telemetry sink exists or is in flight; the next step is producer completeness:

- Claude Code dispatch path
- Codex path
- Pi path
- Opencode path
- future direct API workers

Why:

- Without producer-complete telemetry, model routing and cost controls remain partly fictional.
- Hermes can afford broad provider support because its product surface already assumes operational infrastructure. Foreman should earn that breadth.

Do:

- normalized event schema
- mandatory event key
- harness/provider/model attribution
- per-goal and per-project budget views

Avoid:

- adding providers first and observability later

Confidence:

- 88-95% this should precede serious multi-model expansion.

### Proposal C: Treat backend abstraction as product-critical, not optional polish

Foreman should graduate from tmux-first to backend-first:

- local/tmux
- Docker
- remote sandbox
- structured provider runtime later

Why:

- Hermes shows the market expectation: agents must run somewhere reliable, resumable, and inspectable.
- tmux is useful but too brittle to be the final execution substrate.

Do:

- normalize session metadata
- normalize artifacts and logs across backends
- normalize kill/idle/check lifecycle

Avoid:

- UI or gateway expansion that assumes tmux remains the only serious runtime

Confidence:

- 80-90% that Docker backend is more important than Slack/Discord expansion.

### Proposal D: Constrain self-improvement targets the way autoresearch constrains train.py

Foreman should not start with "improve Foreman."
It should start with:

1. improve dispatch-policy prompts
2. improve prompt-composer sections
3. improve verifier prompts/rubrics
4. improve plan ranking policy

Each target is a bounded subsystem, not necessarily a single file.
It can span multiple modules if they serve one measurable objective.

Each target gets:

- fixed eval set
- fixed budget
- explicit acceptance threshold
- automatic rollback on regressions

Why:

- This is the safest way to get real self-improvement wins that can accumulate.

Avoid:

- whole-repo mutation
- multi-module self-modification as the first step

Confidence:

- 90-95% that this is the correct near-term self-improvement strategy.

## Recommended Priority Order

1. Replay harness and offline policy evaluation
2. Producer-complete telemetry
3. Service integration and end-to-end tests
4. Docker backend
5. Narrow self-improvement loops on policy/prompt/verifier layers
6. External beta install and operator study
7. Only then: broader multi-model routing and stronger autonomous planning
8. Much later: self-modifying Foreman service code

## Decision

Foreman should position itself as:

- Hermes on UX discipline
- autoresearch on optimization discipline
- Hyperagents on long-term self-improvement direction

But it should adopt each at different layers and different times.

That is the clearest path that preserves product quality while still pursuing the research thesis.
