# Session: 2026-03-23 Day 2 — Hyperagents + Product Architecture

Duration: ~6 hours
Scope: Competitive adoption, product architecture, skill system, install flow

## Grade: 9/10

## Metrics
| Metric | Start of day | End of day |
|---|---|---|
| Decisions | 25 | 39 |
| Learnings | 689 | 1,074 |
| Sessions scanned | 1,057 | 1,409 |
| Success rate | 88% | 92% |
| Commits | 0 | 11 |

## What Was Built
- MCP integration (register servers, auto-inject into dispatches)
- Skill proposal system (diff analysis, REVIEW.md, draft PRs)
- Self-improvement dispatch (POST /api/self-improve)
- Guaranteed PR creation on every session with commits
- Auto-merge flag (FOREMAN_AUTO_MERGE + confidence gate)
- Cross-project confidence transfer
- Experiment trajectory in prompt composition
- Snapshot-before-overwrite in harvest
- Curl installer
- Hyperagents comparison + research decision
- Origin tracking + cost breakdown in stats

## Key Decisions
- [007: Hyperagents comparison](../decisions/007-hyperagents-comparison.md)
- Everything in ~/.foreman/ — no per-project dirs
- Skill proposals via draft PRs against dotfiles repo
- Evolve files can be overwritten; learnings persist in SQLite + experiments.jsonl

## Open: service.ts at 3,000+ lines needs splitting
## Open: cost tracking still not populating
## Open: curl installer not E2E tested
