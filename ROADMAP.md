# Foreman Roadmap

## What Foreman is

Foreman is an autonomous engineering operator. It manages a portfolio of active sessions across repos, resumes them, fixes what's broken, and learns from every run. It replaces the human at the orchestration layer.

## Architecture (as of March 2026)

Foreman is NOT a task pipeline. It's a meta-layer:

1. **CLAUDE.md generator** — translates memory + product context + CI learnings into instructions for agents
2. **Session manager** — discovers, spawns, resumes, and monitors sessions across repos
3. **Memory system** — persists atomic facts, CI requirements, worker performance, and repair recipes
4. **Heartbeat** — periodic scan that checks CI, detects stale work, auto-resumes blocked sessions
5. **Supervision tools** — harden, observe, dispatch, validate, memory as callable functions

Workers are Claude Code, Codex, Pi, or any agent with bash. Foreman doesn't replace them — it makes them better by giving them the right context and learning from their results.

## Completed

- [x] Core runtime with parallel tracks, abort signals, error safety (110 tests)
- [x] Worker registry with capability scoring, profile preferences
- [x] Provider adapters: Claude, Codex, Opencode, OpenClaw, browser
- [x] Environment adapters: git, document, research, service, hybrid
- [x] Product context discovery (CLAUDE.md, README, ARCHITECTURE.md, CI configs)
- [x] Evaluation pipeline (deterministic → environment → judge) with allSettled
- [x] Memory system (filesystem + Postgres) with atomic facts and CI learnings
- [x] Task hardening with CI command extraction from GitHub Actions
- [x] Prompt variant system with optimizer sidecar
- [x] Trace store with reward signals
- [x] Provider fallback (implementation + review)
- [x] Worker memory attribution (infra failures not blamed on workers)
- [x] Aggressive L7/L8 directives for workers and reviewers
- [x] Standalone supervision tools (harden, observe, dispatch, validate, memory)
- [x] CI feedback tools (push, PR, checkCI, readCILogs)
- [x] Event streaming (onEvent callback, --verbose CLI)
- [x] Operator loop (session discovery, heartbeat, CLAUDE.md generation, spawn/resume)
- [x] Operator CLI (npm run foreman — tested against real repos)
- [x] Pi extension template (5 Foreman tools as Pi tools)
- [x] Heartbeat cron script
- [x] Proven against 2 real repos: openclaw-sandbox-blueprint, vllm-inference-blueprint

## In Progress

- [-] Autonomous heartbeat on cron
  Script exists but not yet added to crontab. Needs testing of auto-resume against real CI failures.
- [-] Foreman's own system prompt
  The control plane should itself be a Claude session with supervision tools. The CLAUDE.md generation applies to Foreman itself, not just workers.
- [-] Context management strategy
  CLAUDE.md is the primary context lever. QMD integration for intelligent retrieval is next.
- [-] Confidence-weighted decisions
  Memory stores repair recipes but no confidence scores. Need: "protoc fix (confidence: 0.95, seen 3x)" → auto-act vs "unknown failure" → ask.

## Next

### Autonomous operation
- [ ] Test auto-resume against real CI failures (openclaw PR #13, vllm PR #1)
- [ ] Add cron entry for heartbeat (every 15 minutes)
- [ ] Confidence scoring on repair recipes
- [ ] Foreman control plane as a Claude session with system prompt
- [ ] Tmux-based visibility: control pane + worker panes

### Context management
- [ ] QMD integration for intelligent repo search (MCP server)
- [ ] Context budget strategy: product docs first, then task-relevant files
- [ ] CLAUDE.md generation includes relevant file pointers, not full content

### Surfaces
- [ ] Slack webhook listener (receive messages, post status, ask questions)
- [ ] GitHub webhook listener (PR reviews, CI failures, issues)
- [ ] Pi extension packaging (bundle with deps, test in real Pi session)

### Product sense
- [ ] Periodic repo health scans (test coverage, TODOs, stale branches, dep CVEs)
- [ ] Feature proposals from performance data and code analysis
- [ ] Cross-repo learning (blueprint-sdk → protoc required, applied everywhere)

### Optimization
- [ ] Run prompt optimization on accumulated traces (need variant diversity first)
- [ ] Golden suites from real traces
- [ ] Track session cost, success rate, time-to-green as operator metrics

## What not to do

- Do not rebuild Claude Code, Pi, or Codex — use them as workers
- Do not build a custom TUI — use Pi's TUI or tmux
- Do not make a fixed pipeline — let agents decide execution order
- Do not hardcode repo-specific logic into the kernel
- Do not ship heuristic shortcuts for tasks that need judgment
