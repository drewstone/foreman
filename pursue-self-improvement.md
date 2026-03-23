# Pursuit: Hyperagents-Inspired Self-Improvement

Generation: 5
Date: 2026-03-23
Status: building

## Thesis

**Foreman improves itself by dispatching sessions on its own codebase.** Like Hyperagents' meta-agent that modifies any code including itself, Foreman dispatches Claude Code sessions to modify `service/index.ts`, runs tests in the worktree, and opens PRs for operator review. The operator stays in the loop (unlike Hyperagents' fully automated approach) via PR review + taste signals.

## Changes

### Architectural (must ship together)

1. **Split service.ts into modules** — 2,876 lines → ~8 modules. Self-modification requires targeted changes, not editing a monolith.
   Risk: MED (lots of imports to rewire, potential breakage)

2. **Self-improvement dispatch endpoint** — `POST /api/self-improve` triggers a dispatch on the Foreman repo itself. Uses worktree isolation + tests as the safety gate.
   Risk: MED (Foreman modifying itself needs careful bounds)

3. **Cross-project confidence transfer** — when a skill succeeds on project A, transfer +0.02 to the same skill on all other projects. Already have the `transfer` signal in ConfidenceStore.
   Risk: LOW (small delta, conservative)

### Success Criteria

- service.ts split into ≥5 modules, all tests pass, service starts clean
- Self-improvement dispatch creates worktree, runs session, opens PR
- Cross-project transfer visible in confidence scores after dispatches
