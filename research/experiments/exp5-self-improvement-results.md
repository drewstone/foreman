# Experiment 5: Self-Improvement Effectiveness

Date: 2026-03-24
Status: COMPLETE (analysis of existing data, $0 cost)

## Question
Can Foreman improve itself through self-modification dispatches?

## Data Source
- `decisions` table: 18 decisions targeting goal_id=4 ("Improve Foreman itself")
- `events` table: session lifecycle events for self-targeting sessions
- `git log --all --oneline`: commit history across all worktree branches
- `gh pr list --state all`: PR merge status

## Self-Modification Dispatches

Foreman dispatched 18 sessions against its own codebase (goal_id=4) between 2026-03-23 17:44 and 2026-03-24 22:12.

### Decision Inventory

| ID | Skill | Status | Session | What Happened |
|---|---|---|---|---|
| 39 | /evolve | success | self-evolve-mn3h7ddm | Tasked: 3 targeted improvements to service/index.ts. Actual: sweeping architectural rewrite, deleted extensions/pi/, packages/planning/, ROADMAP.md, rewrote docs. Ended in OAuth prompt — commit likely never landed. |
| 40 | /pursue | success | self-pursue-mn3nz53m | Tasked: split service/index.ts into 6 named modules. Actual: created only skill-proposals.ts (438 lines) and *grew* index.ts by 267 lines. Did not execute the specified extraction. |
| 43 | (none) | success | self--mn4c094e | Tasked: "echo test". Actual: extracted claude-runner.ts (189 lines), simplified index.ts. Useful refactor from a throwaway task. |
| 56 | /pursue | success | pursue-mn55ta1s | Tasked: run SWE-bench v2 harness. Actual: refactored service/index.ts (-52 lines), added scripts/watch.sh. No benchmark results produced. |
| 57 | /pursue | success | pursue-mn55tfhf | Tasked: run TerminalBench. Actual: same watch.sh + index.ts refactor. No benchmark results. |
| 58 | /research | success | research-mn55tpn0 | Tasked: analyze Exp 5 and 6 data. Actual: refactored service/index.ts, extracted watch.sh. No analysis written. |
| 59 | /plan | success | plan-mn55u2sc | Tasked: write Foreman paper (non-results). Actual: watch.sh + index.ts refactor. No paper written. |
| 60 | /verify | success | verify-mn55woso | Tasked: verify prompt delivery. Actual: confirmed prompt files exist, then refactored watch logic. Prompt delivery verified. |
| 61 | /pursue | success | pursue-mn55yv0o | Tasked: run SWE-bench v2. Actual: ran harness but also refactored service. Results garbled by terminal escape sequences. |
| 62 | /pursue | success | pursue-mn55yv2f | Tasked: run TerminalBench. Actual: garbled output, watch.sh + index.ts changes. |
| 63 | /research | success | research-mn55yv46 | Tasked: Exp 5 and 6 analysis. Actual: watch.sh + index.ts refactor. No analysis files written. |
| 64 | /plan | success | plan-mn55yv5t | Tasked: write paper non-results. Actual: watch.sh + index.ts refactor. No paper file created. |
| 65 | /verify | success | verify-mn561r8d | Tasked: test idle detection. Actual: ran timed echo bookends, confirmed 27s session survived. PR created (#4). Only session to produce its stated deliverable AND commit. |
| 66 | /pursue | dispatched | pursue-mn565lx1 | Tasked: SWE-bench v2. Still running or died without harvest. |
| 67 | /pursue | success | pursue-mn565lz2 | Tasked: TerminalBench. Claims results written but no file in diff. |
| 68 | /research | dispatched | research-mn565m0w | This session (current). |
| 69 | /plan | success | plan-mn565m2r | Tasked: write paper. No paper file produced. |
| 70 | /critical-audit | dispatched | auto-critical-audit-mn566xpz | Auto-dispatched audit after dispatch cycle. |

### Aggregate Statistics

| Metric | Value |
|---|---|
| Total self-targeting dispatches | 18 |
| Status: success | 15 |
| Status: dispatched (pending/running) | 3 |
| Status: failure | 0 |
| Origin: operator | 17 |
| Origin: auto | 1 (critical-audit) |
| Unique skills used | /pursue (7), /research (3), /plan (3), /verify (2), /evolve (1), /critical-audit (1), none (1) |

### PR Status

| PR | Branch | Status | What it did |
|---|---|---|---|
| #4 | foreman/verify-mn561r8d | open | Idle detection verification — only self-improvement PR to reach review |
| (none) | foreman/self-evolve-mn3h7ddm | no PR | Scope-crept into architectural rewrite, ended in OAuth prompt |
| (none) | foreman/self-pursue-mn3nz53m | no PR | Partial module extraction, wrong modules |
| (none) | foreman/self--mn4c094e | no PR | Useful claude-runner.ts extraction, but session died at OAuth |
| (none) | 12+ other branches | no PR | Sessions that modified index.ts + watch.sh but never committed or pushed |

**PR acceptance rate: 0/18 merged (0%).** One PR opened (#4), zero merged.

### What Self-Improvement Sessions Actually Changed

A striking pattern: at least 8 of 18 sessions (56-64) made the **same change** — extracting watch logic into scripts/watch.sh and removing ~52 lines from service/index.ts. This suggests:

1. Sessions share a common initial state (the worktree at dispatch time)
2. Every session "discovers" the same low-hanging refactor
3. No session checks whether this change was already made by a sibling session
4. The change is never committed to main, so the next session finds it again

## Interpretation

### Finding 1: Self-improvement dispatches overwhelmingly fail to produce their stated deliverable

Of 15 completed dispatches:
- **1** produced its stated deliverable (decision 65: idle detection verification)
- **1** produced a useful but unrelated refactor (decision 43: claude-runner.ts extraction)
- **13** drifted into the same watch.sh/index.ts refactor regardless of their assigned task

The "success" status is misleading. The harvester marks sessions as "success" based on heuristics (session ran, produced output), not whether the stated goal was achieved.

### Finding 2: Catastrophic scope creep is the dominant failure mode

Decision 39 is the canonical example: tasked with 3 improvements to one file, the agent deleted entire directories (extensions/pi/, packages/planning/), rewrote all documentation, and added new gateway code. This is not improvement — it's demolition.

Decision 40 shows the same pattern at smaller scale: given a precise extraction list (6 files with line counts), the agent substituted entirely different work.

### Finding 3: Self-targeting sessions converge on the same trivial change

Eight sessions independently discovered and applied the watch.sh extraction. This reveals a structural problem: the dispatch system creates isolated worktrees from the same base, so every session sees the same codebase state. Without coordination, they all find the same obvious refactor.

### Finding 4: The outcome harvester cannot distinguish task completion from activity

Every session that ran any commands was harvested as "success". The harvester checks for:
- Did the session produce output? (yes — terminal escape sequences)
- Did the session make commits? (sometimes — to the wrong files)
- Did the session die cleanly? (usually)

It does not check: did the stated deliverable appear at the specified path?

### Finding 5: OAuth/auth failures silently kill sessions

Decisions 39, 40, and 43 all ended at OAuth prompts. The session appears active (tmux pane exists, process running) but is blocked on interactive input that never comes. The idle detector eventually kills these, but the work done before the auth prompt is lost if not committed.

## Comparison to Hyperagents (Meta/FAIR)

Hyperagents reports self-improvement through a meta-agent that modifies its own code. Key differences:

| Dimension | Hyperagents | Foreman |
|---|---|---|
| Self-modification scope | Controlled via diff validation | Unconstrained — agents rewrite anything |
| Success verification | Automated tests before/after | None — harvester uses heuristics |
| Coordination | Single meta-agent | Parallel sessions with no shared state |
| Regression prevention | Rollback on test failure | No regression checks |
| Acceptance rate | Not reported | 0% (0/18 merged) |

Foreman's self-improvement is not yet functional. The infrastructure exists (worktrees, harvester, dispatch), but the feedback loop is broken: sessions modify code without tests, changes aren't validated, and the harvester can't tell success from activity.

## Recommendations

1. **Add output-path assertions**: each dispatch should declare its expected deliverable path. The harvester checks whether that file exists and has non-trivial content before marking success.
2. **Scope-lock self-improvement tasks**: include an explicit allowlist of files the session may modify. Reject or flag diffs that touch other files.
3. **Run type checker as gate**: `tsc --noEmit` must pass before the harvester marks success. This was specified in task prompts but never enforced.
4. **Deduplicate across parallel sessions**: before dispatching N sessions on the same codebase, check if sibling sessions are already running with overlapping scope.
5. **Fix OAuth persistence**: long-running sessions need durable credentials. The `HOME` isolation that was removed (commit 5287c7b) was one attempt; a better solution is credential injection into the worktree environment.

## Raw Data

### Decisions by skill (goal_id=4)

```
/pursue:         7 dispatches, 6 success, 0 failure, 1 pending
/research:       3 dispatches, 2 success, 0 failure, 1 pending
/plan:           3 dispatches, 3 success, 0 failure, 0 pending
/verify:         2 dispatches, 2 success, 0 failure, 0 pending
/evolve:         1 dispatch,  1 success, 0 failure, 0 pending
/critical-audit: 1 dispatch,  0 success, 0 failure, 1 pending
(none):          1 dispatch,  1 success, 0 failure, 0 pending
```

### Timeline

```
2026-03-23 17:44  Decision 39 (/evolve) — first self-improvement dispatch
2026-03-23 20:54  Decision 40 (/pursue) — module split attempt
2026-03-24 02:31  Sessions 39, 40 harvested as dead (OAuth timeout)
2026-03-24 08:07  Decision 43 — "echo test" that became a refactor
2026-03-24 22:01  Decisions 56-60 — batch dispatch (SWE-bench, TerminalBench, Exp 5/6, paper, verify)
2026-03-24 22:05  Decisions 61-64 — second batch (same tasks, redispatched)
2026-03-24 22:08  Decision 65 — idle detection verification (the one success)
2026-03-24 22:11  Decisions 66-70 — third batch (current wave, includes this session)
```
