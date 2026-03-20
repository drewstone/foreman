# Foreman Roadmap

## What Foreman is

Foreman is an autonomous engineering operator. It manages a portfolio of active sessions across repos, resumes them, fixes what's broken, and learns from every run. It replaces the human at the orchestration layer.

## Architecture (as of March 2026)

Foreman is NOT a task pipeline. It's a meta-layer:

1. **CLAUDE.md generator** — translates memory + product context + CI learnings into instructions for agents
2. **Session manager** — discovers, spawns, resumes, and monitors sessions across repos
3. **Memory system** — persists atomic facts, CI requirements, worker performance, repair recipes, operator profile
4. **Heartbeat** — periodic scan that checks CI, diagnoses failures, auto-resumes blocked sessions
5. **Learning loop** — extracts patterns from sessions, writes recipes/facts/profile to memory
6. **Session index** — FTS5 search across 172K messages from Claude/Codex/Pi/Opencode
7. **Evaluation pipeline** — deterministic + LLM judges, versioned artifacts, benchmark environments
8. **Optimization loop** — variant generation, auto-promotion, skill tracking

Workers are Claude Code, Codex, Pi, Opencode, or any agent with bash. Foreman doesn't replace them — it makes them better by giving them the right context and learning from their results.

## Completed — Phase 1: Core Runtime

- [x] Core runtime with parallel tracks, abort signals, error safety (145 tests)
- [x] Worker registry with capability scoring, profile preferences
- [x] Provider adapters: Claude, Codex, Opencode, Pi, browser
- [x] Environment adapters: git, document, research, service, hybrid
- [x] Product context discovery (CLAUDE.md, README, ARCHITECTURE.md, CI configs)
- [x] Memory system (filesystem + Postgres) with atomic facts and CI learnings
- [x] Task hardening with CI command extraction from GitHub Actions
- [x] Prompt variant system with optimizer sidecar
- [x] Trace store with reward signals
- [x] Provider fallback (implementation + review)
- [x] Worker memory attribution (infra failures not blamed on workers)
- [x] Standalone supervision tools (harden, observe, dispatch, validate, memory)
- [x] CI feedback tools (push, PR, checkCI, readCILogs)
- [x] Event streaming (onEvent callback, --verbose CLI)

## Completed — Phase 2: Operator Loop

- [x] Operator loop (session discovery, heartbeat, CLAUDE.md generation, spawn/resume)
- [x] Operator CLI with --heartbeat, --fix-ci, --resume, --max-resumes, --min-confidence
- [x] Heartbeat cron every 15min (LIVE — not dry-run)
- [x] Confidence-weighted auto-resume with RepairRecipe scoring
- [x] Heartbeat traces persisted to ~/.foreman/traces/heartbeats/
- [x] CI diagnosis: reads `gh run view --log-failed`, parses errors, generates repair recipes
- [x] Recipe scoring: recordRepairOutcome wired into heartbeat (confidence updates on outcomes)
- [x] Dynamic repo discovery from session index (supplements hardcoded list)
- [x] Proven against real repos: openclaw-sandbox-blueprint, vllm-inference-blueprint, agent-dev-container, phony

## Completed — Phase 3: Learning & Memory

- [x] FTS5 session search index (172K messages, 2250 sessions, 4 harnesses)
- [x] Learning loop: sessions → repair recipes, operator profile, environment facts, cross-repo patterns
- [x] Learning loop LIVE in daily cron (was dry-run)
- [x] Deep session insight extraction (commands, files, goals, cross-repo patterns)
- [x] Session insights drive CLAUDE.md generation
- [x] Cross-session awareness (Claude/Codex/Pi/Opencode JSONL scanning)
- [x] Persisted operator profile: quality bar, shipping-oriented, verification-driven, context-switcher
- [x] Per-repo environment facts: key files, repo types
- [x] Cross-repo patterns: 25+ patterns persisted as strategy memory
- [x] Memory nudges: post-session prompts to save patterns, corrections, fixes (Pi extension)

