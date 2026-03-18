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
- [x] Deep session insight extraction (75K messages analyzed, patterns across repos)
- [x] Session insights drive CLAUDE.md generation (key files, check commands, recent goals)
- [x] Cross-session awareness (Claude JSONL scanning, branch matching, worker session filtering)
- [x] Code review-driven hardening (streaming JSONL reads, state pruning, error handling)
- [x] vllm PR #1: all CI green. openclaw clippy fix pushed.

## Done this session (not yet in Completed list)

- [x] Cron heartbeat running every 15 min (dry-run mode)
- [x] Confidence-weighted auto-resume with RepairRecipe scoring
- [x] Heartbeat traces persisted to ~/.foreman/traces/heartbeats/
- [x] Heartbeat history in operator state (last 200, pruned)
- [x] onReview callback dispatches Claude agent with full operator context
- [x] Review agent prompt: portfolio, history, 6 analysis tasks, structured output
- [x] Dry-run mode for all autonomous actions

## Next

### Observe and validate (immediate — let it run)
- [ ] Let cron run 24h, review heartbeat traces for quality
- [ ] Remove --dry-run once decisions look correct
- [ ] Test auto-resume on a simple CI failure end-to-end
- [ ] Validate review agent output quality on real accumulated history

### Pi extension (the UX)
- [ ] Package extensions/pi/foreman.ts with esbuild + deps
- [ ] Test in real Pi session with Foreman tools
- [ ] QMD available as MCP tool inside Pi (just CLAUDE.md instruction)

### Surfaces (always-on)
- [ ] Slack webhook listener (receive messages, post status, ask questions)
- [ ] GitHub webhook listener (PR reviews, CI failures, issues)

### Self-improvement
- [ ] Run prompt optimization after variant diversity (10+ traces, 2+ variants)
- [ ] Golden suites from real traces for regression testing
- [ ] Track session cost, success rate, time-to-green as operator metrics
- [ ] Cross-repo learning (recipe from one repo applied everywhere)

## What not to do

- Do not rebuild Claude Code, Pi, or Codex — use them as workers
- Do not build a custom TUI — use Pi's TUI or tmux
- Do not make a fixed pipeline — let agents decide execution order
- Do not hardcode repo-specific logic into the kernel
- Do not ship heuristic shortcuts for tasks that need judgment
