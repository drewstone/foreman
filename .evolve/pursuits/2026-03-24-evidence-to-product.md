# Pursuit: Evidence to Product

Generation: 8
Date: 2026-03-24
Status: building

## Thesis

**Foreman must prove it works with real benchmarks, validate its learning loop, write it up, and ship it as a product.** The system has 96% dispatch success across 55 decisions — but zero evidence it outperforms raw Claude Code. This generation closes that gap end-to-end.

## System Audit

### What exists and works
- Service: 55 decisions, 96.3% success, 4 active goals, auto-harvest (fixed today)
- Confidence graduation: tracks per-(skill, project), under-confident (94% actual at 0.15)
- Session mining: 120+ operator sessions, 64 learnings extracted
- Post-completion pipeline: digest → confidence → next-action recommendation
- Plan ideation: 5 strategic plans generated from evidence
- Worktree isolation, PR creation, tmux dispatch, pipe-pane capture
- SWE-bench harness (exists but 0/3 pilot)
- Experiment protocol with 8 experiments designed

### What exists but doesn't work
- SWE-bench harness: `claude -p` with long prompts has arg parsing issues, shallow clones miss old commits, 600s timeout too generous
- TerminalBench: no tasks exist yet
- Experiments 3-6: designed but never run
- Paper: protocol exists but no paper draft
- Installer: exists but never tested E2E

### Baselines
- Dispatch success: 96.3% (55 decisions)
- SWE-bench: 0/3 pilot (harness broken, not capability)
- TerminalBench: N/A (doesn't exist)
- Confidence ECE: unmeasurable (all dispatches in 0.10-0.20 bin)
- Cost per dispatch: unknown (cost capture broken)

## Milestones

### M1: Close the Evidence Gap
**Goal**: Real benchmark data showing whether Foreman helps or doesn't.

Tasks:
- [ ] Fix SWE-bench harness: pipe prompt via stdin, use full clone + checkout, 300s timeout, 20+ tasks
- [ ] Build TerminalBench: 30 terminal tasks (file ops, git, system admin, scripting) across 3 tiers
- [ ] Run SWE-bench: 10 tasks × bare vs full × 3 repeats = 60 sessions
- [ ] Run TerminalBench: 30 tasks × raw vs foreman × 1 repeat = 60 sessions
- [ ] Analyze: produce honest comparison tables

Success: We know whether Foreman-composed prompts help on real tasks.

### M2: Validate the Learning Loop
**Goal**: Evidence that Foreman improves over time, not just dispatches well.

Tasks:
- [ ] Exp 3 (mining ablation): 20 tasks × with/without mining × 3 repeats = 120 sessions (~$30)
- [ ] Exp 4 (post-completion ablation): 10 sequential dispatches × 3 conditions × 3 repeats = 90 sessions (~$25)
- [ ] Exp 5 (self-improvement): analyze existing PR acceptance rate + dispatch 10 self-improve sessions
- [ ] Exp 6 (cross-project transfer): analyze existing confidence data across 4 goals
- [ ] Calibration recheck: after signal weight fix, does confidence track better?

Success: At least one learning mechanism shows measurable improvement.

### M3: Write the Paper
**Goal**: Submit-ready paper positioned against Hyperagents, Hermes, SWE-Agent.

Sections:
- [ ] Abstract + Introduction (position the problem)
- [ ] Architecture (service + conversation-as-policy + universal agent shape)
- [ ] Methodology (autoresearch pattern applied to portfolio management)
- [ ] Experiments (M1 + M2 results, honest negatives)
- [ ] Related work (Hyperagents, Hermes, ADAS, SWE-Agent, DSPy)
- [ ] Discussion + Limitations
- [ ] Title that captures the contribution

Success: Paper is honest, positions clearly, has real data.

### M4: Package as Product
**Goal**: `curl -sL foreman.sh/install | bash` → working Foreman in 60 seconds.

Tasks:
- [ ] E2E test the installer on clean machine
- [ ] Auto-detect Claude Code / Pi / Codex
- [ ] First-run wizard: pick a goal, watch first dispatch
- [ ] Web dashboard (session viewer, decision log, plan board)
- [ ] Landing page with honest benchmarks
- [ ] GitHub release with changelog

Success: A stranger can install and use Foreman in < 5 minutes.

## Dispatch Plan

### Wave 1 (now) — Independent, dispatch in parallel
1. **SWE-bench harness fix + run** — fix harness, run 20 tasks
2. **TerminalBench build + run** — create 30 tasks, run all
3. **Exp 5+6 analysis** — $0, just analyze existing data
4. **Paper skeleton** — write non-results sections now

### Wave 2 (after M1 data) — Depends on Wave 1
5. **Exp 3+4 runs** — need working harness from Wave 1
6. **Paper results sections** — needs M1+M2 data
7. **Installer E2E test** — independent but lower priority

### Wave 3 (after paper) — Depends on Wave 2
8. **Landing page + release**
9. **Web dashboard**
10. **Launch**
