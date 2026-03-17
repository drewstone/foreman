# Foreman Repo Plan

## Core framing

Foreman is a harness that coordinates workers across environments.

The main semantic model is:

- `Task`
  A unit of work with success criteria.
- `Environment`
  The world the task operates in.
- `Worker`
  A specialist agent that can act in or reason about that environment.
- `Trace`
  The structured record of the run.
- `Evaluation`
  The process that decides whether the outcome was actually good.
- `Memory`
  The distilled knowledge learned from prior traces.

## What is an environment?

An environment is not necessarily the same thing as a repo.

A repo is often one environment target, but the abstraction is broader.

Examples:

- A single code repo can be one `code` environment.
- A deployed web app can be one `browser` environment.
- A repo plus its running app plus CI plus logs can be a `hybrid` environment.
- A tax workspace with documents, generated forms, and validation scripts can be a `document` + `shell` hybrid environment.

The clean rule is:

- `environment kind` describes the interaction model
- `environment target` identifies the concrete system being worked on

So yes, a project or repo can be treated as an environment target, but not every task should collapse all work to “one repo = one environment.”

## How Foreman improves over time

Foreman should improve in two different ways:

### 1. Runtime improvement without model retraining

This is the default path and should provide most near-term gains.

Foreman gets better in the same environment by learning:

- which workers perform best for which task shapes
- which validation gates catch real failures
- which failure classes recur
- which repair strategies resolve those failures
- environment-specific facts and invariants
- reliable commands, selectors, routes, and checkpoints

This is memory, retrieval, and policy improvement, not weight updates.

### 2. Offline learning from traces

Every run should emit structured traces that can later support:

- replay
- benchmark generation
- judge calibration
- ranking
- preference datasets
- RL-style reward modeling

The core rule is:

Foreman should emit data now that can be used for learning later, even if no training loop exists yet.

## What it learns in the same environment

Foreman should maintain memory at three levels:

### Environment memory

Facts about a specific environment target:

- architecture summaries
- known invariants
- common failure modes
- required validation steps
- trusted commands and entrypoints
- stable browser/workflow landmarks

### Worker performance memory

Empirical data about workers:

- success rate
- cost
- latency
- common failure classes
- best-fit task types

### Strategy memory

What tends to work:

- repair recipes
- escalation thresholds
- decomposition patterns
- validation bundles
- stopping heuristics

## How success should be evaluated

Success should be decided in layers.

### Layer 1: deterministic validators

Use these first whenever possible:

- tests
- typecheck
- lint
- snapshots
- assertions
- schema checks
- DOM checks
- API checks
- document audits

### Layer 2: environment-grounded validation

Use environment-specific evidence:

- screenshots
- page state
- diffs
- logs
- traces
- output files
- metrics

### Layer 3: model-based judgment

Use LLM judges only after deterministic and grounded checks.

LLM judges are useful for:

- coverage assessment
- synthesis
- ranking competing outputs
- evaluating ambiguous quality dimensions
- deciding whether a failure is material

They should not be the only gate for objective tasks.

### Layer 4: human escalation

Use the human when:

- stakes are high
- criteria are ambiguous
- validators disagree
- the policy requires approval
- the system is outside its confidence budget

## Human in the loop

The human should remain in the loop at the policy level, not the turn level.

The human should define:

- success criteria
- risk tolerance
- allowed autonomy
- budgets
- escalation policy

Foreman should handle:

- worker coordination
- progress checks
- retries
- repair
- evidence gathering
- outcome reporting

## LLMs as judges

LLMs should be treated as judges, but not as the only judges.

Best practice:

1. deterministic checks first
2. environment-grounded evidence second
3. LLM synthesis and adjudication third
4. human escalation when needed

This keeps the system legible and avoids fake certainty.

## Reward and RL framing

Each task run should be treated as an episode.

The trace should contain enough information to derive reward proxies such as:

- correctness
- evidence quality
- reliability
- speed
- cost
- intervention avoided
- policy compliance

Do not start with a single scalar reward.

Start with a score bundle.

## Prompt strategy

Prompting should be treated as policy data, not hidden string glue.

The lightweight model is:

- `prompt pack`
  A set of prompt variants for one task shape and worker role
- `prompt variant`
  One concrete strategy, such as `minimal`, `persona`, or `contract-heavy`
- `prompt experiment`
  A comparison run across variants using the same task family and eval bundle

This matters because “You are a world-class engineering manager” may help on some task shapes and hurt on others. Foreman should be able to record which variant was used, evaluate the result, and update memory from that evidence.

Optimization systems like DSPy, GEPA-style search, or other prompt optimizers should be treated as offline or sidecar systems:

- they generate or rank candidate variants
- Foreman runs those variants against real tasks
- evals decide whether the variant actually improved outcomes

That keeps the runtime simple and preserves harness quality as the real product boundary.

## Repo organization target

The repo should be organized around the semantic model:

- `packages/core`
  Contracts, runtime, policy, stop gates.
- `packages/tracing`
  Trace schema, replay, export.
- `packages/evals`
  Validators, scorecards, judge orchestration.
- `packages/workers`
  Worker contracts and adapters.
- `packages/environments`
  Environment contracts and target-specific logic.
- `packages/memory`
  Environment memory, worker memory, strategy memory.
- `packages/surfaces`
  CLI, webhook, cron, queue, service APIs.

## Immediate implementation rule

Before adding more orchestration logic, add:

1. explicit environment objects
2. explicit evaluation interfaces
3. explicit memory categories
4. structured trace export

Those are the foundations for both better runtime performance and future RL/eval work.
