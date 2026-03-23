# Foreman Vision

## One sentence

Foreman is your autonomous operating system. You tell it what you want — in any domain — and it decomposes, dispatches, tracks, learns, and drives it to completion.

## What Foreman is

Foreman is autoresearch applied to your entire life.

In autoresearch, an agent modifies code, runs a benchmark, keeps what improves the metric, discards what doesn't, and loops forever. The agent never stops. The metric is the judge. History prevents repeating dead ends.

Foreman does this at the level of goals. The "experiment" is dispatching work — a Claude Code session with /evolve, a Pi session for GTM strategy, a research session for a paper, a skill invocation for code quality. The "metric" is whether the goal moved forward, judged by operator taste. The history is a structured decision log that prevents repeating mistakes and enables cross-pollination.

The operator provides goals and taste. Foreman provides decomposition, execution, tracking, and learning. The conversation between them IS the policy function. Everything else is infrastructure.

## The operator

The operator works across dozens of domains simultaneously — code, marketing, research, business strategy, product design, sales, content, operations. They explore by starting sessions. Ideas emerge from the work. A marketing session becomes a GTM product. A training session becomes a voice cloning paper. A tax session becomes a tax agent.

The operator's workflow:
1. **Explore.** Start sessions. Ideas emerge from work.
2. **Productize.** The session pattern becomes a product, skill, or deliverable.
3. **Amplify.** Throw skills at everything — /evolve /pursue /polish /research — like a monkey with tools. No predetermined plan.
4. **Compound.** Each skill makes future work better. Each outcome trains Foreman's taste model.
5. **Repeat** with expanding capability.

Foreman's job: learn this workflow, model the operator's taste, predict what they'd do, and do it — faster, more consistently, across more domains simultaneously.

## Architecture

```
Operator ↔ Conversation (Pi/Claude/any client) ↔ Foreman Service ↔ Execution backends
```

### Foreman Service (runs 24/7)

A standalone process. Manages state, sessions, and events. Never makes policy decisions — only executes them.

- **State store** (SQLite): goals, decisions, sessions, taste model, costs
- **Session manager**: spawn/monitor/kill sessions across backends (tmux → Claude Code, Pi, Codex)
- **Event detection**: session completion, CI changes, experiment results, cost alerts
- **Notifications**: surface what needs attention (Slack, desktop, Pi widget)
- **HTTP API**: ~10 endpoints, any client can connect

### Clients (the policy layer)

The conversation IS the policy. Any client that can talk to the service API can be Foreman's interface.

- **Pi extension** (primary): tools + dashboard + /foreman command. The operator talks to Pi, Pi calls the service.
- **Slack bot** (future): notifications + approve/reject from phone
- **Claude Code hooks** (future): detect session outcomes, inject Foreman context
- **Web dashboard** (future): visual portfolio
- **CLI** (future): `foreman status`, `foreman dispatch`
- **Cron jobs** (future): scheduled briefings, overnight autonomy

### Execution backends

What Foreman can dispatch work to:

- **Claude Code** (via tmux): coding, skills (/evolve /pursue /polish /verify /research /converge /critical-audit), git operations
- **Pi** (via tmux or API): thinking, writing, research, strategy, planning
- **Autoresearch loops**: metric optimization with structured experiment tracking
- **Direct commands**: scripts, builds, deploys, arbitrary shell
- **Future**: browser agents, API calls, email, calendar

## Goals, not projects

The unit of work is a **goal**, not a repo or project.

A goal is anything the operator wants done:
- "Drive phony voice cloning to SOTA, track experiments, write a latex paper"
- "Ship the sandbox blueprint with full test coverage"
- "Run the GTM launch for the new product"
- "Research transformer architectures for the book chapter"
- "Make foreman itself better"

A goal decomposes into tasks. Tasks get dispatched to backends. Some goals map to git repos. Some don't. Some span multiple repos. Some are pure research or writing.

