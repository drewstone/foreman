# Foreman

Autonomous engineering operator. Replaces the human at the orchestration layer — drives coding agents across repos, validates with skepticism, runs improvement cycles, learns from every session.

## What it does

- **Sees everything** — scans all repos, branches, PRs, CI status, Claude/Codex sessions every 15 minutes
- **Drives agents** — dispatches `/evolve`, `/polish`, `/verify`, `/status` on active sessions via Claude Code
- **Validates skeptically** — never trusts agent self-report, runs independent checks, dispatches separate validator agents
- **Builds experiment infrastructure** — notices where improvement cycles should exist, proposes and builds them
- **Learns** — traces every heartbeat, scores trajectories, improves skills and prompts from outcomes

## How it works

Foreman is a meta-layer, not a runtime. It generates CLAUDE.md instructions from memory + product context + session insights, then spawns/resumes Claude Code sessions with those instructions. The skills (`/evolve`, `/polish`, `/verify`) do the actual work.

```
Cron (every 15 min)
  → Scan repos, branches, CI, sessions
  → Write trace
  → Dispatch review agent (what needs attention?)
  → Auto-resume with confidence scoring (dry-run by default)

When driving work:
  claude -p --resume <session> "/evolve"    # autonomous improvement cycle
  claude -p --resume <session> "/polish"    # iterate to 10/10
  claude -p --resume <session> "/verify"    # skeptical validation
  claude -p --resume <session> "continue"   # the 80-90% automation
```

## Quick start

```bash
# Install
npm install

# Run heartbeat (what's happening across your repos?)
npm run foreman

# Run with auto-resume in dry-run (see what Foreman would do)
npm run foreman -- --heartbeat --dry-run

# Resume a specific session
npm run foreman -- --resume <session-id>

# Fix all failing CI
npm run foreman -- --fix-ci
```

## Pi extension

```bash
# Install Pi
npm install -g @mariozechner/pi-coding-agent

# Link Foreman extension
ln -s ~/code/foreman/extensions/pi/foreman.ts ~/.pi/agent/extensions/foreman.ts

# In Pi: /foreman for status, /heartbeat to scan
```

## Architecture

```
~/.foreman/
  operator-state.json     # session portfolio
  traces/heartbeats/      # every heartbeat traced
  repos.json              # managed repos (or auto-discovers ~/code/)

Per repo:
  .foreman/
    memory/               # environment facts, worker performance, repair recipes
    traces/               # run traces with reward signals
    runs/                 # artifact store per run
```

## Key docs

- [SOUL.md](SOUL.md) — operating principles: skepticism, relentless loop, research director, experiment cycles
- [ROADMAP.md](ROADMAP.md) — what's done, what's next
- [VISION.md](VISION.md) — north star and product boundary
