# Foreman Roadmap v1

Date: 2026-03-27
State: governance and operator-control phase

## Where Foreman Actually Is

Foreman is no longer just a tmux orchestrator.

The core system now exists in four layers:
- execution and session management
- telemetry and budget control
- replay and promotion governance
- policy optimization for dispatch and prompt surfaces

What is real today:
- service installer, setup flow, and `foreman doctor`
- normalized telemetry sink with import/backfill
- daily budget visibility and budget blocking
- replay dataset export and replay policy evaluation
- staged dispatch policy with operator-session learning
- structured prompt policy and prompt-policy governance
- unified dashboard model with project recommendations
- `185` passing tests

What is still not true:
- runtime is not production-grade yet
- counterfactual evaluation is still approximate
- external-user readiness is not proven
- roadmap/docs have lagged the implementation

## Product Thesis

Foreman should become a governed autonomy system for a portfolio of projects:
- measure everything
- learn from both autonomous runs and operator behavior
- optimize bounded policy surfaces
- promote changes only when replay and telemetry justify them
- tell the operator where to research, optimize, or loop next

## Current Architecture

### 1. Execution Layer
- tmux-backed sessions
- worktree isolation
- deliverable verification
- scope enforcement

### 2. Measurement Layer
- telemetry sink for harness/provider/model/repo/skill/cost/tokens
- telemetry import from local artifacts
- coverage and freshness reporting
- daily budget controls

### 3. Governance Layer
- replay dataset and replay summaries
- replay candidate-vs-baseline policy evaluation
- promotion rules and persisted promotion history
- prompt policy observational evaluation and promotion

### 4. Optimization Layer
- staged dispatch policy: choose `mode + skill`, then synthesize task text
- structured prompt policy: optimize configuration, not raw prompt blobs
- operator session mining as training signal

## What Is Done

### Foundation
- tests are in place and growing
- installer and reconfiguration UX exist
- service module split is done
- dashboard exists and is now meaningful

### Measurement
- telemetry sink is implemented
- telemetry imports and source mix reporting exist
- cost is visible by harness/provider/model/repo/skill
- coverage and orphan-telemetry reporting exist

### Governance
- dispatch replay evaluation exists
- replay promotion/apply flow exists
- replay governance history exists
- prompt policy evaluation and promotion now exist

### Operator UX
- dashboard answers “where should Drew point autonomy next?”
- project recommendations exist for:
  - `autoresearch`
  - `optimize`
  - `loop`
- dataset health warnings exist for:
  - replay sparsity
  - telemetry gaps
  - training skew
  - prompt-policy sample thinness

## Main Gaps

### 1. Runtime Hardening
- tmux remains brittle
- no Docker backend yet
- no Agent SDK/runtime migration yet

### 2. Evaluation Quality
- replay is strong enough to guide, not strong enough to prove
- prompt policy evaluation is observational, not counterfactual
- counterfactual labels and trajectory understanding should get richer

### 3. Operator Query Layer
- dashboard is better, but the question-answering layer is still thin
- project recommendation API exists, but not a richer natural-language or interactive filter UX

### 4. External Validation
- no real beta deployment proving install, onboarding, and operations on someone else’s machine

## Highest-Value Priorities

### Priority 1. Consolidate Control Surfaces
- keep the dashboard, recommendation API, telemetry, replay, and policy governance on one coherent data model
- avoid one-off observability features

### Priority 2. Strengthen Prompt Governance
- move prompt policy from observational comparison toward stronger replay-like promotion criteria where possible
- make prompt-policy promotion as interpretable as dispatch-policy promotion

### Priority 3. Better Question Layer
- answer questions like:
  - what should Drew auto-research next across these repos?
  - which project is safe to loop harder on?
  - where are we spending money without improving deliverables?
  - which policy changes improved outcomes and which only moved cost?

### Priority 4. Runtime Upgrade
- add Docker backend
- reduce dependence on tmux scraping
- prepare for a more structured agent runtime

### Priority 5. External User Proof
- run installer and onboarding with a real external user
- measure what breaks first

## Explicit Do / Avoid

Do:
- optimize bounded subsystems, not the whole product at once
- keep raw metrics and vector objectives
- gate policy changes through replay or observed-governance checks
- learn from operator sessions, but measure skew

Avoid:
- freeform full-prompt optimization as the main control surface
- broad autonomy expansion before telemetry and governance stay honest
- adding more disconnected dashboards or analytics endpoints
- treating replay as proof rather than evidence

## Suggested Near-Term Sequence

1. Finish consolidating the dashboard and query layer.
2. Use the query layer operationally for a week across your real projects.
3. Refresh promotion thresholds based on real usage and observed false positives.
4. Add Docker backend.
5. Do first external-user install and beta.

## Success Markers

Foreman is on track if:
- operators can see where to spend autonomy clearly
- prompt and dispatch policy changes are both governed
- telemetry coverage stays high enough to trust cost signals
- the system can recommend projects to research, optimize, or loop without hand-auditing raw tables
- runtime upgrades do not break the governance layer
