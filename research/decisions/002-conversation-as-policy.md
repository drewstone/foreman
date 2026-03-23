# Decision 002: Conversation as Policy Function

Date: 2026-03-22
Status: ACCEPTED
Origin: Human (Drew)

## Context

Traditional agent orchestrators have a policy function: `f(state) → action`. This is a single LLM call with a state snapshot. Foreman's daemon used this pattern and it produced 98.4% inaction.

## Decision

The policy function is the ongoing conversation between the operator and an LLM. There is no separate policy call. The operator says what they want, the LLM reasons about how to achieve it using Foreman's tools, and the conversation continues across dispatches and outcomes.

## Rationale

A cold LLM call cannot:
- Know the operator's current priorities
- Understand why a previous approach failed from the operator's perspective
- Judge whether an outcome is "good enough" without taste
- Redirect when the operator's goals change

A conversation can do all of these because the operator is IN it.

## Origin Analysis

- **Human contribution**: Drew articulated "the product is a conversation, not a daemon" and "the prompt IS the product" — these were the foundational insights
- **AI contribution**: Claude implemented this as the Pi extension + skill architecture where tools are available in conversation context
- **Key interaction**: Drew's pushback "it just creates claude code that says 'do this thing'" led to the prompt composition system — the realization that the dispatch prompt must carry the full context, not just the operator's words

## Trade-offs

- **Pro**: Rich context, operator in the loop, taste learning, real-time redirection
- **Con**: Requires the operator to be present (mitigated by confidence graduation → autonomous dispatch at high confidence)
- **Con**: Conversation context is bounded (mitigated by persistence in SQLite + portfolio.md)
