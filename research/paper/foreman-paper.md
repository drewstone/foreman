# Autonomous Portfolio Operation: Dispatching, Learning, and Failing to Self-Improve

## Abstract

We present Foreman, an autonomous operating system that manages a portfolio of goals across domains — code, research, marketing, strategy — by dispatching agent sessions, harvesting outcomes, and attempting to learn from experience. Built over 8 generations in 3 days, Foreman achieves a 91.5% session-level success rate across 71 dispatches on 4 concurrent goals. However, our experiments reveal a stark gap between activity and achievement: the actual deliverable completion rate is approximately 56%, and self-improvement dispatches produce their stated deliverable 0% of the time. Cross-project learning transfer shows no positive effect — success rate correlates with project difficulty, not accumulated experience. We report these results honestly as both a systems contribution (the architecture works) and a methodology contribution (how to distinguish genuine agent progress from noise). The dominant failure modes — scope creep, success/activity conflation, and convergent trivial fixes — represent open problems for all autonomous agent systems.

## 1. Introduction

The promise of autonomous agents is that they can manage complex, multi-domain work without constant human supervision. An engineer managing four projects simultaneously — an intelligence platform, a research framework, an evaluation suite, and the orchestration system itself — needs each project to make progress even when attention is elsewhere.

Current agent orchestration approaches fall into two categories: **single-task agents** (SWE-Agent, Devin, Claude Code) that execute one task with full attention, and **workflow engines** (LangGraph, CrewAI) that follow pre-defined multi-step pipelines. Neither addresses **portfolio-level orchestration**: deciding what to work on across multiple goals, dispatching work to agent sessions, learning which dispatches succeed, and improving over time.

Foreman attempts this. It is a standalone service that:
1. Maintains a portfolio of goals with their decompositions and decision history
2. Dispatches work to Claude Code sessions via tmux, with rich prompt composition
3. Harvests outcomes through session monitoring and output analysis
4. Learns operator taste from approval/rejection signals
5. Graduates actions to higher autonomy through evidence-based confidence scoring
6. Attempts self-improvement by dispatching sessions on its own codebase

We built Foreman through 8 pursuit generations over 3 days, producing a system with 3,200+ lines of TypeScript, 20+ API endpoints, and integration with Claude Code, Pi, and Telegram. We then ran 6 experiments to evaluate whether the system actually works as intended.

The results are mixed and instructive. The dispatch infrastructure works: sessions spawn, execute, complete, and get harvested reliably (after fixing three critical bugs in idle detection, prompt delivery, and session lifecycle). But the learning and self-improvement layers fail to show measurable improvement. The gap between what the system reports (91.5% success) and what it achieves (~56% deliverable completion) is the central finding of this paper.

## 2. Related Work

### Hyperagents (Meta/FAIR, 2025)
Self-referential self-improvement through a meta-agent that modifies any code including itself. Key difference from Foreman: Hyperagents uses automated tests as a safety gate for self-modifications, while Foreman has no regression checks. Hyperagents' controlled diff validation prevents the scope creep that dominates Foreman's self-improvement failures.

### SWE-Agent (Princeton, 2024)
Single-task coding agent with a custom shell interface for repository navigation. SWE-Agent optimizes the agent-computer interface for individual bug fixes. Foreman operates at a higher level — it dispatches and orchestrates agents like SWE-Agent, but does not compete on individual task performance.

### ADAS: Automated Design of Agentic Systems (Google, 2024)
Meta-search over agent architectures. ADAS explores the design space of agent systems automatically. Foreman's self-improvement dispatch is a crude version of this — dispatch sessions to modify the system, keep what works. ADAS is more principled, using structured search with fitness evaluation.

### DSPy (Stanford, 2024)
Prompt optimization framework that compiles declarative language model programs. Foreman integrates AxGEPA (a Pareto-optimal prompt optimizer from @ax-llm/ax) for template evolution, but has not generated sufficient data for optimization. DSPy's compile-time optimization is more practical than Foreman's runtime optimization approach for the current data volumes.

### Voyager (NVIDIA, 2023)
Skill library that grows through exploration in Minecraft. Foreman's skill proposal system (generating improvements to operator skills stored in `~/.claude/skills/`) is conceptually similar. Both accumulate reusable knowledge from experience. Voyager's environment is more structured.

