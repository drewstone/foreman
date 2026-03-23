# Experiment 1 (Preliminary): Existing PiGraph Eval Data

Date: 2026-03-23
Status: DATA COLLECTED (from overnight dispatches, $0 additional cost)

## Data Available

### Run 1: Easy/Medium/Hard (20 tasks, 60 sessions, Haiku)
- **Result**: 100% pass rate across all 3 variants (baseline, validation, full)
- **Finding**: At this difficulty, Haiku saturates — PiGraph can't show differentiation
- **Speed finding**: Validation variant is 35% faster on hard tasks (17.6s vs 27.0s)
- **Interpretation**: PiGraph validation helps the agent converge faster even when both succeed

### Run 2: Challenge (10 tasks, 90 sessions, Haiku)
- **Result**: 0% pass rate across all 3 variants
- **Finding**: Challenge tasks are genuinely hard — designed to cause failures
- **Interpretation**: Need to run with Sonnet to get variance (Haiku can't solve these at all)

## What This Means for the Foreman Prompt Ablation

The PiGraph data tests PiGraph's value (validation, context shaping). The Foreman prompt ablation tests a DIFFERENT hypothesis: does Foreman's rich prompt composition improve session success?

To run the Foreman-specific ablation:
1. Use the same 30 tasks (e01-e07, m01-m10, h01-h06, c01-c10)
2. Instead of PiGraph variants, vary the PROMPT:
   - bare: just the task description
   - basic: task + CLAUDE.md + standards
   - rich: task + full composePrompt() output
3. Use Sonnet (not Haiku) so challenge tasks have variance
4. The existing PiGraph run-eval.mjs runner can be adapted

## Key Insight

The 35% speed improvement from PiGraph validation on hard tasks is a real result for PiGraph's paper. For Foreman's paper, we need to show that PROMPT COMPOSITION (not PiGraph instrumentation) improves success rate. Different hypothesis, different experiment, same task suite.

## Next Step

Build the Foreman prompt ablation harness that:
1. Takes a task from the PiGraph suite
2. Composes prompts at 3-4 levels of richness
3. Dispatches via `claude -p` with each prompt level
4. Runs verification
5. Records results
