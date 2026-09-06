# Foreman

Foreman turns operator goals into dispatched work and checked outcomes across code, research, marketing, and strategy.
Read [VISION.md](VISION.md) for the product intent.
The work unit is a goal, which may span repositories and execution backends.

## Boundaries

The conversation makes judgments about priorities, skill selection, quality, and whether to continue or change direction.
The service owns durable state, session lifecycle, events, accounting, and execution constraints.
It must enforce authorization and resource limits without choosing the operator's research or product strategy.
The Pi extension stays a client of that service.
Behavioral guidance belongs in skills rather than duplicated conditional workflows in service code.

For service changes, inspect `service/` and its focused tests.
For extension changes, inspect `pi-package/` and the tools it currently exposes.
For shared storage, indexing, and execution behavior, inspect the owning package under `packages/`.
Read commands from `package.json` rather than copy an inventory here.

## Autonomy and learning

Operator approval, rejection, corrections, and outcomes inform taste and confidence.
Preserve their attribution and scope.
Read `packages/memory/src/confidence.ts` and its tests when changing confidence levels or overrides.
Read `service/lib/auto-dispatch.ts` when changing how confidence controls automatic execution.
A numeric confidence score does not replace an explicit permission boundary.

Measure whether dispatched work achieves the goal.
Keep supported improvements and record failures without turning one successful workflow into a fixed strategy for every goal.
Avoid adding infrastructure unless it improves a concrete operator outcome.
