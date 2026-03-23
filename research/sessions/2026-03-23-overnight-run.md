# Session: 2026-03-23 — First Overnight Autonomous Run

Duration: ~10 hours (overnight, unattended)
Scope: PiGraph + belief-state-agents portfolio

## Key Achievement

**13 dispatches ran autonomously without operator intervention.** This is the first time Foreman operated independently overnight, producing real research output across 2 projects.

## Metrics

| Metric | Value |
|---|---|
| Total dispatches | 26 |
| Successes | 22 (85%) |
| Failures | 1 (4%) |
| Still running | 3 (12%) |
| Operator sessions scanned | 1,057 |
| Learnings extracted | 689 |
| Taste signals | 49 |

## What Was Produced

### PiGraph
- Installed as real Pi extension
- First real benchmark results (3 coding tasks through live Pi)
- Full eval framework: 20 task workspaces + runner + analyzer
- Eval suite: 60 pi sessions (20 tasks × 3 variants)
- Challenge tasks: 10 hard tasks designed to cause agent failures (in progress)
- Debloated 570 lines

### Belief-state-agents
- Paper evaluation section: 3,500 words covering experimental setup, proposition validation, calibration, sensitivity, limitations
- 3 missing experiments: 1,449 new lines
- Integration adapter: Python trace_adapter.py
- Pi extension: live belief-state sidecar (1,077 lines)
- Sensitivity analysis: decay × threshold sweep
- Documentation polished to publication quality
- SWE-bench harness (in progress)
- Real trace analysis pipeline (in progress)

## Skill Effectiveness

| Skill | Dispatches | Success | Rate |
|---|---|---|---|
| /evolve | 12 | 10 | 83% |
| /pursue | 4 | 3 | 75% |
| /research | 2 | 2 | 100% |
| /polish | 2 | 2 | 100% |
| direct | 5 | 5 | 100% |

## Issues Found

1. Decision task field stores entire multi-page prompts — needs truncation
2. Confidence still keying on worktree names for some dispatches
3. No cost tracking — estimated $13-52 for the overnight run
4. Some zombie tmux sessions not reaped (9 still alive)

## Human vs AI Contribution

- **Human**: Set up goals, started Pi sessions, provided initial direction ("no shortcuts, production quality")
- **AI (Foreman)**: Decomposed goals into 26 dispatches, selected skills, composed prompts, monitored sessions, harvested outcomes, auto-dispatched follow-ups
- **AI (Claude Code workers)**: Executed each dispatch — wrote code, tests, papers, eval frameworks
- **Interaction**: Human set the goal, went to sleep. Foreman ran autonomously for 10 hours. Human reviews results in the morning.

This is the first demonstration of the full autonomous loop: goal → decompose → dispatch → execute → harvest → learn → dispatch more.
