# Session: 2026-03-22/23 — Foreman Rebuild

Duration: ~8 hours
Scope: Complete rebuild from daemon to service + Pi client architecture

## Key Decisions Made
- [001: Service over daemon](../decisions/001-service-over-daemon.md)
- [002: Conversation as policy](../decisions/002-conversation-as-policy.md)
- [003: Prompt composition](../decisions/003-prompt-composition.md)
- [004: Session mining](../decisions/004-session-mining.md)
- [005: Confidence graduation](../decisions/005-confidence-graduation.md)
- [006: Universal agent shape](../decisions/006-universal-agent-shape.md)

## Metrics
| Metric | Before | After |
|---|---|---|
| Architecture | Daemon (98.4% inaction) | Service + conversation-as-policy |
| Success rate | Unmeasured | 92% (11/12 dispatches) |
| Codebase | 32K lines, 100+ files | 21K lines, 60 files |
| Service | 0 | 2,696 lines, 20 API endpoints |
| Pi extension | Old (broken imports) | 697 lines, 7 tools |
| Sessions scanned | 0 | 437 |
| Learnings | 0 | 180 |
| Skills created | 0 | 2 (/reflect, /capture-decisions) |
| Research decisions | 0 | 6 |
| Pursuit generations | 0 | 4 |
| Gateways | 0 | 2 (Telegram running, Slack built) |

## Human vs AI Contribution
| Component | Human | AI | Pattern |
|---|---|---|---|
| Architecture | Drew: "conversation is policy" | Claude: service design | Insight → implementation |
| Prompt composition | Drew: "it just sends a one-liner" | Claude: 5K+ char composer | Gap identification → solution |
| Session mining | Drew: "learn from my sessions" | Claude: scanner + analysis | Feature request → build |
| Worktree isolation | Drew: "can it support worktrees?" | Claude: worktree-by-default | Question → architectural feature |
| Confidence graduation | Drew: original VISION.md design | Claude: integration into service | Pre-existing design → wiring |
| Universal agent shape | Drew: "track these post-digests" | Claude: formalized the pattern | Observation → abstraction |
| /reflect skill | Drew: "meta-analyze like GTM agent" | Claude: skill design | Cross-project insight → tool |
| /capture-decisions | Drew: "I want this in every repo" | Claude: skill + research structure | Methodology → tooling |
| Telegram gateway | Drew: "will it telegram me?" | Claude: built + deployed | Need → implementation |
| Post-completion pipeline | Drew: "spawn sub-agents after completion" | Claude: digest/audit/plan agents | Architecture idea → pluggable system |

## Open Questions
- Multi-turn sessions: how to guide dispatched sessions mid-run?
- Cost tracking: what does Claude's actual cost output look like?
- Service.ts at 2,696 lines: when to split into modules?
- Eval framework: how to wire packages/evals/ into service?
- Foreman as a product: pricing, hosting, onboarding flow?

## Session Grade: 8.5/10
Genuinely strong output. 4 pursuit generations, 6 decision records, 2 new skills, real dispatches on real projects. Main deductions: 0 tests for new code, monolithic service file, multi-turn not built.
