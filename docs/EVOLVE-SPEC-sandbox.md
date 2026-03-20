# EVOLVE-SPEC — Tangle Sandbox Product

**Repo:** `~/code/agent-dev-container`
**Product:** Tangle Sandbox — cloud dev environments with AI agents
**Created:** 2026-03-20
**Last baseline:** 20% (F) — 2/7 scenarios passing

## Backstory

This spec was born from a full-day session (2026-03-19 to 2026-03-20) that went through:

1. **Merged PR #252** — the massive sandbox product PR (SDK, CLI, API, billing, Firecracker driver, gateway). Required 4 rounds of CI convergence to get green (security audit overrides, env var rename from merge, CodeQL SARIF removal, grpc CVE patch in Docker build).

2. **Built the `/converge` skill** — codified the CI-green loop pattern we discovered: read remote CI → diagnose from logs → fix root cause → commit+push → wait → repeat. The key insight was that this is fundamentally different from `/evolve` (remote async measurement, not local scripts).

3. **Integrated SandboxWorkbench UI** — wired sandbox-ui's workspace components into the sandbox web dashboard. Published sandbox-ui 0.3.3 with workspace exports.

4. **Built eval infrastructure** — started with toy measurement scripts, recognized they wouldn't scale, deleted them, and built a proper eval framework at `products/sandbox/evals/` with:
   - Composable assertion library (inspired by phony's `turnAssert`/`sessionAssert` pattern)
   - Scenario-based evaluation (not step-based)
   - Weighted category scoring (inspired by CompanyBench)
   - Environment management with orchestrator lifecycle
   - Regression detection via baseline comparison

5. **Ran the first baseline** — 20% (F). Health check and list-sandboxes pass. Everything else fails on sidecar startup in Docker containers. This IS the starting point for the evolve loop.

The key realization: the skill stack was complete (`/pursue` → `/evolve` → `/converge` + `/diagnose` + `/research` + `/polish` + `/improve`). What was missing was the **domain spec** connecting the eval framework to Foreman's dispatch model. That's this document.

## Source Repo Layout

```
~/code/agent-dev-container/
├── apps/
│   ├── orchestrator/          ← container orchestration, Docker/Firecracker drivers
│   ├── sidecar/               ← agent runtime injected into containers
│   └── host-agent/            ← bare-metal agent driver
├── packages/
│   ├── sdk-*/                 ← internal SDK packages (core, telemetry, providers)
│   └── shared/                ← shared utilities
├── products/sandbox/
│   ├── api/                   ← Cloudflare Worker (Hono) — customer-facing API
│   ├── sdk/                   ← @tangle-network/sandbox — customer SDK
│   ├── cli/                   ← CLI tool (tangle-sandbox)
│   ├── web/                   ← React dashboard + SandboxWorkbench
│   └── evals/                 ← THIS eval framework
├── services/
│   ├── benchmark-cli/         ← CompanyBench (SDK AI-buildability eval)
│   └── devtools/              ← Developer tooling CLI
└── docs/
    └── EVOLVE-SPEC.md         ← Copy of this spec (kept in sync)
```

## How to Measure

```bash
# Prerequisites — start local orchestrator
pnpm devtools dev start
# Ensure sidecar is built
pnpm build --filter @tangle-network/sidecar

# Run eval
SANDBOX_API_KEY=$API_SECRET_KEY pnpm eval:sandbox

# Filtered runs
pnpm eval:sandbox:smoke           # lifecycle checks only
pnpm eval:sandbox:lifecycle       # lifecycle category
pnpm eval:sandbox:agent           # agent category
```

**Output:** JSON to stdout with `scores.overall` (0-100), `scores.grade` (A+ through F), per-category and per-scenario breakdown with assertions and timing measurements.

**Local mode:** Evals target the orchestrator directly (`:4095`) with path translation (`/v1/sandboxes` → `/projects`). The sandbox API proxy layer is bypassed for speed.

**Staging mode:** `SANDBOX_API_URL=https://sandbox.tangle.tools SANDBOX_API_KEY=sk_sb_... pnpm eval:sandbox:staging`

## What Levers to Pull

### Tier 1: Infrastructure (fix these first — everything depends on them)

| Lever | Files | Symptom |
|-------|-------|---------|
| Sidecar startup | `apps/sidecar/src/server.ts`, `apps/sidecar/docker/entrypoint.sh` | "Sidecar process exited before becoming ready" |
| Sidecar dist freshness | `apps/sidecar/dist/` | Stale build → runtime errors in container |
| Docker driver mounts | `apps/orchestrator/src/drivers/docker/` | Sidecar dir not found, permission denied |
| Container security profile | `DEFAULT_CONTAINER_NO_NEW_PRIVS`, `DEFAULT_CONTAINER_CAP_DROP` | Process can't start due to seccomp/capabilities |

### Tier 2: Latency (optimize after infra is stable)

| Metric | Target | Lever |
|--------|--------|-------|
| Sandbox creation | <10s | Container pool warming, image pre-pull |
| Wait for running | <30s | Health check interval, sidecar startup optimization |
| Session creation | <3s | SessionGateway configuration |
| First SSE event | <30s | Agent backend startup, model cold start |
| Full prompt response | <60s | Model selection, tool execution efficiency |

### Tier 3: Quality (optimize after latency is acceptable)

| Metric | Target | Lever |
|--------|--------|-------|
| Agent task completion | >90% | Model selection, system prompt, tool permissions |
| Context preservation | 100% | Session state management, message persistence |
| File verification | 100% | Agent tool configuration, workspace permissions |

## What to Verify After Changes

1. **Sidecar is rebuilt:** `ls -la apps/sidecar/dist/server.js` — timestamp after your change
2. **Sidecar starts in container:** `docker exec <id> curl -s http://localhost:8080/health`
3. **Eval ran against new code:** check `runId` and `timestamp` in output
4. **No leaked containers:** `docker ps --filter label=agent.managed` — empty after eval
5. **Orchestrator reloaded:** tsx watch auto-reloads, but verify via `/health` uptime < 60s

## Current Scenario Coverage

### Passing (2)
- `lifecycle.health-check` — 9ms
- `lifecycle.list-sandboxes` — 4ms

### Failing (5)
- `lifecycle.create-and-delete` — 500 (sidecar startup)
- `agent.single-prompt-file-create` — 500 (sidecar startup)
- `agent.multi-turn-conversation` — 500 (sidecar startup)
- `streaming.sse-connect` — 500 (sidecar startup)
- `streaming.first-event-latency` — 500 (sidecar startup)

### Not Yet Implemented (P0 priorities)
- `terminal.exec-command` — exec via runtime proxy
- `files.read-write` — file ops via runtime proxy
- `sdk.full-lifecycle` — SDK client end-to-end
- `cli.create-delete` — CLI tool end-to-end

## Existing Measurement Infrastructure (don't rebuild)

| Tool | Measures | Invoke |
|------|----------|--------|
| `benchmark-startup-stream.ts` | Sidecar startup + SSE latency (p50/p95) | `pnpm --filter orchestrator benchmark:startup-stream` |
| `benchmark-core-flows.ts` | Full lifecycle with concurrency | `pnpm --filter orchestrator benchmark:core-flows` |
| `provider-driver-bench-matrix.sh` | Driver × backend matrix | `pnpm benchmark:provider-driver:matrix` |
| CompanyBench | SDK AI task quality (graded) | `tangle-bench run -t tasks.json -b ...` |
| Provision benchmark store | Runtime provision step timing | `GET /admin/benchmarks/report` |

The eval framework (`products/sandbox/evals/`) measures the **product path** end-to-end. The tools above measure **internal layers**. Both are needed — the eval framework catches product-level regressions, the benchmarks catch internal performance regressions.

## Foreman Dispatch Contract

**Input:**
```json
{
  "goal": "sandbox eval score above 90 (A-)",
  "scope": "~/code/agent-dev-container",
  "successCriteria": {
    "metric": "scores.overall",
    "threshold": 90,
    "measure": "SANDBOX_API_KEY=$API_SECRET_KEY pnpm eval:sandbox"
  },
  "constraints": { "maxRounds": 5 },
  "spec": "~/code/foreman/docs/EVOLVE-SPEC-sandbox.md"
}
```

**Expected output:**
```json
{
  "status": "converged|in_progress|plateau",
  "score": { "before": 20, "after": 90, "target": 90 },
  "rounds": 3,
  "experiments": [
    { "hypothesis": "rebuild sidecar dist", "delta": "+40%", "verdict": "KEEP" },
    { "hypothesis": "fix container security profile", "delta": "+20%", "verdict": "KEEP" },
    { "hypothesis": "add terminal/file scenarios", "delta": "+10%", "verdict": "KEEP" }
  ]
}
```

## Insights from the Session That Built This

1. **CI convergence is its own discipline.** Remote async measurement (push → wait 15min → poll API → read logs) is fundamentally different from local evolve loops. That's why `/converge` exists separately.

2. **The first failure is always infra.** Before you can optimize latency or agent quality, containers need to start. The 20% baseline is entirely an infra problem (sidecar startup), not a quality problem.

3. **Toy scripts don't survive.** A single-file measurement script with hardcoded steps can't test user stories, assert on output correctness, or scale to new scenarios. The eval framework exists because the alternative was throwaway.

4. **Existing test helpers are gold.** The repo has `SandboxTestContext`, `EventCollector`, `orchestrator-server.ts` — battle-tested helpers for exactly this kind of testing. The eval framework should eventually consume these instead of reimplementing API calls.

5. **Category weights matter.** Lifecycle (30%) + agent (30%) = 60% of the score. If containers can't start, the max possible score is ~20% regardless of everything else. This correctly reflects business priority.

6. **Direct orchestrator mode is essential for local dev.** The sandbox API (Cloudflare Worker) adds auth, billing, and quota layers that complicate local testing. Targeting the orchestrator directly (with path translation) gives clean signal on the core product path.
