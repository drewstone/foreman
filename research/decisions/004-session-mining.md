# Decision 004: Mine Operator Sessions as Training Data

Date: 2026-03-22
Status: ACCEPTED
Origin: Human (Drew)

## Context

Drew asked: "can we ensure that foreman learns from my sessions? I'm literally generating so many sessions I want the foreman to learn and track this too."

## Decision

The service scans `~/.claude/projects/`, `~/.pi/agent/sessions/`, and `~/.codex/history.jsonl` for operator session files. It extracts user messages, skill invocations, and outcome signals. Two learning loops run:

1. **Fast loop** (hourly, ~0 cost): pattern matching extraction of exemplars, skill patterns
2. **Deep loop** (every 6 hours, ~$0.10): dispatches Claude to analyze session batches and extract workflows, taste, anti-patterns, project relationships

## Origin Analysis

- **Human contribution**: Drew identified that his existing sessions are the richest training data available
- **AI contribution**: Claude built the scanner (handles Claude Code, Pi, and Codex JSONL formats), the deep analysis prompt, and the learning extraction pipeline
- **Key debugging**: Initial scanner found 0 sessions because Claude Code's JSONL format has `message.content` as a string, not an array of content blocks. Fixed by adding format-specific parsing.

## Results

- 437 operator sessions scanned
- 180 learnings extracted
- 21 taste signals from deep analysis
- Session content feeds into prompt composition (exemplars, flows, anti-patterns)

## Key Insight for Paper

The operator's existing sessions across multiple harnesses (Claude Code, Pi, Codex) are a rich, untapped training signal. Most agent systems only learn from their own interactions. Mining cross-harness session data provides taste, workflow patterns, and domain knowledge that no single-session agent could learn.
