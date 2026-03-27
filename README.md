# Foreman

Autonomous operating system for the operator. Give it a goal in any domain — code, research, marketing, strategy — and it decomposes, dispatches, tracks, learns, and drives to completion.

## Architecture

```
Operator ↔ Conversation (Pi/Slack/CLI) ↔ Foreman Service ↔ Execution Backends
```

**Service** (`service/index.ts`) — Standalone daemon. SQLite state, session manager, event detection, learning loop, HTTP API. Runs 24/7. Never makes policy decisions.

**Pi Extension** (`pi-package/`) — Thin client. 7 tools + dashboard widget + /foreman command. The conversation IS the policy.

**Skill** (`pi-package/skills/foreman/SKILL.md`) — Behavioral instructions for the LLM. Taste, first-principles thinking, skill selection.

## Quick Start

```bash
# Install with the onboarding wizard
curl -fsSL https://raw.githubusercontent.com/drewstone/foreman/main/install.sh | bash

# Re-run setup later
foreman setup
```

The installer is consent-first. It explains each capability, asks before enabling it, writes config to `~/.foreman/.env`, and can install only the parts you want: core service, budgets, provider keys, Telegram, and Pi wiring.

## What It Does

- **Dispatches work** to Claude Code sessions with rich, context-loaded prompts (6,000+ chars of project state, past decisions, learned flows, dead ends, operator exemplars)
- **Learns from you** — scans your Claude/Pi/Codex sessions, extracts workflows, taste, anti-patterns via LLM analysis
- **Works in isolation** — every dispatch uses a git worktree, opens PRs against your branch
- **Tracks everything** — SQLite decisions log, goal progress, cost, taste signals
- **Never stops** — always has work in flight, monitors sessions, dispatches more when idle

## Service API

| Endpoint | Method | What |
|---|---|---|
| `/api/status` | GET | Portfolio overview |
| `/api/goals` | POST/GET | Create/list goals |
| `/api/dispatch` | POST | Dispatch work (non-blocking) |
| `/api/sessions` | GET | List active sessions |
| `/api/sessions/:name` | GET/DELETE | Check/kill session |
| `/api/outcomes` | POST | Log outcome + learnings |
| `/api/decisions` | GET | Search decision history |
| `/api/taste` | GET/POST | Taste model |
| `/api/learn` | POST | Trigger fast learning loop |
| `/api/analyze` | POST | Trigger deep LLM analysis |
| `/api/context` | GET | Read project context |
| `/api/events` | GET | SSE event stream |
| `/api/replay/summary` | GET | Aggregate historical replay metrics from decisions/outcomes |
| `/api/replay/examples` | GET | List normalized replay examples with objective vectors |
| `/api/replay/export` | GET | Export replay summary + examples as one dataset |

## Pi Extension Tools

| Tool | What |
|---|---|
| `portfolio_status` | See all goals, sessions, decisions |
| `dispatch_skill` | Spawn Claude Code session with a skill |
| `check_session` | Inspect running session |
| `log_outcome` | Record what happened + learnings |
| `project_context` | Deep read of a project |
| `search_history` | Search past decisions |
| `analyze_sessions` | Deep LLM analysis of operator sessions |

See `VISION.md` for full architecture and philosophy.
