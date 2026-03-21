# Foreman Vision

## What Foreman is

Foreman is the policy layer between an operator and their agents.

It watches all sessions across all projects. It builds a model of how the operator works. It decides what to do next. It acts — spawning sessions, running experiments, invoking skills, creating PRs. It scores outcomes and improves its own decision-making.

The operator explores. Foreman exploits what works.

## The operator's workflow

This is the loop Foreman must model and amplify:

1. **Explore.** Start sessions for real work. Ideas emerge from the work itself — a marketing session becomes a GTM agent product, a tax session becomes a tax agent product.

2. **Productize.** Branch it. The session pattern becomes a product or skill.

3. **Amplify.** Invoke /evolve, /polish, /critical-audit, /pursue — aimlessly, like a monkey with skills. Build environments that maximize evolution success. Push everything to improve without a predetermined plan.

4. **Compound.** Each skill makes future sessions more powerful. Better skills generate better sessions. Better sessions generate better skills.

5. **Repeat** with expanding capability.

The "aimless monkey with skills" is deliberate. It's exploration-heavy because the search space is large and the optimal strategy is unknown. Skills provide a growing action space. /evolve provides selection pressure. The operator provides reward signal by accepting or rejecting results. This is reinforcement learning at the human level.

## What Foreman actually is (technically)

```
Foreman = state + policy + actions
```

**State** — everything Foreman knows:
- Session histories across all projects and harnesses
- Experiment results (autoresearch.jsonl, eval traces, skill outcomes)
- Operator model (how they work, what they prioritize, patterns)
- Project states (active, stalled, blocked, momentum)
- Confidence scores per action type per project

**Policy** — given state, what's the highest-value action?
- This is an LLM call with full state as context
- It improves over time as outcomes are scored
- THIS IS THE PRODUCT. Everything else is infrastructure.

**Actions** — things the policy can do:
- Spawn a Pi/Claude/Codex session with a goal
- Continue or resume a stalled session
- Start an autoresearch/evolve loop on a metric
- Run GEPA optimization on a tunable surface
- Create a skill from observed patterns
- Cross-pollinate a learning across projects
- Send a notification or create a PR
- Spawn another Foreman instance (recursion)
- Do nothing (important — explore/exploit tradeoff)

Most of the existing codebase is state collection or action execution. The policy — the actual brain — is a single LLM call with good context preparation. That's ~200 lines of core logic.

## Event-driven architecture

Foreman runs as a daemon that reacts to events, not a cron job that polls.

### Event sources

**File watchers** (primary — zero latency):
- Session JSONL directories (~/.claude/, ~/.pi/, ~/.codex/) — detect session start/end/activity
- autoresearch.jsonl files in project dirs — detect experiment results
- Git refs across managed repos — detect pushes, branch creation, merges
- ~/.foreman/ state files — detect external state changes

**Webhooks** (external events):
- GitHub webhook receiver (CI status, PR events, issue events)
- Slack/Telegram incoming (operator messages about priorities)
- Custom webhook endpoint for integrations

**Session lifecycle hooks**:
- Pi extension hooks (before_agent_start, agent_end) — real-time session awareness
- Claude Code hooks (PreToolUse, PostToolUse, Notification) — tool-level awareness

**Polling** (fallback for things without push):
- CI status checks (gh pr checks) — every 5 minutes when active PRs exist
- Cost tracking aggregation — every hour
- Session index reindex — every 15 minutes

### Event → Policy → Action flow

```
event arrives (session ended, CI failed, experiment completed, ...)
    |
    v
state update (incorporate event into current state snapshot)
    |
    v
policy call (LLM: given updated state, should I act? what action?)
    |
    v
confidence gate (is my confidence high enough for this action type?)
    |
    ├─ below threshold → log (dry-run)
    ├─ in approval zone → propose to operator, wait
    ├─ in notify zone → act, notify immediately
    └─ above threshold → act silently, report in digest
    |
    v
execute action
    |
    v
observe outcome → update state → update confidence
```

## Confidence graduation (dry-run → live)

Every action type starts in dry-run. Confidence increases through evidence. Each action type graduates independently per project.

### Confidence levels

| Confidence | Mode | Behavior |
|------------|------|----------|
| 0.0 – 0.3 | **dry-run** | Log what you WOULD do. No side effects. |
| 0.3 – 0.6 | **propose** | Show the operator. Wait for approval. |
| 0.6 – 0.8 | **act-notify** | Execute the action. Notify immediately. |
| 0.8 – 1.0 | **autonomous** | Execute silently. Report in daily digest. |

### How confidence increases

- **Agreement signal:** Operator approves a proposed action → +0.1 for that action type
- **Outcome signal:** Action succeeds (CI passes, tests pass, session completes) → +0.05
- **Transfer signal:** Similar action type has high confidence in another project → +0.02
- **Disagreement signal:** Operator rejects a proposed action → -0.15
- **Failure signal:** Action fails (CI breaks, session abandoned) → -0.1

### Per-action-type, per-project

Confidence is tracked as `(actionType, project) → score`. Examples:

- `(resume-session, openclaw-blueprint) → 0.72` — act and notify
- `(create-pr, new-project) → 0.15` — dry-run only
- `(invoke-evolve, foreman) → 0.85` — autonomous
- `(run-autoresearch, phony) → 0.45` — propose and wait

