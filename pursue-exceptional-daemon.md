# Pursuit: Exceptional Daemon State
Generation: 1
Date: 2026-03-22
Status: auditing

## System Audit

### What exists and works
- Policy agent (policy.ts, 642 lines) — LLM reasoning, action dispatch, confidence gating
- Confidence store (SQLite, 5 signals, 4 levels, overrides) — 17 tests
- State snapshot (session index + git + CI + tmux detection) — builds in ~90ms
- Daemon (foreman-daemon.ts, 308 lines) — poll timer, git watchers, mutex, rate limiting
- Multi-round driver script — loops claude up to 20 rounds per session
- Tmux session management — persistent, attachable sessions
- `--dir` flag for targeting specific projects
- `--dangerously-skip-permissions` for autonomous code writing
- `always-auto` / `never-auto` overrides for project-level control
- **VERIFIED: produces real commits.** belief_state_agents: 5 commits (3196 lines, 118+29 tests). pigraph: 3 commits (482 lines, comprehensive tests).

### What exists but isn't integrated
- Pi extension (extensions/pi/) — not connected to daemon at all
- Policy optimizer (policy-optimizer.ts) — generates variants but never tested in practice
- Confidence CLI (confidence-cli.ts) — works but operator rarely uses it
- Cross-pollination logic — exists but no data to act on
- Nightly optimize cron — still running old pipeline, not connected to new daemon

### What was tested and failed
- `require()` in ESM context — caused ENOENT errors repeatedly, fixed with top-level imports
- Session dir watchers — exhausted inotify, disabled
- Policy picking blocked projects — fixed by filtering non-autonomous from LLM context
- Dedup blocking autonomous projects — fixed by skipping dedup for autonomous level
- `--resume` with `-p` — incompatible flags, dropped --resume
- Exploration prompts — LLM generates analysis instead of work, fixed with hardcoded build prompt

### What doesn't exist yet
- Session output capture — can't see what claude did without attaching to tmux
- Session resumption — when a session exits, daemon respawns with same generic prompt instead of continuing where it left off
- Progress tracking — no way to see "round 3/20, 5 commits so far" without attaching
- Project-specific context — the build prompt is generic, doesn't know about each project's ChatGPT thread or domain
- Cost tracking per session — no idea how much each autonomous session costs
- Session log persistence — tmux scrollback is lost when sessions die

### User feedback not yet addressed
- "it doesn't progress past maybe 1 prompt" — FIXED with driver script
- "you're not even verifying for real" — FIXED with manual testing before committing
- "it should really consider RESUMING sessions" — NOT YET DONE
- "I want to dispatch three Foreman sessions and have them drive to completion" — WORKING NOW
- "succinctness is key so we don't create bloat" — driver prompt says this but not enforced

### Measurement gaps
- No metric for "how much real work did a session produce" (commits, lines, test count)
- No metric for "how close is the project to done"
- No cost per session tracking
- No quality assessment of what was built

## Current Baselines
- belief_state_agents: 5 commits, 3196 lines added, 147 tests in ~10 min
- pigraph-run-ready: 3 commits, 482 lines added, comprehensive test coverage in ~8 min
- avalanche-intelligence: 0 commits (still running round 1)
- Daemon reliability: 100% session spawn success (3/3) after mutex fix
- Policy accuracy: picks correct projects when only autonomous shown
- Session completion: all rounds run, commits produced

## Diagnosis

**Root causes of current limitations:**

1. **Sessions are stateless between rounds.** Each `claude -p` invocation starts fresh — it re-reads the codebase from scratch. Round 2 doesn't know what round 1 did except via git history. This wastes tokens and context.

2. **No project-specific knowledge injection.** The driver script sends the same generic "build this project" prompt to avalanche-intelligence (a complex data platform) and pigraph (a small TypeScript framework). The ChatGPT threads in ~/foreman-projects/ contain deep domain knowledge that never reaches claude.

3. **No session output persistence.** When a tmux session exits, all output is lost. The daemon can't learn from what happened. No feedback loop.

4. **The daemon is reactive, not strategic.** It spawns sessions when projects don't have one, but it doesn't plan WHAT to work on. A human operator would look at the project, decide "the priority is getting tests passing, then the API endpoints, then docs" — the daemon just says "build stuff."

**What's architectural vs tunable:**
- Stateless sessions → architectural (need session persistence or context passing)
- Generic prompts → tunable (inject project context from ChatGPT threads)
- No output capture → architectural (need log capture from tmux)
- No strategic planning → architectural (need project-level work plans)

## Generation 1 Design

### Thesis
Sessions that know their project's domain context and persist their output produce 3x more useful work than generic "build stuff" sessions.

### Changes (ordered by impact)

#### Architectural (must ship together)

1. **Project context injection** — Read the ChatGPT thread (.txt file in parent dir) and inject a summary as CLAUDE.md in the project before spawning. Claude reads CLAUDE.md automatically. This gives domain knowledge without prompt bloat.
   - Risk: low. CLAUDE.md is standard. Reversible.

2. **Session output capture** — Pipe tmux output to a log file per project (`~/.foreman/logs/session-<project>.log`). Use `tmux pipe-pane` to capture everything claude outputs.
   - Risk: low. Append-only log.

3. **Round-aware continuation** — Between rounds, the driver script writes a `.foreman/session-state.md` file in the project with: what was done, what's next, current test status. Next round reads it. Gives cross-round memory without session persistence.
   - Risk: low. File-based, claude reads it naturally.

#### Prompt/Config (independent)

4. **Project-specific CLAUDE.md generation** — For each watched project, generate a CLAUDE.md from the ChatGPT thread that tells claude what the project IS, what the stack is, and what the priorities are.

5. **Progress reporting** — After each round, the driver script appends to `~/.foreman/logs/progress-<project>.log` with: round number, commits made, test results.

#### Measurement

6. **Session metrics** — Count commits, lines changed, tests added per session. Write to `~/.foreman/traces/session-metrics/`.

### Success Criteria
- All 3 projects get project-specific CLAUDE.md files
- Session output captured to log files
- Cross-round state persisted in .foreman/session-state.md
- Measurably more commits per session (baseline: 3-5 per project, target: 10+)
- Operator can review session logs without attaching to tmux
