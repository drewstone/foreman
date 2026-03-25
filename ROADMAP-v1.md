# Foreman Roadmap v1

Date: 2026-03-24
Generation: 10 (current)
Decisions: 97 | Deliverable-verified: 19 (11 pass, 8 fail) | Goals: 4

## Where We Are

Built in 4 days across 10 generations. 97 dispatches, 5K lines of TypeScript, 9 modules. The system dispatches agent sessions, harvests outcomes, verifies deliverables, enforces scope via git hooks, and tracks confidence per (skill, project).

Key metrics:
- Focused task deliverable rate: 85% (11/13 with specs)
- Self-improvement deliverable rate: 1/24 (4%) — first scope-respecting edit in Gen 10
- SWE-bench: 0% pass, 59% partial (right files, wrong fix)
- Session success vs actual deliverable: 91.5% vs ~56% (35pp gap closed by Gen 9 verification)
- Tests: 0

## Competitive Position

| Capability | Hyperagents | Hermes (10.3K stars) | Foreman |
|---|---|---|---|
| Portfolio orchestration | None | None | **Unique** |
| Honest deliverable measurement | Published benchmarks | Community benchmarks | **Novel** (3-tier metric) |
| Scope enforcement | Diff validation | None | **Novel** (git hooks) |
| Operator session mining | None | Honcho profiles | **Unique** (3000+ sessions) |
| Single-task coding | Strong | Strong (200+ models) | Weak (0% SWE-bench) |
| Tests | Research rigor | 3,000 | **0** |
| Execution backends | Unknown | 6 (Docker, SSH, Modal...) | 1 (tmux) |
| Model support | Multiple | 200+ (OpenRouter) | Claude only |
| Community | Meta/FAIR | Active contributors | 1 user |

Foreman's moat: portfolio orchestration + honest measurement + scope enforcement + operator learning. Nobody else does all four. But the foundation (tests, backends, multi-model) is far behind production-grade competitors.

## Tier 1: Foundation (must-haves before anyone else can use this)

### 1.1 Test Suite
- **Why**: 0 tests. Can't self-improve (no regression gate), can't ship, can't CI. Everything else depends on this.
- **What**: Unit tests for verify-deliverable.ts, scope-enforcer.ts, dispatch-policy.ts, confidence.ts. Integration tests for the harvest pipeline. E2E test for dispatch → harvest → verify flow.
- **Effort**: 2-3 sessions
- **Blocks**: Self-improvement, CI, contributor onboarding

### 1.2 Service Module Split
- **Why**: 3,580-line index.ts is unmaintainable. Can't test what you can't isolate.
- **What**: Extract into ~8 modules: http-server.ts, session-manager.ts, watcher.ts, harvester.ts, prompt-composer.ts, auto-dispatch.ts, learning-loop.ts, api-routes.ts. Keep index.ts as thin entrypoint.
- **Effort**: 1-2 sessions
- **Blocks**: Testability, contributor readability

### 1.3 Web Dashboard
- **Why**: Nobody will use tmux. Need visual session viewer, decision log, plan board, confidence display.
- **What**: Lightweight web UI served from the service (port 7374). React or plain HTML+fetch. Pages: status overview, active sessions (live output), decision history, plans, confidence matrix.
- **Effort**: 3-5 sessions
- **Blocks**: First external user, product demos

### 1.4 E2E Installer Test
- **Why**: `curl install.sh` has never been tested on a clean machine.
- **What**: Docker-based test: fresh Ubuntu, run installer, verify service starts, dispatch a task, verify deliverable.
- **Effort**: 1 session
- **Blocks**: Distribution, onboarding

## Tier 2: Competitive Differentiators (double down on what's unique)

### 2.1 Deliverable Spec Auto-Inference
- **Why**: Currently manual — operator must specify `deliverable.path` in dispatch. LLM should infer it from task description.
- **What**: Before dispatch, a fast LLM call (Haiku) analyzes the task and generates a DeliverableSpec. "Write results to foo.md" → `{path: "foo.md", minLines: 10}`.
- **Effort**: 1-2 sessions

### 2.2 Scope Enforcement UX
- **Why**: Git hooks reject commits but the agent doesn't always recover gracefully. Need clear retry guidance.
- **What**: Improve hook error messages. Add prompt instruction: "If your commit is rejected by a scope hook, unstage the out-of-scope files with `git reset HEAD <file>` and commit only the allowed files." Test with 5 scoped dispatches.
- **Effort**: 1 session