## Completed — Phase 4: Evaluation & Optimization

- [x] Deterministic judge (5 dimensions, auto-appended to daily reports)
- [x] LLM judge (Opus, brutal honest scoring, versioned directive)
- [x] Versioned artifact store (universal versioning for all tunable surfaces)
- [x] Session metrics: cost/tokens/turns/tool calls/task completion from all 4 harnesses
- [x] Tool call tracking with tool_use_id-based error attribution
- [x] Task completion classification (completed/partial/failed/abandoned)
- [x] Eval environment base (ForemanEvalEnv) with trace writing + version attribution
- [x] CIRepairEnv — tests Foreman's ability to fix CI failures
- [x] ReportQualityEnv — tests daily report quality over time
- [x] TerminalTaskEnv — basic agent competence (file creation, scripts, git)
- [x] SWEBenchEnv — real GitHub issues with test verification
- [x] MultiHarnessEnv — tests orchestration strategies (single, review, multi-harness)
- [x] Strategy selector — picks best harness combo from scored trace history
- [x] Variant generator — LLM proposes improved artifact versions from judge feedback
- [x] Nightly optimization cron: variant gen → auto-promote → skill tracking
- [x] Skill performance tracking (invocation counting, success/failure rates, trend detection)
- [x] Skill degrade→patch loop (degradation alerts in daily report)

## Completed — Phase 5: Pi Extension (UX)

- [x] Pi extension: 6 tools + 3 commands + 2 flags
- [x] Autonomous auto-loop (agent_end → check → fix → review → ship)
- [x] Mid-session watchdog (stuck detection, abort + nudge, max 3 attempts)
- [x] Skill-aware context injection (suggests /evolve, /polish, /converge etc. based on prompt)
- [x] Operator profile injection on session start
- [x] Memory nudges (post-session learning prompts)
- [x] Command injection fixes (JSON.stringify for all user input)

## Completed — Phase 6: Daily Report & Observability

- [x] Daily report with session activity, user messages, stale repos, portfolio snapshot
- [x] Session metrics in daily report (cost, tokens, turns by harness/repo/model)
- [x] Skill performance in daily report (invocation table + degradation alerts)
- [x] Both judges (deterministic + LLM) auto-appended with scores
- [x] Daily report cron at 5:47am (learning → index → report → judges)
- [x] Review checklist for human validation
- [x] Judgment traces persisted for optimizer

## Active — Phase 7: Live Rollout (7-day experiment)

Started 2026-03-20. See `.foreman/rollout-tracker.md` for daily logs.

### Success criteria (Day 7)
- LLM judge score: 20/50 → 30/50
- Heartbeat actions (not SKIP): 0 → ≥5
- Recipes with confidence > 0.5: 3 → ≥8
- Artifact promotions: 0 → ≥1
- Repos tracked: 6 → 8+

### Monitoring
- Heartbeat log: /tmp/foreman-heartbeat.log
- Daily reports: ~/.foreman/reports/
- Judge traces: ~/.foreman/traces/judgments/
- Nightly optimize: /tmp/foreman-nightly-optimize.log

## Future — Phase 8

- [ ] Pi extension tested in real Pi session end-to-end
- [ ] Golden suites from real traces for regression testing
- [ ] AxLLM GEPA full integration (currently promotes but doesn't train new selectors)
- [ ] Skill success classifier calibration (keyword matching → LLM classification)
- [ ] Foreman invokes /pursue for multi-stream goal orchestration
- [ ] QMD available as MCP tool
- [ ] Webhook/Slack surfaces for notifications

## What not to do

- Do not rebuild Claude Code, Pi, or Codex — use them as workers
- Do not build a custom TUI — use Pi's TUI or tmux
- Do not make a fixed pipeline — let agents decide execution order
- Do not hardcode repo-specific logic into the kernel
- Do not ship heuristic shortcuts for tasks that need judgment
