---
# Decision 006: The Universal Agent Shape

Date: 2026-03-23
Status: ACCEPTED
Origin: Human (Drew) + AI (Claude) — emerged from building post-completion pipeline

## Context

While building the post-completion pipeline (sub-agents that analyze sessions after completion), we realized that every pipeline in Foreman follows the same pattern:

1. Prompt composition: task → composePrompt() → dispatch prompt
2. Post-completion: session output → digest agent → quality score + learnings
3. Deep analysis: operator sessions → LLM → flows + taste
4. Template evolution: outcomes → Identity/GEPA → better template
5. Session mining: JSONL files → pattern extraction → exemplars
6. Decision capture: session → reflect → decision records

All of them are: Input → Agent → Structured Output → Stored → Feeds next cycle.

## Decision

Every pipeline in Foreman shares the same pluggable agent interface:
- `Identity`: passthrough, no processing
- `LLM`: Claude analyzes and produces structured output
- `GEPA-optimized`: AxGEPA evolves the agent's instruction over time

All outputs are stored, traced, and feed subsequent cycles. Every surface is optimizable.

## Rationale

Drew identified the pattern while discussing post-completion agents: "These post digests should be tracked like our experiments, reflections, research decisions. All tracked, all GEPA, LLM optimized, same interface where we could put the identity there."

The insight: it's not that we have separate systems for prompt optimization, session analysis, and post-completion review. It's ONE system with different input/output shapes. The optimization mechanism (GEPA) and the storage mechanism (SQLite + research/) are the same.

## Origin Analysis

- **Human contribution**: Drew saw the unifying pattern across pipelines — that the post-completion digest, the prompt template, and the session analysis should all be "tracked, all GEPA, LLM optimized, same interface." This was the architectural insight.
- **AI contribution**: Claude formalized it as the `Input → Agent → Output → Store → Feed` shape and enumerated all 6 pipelines that follow it. Also identified `TracedAgent` as the long-term abstraction.
- **Interaction**: Drew's observation about tracking post-completion digests triggered Claude to see the pattern across ALL pipelines, not just post-completion.

## Implementation

Currently partially implemented:
- PromptOptimizer interface: Identity + AxGEPA (for template evolution)
- PostCompletionAgent interface: Identity + Digest + Full (for session analysis)
- Both share the pluggable pattern but don't share a common abstraction yet

## Future: TracedAgent

A unified abstraction that wraps any pipeline:
```typescript
interface TracedAgent<TInput, TOutput> {
  name: string
  version: number
  run(input: TInput): Promise<TOutput>
  // Auto-logged: input, output, duration, version
  // Auto-scored: downstream outcome correlation
  // Auto-optimized: GEPA evolves the instruction
}
```

This is the Gen 5 architectural change. Every agent in the system becomes self-improving through the same mechanism.

## Key Insight for Paper

The universal agent shape means Foreman is not a collection of separate systems — it's one optimization loop applied at multiple scales. The prompt composition is optimized by the same mechanism that optimizes post-completion analysis, which is the same mechanism that optimizes session mining. This recursive self-improvement is the core contribution.
