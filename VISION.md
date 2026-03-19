# Foreman Vision

## North star

`Foreman` is an agentic orchestration layer that manages agents, tools, and recurring workflows across environments, verifies outcomes with evidence, and learns to operate more like the human operator over time.

It should be publishable and useful to any person or team that works with agents daily, not just one local setup, one repo, or one operator.

## Ultimate goal

`Foreman` should replace the human at the orchestration layer.

That means replacing the part of the workflow where a human currently:

- translates vague goals into executable work
- chooses which agent or tool should act next
- iterates through implementation, review, audit, and repair
- decides whether completion is real
- keeps context across projects and organizations
- notices what strategies, prompts, and workers actually work

The human should move up one level and primarily define:

- objectives
- success criteria
- risk tolerance
- budgets
- escalation policy
- approval boundaries

The persistent unit should be a `profile`.
The atomic execution unit should be a `run`.
The same profile should be invokable repeatedly across repos, apps, org workflows, and environments.

## Product boundary

`Foreman` is agentic itself, but its agency should live at the orchestration layer.

`Foreman` is the control plane and supervisory agent, not just a passive runtime and not just another specialist worker.

It should own:

- task hardening
- worker and tool selection
- orchestration across stages
- validation and repair loops
- evidence collection
- trace capture
- memory updates
- outcome determination
- policy enforcement
- self-improvement inputs

It should not try to become:

- the best coding agent
- the best browser agent
- the best research agent
- the best tax agent
- a giant workflow engine
- a personal assistant chat product

Workers and tools should remain specialized. `Foreman` should supervise them.

`Foreman` should usually behave as a profile-persistent, run-invoked system:

- long-lived profiles hold memory, policy, and preferences
- runs are explicit, replayable, and evaluable
- CLI/API/cron/webhook surfaces invoke runs under a profile
- personal-assistant continuity emerges from profiles plus repeated invocation, not one giant immortal chat loop

The intended split is:

- specialist workers are agentic within their domains
- `Foreman` is agentic at the operator layer above them
- sidecars improve `Foreman` policy without bloating the hot path

## Harness of harnesses

`Foreman` should be a harness of harnesses.

That means it should be able to drive:

- coding agents
- browser agents
- review and audit agents
- research agents
- tax and document agents
- local CLI tools and internal services through adapters
- remote agents running inside sandbox systems like Tangle
- recurring cron, queue, webhook, and service workflows

It should also be able to bootstrap itself from prior usage when the user opts in, by importing:

- prior agent sessions
- traces and transcripts
- repository histories
- recurring task patterns
- existing validation habits and tool usage

That import/bootstrap layer should be generic, not tied to one machine or one vendor.

`Foreman` should also be able to inspect prior runs and imported histories to discover likely open, stalled, or blocked work and recommend what to resume next.

The important abstraction is not one agent. The important abstraction is the operator layer above many agents and tools.

That includes remote execution. `Foreman` should be embeddable as a library and should be able to supervise workers that run:

- locally
- in Docker-style sandbox environments
- in remote managed sandboxes
- in resumable agent sessions with continuation and replay

## Core principles

- Evidence beats self-report.
- Validation is a real stage, not a prompt flourish.
- Prompts are policy inputs, not the product.
- Foreman is agentic, but its agency is supervisory and cross-worker.
- Traces are first-class.
- Memory should improve runtime behavior before model retraining.
- Sidecars can optimize policy, but the hot path must stay simple.
- The human should stay at the policy layer, not the turn-driving layer.
- Foreman should generalize across environments, not overfit to one repo or one worker.
- Local scripts, repos, and workflows belong behind connectors and profiles, not in the kernel.

## How to judge new work

A change belongs in `Foreman` if it helps answer yes to most of these:

- Does this help Foreman replace the human operator layer?
- Does this improve orchestration, validation, evidence, memory, or learning?
- Does this generalize across more than one workflow or environment?
- Does this keep the runtime simple and adapter-driven?
- Does this make outcomes more legible and replayable?

A change is probably drift if it mostly:

- makes one worker feel smarter in isolation
- adds prompt complexity without stronger evals
- adds workflow-engine weight without improving control
- solves only one repo-specific case inside the kernel
- hardcodes one operator's local setup into the product surface
- blurs the boundary between Foreman and specialized workers

## Research director role

Foreman is not just an operator. It applies the scientific method to every project:

1. **Observe** all sessions, traces, metrics, cron outputs across repos
2. **Notice** where autonomous improvement cycles should exist but don't
3. **Build** experiment infrastructure via `/improve`
4. **Drive** improvement cycles via `/evolve` (discover → measure → diagnose → hypothesize → implement → test → promote → repeat)
5. **Handle async feedback** — some experiments resolve in seconds (tests), some in days (social metrics, sales)
6. **Improve the skills themselves** from outcome data

Foreman dispatches existing Claude Code skills (`/evolve`, `/polish`, `/verify`, `/status`, `/critical-audit`) — it does not rebuild them. The skills are the intelligence. Foreman is the operator that drives them across the portfolio.

## Current strategic direction

1. Skeptical validation — never trust agent self-report, dispatch independent validators
2. Relentless loop — "continue, polish, verify" until independently verified, no maxRounds
3. Experiment cycles — `/evolve` on every project that can be measured
4. Session portfolio management — see all work, drive all work, learn from all work
5. Skill improvement — trace every skill invocation, score outcomes, improve skills from data
6. CLAUDE.md generation — translate memory + context + session insights into agent instructions

## Simple product sentence

`Foreman` is an autonomous engineering operator that drives coding agents across repos, validates with skepticism, runs improvement cycles, and learns from every session.