This means Foreman naturally graduates from "observer that suggests" to "autonomous operator" at different rates for different contexts. The operator never has to "flip the switch" — confidence grows from evidence.

### Operator overrides

- `never-auto(project)` — force dry-run for all actions on a project
- `always-auto(actionType)` — skip confidence check for an action type
- `confidence-floor(project, 0.5)` — set minimum confidence before any action
- These are stored in the operator profile

## What exists and what changes

### Packages (13 total — all keep)

| Package | Role | Status |
|---------|------|--------|
| core | Type contracts, runtime loop, versioned store | KEEP — foundational |
| tracing | Trace store (filesystem/Postgres), search | KEEP — state pillar |
| memory | Memory store, session index, learning data | KEEP — state pillar |
| workers | Worker registry, adapters | KEEP — action execution |
| providers | Claude/Codex/Pi/Opencode drivers | KEEP — action execution |
| environments | Git/document/service observation | KEEP — state collection |
| profiles | Operator modeling, work discovery | KEEP — state pillar |
| evals | Eval pipeline, judges, failure taxonomy | KEEP — outcome evaluation |
| optimizer | GEPA, variant scoring, policy store | KEEP + EXPAND — policy learning |
| planning | Task hardening, prompt variants | CONSOLIDATE into optimizer |
| sandbox | Sandbox worker adapter | KEEP — action execution |
| tangle | Tangle-specific sandbox | KEEP — action execution |
| sdk | Public API re-exports | KEEP — interface |

### Surfaces — what changes

**State collectors (keep as-is, become data sources for policy):**
session-metrics, session-insights, session-analysis, session-registry, skill-tracker, intent-engine, cost-monitor, async-replan, operator-adaptation

**Action executors (keep as-is, become tools for policy):**
ci-tools, ci-diagnosis, notify, engineering-tools, session-run, provider-session, retrieve-traces, sync-operator, schedule, golden-suite-generator, worktree-experiment

**Policy code (REPLACE with agent reasoning):**
operator-loop, engineering-foreman, environment-foreman, hybrid-foreman, work-discovery, work-continuation, session-review, nightly-optimize (orchestration parts), variant-generator (selection parts)

These ~13 files contain pre-decided workflows (~5000 lines). They get replaced by one policy function (~200 lines) that calls an LLM to reason about what to do given current state.

**Eval infrastructure (keep — feeds the self-improvement loop):**
benchmark-env, ci-repair-env, report-quality-env, eval-runner, judge-calibration, operator-learning-eval, golden-suite

**CLIs (keep — thin wrappers, no logic):**
All 34 *-cli.ts files stay. They're just argument parsing + dispatch.

**API server (keep — event receiver + status):**
api-server becomes the webhook receiver and status endpoint for the daemon.

### What to build

**1. Foreman daemon** (`packages/surfaces/src/foreman-daemon.ts`)
- Event loop: file watchers + webhook listener + poll timers
- On event: update state → call policy → confidence gate → execute or log
- Persistent process (systemd or pm2)

**2. Policy function** (`packages/surfaces/src/policy.ts`)
- `async function decideAction(state: ForemanState): Promise<Action | null>`
- Prepares state snapshot (active projects, recent events, operator model, confidence scores)
- Calls LLM with state as context
- Parses structured action output
- ~200 lines

**3. Confidence store** (`packages/memory/src/confidence.ts`)
- `getConfidence(actionType, project): number`
- `updateConfidence(actionType, project, signal): void`
- Backed by SQLite or JSON file in ~/.foreman/
- Per-action-type, per-project scores

**4. State snapshot builder** (`packages/surfaces/src/state-snapshot.ts`)
- Aggregates: active sessions, recent events, project states, operator model, confidence scores
- Formats for LLM context
- Reuses existing state collectors (session-registry, session-insights, cost-monitor, etc.)

## Recursion

Foreman can spawn Foreman instances as workers. A portfolio-level Foreman manages project-level Foreman instances:

```
Foreman (portfolio)
  ├── Foreman (project A) → spawns Pi/Claude sessions
  ├── Foreman (project B) → spawns Pi/Claude sessions
  └── Foreman (project C) → runs autoresearch loops
```

The parent cross-pollinates learnings. Each child has its own confidence scores and operator model scoped to its project. "foreman" is a recognized provider alongside claude/codex/pi/opencode.

## What Foreman is NOT

- Not a workflow engine (workflows are emergent from policy reasoning)
- Not a prompt optimizer (prompts are one tunable surface among many)
- Not a coding agent (it supervises coding agents)
- Not a personal assistant (it's an autonomous operator)
- Not a collection of scripts triggered by cron

## Core principles

1. The operator's exploration IS the intelligence. Foreman amplifies it.
2. Sessions are both work and training data.
3. Skills are compound interest.
4. The policy function is the product. Everything else is infrastructure.
5. Evidence beats self-report. Validate independently.
6. Confidence graduates through evidence, not switches.
7. React to events, don't poll on timers.
8. The agent reasons about what to do. We don't pre-decide workflows.
9. Self-improvement is continuous.
10. Breadth and generality over depth in one domain.

## Simple product sentence

Foreman is an autonomous agent that learns from its operator, decides what to work on across all their projects, acts with evidence-based confidence, and self-improves through continuous experimentation.