### 2.3 Operator Feedback Loop
- **Why**: `agree/disagree` confidence signals are defined but never called. The operator has no way to approve/reject dispatches.
- **What**: Wire up taste API. Add `foreman approve <id>` / `foreman reject <id>` CLI commands. Dashboard buttons. Confidence updates on feedback.
- **Effort**: 1 session

### 2.4 Confidence Recalibration
- **Why**: 19 deliverable-verified decisions — first real data for calibration. Can compute ECE.
- **What**: Analyze deliverable_status vs confidence at dispatch time. Plot calibration curve. Adjust signal weights if miscalibrated. Target ECE < 0.15.
- **Effort**: 1 session

### 2.5 Cost Tracking
- **Why**: Still $0 across all decisions. Can't optimize what you can't measure.
- **What**: Parse Claude Code session cost from pipe-pane logs or `claude --usage` API. Store per-decision. Add to dashboard and CLI.
- **Effort**: 1 session

## Tier 3: Expansion (reach new users and use cases)

### 3.1 Docker Execution Backend
- **Why**: tmux-only means local-only. Docker enables cloud deployment, better isolation, multi-user, CI integration.
- **What**: New backend in ExecutionBackend interface. `docker run` with mounted worktree, Claude Code installed. Session monitoring via `docker logs`.
- **Effort**: 2-3 sessions

### 3.2 Multi-Model Support (OpenRouter)
- **Why**: Claude-only limits cost optimization and capability matching. Haiku for simple tasks, Opus for complex.
- **What**: Model router in dispatch. selectModel() returns model + provider. Support OpenRouter endpoint for 200+ models.
- **Effort**: 1-2 sessions

### 3.3 Slack/Discord Gateway
- **Why**: Mobile access. Review PRs, approve dispatches, check status from phone.
- **What**: Slack bot (slash commands + event subscriptions). Existing gateway/slack.ts is scaffolded but untested.
- **Effort**: 1-2 sessions

### 3.4 Agent SDK Migration
- **Why**: tmux + pipe-pane is brittle. Claude Agent SDK provides proper tool tracking, cost reporting, streaming, structured output.
- **What**: Replace tmux backend with Agent SDK. Each dispatch becomes an SDK agent run. Output captured structurally, not via terminal scraping.
- **Effort**: Big refactor (3-5 sessions)

## Tier 4: Research (validate the thesis)

### 4.1 AxGEPA Dispatch Policy Training
- **Why**: 97 decisions — enough data to start training the learned dispatch policy.
- **What**: Set FOREMAN_DISPATCH_POLICY=gepa. Train on (context, decision, outcome) triples. Compare to LLM policy on held-out goals.
- **Effort**: 2-3 sessions

### 4.2 SWE-bench with Slim Prompts
- **Why**: Bare outperformed full (78% vs 50% partial). Test whether Gen 9's slim tier improves pass rate from 0%.
- **What**: Rerun 10 SWE-bench tasks with slim prompts. Compare to existing bare/full results.
- **Effort**: 1 session (30-60 min compute)

### 4.3 Cross-Repo Deployment
- **Why**: First external user is the real product validation.
- **What**: Find a willing beta tester. Install on their machine. Set up a goal. Observe what breaks.
- **Effort**: Variable

### 4.4 Paper Finalization
- **Why**: Draft exists (279 lines). SWE-bench + Gen 9/10 results need to be added.
- **What**: Update results sections with deliverable verification data, scope enforcement findings, context rot ablation. Submit to workshop or arxiv.
- **Effort**: 1-2 sessions

## Critical Path

```
Tests ──→ Module split ──→ Web dashboard ──→ Docker backend ──→ First external user
  │                                                                    │
  └── self-improvement becomes viable ─────────────────────────────────┘
```

## Session History (for context)

| Session | Date | Key Outputs |
|---|---|---|
| 1 | Mar 22 | Scaffold → service + Pi extension. Gen 0-2. |
| 2 | Mar 22-23 | Gen 3-4. Confidence, overnight run (26 dispatches, 85%). |
| 3 | Mar 23 | Gen 5-7. Self-improvement (0/18), planning layer, SWE-bench harness. |
| 4 | Mar 24 | Gen 8-10. Evidence pursuit, paper, deliverable verification, scope enforcement. 3 critical bugs fixed. Exp 5/6 honest self-assessment. |

## Next Session Priorities

1. **Test suite** for service/lib modules (verify-deliverable, scope-enforcer, dispatch-policy, confidence)
2. **Module split** of service/index.ts into 8 focused modules
3. **Web dashboard** MVP (status page + session viewer + decision log)
