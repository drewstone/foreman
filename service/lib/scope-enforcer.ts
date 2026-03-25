/**
 * Scope Enforcer — Git-level scope control for dispatched sessions.
 *
 * Injects a git pre-commit hook that rejects commits touching files
 * outside the allowlist. The agent can READ anything but can only
 * COMMIT changes to allowed files.
 *
 * Worktree-aware: uses per-worktree config so parallel sessions
 * don't interfere with each other's scope rules.
 */

import { writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export interface ScopeConfig {
  allowedPaths: string[]
  forbiddenPaths?: string[]
}

/**
 * Install a git pre-commit hook that enforces scope.
 * Works in both regular repos and worktrees.
 */
export function installScopeHook(worktreePath: string, scope: ScopeConfig): string | null {
  if (!scope.allowedPaths?.length) return null

  // Create a per-worktree hooks directory
  const hooksDir = join(worktreePath, '.foreman-hooks')
  mkdirSync(hooksDir, { recursive: true })

  // Enable worktree-specific config and set hooksPath for THIS worktree only
  try {
    execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], {
      cwd: worktreePath, timeout: 5_000,
    })
    execFileSync('git', ['config', '--worktree', 'core.hooksPath', hooksDir], {
      cwd: worktreePath, timeout: 5_000,
    })
  } catch {
    // Fallback: try --local (won't be worktree-isolated but better than nothing)
    try {
      execFileSync('git', ['config', '--local', 'core.hooksPath', hooksDir], {
        cwd: worktreePath, timeout: 5_000,
      })
    } catch { return null }
  }

  const allowedPatterns = scope.allowedPaths.map(p => p.replace(/\*/g, '.*'))
  const forbiddenPatterns = (scope.forbiddenPaths || []).map(p => p.replace(/\*/g, '.*'))

  const hookScript = `#!/usr/bin/env bash
# Foreman scope enforcer — rejects commits with out-of-scope changes
# Installed by Foreman dispatch. DO NOT edit manually.

ALLOWED_PATTERNS=(${allowedPatterns.map(p => `"${p}"`).join(' ')})
FORBIDDEN_PATTERNS=(${forbiddenPatterns.map(p => `"${p}"`).join(' ')})

CHANGED_FILES=$(git diff --cached --name-only)

if [ -z "$CHANGED_FILES" ]; then
  exit 0
fi

VIOLATIONS=""

while IFS= read -r file; do
  ALLOWED=false

  for pattern in "\${ALLOWED_PATTERNS[@]}"; do
    if echo "$file" | grep -qE "^$pattern$"; then
      ALLOWED=true
      break
    fi
  done

  for pattern in "\${FORBIDDEN_PATTERNS[@]}"; do
    if echo "$file" | grep -qE "^$pattern$"; then
      ALLOWED=false
      VIOLATIONS="$VIOLATIONS\\n  FORBIDDEN: $file (matches $pattern)"
      break
    fi
  done

  if [ "$ALLOWED" = false ]; then
    VIOLATIONS="$VIOLATIONS\\n  OUT OF SCOPE: $file"
  fi
done <<< "$CHANGED_FILES"

if [ -n "$VIOLATIONS" ]; then
  echo ""
  echo "FOREMAN SCOPE VIOLATION — commit rejected"
  echo "=========================================="
  echo "This session is scoped to: ${allowedPatterns.join(', ')}"
  echo ""
  echo "The following files are out of scope:"
  echo -e "$VIOLATIONS"
  echo ""
  echo "To fix: unstage out-of-scope files with 'git reset HEAD <file>', then commit only allowed files."
  echo ""
  exit 1
fi

exit 0
`

  const hookPath = join(hooksDir, 'pre-commit')
  writeFileSync(hookPath, hookScript)
  chmodSync(hookPath, 0o755)

  return hookPath
}

/**
 * Remove a scope hook from a worktree.
 */
export function removeScopeHook(worktreePath: string): void {
  try {
    unlinkSync(join(worktreePath, '.foreman-hooks', 'pre-commit'))
  } catch {}
  try {
    execFileSync('git', ['config', '--worktree', '--unset', 'core.hooksPath'], {
      cwd: worktreePath, timeout: 5_000,
    })
  } catch {}
  try {
    execFileSync('git', ['config', '--local', '--unset', 'core.hooksPath'], {
      cwd: worktreePath, timeout: 5_000,
    })
  } catch {}
}