### CrewAI / LangGraph
Multi-agent workflow engines with pre-defined roles and pipelines. Foreman explicitly avoids pre-defined workflows — "the conversation is the policy." The LLM in conversation with the operator decides what to dispatch, not a static graph. This is more flexible but harder to evaluate.

## 3. Architecture

```
Operator ↔ Conversation (Pi/Claude) ↔ Foreman Service ↔ Execution Backends
                                            │
                                     ┌──────┼──────┐
                                     │      │      │
                                  SQLite  tmux   git
                                  (state) (sessions) (worktrees)
```

### 3.1 Foreman Service

A standalone Node.js daemon (`service/index.ts`, 3,200+ lines) with:

- **SQLite state store**: goals, decisions (dispatch records), sessions, taste signals, events, operator sessions (mined from Claude/Pi/Codex history), prompt templates, learnings, MCP server configs
- **tmux session manager**: spawn Claude Code in isolated tmux sessions, monitor via `has-session` and `capture-pane`, detect idle/completion, harvest output
- **Worktree isolation**: every dispatch creates a git worktree branched from the operator's current branch, preventing interference
- **Post-completion pipeline**: after session completes, a digest agent (via `callClaude`) summarizes output, scores quality 1-10, extracts learnings, recommends next action
- **Confidence store**: per-(skill, project) scores 0.0-1.0 that graduate from dry-run → propose → act-notify → autonomous
- **HTTP API**: 20+ endpoints for goals, decisions, sessions, taste, plans, confidence, events (SSE)

### 3.2 Conversation as Policy

Foreman explicitly avoids making policy decisions in code. The service manages state and execution; the *conversation* between operator and LLM decides:
- What to work on next
- Which skill to dispatch (`/evolve`, `/pursue`, `/polish`, `/verify`, `/research`, `/converge`, `/critical-audit`)
- Whether an outcome is acceptable
- When to pivot or abandon a goal

This is implemented through Pi (a conversation agent) with 7 Foreman tools: `portfolio_status`, `dispatch_skill`, `check_session`, `log_outcome`, `project_context`, `search_history`, `analyze_sessions`.

### 3.3 Universal Agent Shape

Every pipeline in Foreman follows:

```
Input → Agent (Identity | LLM | GEPA-optimized) → Structured Output → Stored → Feeds next cycle
```

This applies to prompt composition, post-completion analysis, session mining, template evolution, and plan generation. Each pipeline is pluggable — the Identity agent passes through unchanged, LLM agents analyze and enrich, GEPA agents optimize over time. This architecture makes every surface theoretically optimizable, though in practice we have not generated sufficient data for optimization.

### 3.4 Prompt Composition

Each dispatch receives a composed prompt averaging 6,000+ characters, containing:
- Task description and skill instructions
- Project CLAUDE.md (conventions, architecture)
- Git workflow instructions (worktree branch, push, PR)
- Recent commit history
- Goal context and past decisions
- Operator exemplars from mined sessions
- Learned flows and dead ends

## 4. Methodology

### 4.1 The Autoresearch Pattern

Foreman applies the autoresearch pattern at portfolio level:

| Autoresearch | Foreman |
|---|---|
| Modify code | Dispatch a session |
| Run benchmark | Harvest outcome |
| Keep/revert | Log success/failure |
| Log experiment | Store decision + learnings |
| Loop | Auto-dispatch next action |

### 4.2 Taste Learning

Operator taste is learned from:
- Explicit approval/rejection of dispatches
- Goal language analysis (what the operator asks for)
- Session mining (how the operator works in Claude/Pi)
- Priority signals (which goals get attention)

The taste model is injected into dispatch prompts so the LLM makes decisions aligned with operator judgment.

### 4.3 Confidence Graduation

Per-(skill, project) confidence scores start at 0.0 and increase with successful dispatches:
- 0.0–0.3: dry-run (log what would be done)
- 0.3–0.6: propose (show operator, wait for approval)
- 0.6–0.8: act-notify (execute, notify immediately)
- 0.8–1.0: autonomous (execute, report in digest)

Success signal: +0.10 per successful dispatch (increased from +0.05 after Experiment 2 showed severe under-confidence).

## 5. Implementation: 8 Generations in 3 Days

Foreman was built through 8 pursuit generations, each a coherent set of changes:

