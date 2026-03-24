# Pursuit: Deliverable Verification — From Activity to Achievement

Generation: 9
Date: 2026-03-24
Status: designing

## Thesis

**Foreman's entire learning loop is built on a lie: "success" means "the session ran," not "the deliverable exists."** Fix the measurement and every downstream system — confidence, transfer, self-improvement, taste — gets honest signal for the first time. This is not a feature. It's correcting a foundational measurement error.

## System Audit

### What exists and works
- Tmux dispatch + worktree isolation: reliable
- Session monitoring (idle detection, prompt delivery): working after 3 bug fixes today
- Harvester: runs, captures git state, creates outcome records
- Confidence store: mechanically correct, updates on every harvest
- Post-completion pipeline: digest agent scores quality, recommends next action
- Prompt composition: 18 sections, context-budget-aware truncation
- 71 decisions, 91.5% status-level success

### What exists but produces wrong signal
- **Harvester success heuristic**: `commits > 0 && hasErrors ? 'success'` — treats errors + commits as success
- **Quality scoring**: Claude assigns 1-10 with no rubric, hardcoded `>= 7` for confidence signal
- **Confidence graduation**: updates on activity, not achievement — every number is wrong
- **Cross-project transfer**: +0.02 signal fires on fake successes, polluting other projects
- **Prompt composition**: 18 sections added speculatively, Exp 1 + SWE-bench show no benefit (and possible harm via context rot)

### What was tested and failed
- Exp 1: Rich prompts 0pp delta on coding tasks (Sonnet saturates)
- Exp 5: 0/18 self-improvement deliverables (scope creep dominates)
- Exp 6: No positive cross-project transfer (difficulty > experience)
- SWE-bench v2: 0% pass rate (10/17 partial — right files, wrong fix)
- SWE-bench: bare outperforms full (7/9 partial vs 4/8 partial)

### What doesn't exist yet
- Deliverable assertions (specify what the output should be)
- Scope locks (restrict what files can be modified)
- Test gates (type checker / test suite must pass before marking success)
- Prompt ablation by section (which of the 18 sections help vs hurt?)
- Separate "doer" and "checker" agents (Artisan pattern)

### Research Findings (from SOTA survey)
1. **Context rot is real** (EMNLP 2025, Chroma 2025): every token added degrades execution 13-85%. Bare prompts for execution, rich prompts only for planning.
2. **Deliverable verification needs independent predicates** (Artisan, arXiv 2602.10046): separate the doer from the checker. 3.14x improvement.
3. **Multi-agent coordination fails at scale** (MAST, NeurIPS 2025): 41-87% failure rates. Cap at 3-4 agents. Single-writer principle.
4. **Scope creep is OWASP top 10 for agents** (MCP02:2025): unsolved industry-wide. Best available: filesystem isolation + file allowlists + diff verification.
5. **More agents ≠ better** (VentureBeat 2025): once single-agent exceeds 45% accuracy, adding orchestration has diminishing returns.

