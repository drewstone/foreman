# Critical Audit: Foreman Codebase

**Date:** 2026-03-24
**Auditor:** Claude Opus 4.6 (3 parallel reviewers)
**Scope:** Full codebase — service/, gateway/, pi-package/, packages/core/

## Overall Score: 4/10

| Dimension | Score | Notes |
|---|---|---|
| Correctness | 4/10 | Duplicate DDL column, broken test gate, wrong glob matching, silent failures everywhere |
| Security | 2/10 | No API auth, command injection, path traversal, CORS wildcard, skip-permissions on all sessions |
| Architecture | 2/10 | 3500-line monolith, zero service tests, DI exists but unused, massive duplication |
| Performance | 3/10 | Synchronous I/O throughout daemon, ad-hoc prepared statements, event loop starvation |
| Type Safety | 4/10 | 39+ `as any` casts, phantom dependencies, null-as-number bypasses |
| Standards | 5/10 | `packages/core/` is clean; `service/` violates every stated principle |

---

## CRITICAL

### 1. No authentication on HTTP API
**service/index.ts** — The entire API (dispatch sessions, kill sessions, read filesystem, self-improve) is unauthenticated. Combined with `Access-Control-Allow-Origin: *`, any webpage can dispatch autonomous agents via CSRF.

### 2. Command injection via `model` parameter
**service/index.ts:364,383** and **claude-runner.ts:85** — User-supplied `model` string is interpolated directly into shell commands sent via `tmux send-keys`. A value like `sonnet; rm -rf /` would execute.

### 3. Path traversal via `/api/context`
**service/index.ts** — The `path` query param is used directly with `readFileSync`/`statSync`. No validation. Can read `/etc/passwd`, `~/.ssh/id_rsa`, any file.

### 4. Arbitrary RCE via `testCommand` in deliverable spec
**verify-deliverable.ts:84** — `execFileSync('bash', ['-c', spec.testCommand])` with spec from user-supplied JSON. Full code execution.

### 5. MCP config injection
**service/index.ts:406-424** — Unauthenticated `/api/mcp POST` accepts arbitrary `command`, `args`, `env` that get written to MCP config and executed by Claude Code sessions.

### 6. Slack signature verification fails open
**slack.ts:87** — `if (!SIGNING_SECRET) return true` means default config (no env var) accepts all forged requests.

### 7. Duplicate `origin` column in DDL
**service/index.ts:87,98** — `origin` defined twice in `CREATE TABLE decisions`. Fresh DB creation will fail on SQLite versions that reject duplicate columns. `NOT NULL` constraint lost.

---

## HIGH

### 8. service/index.ts is 3500 lines with zero tests
Monolith with module-level side effects (DB init, mkdirSync, server.listen on import). Every function closes over globals. Impossible to unit test. The most critical code in the system has zero test coverage.

### 9. Synchronous I/O throughout the daemon
50+ `readFileSync`/`execFileSync` calls in hot paths. `watcherTick` runs sync tmux subprocesses for every active session every 10s. `composePrompt` runs sync git on every dispatch. Event loop starvation risk.

### 10. context.ts DI infrastructure exists but is entirely unused
`ServiceConfig`, `ServiceContext`, `loadConfig()` are defined but `service/index.ts` uses raw globals. Dead architecture.

### 11. `runTestGate` returns on first command, never runs both
**verify-deliverable.ts:171-185** — If `tsc --noEmit` succeeds, `npm test` never runs. The gate can never verify both type checking AND tests.

### 12. `selectModel()` violates "service executes, conversation decides"
**service/index.ts:583-603** — Hardcoded `switch` makes model routing policy decisions. CLAUDE.md explicitly forbids judgment calls in the service.

### 13. Scope check only examines last commit
**verify-deliverable.ts:104** — `git diff --name-only HEAD~1..HEAD` misses out-of-scope modifications from all earlier commits.

### 14. `openProposalPR` does `git checkout` in operator's repo
**skill-proposals.ts:297** — Creates branches and switches in shared repos. Concurrent proposals or crash leaves repo on wrong branch.

### 15. Triplicated `api()` client, duplicated `tmux()` helpers
Three identical HTTP clients across gateways + pi-package. Two copies of tmux helpers. Two copies of FOREMAN_HOME, CLAUDE_BIN, ENV.

---

## MEDIUM

### 16. 69 silent `catch {}` blocks
Errors swallowed everywhere: git operations, JSON parsing, session scanning, experiment parsing, tmux operations. System makes decisions on incomplete data with no indication.

### 17. Regex glob matching is broken
**verify-deliverable.ts:121-128** — `*` to `.*` without escaping regex metacharacters. `src/utils.ts` matches `src/utilsXts`. `**` not handled.

### 18. `autoCommitWorktree` stages everything including secrets
**service/index.ts:1681** — `git add -A` stages `.env`, credentials, etc. Committed with generic message and pushed.

### 19. Phantom dependency: `@tangle-network/sandbox`
**service/index.ts:432-441** — Type imports from a package that only resolves if a specific local path exists.

### 20. `writeFileSync` imported twice
**service/index.ts:14,403** — Second import 400 lines later indicates organic growth without cleanup.

### 21. Ad-hoc `db.prepare()` calls defeat prepared statements
20+ scattered `db.prepare()` calls alongside the `stmts` object designed to hold them.

### 22. `detectIdle` depends on Claude Code UI Unicode chars
**service/index.ts:285-321** — Hardcoded `✻✓✶✽●` and English phrases. Any UI change silently breaks harvest.

### 23. N+1 query pattern in `updateLearningsFromOutcome`
**service/index.ts:1237-1243** — Two queries per template in a loop.

### 24. SSE has no heartbeat
Dead connections accumulate until next `emitEvent`. Proxies will kill idle connections.

### 25. No request body size limit
`readBody()` accumulates unbounded memory from large POST bodies.

---

## LOW

26. `listenForEvents` in telegram.ts is dead code — defined but never called.
27. `POLL_INTERVAL_MS` in telegram.ts is unused.
28. `handleFreeText` accepts unused `chatId` param — telegram.ts:208.
29. `basename`/`dirname` imported but unused — skill-proposals.ts:17.
30. Dedup uses first 200 chars but stores 500 — distinct learnings with same prefix treated as duplicates.
31. `@ax-llm/ax` types entirely opaque — all access via `as any` chains.

---

## Top 3 Actionable Fixes

1. **Add API authentication + remove CORS wildcard.** Even a simple bearer token check eliminates the entire class of CSRF/unauthorized dispatch vulnerabilities (1, 5, 25). Fail closed on Slack signing (6).

2. **Sanitize all shell-interpolated values.** The `model` parameter, `testCommand`, and any user-derived string going into `tmux send-keys` or `execFileSync('bash', ['-c', ...])` must be validated against a strict allowlist. Findings 2 and 4 are full RCE.

3. **Break up `service/index.ts` and wire in `context.ts` DI.** The 3500-line monolith with zero tests is the root cause of most quality issues. Extract into separate modules that accept `ServiceContext`. This makes everything testable and eliminates duplicated helpers (8, 9, 10, 15, 21).
