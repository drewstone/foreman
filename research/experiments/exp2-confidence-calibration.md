# Experiment 2: Confidence Calibration Analysis

Date: 2026-03-23
Status: COMPLETE (analysis of existing data, $0 cost)

## Question
Does Foreman's confidence graduation model correlate with actual dispatch success?

## Data
- 40 total decisions
- 38 with outcomes (success/failure)
- 29 confidence entries across (skill, project) pairs
- 41 confidence log entries showing trajectory

## Results

### Calibration Table

| Confidence Range | Dispatches | Successes | Actual Rate | Expected Rate | Gap |
|---|---|---|---|---|---|
| 0.00–0.10 | 1 | 1 | 100% | 5% | +95pp (too few samples) |
| 0.10–0.20 | 35 | 33 | 94% | 15% | +79pp |
| 0.20–0.30 | 2 | 2 | 100% | 25% | +75pp (too few samples) |

**Overall: 36/38 = 94.7% success rate**

### By Skill

| Skill | Success Rate | Dispatches |
|---|---|---|
| /evolve | 87% | 13/15 |
| /pursue | 100% | 13/13 |
| /research | 100% | 2/2 |
| /polish | 100% | 2/2 |
| direct prompts | 100% | 6/6 |

### Confidence Trajectory

/pursue@repo: 0.00 → 0.05 → 0.10 → 0.15 → 0.20 → 0.25 → 0.30 → 0.35 → 0.40 (8 consecutive successes)
/evolve@pigraph: 0.00 → 0.05 → 0.10 → 0.15 (3 successes + transfer)

## Interpretation

### Finding 1: The model is severely UNDER-confident
Confidence ranges 0.10-0.20 have a 94% actual success rate. The model expects ~15% success at this confidence. This means Foreman is being far too cautious — it should be dispatching autonomously much sooner.

**Root cause**: The signal weights are too conservative. Success = +0.05 means it takes 12 successes to reach 0.60 (act-notify). With 94% actual success rate, the system should graduate faster.

**Recommendation**: Increase success signal weight from +0.05 to +0.10, or add a "streak bonus" where consecutive successes accelerate graduation.

### Finding 2: /pursue is the best-performing skill
100% success rate across 13 dispatches. This is likely because /pursue tasks are well-specified architectural changes — the Pi session writes very detailed prompts for /pursue dispatches.

### Finding 3: /evolve has the only failures
2 failures out of 15, both on PiGraph (viz-export prompt formatting issue, redispatched successfully). The failure mode was prompt-related, not skill-related.

### Finding 4: Insufficient variance for real calibration analysis
Almost everything succeeds (94.7%). We need tasks that fail more often to test whether confidence predicts failure. The prompt ablation experiment (Experiment 1) will provide this by using deliberately degraded prompts.

## ECE (Expected Calibration Error)
Cannot compute meaningfully — all data points are in the 0.10-0.20 confidence bin with 94% success. Need wider confidence distribution.

## Recommendations for the Paper

1. Report the under-confidence finding — it's genuine and interesting
2. Adjust signal weights before running ablation experiments
3. The 94.7% success rate IS a publishable result for portfolio-level dispatch
4. Need to run experiments that produce failures to validate the lower end of the confidence model

## Action Items

- [ ] Adjust confidence signal: success from +0.05 to +0.10
- [ ] Run prompt ablation (Experiment 1) to produce deliberate failures
- [ ] Re-analyze calibration after more variance in outcomes
