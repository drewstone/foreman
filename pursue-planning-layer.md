# Pursuit: Planning Layer — Foreman Generates Plans

Generation: 7
Date: 2026-03-23
Status: designed (build next session)

## Thesis

**Foreman shifts from execution operator to planning operator.** Instead of waiting for goals, it generates plans from session analysis, ranks them by predicted operator value, and learns which plans get approved. Approved plans become goals → dispatched → executed → outcomes feed back into plan quality.

## Changes

### Architectural (must ship together)

1. **Plan generator** — periodic job (every 12 hours or on-demand) that:
   - Reads recent session activity across all projects
   - Identifies: stalled goals, emerging opportunities, unaddressed gaps
   - Generates 3-5 plans with clear reasoning
   - Ranks: critically valuable / high / medium / low
   - Stores in ~/.foreman/plans/<id>/

2. **Plan storage + API** —
   - POST /api/plans — create a plan (manual or auto-generated)
   - GET /api/plans — list plans (filter by status, rank)
   - PATCH /api/plans/:id — approve/reject/modify
   - Plans include: title, reasoning, rank, proposed_goal, evidence, risks

3. **Plan → Goal pipeline** — when a plan is approved:
   - Auto-create a goal (POST /api/goals)
   - Auto-dispatch the first skill on the goal
   - Track which plan generated which goal

4. **Plan taste learning** — same taste model as dispatches:
   - Approved plans → +signal for that plan type
   - Rejected plans → -signal
   - Over time, Foreman generates plans that match operator taste
   - Use GEPA to optimize the plan generation prompt

### Infrastructure

5. **New project detection** — when session scanning finds sessions in repos
   that aren't in the goals table, generate an onboarding plan automatically

6. **Telegram integration** — send plans to Telegram for quick approval:
   "Foreman suggests: /evolve phony voice quality (high value). Approve? /yes /no"

## Plan Format

```json
{
  "id": "plan-mn4abc",
  "title": "Research CosyVoice3 fine-tuning alternatives",
  "type": "research",  // product | research | engineering | marketing | paper
  "rank": "high",      // critical | high | medium | low
  "reasoning": "Phony voice quality has plateaued at 0.85 composite across 3 evolve cycles. Current LoRA approach may have reached its ceiling. CosyVoice3 paper suggests multi-speaker fine-tuning could break through.",
  "evidence": ["decision:15 — /evolve plateau", "learning:flow — evolve 3x then pursue"],
  "proposed_goal": {
    "intent": "Research and implement CosyVoice3 multi-speaker fine-tuning for phony",
    "workspace_path": "/home/drew/code/phony",
    "first_skill": "/research"
  },
  "risks": ["May cost $50+ in GPU time", "CosyVoice3 may not support our voice format"],
  "status": "proposed",
  "created_at": "2026-03-23T...",
  "taste_signal": null
}
```

## Success Criteria

- Plans generated automatically from session analysis
- At least 1 plan approved and converted to a goal within 24 hours
- Taste model shows convergence (approved plan types score higher over time)
- New project detection triggers onboarding plan within 1 hour of first session
