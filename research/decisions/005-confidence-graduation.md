# Decision 005: Confidence Graduation — Autonomy Through Evidence

Date: 2026-03-22
Status: ACCEPTED
Origin: Pre-existing design (VISION.md), integrated as Gen 3

## Context

The confidence graduation system was designed in the original VISION.md but never implemented in the daemon. Gen 3 integrated the existing `packages/memory/confidence.ts` (197 lines, tested) into the service.

## Decision

Per-(skill, project) confidence scores from 0.0 to 1.0:
- 0.0-0.3: dry-run (log what you'd do)
- 0.3-0.6: propose (ask operator)
- 0.6-0.8: act-notify (dispatch, notify)
- 0.8-1.0: autonomous (dispatch, silent)

Signals: success +0.05, failure -0.10, operator agrees +0.10, operator disagrees -0.15

Safety rails: $20/day cost cap, 5 concurrent session cap

## Origin Analysis

- **Human contribution**: Drew designed the confidence levels and graduation concept in VISION.md before this session
- **AI contribution**: Claude wired the existing ConfidenceStore into the service's harvest → confidence → auto-dispatch pipeline
- **Integration insight**: The confidence store was already built and tested. The value was in WIRING it into the autonomous loop, not rebuilding it.

## Current State

11 (skill, project) pairs tracked. All at 0.05-0.10 (dry-run). Need ~12 more successes per pair to reach act-notify. The PiGraph run produced 10 successes across different worktrees — if they were on the same project key, confidence would be at 0.50 already.

## Key Insight for Paper

Confidence graduation solves the trust calibration problem: users don't want to "flip a switch" from manual to autonomous. Evidence-based graduation means the system earns trust at different rates for different contexts. The asymmetric signal weights (disagree=-0.15 vs agree=+0.10) encode a conservative prior — it's harder to gain trust than to lose it.
