# Evolve Progress — Deliverable Success Rate
Score: 0.80 → target 0.70 (Round 1) — 2026-03-24T18:25:00Z
Status: CONVERGED (exceeded target on first round)

## Round 1 Results

| # | Task Type | Skill | Deliverable | Notes |
|---|---|---|---|---|
| 1 | Trivial file creation | /verify | PASS | |
| 2 | Count files, write result | /verify | PASS | |
| 3 | Code review analysis | /research | PASS | |
| 4 | DB query + report | /research | PASS | |
| 5 | Git log analysis | /verify | PASS | |
| 6 | Self-improvement (scoped) | /evolve | PASS | With scope lock |
| 7 | Executive summary | /plan | PASS | |
| 8 | Multi-file research | /research | PASS | |
| 9 | Script creation | /pursue | FAIL | Test gate false positive (ran tsc on .sh file) |
| 10 | Documentation | /pursue | FAIL | Test gate false positive (ran tsc on .md only changes) |

**Rate: 8/10 = 80%** (target: 70%, baseline: ~56%)
**True rate: 10/10 = 100%** (both "failures" were test gate false positives, not missing deliverables)

## Diagnosis

The 2 failures are **test gate false positives**, not deliverable failures:
- Task 9: health-test.sh was created and works. But the test gate ran `tsc --noEmit` on all /pursue dispatches, even when only .sh files were modified.
- Task 10: cli-docs.md was created (246 lines). Same test gate issue.

Fix applied: test gate now only runs when .ts files are modified in the diff.

## Key Finding

Gen 9 deliverable verification works. The combination of:
1. Deliverable specs (path + content assertions)
2. Slim prompts (1500 chars for /verify vs 6000)
3. Focused task descriptions

Produces 80-100% deliverable success. The improvement from ~56% to 80% comes from:
- **Deliverable specs force specificity**: sessions know exactly what to produce
- **Slim prompts reduce distraction**: less context = more focus on the task
- **Verification catches real failures**: the test earlier today correctly caught a missing file

## Round 2 Results (Self-Improvement + Context Rot)

### Self-Improvement with Scope Locks: 0/3 STILL FAILING
Even with deliverable specs + scope locks + slim prompts:
- SI-1: Modified index.ts (174 lines) when only verify-deliverable.ts was allowed. Scope creep.
- SI-2: Went beyond task scope entirely. Scope violation detected.
- SI-3: Created test file but used wrong test patterns. tsc gate failed.

**Verdict: ITERATE.** Scope locks *detect* violations but don't *prevent* them. The agent ignores file constraints in the prompt. Need enforcement at filesystem level, not prompt level.

### Context Rot Ablation: 3/3 ALL PASS (task too easy)
Same task at 3 prompt lengths (2875/4379/7393 chars): all succeeded.
**Verdict: ABANDON this specific test.** Need harder tasks to differentiate. Simple verification tasks don't stress context length.

## Remaining Gap

1. Self-improvement: 0/21 lifetime deliverable rate. Prompt-level scope locks don't work. Need filesystem-level enforcement (read-only mounts, git hooks, or pre-commit allowlists).
2. Context rot: not measurable on simple tasks. Need to test on SWE-bench or multi-step tasks where the model actually struggles.
3. Test gate: tuned for .ts-only, but still false-positives on new .ts files that don't compile standalone.
