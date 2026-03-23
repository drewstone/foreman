# Pursuit: Autonomous Loop Closure

Generation: 1
Date: 2026-03-23
Status: designing

## System Audit

See conversation for full audit. Key finding:

**The system can dispatch. It cannot close the loop.** The gap between "session started" and "outcome recorded" is manual. Until this closes automatically, Foreman can't learn, can't improve, can't build taste.

## Current Baselines

| Metric | Value |
|---|---|
| Dispatches with auto-detected outcomes | 0 |
| Taste signals recorded | 0 |
| Prompt templates scored | 0 |
| Autonomous dispatch-to-PR cycles | 0 |
| Cost tracked per dispatch | $0 |
| Notifications delivered | 0 |

## Diagnosis

The watcher detects idle/dead sessions. It fires events. But nothing:
1. Reads the session output to understand what happened
2. Checks git in the worktree to see what was committed
3. Generates an outcome record with learnings
4. Updates the prompt template scores
5. Notifies the operator

This is the difference between "a tool that dispatches work" and "an autonomous operator that learns." Without loop closure, every dispatch is fire-and-forget.

## Generation 1 Design

### Thesis

**Generation 1 closes the loop: dispatch → execute → auto-detect outcome → learn → improve prompts → dispatch better.** Once this works, Foreman is self-improving. Everything else is surface area.

### Changes (ordered by impact)

#### Architectural (must ship together)

1. **Auto-outcome harvester** — when watcher detects session idle/dead, read worktree git log + tmux output, auto-generate outcome record with: commits made, tests status, files changed, PR created, error signals. Store as a decision outcome. This is the critical missing link.
   Risk: LOW (reads existing data, no side effects)

2. **Outcome-driven learning update** — when an outcome is recorded (auto or manual), immediately: update taste model, update prompt template score, extract learnings, check if similar dispatches should be triggered on other projects.
   Risk: LOW (writes to existing tables)

3. **Prompt template scoring** — track which prompt template version was used for each dispatch. After outcomes, score the template. After N scored dispatches, use GEPA to generate a variant. A/B test new vs current. Auto-promote winners.
   Risk: MED (GEPA calls cost money, bad variants could produce worse dispatches)

#### Infrastructure (independent, can ship separately)

4. **Session cost parsing** — after session completes, parse the tmux log for Claude's cost summary line. Store on the decision record. Aggregate in /api/stats.
   Risk: LOW

5. **Desktop notifications** — when auto-outcome detects a completed session, send a desktop notification (notify-send on Linux). Simple, immediate value.
   Risk: LOW

6. **Worktree lifecycle** — auto-clean worktrees when: branch is merged, session is dead for >24h, or operator explicitly cleans. Add `POST /api/cleanup`.
   Risk: LOW

7. **Session-index search endpoint** — wire the existing FTS5 session-index (172K messages) into the service as `GET /api/search`. The Pi extension's search_history should search BOTH decisions AND session content.
   Risk: LOW (existing code, just needs an HTTP wrapper)

### Alternatives Considered

- **LLM-based outcome evaluation**: have Claude read the session output and grade it. Rejected for Gen 1 — too expensive to run on every outcome. Add in Gen 2 after we have cost tracking.
- **Confidence-gated dispatch**: use confidence scores to decide whether to dispatch autonomously. Rejected for Gen 1 — need outcome data first before confidence means anything.
- **Full eval pipeline**: run the eval judges on every outcome. Rejected for Gen 1 — overkill. Deterministic metrics (commits, tests, CI) are sufficient for loop closure.

### Risk Assessment

- Bad auto-outcomes could train the taste model wrong → mitigate with conservative outcome classification (only "success" if commits + no errors)
- GEPA variants could degrade prompt quality → mitigate with A/B testing, never auto-promote without N>5 samples
- Cost could increase if we're scoring every outcome → mitigate with deterministic scoring first, LLM scoring opt-in

### Success Criteria

- Dispatches with auto-detected outcomes: >0 (from 0)
- End-to-end cycle: dispatch → session runs → outcome auto-detected → learning extracted → next dispatch informed by learning
- Prompt template with score: at least 1 scored template
- Cost tracked: at least 1 dispatch with cost_usd populated
- Time from session idle to outcome recorded: <30 seconds (currently: infinite/manual)

## Build Status

| # | Change | Status | Files Changed |
|---|--------|--------|---------------|
| 1 | Auto-outcome harvester | ✅ built | service/index.ts:harvestOutcome() |
| 2 | Outcome-driven learning update | ✅ built | service/index.ts:updateLearningsFromOutcome() |
| 3 | Prompt template scoring | ✅ built (scoring only, GEPA Gen 2) | service/index.ts:updateLearningsFromOutcome() |
| 4 | Session cost parsing | ✅ built | service/index.ts:harvestOutcome() |
| 5 | Desktop notifications | ✅ built | service/index.ts:sendNotification() |
| 6 | Worktree lifecycle | ✅ built | service/index.ts:cleanupWorktrees(), /api/cleanup |
| 7 | Session-index search | ✅ built | service/index.ts:/api/search |

### Integration Verified
- [x] Service compiles
- [x] Dispatch creates worktree, sends prompt, session runs
- [x] Watcher detects idle → triggers harvestOutcome()
- [x] Outcome updates decision record with commits, tests, cost, learnings
- [x] Desktop notification sent on completion
- [x] Prompt template scored from outcomes
- [x] Worktree cleanup endpoint works
- [x] Session search endpoint works (FTS5)
- [ ] E2E: full cycle dispatch → outcome → learning → improved next dispatch (needs longer-running test)