The service tracks goals and their progress. A goal has:
- **Intent**: what the operator said (their exact words — the prompt IS the product)
- **Decomposition**: how Foreman broke it into dispatchable tasks
- **Decisions**: every dispatch and its outcome
- **Learnings**: what worked, what failed, what to try next
- **State**: active, stalled, blocked, completed
- **Taste signals**: operator approval/rejection of decisions

## Taste

Foreman learns how the operator thinks.

Taste is not preferences — it's judgment. Which dispatch was the right call? Which goal matters more? When should you /evolve vs /pursue? When is something "shipped" vs "good enough"?

Taste comes from:
- **Explicit signals**: operator approves/rejects a dispatch
- **Goal language**: how the operator describes what they want (specific vs vague, ambitious vs incremental)
- **Correction patterns**: what the operator changes after Foreman acts
- **Priority signals**: what the operator works on first, what they ignore
- **Quality standards**: when the operator says "done" vs "keep going"

The taste model is injected into the conversation context so the LLM makes better decisions over time. It's not a config file — it's a learned model that evolves from evidence.

## Confidence graduation

Actions earn autonomy through evidence. Per goal, per action type.

| Confidence | Mode | Behavior |
|------------|------|----------|
| 0.0–0.3 | **dry-run** | Log what you would do |
| 0.3–0.6 | **propose** | Show operator, wait for approval |
| 0.6–0.8 | **act-notify** | Execute, notify immediately |
| 0.8–1.0 | **autonomous** | Execute, report in digest |

Confidence increases from agreement (operator approves) and success (outcome is good). Decreases from rejection and failure. The operator never flips a switch — Foreman graduates itself.

## The autoresearch pattern

Everything in Foreman follows the autoresearch pattern:

| Autoresearch | Foreman |
|---|---|
| autoresearch.md | portfolio state (living doc, any session can resume) |
| autoresearch.jsonl | decisions log (append-only, structured, searchable) |
| autoresearch.sh | dispatch (spawn a session with a skill/goal) |
| run_experiment | dispatch + monitor |
| log_experiment | log outcome + learnings |
| METRIC lines | goal progress metrics |
| confidence score | taste-informed quality judgment |
| git commit/revert | keep what works, revert what doesn't |
| never stop | never stop |

The key extension: autoresearch optimizes one metric in one project. Foreman applies the same loop across all goals, all domains, learning and cross-pollinating between them.

## Parallel execution

Foreman runs many things simultaneously:
- Multiple goals active at once
- Multiple sessions per goal (via git worktrees for code, separate sessions for non-code)
- Skills that decompose into parallel sub-goals (/evolve can run parallel experiments)
- Cross-pollination: learnings from one goal inform dispatches on another

## What Foreman is NOT

- Not a daemon that makes policy decisions (the conversation is the policy)
- Not a coding-only tool (goals span all domains)
- Not a workflow engine (no pre-decided workflows — the LLM reasons)
- Not a prompt optimizer (prompts are one surface among many)
- Not a personal assistant (it's an autonomous operator that learns)

## Principles

1. **The prompt is the product.** The operator's natural language goal is the entire input. Better prompts → better outcomes.
2. **Taste is king.** A technically correct action the operator rejects is a bad action.
3. **Goals, not projects.** Work spans domains. Don't assume git repos.
4. **The conversation is the policy.** No cold LLM calls with state snapshots. The operator is in the loop.
5. **Autoresearch everything.** Dispatch, measure, keep/revert, learn, repeat. For all goals.
6. **Ship > perfect.** A working thing with rough edges beats a polished thing that does nothing.
7. **Never stop.** Always have work in flight. Idle time is failure.
8. **Evidence over self-report.** Validate independently. Score honestly.
9. **Cross-pollinate.** What works on one goal might transform another.
10. **Infrastructure serves the conversation.** The service runs sessions and stores state. It does not think.
