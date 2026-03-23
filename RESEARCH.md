# Foreman Research

Adjacent architectures and what they imply for Foreman.

## Positioning

Foreman is the harness above worker agents. Not another coding CLI. Not a personal assistant. Not a workflow engine.

The field splits into:

| Category | Examples | Foreman relation |
|---|---|---|
| Worker agents | Claude Code, Pi, Codex, Hermes | Foreman dispatches TO these |
| Personal assistants | NanoClaw, OpenClaw | Borrow memory/scheduling ideas, don't become one |
| Memory systems | Honcho, Mem0, Letta | Use as infrastructure, not the whole product |
| Experiment runners | pi-autoresearch, /evolve, /research | Foreman applies this pattern at portfolio level |

## Key references

### OpenAI: Harness engineering

- Harness quality > prompt cleverness
- Environment legibility matters more as agents get stronger
- Traces improve evals over time
- Implication: Foreman optimizes the harness, not the prompts (though GEPA does both)

### Pi (badlogic/pi-mono)

- Excellent extension model: tools, skills, widgets, commands
- JSONL sessions with tree branching, compaction, resume
- SDK + RPC + CLI coexistence
- Implication: Foreman integrates WITH Pi (via extension), doesn't compete

### pi-autoresearch (davebcn87)

- Proven autonomous experiment loop: init → run → log → repeat
- Domain-agnostic extension + domain-specific skill separation
- Persistence via autoresearch.md + autoresearch.jsonl
- Confidence scoring via Median Absolute Deviation
- Implication: Foreman IS this pattern applied to the entire portfolio

### Hermes Agent (NousResearch)

- 10.3k stars, MIT, Python
- Self-improving agent with auto-generated skills
- 6 terminal backends (local, Docker, SSH, Daytona, Singularity, Modal)
- Multi-platform gateway (Telegram, Discord, Slack, WhatsApp, Signal)
- 200+ models via OpenRouter
- MCP integration for external tools
- Honcho dialectic user modeling
- Cron scheduler for unattended work
- Trajectory generation for RL training

Full comparison in memory: `reference_hermes_agent.md`

**Key insight: Hermes is a better single agent. Foreman is a better operator.** Complementary — Foreman could dispatch TO Hermes.

## Capabilities to adopt from Hermes

### 1. Multi-platform gateway

**What**: Talk to Foreman from Telegram, Slack, Discord — not just Pi.

**Architecture fit**: The service already has an HTTP API. A gateway process multiplexes platform webhooks to the same API. Each platform adapter translates messages to/from the service endpoints.

```
Telegram → gateway → POST /api/dispatch
Slack    → gateway → POST /api/outcomes
Pi       → extension → POST /api/dispatch
CLI      → curl → POST /api/dispatch
```

**Implementation**: Add `gateway/` directory with platform adapters. Start with Telegram (simplest webhook API). Each adapter:
- Receives messages from the platform
- Calls the service API
- Formats responses back to the platform
- Handles auth (API key per platform)

**Priority**: HIGH — enables phone-based operation (approve/reject from anywhere).

### 2. Cloud execution backends

**What**: Not every dispatch needs a local tmux session. Modal/Daytona for serverless, SSH for remote machines.

**Architecture fit**: The service's `spawnSession()` function currently only spawns tmux. Abstract this to a `Backend` interface:

```typescript
interface Backend {
  spawn(opts: { workDir: string, prompt: string }): Promise<{ id: string }>
  check(id: string): Promise<{ status: string, output: string }>
  kill(id: string): Promise<void>
}

// Implementations:
// TmuxBackend — current behavior (local)
// ModalBackend — serverless (for GPU work, autoresearch)
// SSHBackend — remote machines
// DockerBackend — isolated containers
```

**Implementation**: Extract current tmux code into `TmuxBackend`. Add `ModalBackend` for autoresearch/training dispatches. Backend selection per dispatch (service picks based on goal type or explicit request).

**Priority**: MEDIUM — enables GPU dispatches (voice training), but local tmux works for most coding.

### 3. Model routing

**What**: Smart model selection per dispatch. Cheap model (Haiku) for simple tasks, expensive (Opus) for complex.

**Architecture fit**: The service's `composePrompt()` already has the task and context. Add a routing function that estimates complexity and selects a model:

```typescript
function selectModel(task: string, skill: string, context: Record<string, string>): string {
  // Simple heuristics + learned patterns
  if (skill === '/converge') return 'sonnet' // CI repair is mechanical
  if (skill === '/verify') return 'haiku' // validation is straightforward
  if (skill === '/pursue') return 'opus' // generational design needs deep reasoning
  // Default: sonnet (best cost/quality)
  return 'sonnet'
}
```

**Implementation**: Add `--model` flag to Claude CLI invocation in `spawnSession()`. Track cost per model per dispatch. Learn which models work best for which tasks from outcome data.

**Priority**: MEDIUM — reduces cost significantly (Haiku is 10x cheaper than Opus).

### 4. MCP (Model Context Protocol) integration

**What**: Connect external tool servers — databases, APIs, custom tools — that any dispatched session can use.

**Architecture fit**: The service could maintain a registry of MCP servers. When composing prompts, include MCP server URLs. Claude Code already supports MCP natively via `--mcp-config`.

**Implementation**: Add MCP server registry to SQLite. When dispatching, generate a temporary MCP config file for the session. The Claude Code session connects to registered servers automatically.

**Priority**: LOW for now — useful when Foreman manages non-code goals that need external APIs.

## Memory hierarchy

Foreman accumulates knowledge at multiple scopes:

| Scope | What | Storage |
|---|---|---|
| **Operator** | Taste, preferences, work style, risk tolerance | `taste` table + deep analysis |
| **Goal** | Intent, decomposition, progress, learnings | `goals` + `decisions` tables |
| **Project** | Architecture, invariants, what works/fails | `learnings` by project |
| **Session** | What this specific dispatch did | `sessions` table + tmux logs |
| **Cross-project** | Patterns, flows, relationships | `learnings` by type (flow, relationship) |

## Strategic conclusion

Foreman manages goals across domains by dispatching worker agents, learning from operator sessions, and compounding knowledge over time.

The sentence: **Give it a goal, it figures out how to achieve it, learns your taste, and gets better every dispatch.**
