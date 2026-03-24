# Experiment 6: Cross-Project Transfer

Date: 2026-03-24
Status: COMPLETE (analysis of existing data, $0 cost)

## Question
Does success on project A accelerate learning on project B? Does confidence progress transfer across goals?

## Data Source
- `decisions` table: 70 total decisions across 4 goals + 15 unlinked
- `goals` table: 4 goals with different workspaces
- `learnings` table: 4,167 entries across 8 types
- `events` table: full session lifecycle

## Portfolio Overview

| Goal ID | Intent | Decisions | Success | Failure | Pending | Period |
|---|---|---|---|---|---|---|
| 1 | Avalanche intelligence platform | 0 | 0 | 0 | 0 | never dispatched |
| 2 | Belief state agents — completion | 22 | 22 | 0 | 0 | Mar 23 04:58 – 17:10 |
| 3 | PiGraph — polish, tests, API | 16 | 14 | 2 | 0 | Mar 23 04:57 – 17:20 |
| 4 | Foreman self-improvement | 18 | 15 | 0 | 3 | Mar 23 17:44 – Mar 24 22:12 |
| NULL | Unlinked dispatches | 15 | 14 | 0 | 1 | Mar 24 02:12 – 17:39 |

**Total: 71 decisions, 65 success, 2 failure, 4 pending.**

## Confidence Progression Analysis

### By Goal: Skill Success Rates

#### Goal 2: Belief State Agents (22 dispatches, 100% success)

| Skill | Count | Success Rate |
|---|---|---|
| /pursue | 13 | 100% (13/13) |
| /evolve | 4 | 100% (4/4) |
| /research | 2 | 100% (2/2) |
| /polish | 2 | 100% (2/2) |
| direct prompt | 1 | 100% (1/1) |

Perfect success across all skills. This goal was dispatched first (with goal 3) and ran during a session where the operator was actively monitoring.

#### Goal 3: PiGraph (16 dispatches, 87.5% success)

| Skill | Count | Success Rate |
|---|---|---|
| /evolve | 11 | 82% (9/11) |
| direct prompts | 4 | 100% (4/4) |
| /evolve (retry) | 1 | 100% (1/1) |

Two failures, both from /evolve:
- **Decision 8 (viz-export)**: Mermaid code block in the task description got interpreted as markdown, splitting the prompt. Redispatched as decision 10 — succeeded.
- **Decision 38 (hard-tasks-4)**: Session made 10 commits but was marked failure. The harvester's diff check likely found issues.

The failure mode was prompt formatting, not agent capability.

#### Goal 4: Foreman Self-Improvement (18 dispatches, 83% success on status, ~6% on actual deliverables)

See Experiment 5 for full analysis. The status-level success rate (83%) is misleading — actual deliverable completion rate is near zero.

| Skill | Count | Status Success Rate |
|---|---|---|
| /pursue | 7 | 86% (6/7) |
| /plan | 3 | 100% (3/3) |
| /research | 3 | 67% (2/3) |
| /verify | 2 | 100% (2/2) |
| /evolve | 1 | 100% (1/1) |
| /critical-audit | 1 | 0% (0/1) |

### Cross-Project Skill Transfer

The key question: does /evolve going 4/4 on belief-state-agents predict /evolve performance on PiGraph or Foreman?

#### /evolve across goals

| Goal | Dispatches | Success Rate | Period |
|---|---|---|---|
| Goal 2 (belief-state) | 4 | 100% | Mar 23 04:58 – 05:25 |
| Goal 3 (PiGraph) | 11 | 82% | Mar 23 04:57 – 08:29 |
| Goal 4 (Foreman) | 1 | 100%* | Mar 23 17:44 |

*Status "success" but actual deliverable was catastrophic scope creep.

#### /pursue across goals

| Goal | Dispatches | Success Rate | Period |
|---|---|---|---|
| Goal 2 (belief-state) | 13 | 100% | Mar 23 04:58 – 17:10 |
| Goal 4 (Foreman) | 7 | 86% | Mar 24 22:01 – 22:11 |

/pursue dropped from 100% to 86% when applied to Foreman's own codebase, despite 13 prior successes on belief-state-agents.

### Temporal Analysis: Learning Curve

#### Phase 1: Initial Batch (Mar 23, 04:57-05:06)
5 concurrent dispatches across goals 2 and 3. All 5 succeeded. The system dispatched well-specified tasks to clean codebases with clear test suites.

#### Phase 2: Follow-up Batch (Mar 23, 05:05-05:26)
7 more dispatches. 6 success, 1 failure (viz-export prompt issue). Success rate: 86%. The failure was a prompt formatting bug, not a learning gap.

#### Phase 3: Deep Work (Mar 23, 05:26-08:50)
13 dispatches across both goals. 100% success. Sessions doing substantial work: writing paper sections, running experiments, building eval frameworks, integration adapters.

#### Phase 4: Benchmark Attempts (Mar 23, 16:58-17:22)
11 dispatches. All harvested as "success" but many sessions died quickly (3-4 min lifespan) and produced no visible results. Sessions targeting real benchmarks (SWE-bench, TerminalBench) failed to execute their harnesses.

#### Phase 5: Self-Improvement (Mar 23 17:44 – Mar 24 22:12)
18 dispatches against Foreman itself. See Experiment 5. Status success rate: 83%. Actual deliverable rate: ~6%.

#### Success Rate Over Time

