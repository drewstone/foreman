---
# Decision 008: Planning Layer — Foreman Generates Plans, Not Just Executes Them

Date: 2026-03-23
Status: DESIGNING
Origin: Human (Drew) — vision for Foreman as product/research operator

## Context

Gens 0-6 built the execution layer: dispatch, harvest, learn, optimize. The operator (Drew) provides goals, Foreman decomposes and executes. But Drew described a higher level:

"I want Foreman to generate product direction and ideas, with very clear reasoning. Rank them critically valuable / high / medium / low. Learn which plans I approve. Over time take the lead in product operations, marketing. Figure out what I'm working on and generate plans for it."

This is a shift from EXECUTION OPERATOR to PLANNING OPERATOR.

## The Architecture

```
Session scanning (1,920+ sessions)
  → Deep analysis (flows, patterns, gaps)
  → Plan generation (product features, research, papers)
  → Plans ranked by value (critical/high/medium/low)
  → Operator reviews (approve/reject/modify)
  → Taste model learns what plans get approved
  → Better plans next cycle
  → Approved plans become Foreman goals → dispatched → executed
```

## What This Means

Foreman doesn't wait for Drew to say "drive phony to SOTA." It NOTICES that phony's voice quality metrics are stalling, generates a plan "Research CosyVoice3 fine-tuning approaches — the current LoRA config has plateaued," ranks it as high-value based on Drew's taste model, and presents it for approval.

When Drew starts a new project, Foreman detects it from session scanning, reads the repo, and generates an onboarding plan: "New project detected: tax-filler-filer. Suggested plan: 1. /init-context 2. /critical-audit 3. /evolve test coverage to 80%."

## Key Design Questions

1. Where do plans live? → ~/.foreman/plans/ (like skill-proposals)
2. How are they generated? → Deep analysis + LLM reasoning (scheduled)
3. How does the operator review? → Draft PRs? Telegram? Pi?
4. How does Foreman learn? → Same taste model (approve/reject signals)
5. How do approved plans become goals? → POST /api/goals automatically

## Origin Analysis

- **Human**: Drew articulated the full vision — Foreman as product operator, not just code executor
- **AI**: Claude formalized as the planning layer architecture
- **Key insight**: The same GEPA + taste infrastructure that optimizes dispatch decisions can optimize plan generation. The "what to work on" decision is just a higher-level version of the "what skill to dispatch" decision.
