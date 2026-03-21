# Foreman Roadmap

## Architecture

Foreman = state + policy + actions. See VISION.md for the full rationale.

```
events (file watchers, webhooks, hooks, poll)
  → state snapshot (session index + git + CI + operator model)
  → policy (LLM reasoning: what should I do?)
  → confidence gate (per-action, per-project)
  → action (spawn session, invoke skill, etc.)
  → outcome → confidence update → learning
  → repeat
```

## Current state (2026-03-21)

14 packages, 79 surface files, ~16,400 lines. 178 tests passing.

All 8 milestones complete. The policy agent daemon is live in dry-run, accumulating decisions. Pre-decided workflow code has been deleted (~9,000 lines removed).

### Package inventory

| Package | Role |
|---------|------|
| core | Contracts, runtime loop, versioned store |
| tracing | Trace store (fs/pg), search, bundles |
| memory | Memory store, session index (FTS5), learning, confidence store |
| workers | Worker registry, adapters, capability scoring |
| providers | Claude/Codex/Pi/Opencode session drivers |
| environments | Git/document/service observation |
| profiles | Operator profiles, work discovery |
| evals | Eval pipeline, judges, failure taxonomy |
| optimizer | GEPA, variant scoring, policy store |
| planning | Task hardening, prompt variants |
| sandbox | Sandbox worker adapter |
| tangle | Tangle sandbox integration |
| sdk | Public re-exports |
| surfaces | Policy agent, daemon, state collectors, action executors, eval infra, CLIs |

### Key surface files

**Policy agent (the product):**
- `policy.ts` — `decideAction(state) → Action`, confidence gating, action dispatch
- `state-snapshot.ts` — aggregates session index + git + CI + memory into LLM context
- `foreman-daemon.ts` — event loop with file watchers, debouncing, rate limiting
- `confidence-cli.ts` — operator CLI for managing confidence scores
- `policy-optimizer.ts` — self-improvement: metrics, variant generation, cross-pollination
- `foreman-provider.ts` — spawn child Foreman instances (recursion)

**State collectors (data sources for policy):**
- `session-metrics.ts`, `session-insights.ts`, `session-analysis.ts`, `session-registry.ts`
- `skill-tracker.ts`, `intent-engine.ts`, `cost-monitor.ts`, `operator-adaptation.ts`

**Action executors (tools for policy):**
- `ci-tools.ts`, `notify.ts`, `engineering-tools.ts`, `session-run.ts`
- `provider-session.ts`, `retrieve-traces.ts`, `golden-suite-generator.ts`
- `session-spawn.ts`, `claudemd-generator.ts`

**Eval infrastructure:**
- `benchmark-env.ts`, `ci-repair-env.ts`, `report-quality-env.ts`, `eval-runner.ts`
- `worktree-experiment.ts`, `judge-calibration.ts`, `operator-learning-eval.ts`, `golden-suite.ts`

**Other:**
- `nightly-optimize.ts` — 8-step optimization pipeline (variants → GEPA → promote → skills → golden → policy → cross-pollinate → costs)
- `daily-report.ts`, `api-server.ts`, `user-profiles.ts`, `profile-bootstrap.ts`
- `variant-generator.ts`, `prompt-optimizer.ts` — artifact generation/optimization
- 20 thin CLI wrappers, 10 replay/benchmark modules

---

## Completed milestones

### M0: Foundation
- [x] Eval runner connecting 5 eval environments
- [x] Dead code cleanup (strategy-selector, claudemd-manager)
- [x] VISION.md, CLAUDE.md, SOUL.md, ROADMAP.md rewrite

### M1: Confidence Store
- [x] `packages/memory/src/confidence.ts` — SQLite-backed, 5 signal types, 4 levels
- [x] Per-action-type, per-project scoring with operator overrides
- [x] Full audit log, getLog() for history
- [x] 17 unit tests

### M2: State Snapshot
- [x] `packages/surfaces/src/state-snapshot.ts` — session index (172K messages) as primary data source
- [x] Git branch + CI status enrichment per project
- [x] `formatStateForLLM()` — priority-based truncation at 3000 chars
- [x] Builds in ~90ms (was 15s+ with old provider-based approach)

### M3: Policy Function
- [x] `packages/surfaces/src/policy.ts` — LLM reasoning + structured JSON parsing
- [x] Action dispatch to session-run, ci-tools, notify, eval-runner
- [x] 4-level confidence gating (dry-run → propose → act-notify → autonomous)
- [x] Decision logging to `~/.foreman/traces/policy/`
- [x] Policy prompt loads from VersionedStore, bootstraps v001 on first run
- [x] 16 unit tests with mock LLM

