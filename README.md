# Foreman

Autonomous operator for agentic harnesses. Manages sessions across Claude Code, Codex, Pi, and any CLI-based agent. Scans your repos, resumes stalled work, validates with skepticism, drives improvement cycles, learns from every run.

You talk to 10+ agent sessions a day. 80-90% of what you say is "continue", "review this", "polish it", "10/10". Foreman says it for you — across all your sessions, all your repos, all the time.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/drewstone/foreman/main/install.sh | bash
```

Requires Node.js 20+. Installs to `~/.foreman/`.

## Usage

```bash
foreman init              # set up ~/.foreman/ (auto-discovers your repos)
foreman status            # what's happening across all your repos
foreman heartbeat         # scan repos, check CI, trace results
foreman resume <id>       # resume a session with full context
foreman fix-ci            # auto-fix all failing CI
```

## What it does

**Sees everything.** Every 15 minutes, Foreman scans your repos for active branches, open PRs, CI status, and recent Claude/Codex sessions. It builds a prioritized portfolio of all your in-flight work.

**Drives sessions forward.** Foreman resumes agent sessions with context-rich instructions generated from memory, product docs, CI requirements, and your working patterns. It dispatches the skills your agents already have — `/evolve`, `/polish`, `/verify`, or just "continue."

**Validates with skepticism.** Foreman never trusts agent self-report. It runs checks independently, dispatches separate validator sessions, and treats "done" as a claim that needs proof.

**Runs improvement cycles.** Foreman notices where autonomous optimization should exist but doesn't. It builds experiment infrastructure, drives discover → measure → diagnose → hypothesize → implement → test → promote → repeat cycles on any measurable project.

**Learns from everything.** Every heartbeat is traced. Every session outcome is scored. CI failures become repair recipes with confidence scores. Your working patterns become context for future sessions.

## How it works

Foreman is a meta-layer above your agents, not a replacement for them.

```
You ← talk to → Foreman ← drives → Claude Code, Codex, Pi, any agent
                    ↓
              Generates context-rich instructions (CLAUDE.md)
              Spawns/resumes sessions with those instructions
              Validates results independently
              Records traces for learning
              Repeats until verified complete
```

Foreman generates a CLAUDE.md for each session from:
- **Memory** — what it learned from prior runs on this repo
- **Product context** — README, ARCHITECTURE.md, CI config
- **Session insights** — your reading patterns, common commands, recent goals
- **CI requirements** — extracted from GitHub Actions workflows

The agent gets the best possible context on turn 1. Foreman checks the results on the last turn.

## Configuration

```
~/.foreman/
  config.json           # repos to manage, heartbeat settings
  soul.md               # operating principles (edit this!)
  operator-state.json   # session portfolio (managed by Foreman)
  traces/heartbeats/    # every scan traced for learning
```

Edit `soul.md` to define how skeptical Foreman should be, when to escalate to you, and what quality bar to enforce.

Edit `config.json` to add/remove repos and tune heartbeat behavior:

```json
{
  "repos": ["/path/to/repo1", "/path/to/repo2"],
  "heartbeat": {
    "intervalMinutes": 15,
    "dryRun": true,
    "minConfidence": 0.7
  }
}
```

## Cron

The install script does NOT add cron automatically. To enable:

```bash
crontab -e
# Add:
*/15 * * * * ~/.foreman/src/scripts/run-heartbeat.sh
```

Start with `dryRun: true` in config. Review `~/.foreman/traces/heartbeats/` to validate decisions. Set `dryRun: false` when confident.

## Pi extension

```bash
npm install -g @mariozechner/pi-coding-agent
ln -s ~/.foreman/src/extensions/pi/foreman.ts ~/.pi/agent/extensions/foreman.ts
```

In Pi: `/foreman` for status, `/heartbeat` to scan, or let the agent use `foreman_status`, `foreman_resume`, `foreman_validate` as tools.

## License

MIT
