# Foreman Skill Decision Stats

Queried from `~/.foreman/foreman.db` on 2026-03-24.

| Skill | Count | Successes | Rate |
|-------|------:|----------:|-----:|
| /pursue | 22 | 22 | 100% |
| /evolve | 16 | 14 | 88% |
| /verify | 8 | 4 | 50% |
| /research | 7 | 5 | 71% |
| /plan | 7 | 6 | 86% |
| (none) | 7 | 7 | 100% |
| /polish | 3 | 3 | 100% |
| (raw prompt — belief-state paper) | 1 | 1 | 100% |
| (raw prompt — PiGraph benchmarks) | 1 | 1 | 100% |
| (raw prompt — PiGraph install) | 1 | 1 | 100% |
| (raw prompt — PiGraph eval suite) | 1 | 1 | 100% |
| (raw prompt — PiGraph hard eval) | 1 | 1 | 100% |
| (raw prompt — PiGraph eval framework) | 1 | 1 | 100% |
| /critical-audit | 1 | 1 | 100% |

**Totals:** 77 decisions, 68 successes, 88% overall rate.

## Observations

- **/pursue** is the most-used skill (22 dispatches) with a perfect record. This is the workhorse.
- **/evolve** is second (16) but has 2 failures — the only skill with a meaningful failure rate besides /verify.
- **/verify** has the worst rate at 50% (4/8). Verification tasks are inherently pass/fail with strict criteria, so this tracks.
- **Raw prompts** (long task descriptions dispatched without a skill wrapper) all show success, but N=1 each — no statistical power.
- **/research** and **/plan** are moderately used with decent rates.
- The (none) bucket — 7 dispatches with no skill — all succeeded. These may be simple direct tasks.
