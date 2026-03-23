# Foreman Experiment Protocol

## Paper Thesis

Autonomous software operating systems that learn operator taste, graduate to autonomy through evidence, and improve their own prompts from outcomes outperform both static orchestrators and fully automated self-improvement systems on real-world portfolio management tasks.

## Experiment Suite

### Experiment 1: Prompt Composition Ablation
**Question**: Does Foreman's rich prompt composition improve dispatch success rate?

**Setup**: 20 coding tasks (from PiGraph eval suite — easy/medium/hard tiers).
Run each task through Claude Code with 4 prompt conditions:

| Condition | What's in the prompt |
|---|---|
| **bare** | Just the task description (1 sentence) |
| **basic** | Task + CLAUDE.md + standards |
| **rich** | Task + CLAUDE.md + git history + evolve state + past decisions + dead ends |
| **full** | Everything above + operator exemplars + taste + learned flows + experiment trajectory |

**Metric**: Task completion rate (tests pass after session), number of commits, wall-clock time.
**Repeats**: 3 per condition per task = 20 × 4 × 3 = 240 sessions.
**Model**: Claude Sonnet (consistent, cost-effective).
**Implementation**: Modify `composePrompt()` to accept a `condition` parameter that gates which sections are included.

### Experiment 2: Confidence Graduation Validation
**Question**: Does confidence-gated autonomy correlate with actual success?

**Setup**: Use Foreman's existing decision history (40+ decisions across multiple projects).
Extract: confidence score at time of dispatch → actual outcome (success/failure).

**Analysis**:
- Plot confidence vs success rate (calibration curve)
- Compute Expected Calibration Error (ECE)
- Compare: does high confidence predict success? Does low confidence predict failure?
- Track confidence trajectory over time per (skill, project) pair

**Data**: Already in SQLite — `decisions` table + `confidence` DB. No new runs needed, just analysis.

### Experiment 3: Session Mining Value
**Question**: Does learning from operator sessions improve dispatch quality?

**Setup**: Same 20 tasks, 2 conditions:

| Condition | Session mining |
|---|---|
| **no-mining** | composePrompt() excludes exemplars, flows, anti-patterns, taste |
| **with-mining** | Full prompt including all mined data |

**Metric**: Task completion rate, quality score (from post-completion digest), relevance of approach (does the session take an approach the operator would approve?).
**Repeats**: 3 per condition per task = 20 × 2 × 3 = 120 sessions.

### Experiment 4: Post-Completion Pipeline Ablation
**Question**: Does the post-completion digest improve subsequent dispatches?

**Setup**: Run 10 sequential dispatches on the same project, 3 conditions:

| Condition | Post-completion |
|---|---|
| **identity** | No analysis after session completes |
| **digest** | Sonnet summarizes, scores quality, recommends next action |
| **full** | Digest + audit sub-agent |

**Metric**: Quality trajectory over 10 dispatches — does quality improve faster with better post-completion analysis?
**Repeats**: 3 sequences per condition = 3 × 3 × 10 = 90 sessions.

### Experiment 5: Self-Improvement Effectiveness
**Question**: Can Foreman improve itself through self-modification?

**Setup**: Dispatch `/api/self-improve` 10 times. For each:
- Record what was changed
- Run type checker + tests before and after
- Measure: does the change improve any metric (success rate, prompt quality score, harvester accuracy)?
- Track: how many self-improvements are accepted (PR merged) vs rejected

**Metric**: Acceptance rate, metric improvement per self-modification, regression rate.
**This is the Hyperagents comparison experiment.**

### Experiment 6: Cross-Project Transfer
**Question**: Does success on project A accelerate learning on project B?

**Setup**: Run Foreman on 3 independent projects (PiGraph, belief-state, avalanche).
2 conditions:

| Condition | Transfer |
|---|---|
| **isolated** | Confidence is per-project only, no transfer signal |
| **transfer** | Cross-project confidence transfer enabled (+0.02 per success) |

**Metric**: Time-to-autonomous (how many dispatches until confidence reaches 0.6), success rate on first dispatch per project, overall portfolio success rate.
**Repeats**: 3 portfolio runs per condition = 6 portfolio runs.

### Experiment 7: Terminal Benchmark (TerminalBench)
**Question**: How does Foreman-dispatched Claude Code compare to raw Claude Code on terminal tasks?

**Setup**: Standard terminal benchmark tasks (file manipulation, system administration, scripting).
2 conditions:

| Condition | How the task is dispatched |
|---|---|
| **raw** | `claude -p "task description"` (no Foreman) |
| **foreman** | Foreman dispatches with full prompt composition, worktree isolation, skill selection |

**Tasks**: 30 terminal tasks across 3 difficulty tiers.
**Metric**: Completion rate, correctness, time, cost.
**Repeats**: 3 per condition per task = 30 × 2 × 3 = 180 sessions.

### Experiment 8: SWE-Bench Lite
**Question**: How does Foreman perform on standardized software engineering tasks?

**Setup**: SWE-bench Lite subset (100 GitHub issues with known fixes).
3 conditions:

| Condition | Approach |
|---|---|
| **raw** | Claude Code with just the issue description |
| **foreman-single** | Foreman dispatches one session with rich prompt |
| **foreman-multi** | Foreman decomposes, dispatches multiple parallel sessions, aggregates |