| Phase | Period | Dispatches | Status Success | Notes |
|---|---|---|---|---|
| 1 | Mar 23 04:57-05:06 | 5 | 100% | Clean start, well-specified tasks |
| 2 | Mar 23 05:05-05:26 | 7 | 86% | One prompt formatting failure |
| 3 | Mar 23 05:26-08:50 | 13 | 100% | Deep, multi-hour sessions |
| 4 | Mar 23 16:58-17:22 | 11 | 100%* | Benchmark sessions, mostly vacuous |
| 5 | Mar 23 17:44-Mar 24 22:12 | 18 | 83%* | Self-improvement, mostly scope drift |

*Status success rate does not reflect actual deliverable completion.

## Interpretation

### Finding 1: No evidence of positive cross-project transfer

The confidence model predicts that success on one project should accelerate learning on another (cross-project transfer signal of +0.02 per success). The data does not support this:

- /evolve went from 100% (4/4) on belief-state to 82% (9/11) on PiGraph — a **decrease**, not an increase.
- /pursue went from 100% (13/13) on belief-state to 86% (6/7) on Foreman — another decrease.
- The failures are not caused by skill capability gaps but by prompt formatting (PiGraph) and scope creep (Foreman).

Transfer would mean: "having seen /evolve succeed on belief-state, Foreman dispatches /evolve on PiGraph with higher confidence and better prompts." There's no evidence this happened. Each project got the same dispatch treatment regardless of prior successes.

### Finding 2: Project difficulty, not skill history, determines success rate

| Project | Success Rate | Difficulty Factors |
|---|---|---|
| Belief-state (Python, clear tests) | 100% (22/22) | Well-defined tasks, strong test suite, single-language |
| PiGraph (TypeScript, extension API) | 87.5% (14/16) | Complex extension API, prompt formatting edge cases |
| Foreman (TypeScript, self-referential) | 83%* (15/18) | Self-modifying, no test suite, OAuth issues |

Success rate correlates with project difficulty and infrastructure maturity, not accumulated experience.

### Finding 3: The confidence model has too little variance for calibration

All dispatches start at low confidence (0.00-0.20 range per Experiment 2). With a +0.05 per-success signal, it would take 12 consecutive successes to reach the 0.60 "act-notify" threshold. The system has 22 consecutive successes on belief-state but confidence has only reached ~0.40 on that skill-project pair.

The result: there is no data in the high-confidence range. We cannot evaluate whether high confidence predicts success because no dispatch has reached high confidence.

### Finding 4: Unlinked dispatches suggest goal attribution is unreliable

15 of 70 decisions (21%) have `goal_id IS NULL`. These are dispatches that the service couldn't attribute to a goal. They include plan-ideation sessions, work sessions, and verification runs. If goal attribution is unreliable, cross-project transfer analysis is compromised because the system can't consistently track which project a dispatch served.

### Finding 5: The "success" metric conflates activity with achievement

The 94.7% overall success rate (from Experiment 2) and the 92% rate for this expanded dataset are both inflated. The harvester marks sessions as "success" if they ran and produced output, even if that output was terminal escape sequences or an unrelated refactor. A more honest metric:

| Metric | Value |
|---|---|
| Status-level success rate | 65/71 = 91.5% |
| Sessions that produced stated deliverable | ~40/71 = ~56% (estimated) |
| Sessions that produced a merged PR | 3 PRs merged (#1, #2, #3) out of 71 dispatches = 4.2% |

## Cross-Project Learning Store

The `learnings` table contains 4,167 entries that could enable transfer:

| Type | Count | Description |
|---|---|---|
| exemplar | 2,864 | Raw operator session prompts — the largest store |
| dispatch_success | 1,171 | Successful dispatch records |
| deep_analysis | 32 | Detailed session analysis |
| flow | 30 | Workflow patterns extracted from operator sessions |
| anti_pattern | 26 | What not to do |
| project_relationship | 21 | Links between projects |
| skill_preference | 21 | Which skills work where |
| dead_end | 2 | Approaches that failed |

The exemplar store (2,864 entries) is the largest potential source of cross-project transfer. These are real operator prompts from Pi and Claude Code sessions across multiple projects. They represent how the operator actually works — skill invocations, task decomposition patterns, code review approaches.

However, injection into dispatch prompts is not granular. The prompt composer includes "top exemplars" but doesn't filter by relevance to the current task. A belief-state exemplar about Bayesian inference may be injected into a PiGraph task about DAG topology — noise, not signal.

## Recommendations

1. **Implement relevance-scored exemplar injection**: use embedding similarity or keyword matching to inject only exemplars relevant to the current task and project.
2. **Track actual deliverable completion**: add a `deliverable_path` field to decisions. The harvester checks file existence and content hash.
3. **Separate status from achievement**: add a `deliverable_status` field (none, partial, complete) alongside the session status.
4. **Fix goal attribution**: decisions with NULL goal_id should be linked retroactively based on workspace path matching.
5. **Increase confidence signal weight**: the current +0.05 per success is too slow. With 94%+ success rates, the system should graduate to higher autonomy after 5-6 successes, not 12+.
6. **Design an A/B experiment for transfer**: run the same task suite on a fresh project with and without the cross-project learning store injected. Compare success rates and convergence speed.

## Conclusion

Cross-project transfer is architecturally present (the learnings store, exemplar injection, cross-project confidence signal) but not empirically validated. The data shows no success rate improvement as Foreman accumulates experience across projects. The dominant variables are project difficulty and task specification quality, not accumulated learning. The confidence model progresses too slowly to produce meaningful autonomy graduation within the observed dispatch volume (70+ decisions).

The most promising transfer mechanism — exemplar injection from 2,864 operator session records — is not yet filtered for relevance, reducing its signal-to-noise ratio. This is the highest-leverage improvement: connect the right operator example to the right dispatch prompt.