### Measurement Gaps
- No per-section prompt efficacy tracking
- No deliverable existence checking
- No diff-scope verification (what changed vs what should have changed)
- No cost per dispatch (cost capture patterns don't match Claude Code output)
- No "agree/disagree" operator feedback path (weights exist but never called)

## Current Baselines

| Metric | Value | Source |
|---|---|---|
| Status-level success rate | 91.5% (65/71) | decisions table |
| Actual deliverable completion | ~56% (estimated) | Exp 6 manual analysis |
| Self-improvement deliverable rate | 0% (0/18) | Exp 5 |
| PR merge rate (self-improvement) | 0% (0/18) | Exp 5 |
| Confidence calibration gap | +79pp (94% actual at 0.15 predicted) | Exp 2 |
| Prompt ablation delta | 0pp (bare = full on coding) | Exp 1 |
| SWE-bench pass rate | 0% (0/17) | SWE-bench v2 |
| SWE-bench bare vs full partial | 78% vs 50% (bare wins) | SWE-bench v2 |

## Diagnosis

The system has **measurement corruption at the foundation**. Every downstream system trusts the harvester's "success" label:
- Confidence updates on "success" → scores are inflated by ~35pp
- Transfer fires on "success" → noise propagated to other projects
- Taste learning sees "success" → can't distinguish good from bad dispatches
- Auto-dispatch triggers at confidence thresholds → based on wrong data

This is not a tuning problem. It's an architectural measurement error. Fixing the metric fixes the signal, which fixes the learning, which fixes the dispatch quality over time.

Secondary: context rot from rich prompts. The 18-section prompt composition is actively hurting execution tasks. SWE-bench bare outperforming full is not noise — it's the context rot phenomenon documented in EMNLP 2025.

---

## Generation 9 Design

### Thesis
**Measure achievement, not activity. Compose less, verify more.**

### Changes (ordered by impact)

#### Architectural (must ship together)

**1. Deliverable assertions in dispatch** — CRITICAL
Each dispatch optionally declares what it should produce:
```typescript
interface DeliverableSpec {
  path: string              // relative to workDir
  minLines?: number         // minimum content length
  mustContain?: string[]    // strings that must appear
  mustNotContain?: string[] // strings that must NOT appear
  testCommand?: string      // command that must exit 0
}
```
The harvester checks these BEFORE marking success. Missing deliverable = failure, regardless of session activity.

Risk: LOW. Optional field, backward compatible. Existing dispatches without specs still use old heuristics.

**2. Independent verification agent (Artisan pattern)** — HIGH IMPACT
After harvest, a separate agent verifies the deliverable:
- Reads the spec
- Checks file existence, content, test results
- Runs the test command in the worktree
- Produces a binary pass/fail + reasoning
- This agent's verdict overrides the harvester's heuristic

The doer and checker must be different agents. Self-report is what caused the 35pp gap.

Risk: MEDIUM. Adds latency and cost to pipeline. But verification is cheap vs re-dispatching.

**3. Scope diff verification** — HIGH IMPACT
After session completes, compute `git diff --name-only` and compare against:
- Expected modified files (from deliverable spec or task description)
- Allowlisted files (if specified)
- Flag unexpected modifications as scope creep

```typescript
interface ScopeSpec {
  allowedPaths?: string[]   // glob patterns of files that MAY change
  forbiddenPaths?: string[] // glob patterns that must NOT change
}
```

Risk: LOW. Information only at first (flag, don't block). Can graduate to blocking.

**4. Slim execution prompts** — HIGH IMPACT
Based on context rot research, split prompt composition into two tiers:

| Task type | Prompt strategy | Budget |
|---|---|---|
| Execution (/verify, /converge, direct fixes) | Bare: task + CLAUDE.md + git workflow only | 1500 chars |
| Reasoning (/pursue, /plan, /research, /reflect) | Rich: task + full context + exemplars + taste | 6000 chars |
| Hybrid (/evolve, /critical-audit, /polish) | Medium: task + CLAUDE.md + recent decisions + dead ends | 3000 chars |

Kill sections that have zero measured impact: exemplars, success patterns, workflows, anti-patterns, skill preferences, project relationships. Keep only: task, CLAUDE.md, git workflow, recent decisions (for avoiding dead ends), and goal context.

Risk: MEDIUM. May lose some contextual value on reasoning tasks. But the data says we're hurting more than helping on execution.

#### Measurement (eval changes)

**5. Honest success metric** — CRITICAL
Replace the status-level success rate with a 3-tier metric:

| Tier | Definition |
|---|---|
| **session_success** | Session ran and exited cleanly (current metric) |
| **deliverable_success** | Deliverable spec satisfied (file exists, content valid, tests pass) |
| **merged_success** | Work was merged to main via PR |

All three reported. Confidence updates ONLY on deliverable_success.

**6. Prompt section ablation tracking** — MEDIUM
Add a `prompt_sections` field to decisions recording which sections were included. After 50+ dispatches, correlate section presence with deliverable_success rate. Kill sections with zero or negative correlation.

#### Infrastructure

**7. Test gate for self-improvement** — MEDIUM
Before marking self-improvement dispatches as success:
```bash
cd $WORKTREE && npx tsc --noEmit 2>&1
```
If type checker fails → deliverable_failure, regardless of other signals.

**8. Sibling session deduplication** — LOW
Before dispatching, check if another active session targets the same worktree/branch. If so, skip or queue.

### Alternatives Considered

| Approach | Why rejected |
|---|---|
| Fix prompts to be more directive | Exp 5 shows 8/18 sessions ignore instructions. Prompt changes alone won't fix this. |
| Add more context to prompts | EMNLP 2025 shows more context = worse execution. We need less. |
| Multi-agent decomposition | MAST (NeurIPS 2025) shows 41-87% failure rates. We're already at the coordination frontier. |
| GEPA optimization of dispatch policy | Need honest success signal first. Optimizing on corrupted labels makes things worse. |
| Remove self-improvement entirely | Too defeatist. Fix measurement first, then see if self-improvement works with honest signal. |

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Deliverable specs are hard to write | Medium | Medium | Start with optional, teach by example, auto-infer from task description |
| Verification agent adds cost | Low | Low | One Haiku call per harvest (~$0.001). Trivial vs dispatch cost. |
| Slim prompts lose needed context | Medium | Medium | A/B test slim vs rich on 20 tasks before full rollout |
| Success rate drops to ~56% (true rate) | High | Low | This is accurate. The old number was wrong. |
| Confidence drops to near-zero | High | Low | Correct. Rebuild from honest signal. |

### Success Criteria

| Metric | Baseline | Target | How measured |
|---|---|---|---|
| Deliverable success rate | ~56% (estimated) | 65%+ (real improvement via scope + verification) | Deliverable spec checks |
| Success/deliverable gap | 35pp (91.5% vs 56%) | <10pp | Compare session_success vs deliverable_success |
| Self-improvement deliverable rate | 0% (0/18) | 30%+ | Deliverable specs on self-improvement dispatches |
| Prompt composition delta | 0pp (bare = full) | +5pp on execution tasks (slim > rich) | A/B on next 20 dispatches |
| SWE-bench bare vs full gap | -28pp (full is worse) | ±5pp (no harm) | Rerun with slim prompts |
| Confidence ECE | unmeasurable (single bin) | <0.15 | After 50+ deliverable-verified dispatches |

### Build Status

| # | Change | Status | Files Changed |
|---|--------|--------|---------------|
| 1 | Deliverable assertions | not started | service/index.ts (dispatch API + harvester) |
| 2 | Verification agent | not started | service/lib/verify-agent.ts |
| 3 | Scope diff verification | not started | service/index.ts (harvester) |
| 4 | Slim execution prompts | not started | service/index.ts (composePrompt) |
| 5 | Honest success metric | not started | service/index.ts (harvester + API) |
| 6 | Prompt section tracking | not started | service/index.ts (composePrompt + decisions schema) |
| 7 | Test gate for self-improvement | not started | service/index.ts (harvester) |
| 8 | Sibling deduplication | not started | service/index.ts (dispatch) |

## Hypotheses to Test After Building

### H1: Deliverable verification closes the 35pp gap
Run 20 dispatches with deliverable specs. Compare deliverable_success to session_success. Target: gap < 10pp.

### H2: Slim prompts improve execution task success
A/B test on 10 tasks: slim (1500 chars) vs rich (6000 chars). Measure deliverable_success. Hypothesis: slim wins by 10+pp on execution tasks.

### H3: Scope locks recover self-improvement deliverables
Dispatch 5 self-improvement sessions with file allowlists. Target: 3/5 produce stated deliverable (vs 0/18 baseline).

### H4: Independent verification catches false positives
Run verification agent on the 15 "successful" decisions from this session. How many does it reject? Target: catches 5+ false positives.

### H5: Honest confidence calibration enables useful graduation
After 50 deliverable-verified dispatches, compute ECE. Target: < 0.15 (vs unmeasurable baseline).

### H6: Context rot is measurable on Foreman tasks
Run SWE-bench with 3 prompt lengths: bare (500 chars), slim (1500), rich (6000). Hypothesis: partial rate decreases monotonically with prompt length.