| Gen | Thesis | Key Change | Outcome |
|---|---|---|---|
| 0 | Daemon | Standalone process that decides what to do | 98.4% do-nothing decisions — failed |
| 1 | Loop closure | Dispatch → harvest → learn pipeline | First working dispatches |
| 2 | Clean signal | Rich prompt composition (6K+ chars) | Sessions produce useful work |
| 3 | Confidence | Per-(skill, project) graduation | Evidence-based autonomy |
| 4 | Overnight run | 26 dispatches, 85% success | First unattended operation |
| 5 | Self-improvement | Dispatch on own codebase | 0% deliverable rate (Exp 5) |
| 6 | Learned policy | AxGEPA prompt optimization | Infrastructure built, no data yet |
| 7 | Planning layer | Strategic plan generation | 5 evidence-based plans generated |
| 8 | Evidence to product | Benchmarks, experiments, paper | This paper |

Key architectural decisions (documented in `research/decisions/001-008.md`):
1. Service over daemon — daemon made 98.4% do-nothing decisions
2. Conversation as policy — LLM reasons, service executes
3. Prompt composition — the prompt IS the product
4. Session mining — operator's 3,000+ sessions are training data
5. Confidence graduation — actions earn autonomy through evidence
6. Universal agent shape — every pipeline is pluggable and optimizable
7. Hyperagents-inspired self-improvement — dispatch on own codebase
8. Planning layer — exploration/exploitation split in plan generation

## 6. Experiments

### 6.1 Prompt Composition Ablation (Experiment 1)

**Question**: Does Foreman's rich prompt composition improve dispatch success rate?

**Setup**: 30 coding tasks (7 easy, 10 medium, 6 hard, 10 challenge), 2 conditions (bare vs full prompt), Claude Sonnet 4.6.

**Result**: Both conditions achieved 100% success rate (26/26 on matching tasks, 46 total sessions). **Negative result** — Sonnet saturates on isolated coding tasks regardless of prompt quality.

**Interpretation**: For tasks with clear test suites where the model's capability exceeds the task difficulty, prompt composition provides no measurable benefit to binary success rate. The value of prompt composition may lie in multi-step goals, approach quality, or weaker models — Haiku achieves 0% on challenge tasks where Sonnet achieves 100%.

### 6.2 Confidence Calibration (Experiment 2)

**Question**: Does confidence-gated autonomy correlate with actual success?

**Setup**: Analysis of 40 decisions with outcomes, 29 confidence entries.

**Result**: 94.7% actual success rate at 0.10-0.20 predicted confidence. **The model is severely under-confident** — it should be dispatching autonomously much sooner. ECE cannot be computed meaningfully because all data points cluster in one confidence bin.

**Action taken**: Success signal weight increased from +0.05 to +0.10.

### 6.3 Self-Improvement Effectiveness (Experiment 5)

**Question**: Can Foreman improve itself through self-modification?

**Setup**: Analysis of 18 self-targeting dispatches (goal_id=4).

**Result**: **0/18 dispatches produced their stated deliverable.** 0% PR merge rate. Dominant failure modes:
- Scope creep: 8/18 sessions made identical watch.sh refactor regardless of assigned task
- Success/activity conflation: harvester marks sessions "success" based on activity, not deliverable presence
- No coordination: parallel sessions discover and apply the same trivial change

**Comparison to Hyperagents**: Hyperagents uses diff validation and automated testing as safety gates. Foreman has no such constraints, leading to unconstrained scope creep.

### 6.4 Cross-Project Transfer (Experiment 6)

**Question**: Does success on project A accelerate learning on project B?

**Setup**: Analysis of 71 decisions across 4 goals (belief-state agents, PiGraph, avalanche intelligence, Foreman self-improvement).

**Result**: **No evidence of positive transfer.** /evolve went from 100% (4/4) on belief-state to 82% (9/11) on PiGraph. /pursue went from 100% (13/13) on belief-state to 86% (6/7) on Foreman. Success rate correlates with project difficulty (test suite quality, codebase complexity), not accumulated experience.

The 94.7% status-level success rate inflates to 91.5% at the decision level. Estimated actual deliverable completion: ~56%.

### 6.5 SWE-bench (Experiment 8)

[RESULTS IN PROGRESS — harness running, partial results available]

Preliminary: 3/20 task-condition pairs completed, all "partial" (correct files modified, tests not passing). Full results pending.

### 6.6 TerminalBench (Experiment 7)

[RESULTS PENDING — session ran but did not commit results due to scope creep, demonstrating the self-improvement failure mode in real time]

## 7. Discussion

### 7.1 The Infrastructure Works

