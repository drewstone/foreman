# Decision Pattern Synthesis

Analysis of 8 decision records (001–008) from the Foreman project, covering 2026-03-22 to 2026-03-23.

## Decision Inventory

| # | Decision | Type | Origin | Status | Outcome Quality |
|---|----------|------|--------|--------|-----------------|
| 001 | Standalone service over daemon | Architecture | Human + AI | ACCEPTED | Strong — 83% dispatch success vs 1.6% action rate |
| 002 | Conversation as policy function | Architecture | Human | ACCEPTED | Strong — foundational reframe, enabled all subsequent work |
| 003 | Rich prompt composition | Architecture | Human gap-ID + AI design | ACCEPTED | Strong — 5K+ char prompts, 83% success rate |
| 004 | Mine operator sessions | Feature | Human | ACCEPTED | Strong — 437 sessions, 180 learnings, 21 taste signals |
| 005 | Confidence graduation | Feature | Pre-existing (Human) | ACCEPTED | Moderate — wired in, all pairs still in dry-run range |
| 006 | Universal agent shape | Architecture | Human + AI | ACCEPTED | Partial — pattern recognized, not yet unified |
| 007 | Hyperagents comparison | Research | Human + AI | RESEARCH | Informational — identified adoption targets, no implementation |
| 008 | Planning layer | Architecture | Human | DESIGNING | Speculative — designed, not built |

## Most Common Decision Type

**Architecture decisions dominate: 5 of 8 (62.5%).** Feature decisions account for 2 (25%), research for 1 (12.5%).

This is consistent with the project's stage — Gens 0–6 were defining what Foreman IS, not adding incremental features. The architecture decisions cluster around a single thesis: remove the LLM from policy, put the operator in the loop, make every surface optimizable.

The two feature decisions (004, 005) are infrastructure that ENABLES the architecture — session mining feeds the prompt composer, confidence graduation gates autonomous dispatch. They serve the architecture, not the user directly.

## Human vs AI Origin Ratios

| Origin Category | Count | Decisions |
|-----------------|-------|-----------|
| Human (Drew) | 4 | 002, 004, 005, 008 |
| Human + AI collaborative | 3 | 001, 006, 007 |
| Human gap-ID + AI design | 1 | 003 |
| AI-originated | 0 | — |

**The human originates 100% of decisions.** In no case did Claude independently identify a problem and propose a solution that Drew hadn't already intuited. The AI's role is formalization, implementation, and pattern completion — never strategic direction.

Breakdown of contribution patterns:
- **Drew identifies the problem** in all 8 cases. His contributions are critiques ("98.4% do nothing"), vision statements ("the product is a conversation"), and requests ("can we ensure foreman learns from my sessions?").
- **Claude formalizes and builds** in all 8 cases. Claude's contributions are architecture designs, interface definitions, implementation, and competitive analysis.
- **The collaborative cases** (001, 006, 007) involve Drew stating a principle and Claude extending it to its logical conclusion. In 001, Drew said "conversation is the policy" and Claude said "the service should never think." In 006, Drew saw the pattern across post-completion digests and Claude generalized it to all 6 pipelines.

## Which Decisions Led to the Best Outcomes

Ranked by measurable impact:

1. **001 — Service over daemon.** Quantified improvement: 1.6% → 83% action success rate. This was the foundational architectural shift. Without it, nothing else works.

2. **003 — Rich prompt composition.** Direct causal link to dispatch quality. Prompts went from generic one-liners to 5K+ chars of project state, past decisions, and taste. The 83% success rate in the PiGraph run is attributable to this.

3. **004 — Session mining.** Produced the largest volume of learning signal: 437 sessions → 180 learnings → 21 taste signals. This is the data flywheel that feeds prompt composition and taste learning.

4. **002 — Conversation as policy.** Hard to measure directly because it's a framing decision, not an implementation. But it's the conceptual foundation for everything — without "conversation is the policy," decisions 001, 003, and 004 have no coherent framework.

5. **005 — Confidence graduation.** Correctly designed and wired in, but hasn't produced measurable autonomy yet (all pairs in dry-run range). The asymmetric signal weights are sound, but the system needs more cycles to prove the graduation model works.

6. **006 — Universal agent shape.** Architecturally elegant but partially implemented. The TracedAgent abstraction is still future work. Value is in the insight, not yet in the outcome.

7. **008 — Planning layer.** Pure design, no implementation. Could be the highest-impact decision long-term (Foreman generating plans vs executing them), but zero evidence yet.

8. **007 — Hyperagents comparison.** Informational only. Validated that self-referential modification works (Meta/FAIR proved it), identified what to adopt, but no Foreman changes resulted.

## Key Patterns

**Pattern 1: The operator's taste IS the product.** Decisions 002, 004, and 008 all center on the same insight — Drew's judgment, preferences, and priorities are the irreplaceable input. Every successful architectural choice amplifies that signal; every failed approach (the daemon) suppressed it.

**Pattern 2: Measurement precedes improvement.** The decisions that produced the best outcomes (001, 003, 004) all introduced measurement where none existed. The daemon had no outcome tracking. Prompt composition made quality visible. Session mining made taste extractable. You cannot optimize what you do not measure.

**Pattern 3: AI extends, human redirects.** In every collaborative decision, the human contribution was a constraint or critique ("this is wrong," "we need this," "can we learn from X?") and the AI contribution was a generalization or formalization. The human narrows the search space; the AI fills it.

**Pattern 4: Accepted decisions cluster, speculative ones trail.** The first 6 decisions are ACCEPTED with measurable outcomes. The last 2 are RESEARCH/DESIGNING with no implementation. The project front-loaded architectural foundations and is now entering a phase where speculative bets need to be validated.