### M4: Event Daemon
- [x] `packages/surfaces/src/foreman-daemon.ts` — file watchers + poll timer
- [x] 30s debounce, 60s rate limit, 10 actions/hour safety cap
- [x] Graceful shutdown, logging to `~/.foreman/logs/daemon.log`
- [x] CLI: `npm run foreman:daemon` (dry-run default, `--live` to enable)
- [x] Verified: 73 decisions in first run, all correctly gated

### M5: Dry-Run Validation
- [x] 73 decisions analyzed — 36% do-nothing, 64% actionable
- [x] Policy consistently identifies skill reliability as #1 priority
- [x] Zero side effects (all gated to dry-run)
- [x] Skill classifier fixed (tightened negative signals, reduced false-negative rate)
- [x] Validation report at `~/.foreman/traces/policy/dry-run-report.md`

### M6: Confidence Graduation
- [x] `packages/surfaces/src/confidence-cli.ts` — `npm run confidence`
- [x] Commands: --list, --seed, --override, --history, --review, --approve, --reject
- [x] Operator can seed scores to graduate action types
- [x] Approve/reject feeds agree/disagree signals back to store

### M7: Self-Improvement Loop
- [x] `packages/surfaces/src/policy-optimizer.ts` — metrics, variant generation, cross-pollination
- [x] Policy prompt versioned in VersionedStore (kind: 'policy', name: 'main')
- [x] `computePolicyMetrics()` — decisions/hour, action distribution, do-nothing rate
- [x] `generatePolicyVariant()` — LLM proposes improved prompt, saved as candidate
- [x] `crossPollinate()` — high-confidence learnings transfer across projects
- [x] Wired into nightly optimize as step 7/8

### M8: Recursion
- [x] `packages/surfaces/src/foreman-provider.ts` — spawn/manage child daemons
- [x] `spawnChild()`, `listChildren()`, `stopChild()`, `stopAll()`
- [x] Policy dispatches via `harness: 'foreman'` in spawn-session action
- [x] Children run in dry-run with their own confidence stores

---

## Open items (not blocking, improve over time)

**Daemon hardening:**
- [ ] Systemd unit file (`scripts/foreman-daemon.service`)
- [ ] GitHub webhook receiver (wire into api-server, Phase C)
- [ ] Pi/Claude Code hook integration (Phase D)
- [ ] Log rotation (daily)
- [ ] Health endpoint (`/health` in api-server)

**Policy quality:**
- [ ] Decision deduplication (policy sometimes proposes same action repeatedly)
- [ ] Score policy variants by operator agreement rate once enough data exists
- [ ] GEPA auto-promote winning policy variant (needs ≥10 scored variants)

**Confidence graduation (operational):**
- [ ] Seed first action type to 0.3 and begin approve/reject cycle
- [ ] Track which proposals operator accepts vs rejects over 1 week
- [ ] Validate confidence math tracks actual reliability

**Planning consolidation:**
- [ ] Merge `packages/planning` into `packages/optimizer` (planning is only used by optimizer + engineering-tools)

**Cron migration:**
- [ ] Point `scripts/run-heartbeat.sh` at daemon (or remove — daemon replaces it)
- [ ] Point `scripts/run-daily-report.sh` at a daemon-triggered action
- [ ] Point `scripts/run-nightly-optimize.sh` at daemon + eval runner

---

## Future directions

**Pi Extension Integration:**
- Bidirectional: Pi sends events, Foreman sends context + suggestions
- TUI widget showing daemon state and next proposed action

**Autoresearch Integration:**
- Watch autoresearch.jsonl files across projects
- Learn which experiment patterns produce improvements
- Autonomously start autoresearch loops where confidence allows

**Skill Generation:**
- When policy repeatedly suggests similar action sequences, crystallize into a skill
- Test in eval environment, promote if it outperforms raw actions

**AxLLM Meta-Optimization:**
- GEPA optimizes the policy prompt, state snapshot format, confidence signal weights
- Outer loop: GEPA optimizes GEPA's own parameters

---

## Principles

- The policy function is the product. Everything else is infrastructure.
- Confidence graduates through evidence, not switches.
- React to events, don't poll on timers (timers are fallback only).
- The agent reasons about what to do. We don't pre-decide workflows.
- Fail-safe: worst case is a really good logging system.
