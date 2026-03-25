# Code Review: service/lib/verify-deliverable.ts

## What it does well

- Clean separation of concerns: deliverable checking vs scope checking are independent stages with distinct result types. The `DeliverableSpec` / `ScopeSpec` split makes the caller decide what to verify without coupling the two.
- Fail-open by default (`'unchecked'` status when no spec provided) — correct for incremental adoption where not every dispatch has a deliverable spec yet.
- `testCommand` runs via `execFileSync('bash', ['-c', ...])` with a timeout, which avoids shell injection from the command string while still allowing pipes/redirects inside the command itself. Good tradeoff.
- Truncation on detail strings (`s.slice(0, 50)`, command `.slice(0, 60)`) prevents log pollution from large content checks.

## What could be improved

- **Glob matching is naive.** `pattern.replace(/\*/g, '.*')` doesn't handle `**` (recursive), `?`, or character classes. A path like `src/*.test.ts` would match `src/foo/bar.test.ts` because `.*` is greedy. Use `minimatch` or `picomatch` — they're already standard in Node ecosystems.
- **`runTestGate` has dead code.** The `for` loop over `commands` returns on the first command — both on success AND failure. The second command (`npm test`) is unreachable. The intent was "try tsc, then fall back to npm test," but the early return on `catch` kills the fallback. Fix: only return on success inside the loop, collect the last error, and return failure after the loop.
- **`git diff HEAD~1..HEAD` only checks the last commit.** If the dispatched session made 3 commits, scope check misses the first two. Use the branch point or a ref stored at dispatch time instead.
- **No validation on `spec.path` for path traversal.** A spec with `path: "../../etc/passwd"` would read outside `workDir`. Add a resolved-path check: `resolve(workDir, spec.path).startsWith(resolve(workDir))`.

## Concrete suggestion

Fix the `runTestGate` dead code — it's the highest-risk bug because it silently skips `npm test`:

```typescript
export function runTestGate(workDir: string): { passed: boolean, output: string } {
  const commands = [
    ['npx', ['tsc', '--noEmit']],
    ['npm', ['test', '--if-present']],
  ] as const

  let lastOutput = 'no test commands found'
  for (const [cmd, args] of commands) {
    try {
      const result = execFileSync(cmd, [...args], {
        cwd: workDir, timeout: 60_000, encoding: 'utf8', stdio: 'pipe',
      })
      lastOutput = result.slice(-500)
    } catch (e: any) {
      return { passed: false, output: (e.stderr || e.stdout || String(e)).slice(-500) }
    }
  }
  return { passed: true, output: lastOutput }
}
```

This runs both commands sequentially, failing fast on the first error but actually reaching `npm test` when `tsc` passes.
