# Foreman Research Corpus

Structured tracking of methodology, decisions, and results for eventual academic publication.

## Thesis

Autonomous software operating systems can be built through human-AI co-design, where the conversation between operator and agent IS the architecture process. The resulting system learns operator taste, graduates to autonomy through evidence, and improves its own prompts from outcomes.

## What We Track

- `decisions/` — every architectural decision with rationale, alternatives, and outcome
- `sessions/` — session summaries with human vs AI contribution analysis
- `metrics/` — quantitative data over time (success rate, cost, confidence, learnings)
- `generations/` — each pursuit generation's audit, design, build, evaluation
- `failures/` — structured failure analysis (what failed, why, what we learned)

## Paper Outline (working)

1. Introduction: the autonomous operating system problem
2. Related work: Hermes Agent, OpenClaw, pi-autoresearch, harness engineering
3. Architecture: service + conversation-as-policy + taste learning
4. The generational pursuit methodology: audit → design → build → evaluate
5. Prompt composition: context-loaded dispatches that improve from evidence
6. Confidence graduation: from dry-run to autonomous through outcome signals
7. Session mining: learning from 300+ operator sessions across harnesses
8. Results: daemon (98.4% inaction) → service (83% success, self-correction)
9. Meta-analysis: the reflect loop and recursive self-improvement
10. Discussion: conversation-driven architecture as a design methodology
