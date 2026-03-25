/**
 * Scope Enforcer — Git-level scope control for dispatched sessions.
 *
 * Problem: prompt-level "only modify file X" is ignored 100% of the time
 * (0/21 self-improvement dispatches respected scope constraints).
 *
 * Solution: inject a git pre-commit hook into the worktree that rejects
 * commits touching files outside the allowlist. The agent can READ anything
 * but can only COMMIT changes to allowed files.
 *
 * This is enforcement at the git level — the agent literally cannot push
 * out-of-scope changes. It will get a "commit rejected" error and must
 * fix its diff or give up.
 */

import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ScopeConfig {
  allowedPaths: string[]     // files/globs the session MAY modify
  forbiddenPaths?: string[]  // files/globs the session must NOT modify
}

/**
 * Install a git pre-commit hook in a worktree that enforces scope.
 * Returns the path to the hook file (for cleanup).
 */
export function installScopeHook(worktreePath: string, scope: ScopeConfig): string | null {
  if (!scope.allowedPaths?.length) return null

  const hooksDir = join(worktreePath, '.git', 'hooks')
  // Worktrees may use a shared .git file pointing to the main repo
  // In that case, .git is a file, not a directory
  const gitPath = join(worktreePath, '.git')
  let actualHooksDir: string

  if (existsSync(join(gitPath, 'hooks'))) {
    actualHooksDir = join(gitPath, 'hooks')
  } else {
    // Worktree — .git is a file pointing to the real git dir
    // We need to create a local hooks dir
    actualHooksDir = join(worktreePath, '.foreman-hooks')
    mkdirSync(actualHooksDir, { recursive: true })
    // Tell git to use this hooks dir
    try {
      const { execFileSync } = require('node:child_process')
      execFileSync('git', ['config', '--local', 'core.hooksPath', actualHooksDir], {
        cwd: worktreePath, timeout: 5_000,
      })
    } catch { return null }
  }

  const allowedPatterns = scope.allowedPaths.map(p => {
    // Convert glob to grep-compatible pattern
    return p.replace(/\*/g, '.*')
  })

  const forbiddenPatterns = (scope.forbiddenPaths || []).map(p => {
    return p.replace(/\*/g, '.*')
  })

  const hookScript = `#!/usr/bin/env bash
# Foreman scope enforcer — rejects commits with out-of-scope changes
# Installed by Foreman dispatch. DO NOT edit manually.

ALLOWED_PATTERNS=(${allowedPatterns.map(p => `"${p}"`).join(' ')})
FORBIDDEN_PATTERNS=(${forbiddenPatterns.map(p => `"${p}"`).join(' ')})

# Get files being committed
CHANGED_FILES=$(git diff --cached --name-only)

if [ -z "$CHANGED_FILES" ]; then
  exit 0
fi

VIOLATIONS=""

while IFS= read -r file; do
  ALLOWED=false

  # Check against allowed patterns
  for pattern in "\${ALLOWED_PATTERNS[@]}"; do
    if echo "$file" | grep -qE "^$pattern$"; then
      ALLOWED=true
      break
    fi
  done

  # Check against forbidden patterns
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
  echo "To fix: git reset HEAD <out-of-scope-file> to unstage, then commit only allowed files."
  echo ""
  exit 1
fi

exit 0
`

  const hookPath = join(actualHooksDir, 'pre-commit')
  writeFileSync(hookPath, hookScript)
  chmodSync(hookPath, 0o755)

  return hookPath
}

/**
 * Remove a scope hook from a worktree.
 */
export function removeScopeHook(worktreePath: string): void {
  const hookPath = join(worktreePath, '.foreman-hooks', 'pre-commit')
  try {
    const { unlinkSync } = require('node:fs')
    unlinkSync(hookPath)
  } catch {}
  // Reset hooks path
  try {
    const { execFileSync } = require('node:child_process')
    execFileSync('git', ['config', '--local', '--unset', 'core.hooksPath'], {
      cwd: worktreePath, timeout: 5_000,
    })
  } catch {}
}
