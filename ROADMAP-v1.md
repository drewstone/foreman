# Foreman Roadmap v1

Date: 2026-03-26
Status: refreshed after module split, `.evolve` migration, telemetry design, and installer/onboarding work

This roadmap replaces the older "tests: 0 / cost tracking missing" framing. That was useful during the first build sprint, but it is now stale and misleading.

The correct next question is no longer "can Foreman do anything real?"
It is:

1. Can Foreman measure itself honestly?
2. Can it improve itself safely?
3. Can someone other than Drew install and trust it?

The rest of the roadmap follows from those three questions.

## Where Foreman Is Strong

- Portfolio orchestration across goals, repos, and skills
- Honest deliverable verification and scope enforcement
- Session mining and operator-learning as a product differentiator
- Clear service architecture with a split `service/lib` surface
- Early web dashboard, plans, confidence, and taste primitives

## Where Foreman Is Still Weak

- Direct service integration coverage is still thin
- Runtime substrate is still too tmux-centric
- Cost/telemetry wiring is not yet producer-complete across all harnesses
- External-user onboarding is only now becoming product-grade
- Self-improvement is conceptually promising but still under-instrumented

## Strategic Position

Foreman should not chase other systems wholesale.

It should combine:

- Hermes for product UX and operational ergonomics
- autoresearch for narrow, measurable optimization loops
- Hyperagents for long-term self-improvement architecture

See [`009-agent-landscape-hermes-hyperagents-autoresearch.md`](./research/decisions/009-agent-landscape-hermes-hyperagents-autoresearch.md) for the detailed comparison.

## Phase 1: Make The System Measurable

### 1. Replay Harness For Policy Evaluation

Build an offline replay harness over historical decisions and verified outcomes.

Why:

- This is the missing substrate for safe self-improvement.
- Policy changes should be tested against old work before they touch live repos.

Deliverables:

- archived decision bundles
- replay evaluator
- scorecards for skill selection, intervention rate, cost, and deliverable outcome

Priority: P0
Confidence: 85-92%

### 2. Producer-Complete Telemetry

Foreman needs one normalized telemetry sink across:

- Claude Code
- Codex
- Pi
- Opencode
- future direct API providers

Why:

- Cost controls, routing, and dashboard views are only as good as the completeness of their inputs.

Deliverables:

- normalized run schema
- ingestion for every producer path
- budget views by harness, model, repo, and goal

Priority: P0
Confidence: 88-95%

### 3. CI For The Real Critical Path

Current tests are useful, but the most important product path is still under-tested.

Add CI for:

- `npm test`
- service API smoke tests
- dispatch -> harvest -> verify -> telemetry integration
- installer smoke test on clean machine

Priority: P0
Confidence: 90-95%

## Phase 2: Make The Runtime Reliable

### 4. Backend-First Execution Model

Foreman should stop behaving like a tmux product that happens to have abstractions.
It should behave like a backend-oriented system where tmux is just one backend.

Target backends:

- local tmux
- Docker
- remote sandbox
- structured provider runtime later

Why:

- This is the bridge from "works on Drew's machine" to "works as a product."

Priority: P1
Confidence: 80-90%

### 5. Normalize Session Lifecycle Across Backends

Every backend should share the same lifecycle shape:

- spawn
- inspect
- idle detection
- kill
- transcript/artifact capture
- telemetry emission

Priority: P1
Confidence: 80-88%

## Phase 3: Constrain Self-Improvement

### 6. Optimize One Layer At A Time

Foreman should not start self-improvement by mutating the whole service.

Start with bounded layers:

1. dispatch-policy prompts
2. prompt-composer sections
3. verifier prompts/rubrics
4. plan ranking policy

Each optimization loop should have:

- fixed eval set
- fixed budget
- explicit promotion threshold
- automatic rollback on regression

Priority: P1
Confidence: 90-95%

### 7. Cross-Project Transfer Checks

Borrow the key Hyperagents insight without copying the risky parts:

- improvements should be tested for transfer across projects
- meta-level wins matter more than one-off local wins

Priority: P1
Confidence: 75-85%

### 8. Avoid Full Repo Self-Modification For Now

Do not prioritize open-ended service self-modification yet.

Reasons:

- weak replay substrate
- incomplete backend hardening
- insufficient promotion/rollback machinery
- research value does not yet outweigh operational risk

Priority: explicitly deferred
Confidence: 85-95%

## Phase 4: Make It Trustable For External Users

### 9. Installer, Setup, Doctor, and Documentation

The goal is not just "install succeeds."
The goal is:

- capability-by-capability explanation
- explicit consent before enabling surfaces
- diagnosis when something is broken
- repeatable reconfiguration

Priority: P1
Confidence: 90-95%

### 10. First External Beta

Install Foreman for a real non-Drew user and observe:

- where onboarding is confusing
- what assumptions break
- what features are noise vs necessary

Priority: P2
Confidence: 80-90%

## Phase 5: Expand Product Surface Carefully

### 11. Multi-Model Routing

Multi-model support should follow telemetry and replay, not precede them.

Why:

- without comparable cost/outcome data, routing is mostly vibes

Priority: P2
Confidence: 75-85%

### 12. Messaging Gateways

Telegram/Slack/Discord matter, but they are not the core blocker now.
They should be treated as optional extensions on top of a reliable core.

Priority: P2
Confidence: 70-80%

## Untested Or Under-Tested Surfaces

These are the main gaps that still deserve explicit attention:

- [`service/lib/harvester.ts`](./service/lib/harvester.ts)
- [`service/lib/session-manager.ts`](./service/lib/session-manager.ts)
- [`service/lib/watcher.ts`](./service/lib/watcher.ts)
- [`service/lib/learning-loop.ts`](./service/lib/learning-loop.ts)
- [`service/lib/prompt-composer.ts`](./service/lib/prompt-composer.ts)
- [`gateway/telegram.ts`](./gateway/telegram.ts)
- [`gateway/slack.ts`](./gateway/slack.ts)
- real systemd installer path
- real remote backend paths

## Immediate Next 5

1. Build replay harness for historical decisions and outcomes
2. Finish telemetry wiring across all producers
3. Add API/integration CI for the real dispatch pipeline
4. Ship Docker backend as the next serious runtime
5. Run narrow self-improvement loops on policy and verifier layers

## Avoid List

Do not spend the next cycle on:

- whole-repo self-modification
- broad gateway expansion before runtime hardening
- provider sprawl before telemetry completeness
- memory/skills surface growth without measurement
- benchmark theater without operator-value evaluation

## Success Criteria For The Next Milestone

Foreman should be able to say, credibly:

- every dispatched run has normalized telemetry
- policy changes can be replay-tested offline
- a clean install is CI-validated
- at least one non-tmux backend is production-usable
- one bounded self-improvement loop improves without regressions

That is the shortest path to a product that is also a real research platform.