**Metric**: Resolution rate, patch correctness, time, cost.
**Repeats**: 1 per condition per task = 100 × 3 = 300 sessions.
**Note**: This is expensive. Run a pilot on 10 tasks first.

## Baselines

| System | What it represents |
|---|---|
| **Raw Claude Code** | No orchestration — just `claude -p "task"` |
| **Foreman (identity)** | Foreman with all optimization disabled (identity optimizer, identity post-completion, no mining) |
| **Foreman (full)** | Everything enabled |
| **Static orchestrator** | Fixed workflow: always /evolve, no taste, no confidence, no learning |

## Metrics Framework

### Primary Metrics
- **Task completion rate**: binary (tests pass / don't pass)
- **Quality score**: 1-10 from post-completion digest agent
- **Time to completion**: wall-clock seconds
- **Cost**: USD per dispatch (tokens × pricing)

### Secondary Metrics
- **Commits per session**: productivity proxy
- **PR acceptance rate**: quality proxy
- **Confidence calibration**: ECE between predicted and actual success
- **Learning curve**: success rate over time (first 10 dispatches vs last 10)
- **Cross-project transfer**: confidence growth rate with vs without transfer

### Meta-Metrics (for the paper's methodology contribution)
- **Operator intervention rate**: how often does the operator redirect Foreman?
- **Taste model accuracy**: do taste-informed dispatches get approved more?
- **Self-improvement acceptance rate**: what % of self-modifications are merged?

## Implementation Plan

### Phase 1: Build the Eval Harness (1 day)
- Create `research/experiments/harness.ts` that:
  - Takes a task suite + condition + model
  - Dispatches via Foreman service API (or raw Claude) depending on condition
  - Captures: completion, quality, time, cost, commits, PR
  - Outputs structured JSON results
- Reuse PiGraph's eval runner pattern (already works)

### Phase 2: Build Task Suites (2 days)
- **Terminal tasks**: 30 tasks across 3 tiers (adapt from TerminalBench or build fresh)
- **Coding tasks**: 20 tasks from PiGraph eval (already exist)
- **SWE-bench lite**: download 100 tasks from SWE-bench dataset
- Each task: workspace + tests + known fix + verification command

### Phase 3: Run Ablation Experiments (3 days)
- Experiment 1: Prompt ablation (240 sessions, ~$50-100)
- Experiment 3: Mining ablation (120 sessions, ~$25-50)
- Experiment 4: Post-completion ablation (90 sessions, ~$20-40)

### Phase 4: Run Benchmark Experiments (2 days)
- Experiment 7: Terminal benchmark (180 sessions, ~$40-80)
- Experiment 8: SWE-bench pilot (30 sessions, ~$15-30)

### Phase 5: Analysis from Existing Data (1 day, no cost)
- Experiment 2: Confidence calibration (analyze SQLite)
- Experiment 6: Cross-project transfer (analyze existing dispatches)
- Experiment 5: Self-improvement (analyze PR acceptance)

### Phase 6: Write Results Section (2 days)
- Tables + figures for each experiment
- Statistical significance tests (bootstrap CI, paired t-tests)
- Comparison to Hyperagents' published results
- Honest limitations section

## Cost Estimate

| Experiment | Sessions | Est. Cost |
|---|---|---|
| Prompt ablation | 240 | $50-100 |
| Mining ablation | 120 | $25-50 |
| Post-completion ablation | 90 | $20-40 |
| Terminal benchmark | 180 | $40-80 |
| SWE-bench pilot | 30 | $15-30 |
| Self-improvement | 10 | $5-10 |
| **Total** | **670** | **$155-310** |

Analysis experiments (2, 5, 6) use existing data — $0 additional cost.

## Related Work to Address

The paper must position Foreman against:

| System | Relationship to Foreman |
|---|---|
| Hyperagents (Meta/FAIR) | Self-referential improvement. Foreman adds operator taste + conversation policy. |
| Hermes Agent (Nous) | Multi-platform single agent. Foreman adds portfolio orchestration + learning. |
| SWE-Agent | Coding agent. Foreman orchestrates coding agents, doesn't compete. |
| OpenDevin | Open coding agent platform. Foreman is the meta-layer above. |
| AutoGPT/BabyAGI | Early autonomous agents. Foreman has evidence-based confidence + taste. |
| DSPy | Prompt optimization framework. Foreman's GEPA integration is related. |
| ADAS (Google) | Automated Design of Agentic Systems. Closest to Foreman's self-improvement. |
| Voyager (NVIDIA) | Skill library that grows. Foreman's skill proposals are related. |
| CrewAI/LangGraph | Multi-agent workflow tools. Foreman dispatches dynamically, not static workflows. |

## Formal Problem Statement (for the paper)

**Autonomous Portfolio Operation** (APO): Given a set of goals G = {g₁, ..., gₙ}, a set of agent sessions S, and an operator taste model T learned from operator feedback, find the dispatch policy π: (G, S, T, H) → A that maximizes the aggregate goal progress while minimizing operator intervention, where H is the history of past dispatches and outcomes, and A is the action space (dispatch skill to project, auto-dispatch, propose, wait).

The key innovation: π is not a fixed function — it's a conversation between the operator and an LLM, informed by T and H. The system improves π over time through:
1. Taste learning from operator signals (T grows)
2. Confidence graduation from outcome evidence (autonomy increases)
3. Prompt optimization from dispatch results (prompt quality improves)
4. Cross-project transfer (learning accelerates)
5. Self-modification (the system improves its own code)