Foreman successfully manages 4 concurrent goals, dispatches 71 sessions across multiple skills, monitors them via tmux, harvests outcomes, and builds a structured decision history. The core dispatch-harvest-learn loop functions. After fixing three critical bugs (idle detection, prompt delivery, session lifecycle), sessions complete reliably.

### 7.2 The Learning Loop Doesn't

The learning mechanisms — taste learning, confidence graduation, cross-project transfer, self-improvement — show no measurable effect on dispatch quality. This is the central negative finding. The reasons:

1. **Insufficient data for optimization**: 71 dispatches across 4 goals produces sparse (skill, project) pairs. AxGEPA optimization needs 50+ examples per target.
2. **No deliverable verification**: the harvester conflates activity with achievement. Without checking whether the stated deliverable exists, the learning signal is noise.
3. **Scope creep dominates**: unconstrained agents ignore their instructions and pursue whatever seems most natural (usually the same trivial refactor). This is not a prompt problem — it's a constraint enforcement problem.

### 7.3 What We'd Do Differently

1. **Deliverable assertions**: each dispatch declares an output path. The harvester checks file existence and content hash. "Success" requires the deliverable.
2. **Scope constraints**: allowlisted files/directories per dispatch. Diffs outside the allowlist trigger review, not auto-merge.
3. **Test gates**: run `tsc --noEmit` (or equivalent) before and after. Regressions block success marking.
4. **Session deduplication**: before dispatching N parallel sessions, check for overlapping scope with sibling sessions.
5. **Weaker models for ablation**: Sonnet saturates on our coding tasks. Use Haiku for prompt ablation to find variance.

## 8. Limitations

- **Sample sizes are small**: 71 total dispatches, many with N=1 per condition. Statistical significance cannot be claimed.
- **Single operator**: all taste and preference data comes from one person. Generalization is unknown.
- **Self-referential evaluation**: Foreman evaluates itself. The post-completion digest agent rates its own dispatches.
- **No real-world deployment**: all experiments run on the developer's machine. Production factors (multiple users, larger scale, diverse workloads) are unaddressed.
- **SWE-bench and TerminalBench results incomplete**: the harnesses work but full results are pending at time of writing.
- **The "success" metric is unreliable**: our experiments demonstrate that status-level success does not predict deliverable completion. All success rates in this paper should be read with this caveat.

## 9. Conclusion

Foreman demonstrates that autonomous portfolio operation is architecturally feasible: a service can manage goals, dispatch agent sessions, and build structured decision histories. The infrastructure contribution — tmux-based session management, worktree isolation, prompt composition, post-completion pipeline — is solid and reusable.

The learning contribution is a negative result: taste learning, confidence graduation, cross-project transfer, and self-improvement do not produce measurable improvement in our experiments. The dominant failure modes (scope creep, activity/achievement conflation, convergent trivial fixes) are not unique to Foreman — they represent open problems for autonomous agent systems broadly.

The methodology contribution may be the most valuable: distinguishing genuine agent progress from noise requires deliverable verification, not just session monitoring. The 91.5% session-level success rate and the ~56% actual deliverable rate tell very different stories about the same system. Future work on autonomous agents should report both metrics.

## References

[1] Meta/FAIR. Hyperagents: Self-Referential Self-Improvement, 2025.
[2] Princeton NLP. SWE-Agent: Agent-Computer Interfaces Enable Automated Software Engineering, 2024.
[3] Google. ADAS: Automated Design of Agentic Systems, 2024.
[4] Stanford NLP. DSPy: Programming—not Prompting—Foundation Models, 2024.
[5] NVIDIA. Voyager: An Open-Ended Embodied Agent with Large Language Models, 2023.
[6] Nous Research. Hermes Agent, 2025.

## Appendix A: System Statistics

| Metric | Value |
|---|---|
| Total decisions | 71 |
| Session-level success rate | 91.5% |
| Estimated deliverable completion | ~56% |
| Self-improvement deliverable rate | 0% (0/18) |
| PR merge rate (self-improvement) | 0% (0/18) |
| Active goals | 4 |
| Learnings extracted | 4,167 |
| Operator sessions mined | 120+ |
| Service codebase | 3,200+ lines TypeScript |
| Pursuit generations | 8 in 3 days |
| Total development cost | ~$50 in API credits |

## Appendix B: Pursuit History

See `.evolve/pursuits/*.md` for detailed generation-by-generation development history including architecture decisions, failed experiments, and pivots.
