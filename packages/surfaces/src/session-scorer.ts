/**
 * Session scorer — measures quality of autonomous session output.
 *
 * After each session round, scores the work produced against
 * operator standards. Feeds into the optimization loop.
 *
 * Scores:
 *   - tests_pass: do tests pass? (0 or 1)
 *   - commits: number of commits this round
 *   - succinctness: lines per commit (lower is better, normalized)
 *   - no_mocks: did it avoid mocks? (grep for mock patterns)
 *   - integration_tests: ratio of integration to unit tests
 *   - session_state: did it write .foreman/session-state.md?
 *   - overall: weighted composite
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), '.foreman')

export interface SessionScore {
  project: string
  timestamp: string
  round: number
  scores: {
    tests_pass: number        // 0 or 1
    commits: number           // raw count
    succinctness: number      // 0-1 (1 = very succinct)
    no_mocks: number          // 0-1 (1 = no mocks found)
    has_session_state: number // 0 or 1
    files_changed: number     // raw count
    lines_added: number       // raw count
  }
  overall: number             // 0-1 weighted composite
  details: string             // human-readable summary
}

function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function shell(cmd: string, cwd: string): string {
  try {
    return execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

export function scoreSession(projectPath: string, round: number = 0): SessionScore {
  const project = projectPath.split('/').pop() ?? ''

  // Commits since initial scaffold
  const firstCommit = git(projectPath, 'rev-list', '--max-parents=0', 'HEAD')
  const allLog = git(projectPath, 'log', '--oneline')
  const commits = allLog ? allLog.split('\n').filter(Boolean).length - 1 : 0 // minus scaffold

  // Lines changed
  let linesAdded = 0
  let filesChanged = 0
  if (firstCommit) {
    const stat = git(projectPath, 'diff', '--shortstat', `${firstCommit}..HEAD`)
    const addMatch = stat.match(/(\d+) insertion/)
    const fileMatch = stat.match(/(\d+) file/)
    linesAdded = addMatch ? parseInt(addMatch[1]) : 0
    filesChanged = fileMatch ? parseInt(fileMatch[1]) : 0
  }

  // Succinctness: lines per commit (lower = more succinct, cap at 200 lines/commit = 0)
  const linesPerCommit = commits > 0 ? linesAdded / commits : 0
  const succinctness = commits > 0 ? Math.max(0, 1 - linesPerCommit / 200) : 0

  // Tests pass
  let testsPass = 0
  // Try common test runners
  const testCommands = ['npm test', 'python -m pytest', 'cargo test', 'node --test']
  for (const cmd of testCommands) {
    const result = shell(`${cmd} 2>&1; echo "EXIT:$?"`, projectPath)
    if (result.includes('EXIT:0') && !result.includes('no test')) {
      testsPass = 1
      break
    }
  }

  // No mocks: search for common mock patterns
  const mockPatterns = ['jest.mock', 'vi.mock', 'mock(', 'MagicMock', 'patch(', '@mock', 'sinon.stub']
  let mockCount = 0
  for (const pattern of mockPatterns) {
    const found = shell(`grep -r "${pattern}" --include="*.ts" --include="*.py" --include="*.js" -l 2>/dev/null | wc -l`, projectPath)
    mockCount += parseInt(found) || 0
  }
  const noMocks = mockCount === 0 ? 1 : Math.max(0, 1 - mockCount / 10)

  // Session state exists
  const hasSessionState = existsSync(join(projectPath, '.foreman', 'session-state.md')) ? 1 : 0

  // Overall: weighted composite
  const overall =
    testsPass * 0.3 +
    (commits > 0 ? 0.2 : 0) +
    succinctness * 0.15 +
    noMocks * 0.15 +
    hasSessionState * 0.1 +
    (filesChanged > 0 ? 0.1 : 0)

  const details = [
    `Tests: ${testsPass ? 'PASS' : 'FAIL/UNKNOWN'}`,
    `Commits: ${commits}`,
    `Files: ${filesChanged}, +${linesAdded} lines`,
    `Succinctness: ${(succinctness * 100).toFixed(0)}%`,
    `Mocks: ${mockCount} files`,
    `Session state: ${hasSessionState ? 'YES' : 'NO'}`,
    `Overall: ${(overall * 100).toFixed(0)}%`,
  ].join(' | ')

  const score: SessionScore = {
    project,
    timestamp: new Date().toISOString(),
    round,
    scores: {
      tests_pass: testsPass,
      commits,
      succinctness,
      no_mocks: noMocks,
      has_session_state: hasSessionState,
      files_changed: filesChanged,
      lines_added: linesAdded,
    },
    overall,
    details,
  }

  // Persist score
  try {
    const scoresDir = join(FOREMAN_HOME, 'traces', 'session-scores')
    mkdirSync(scoresDir, { recursive: true })
    const filename = `${project}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    writeFileSync(join(scoresDir, filename), JSON.stringify(score, null, 2) + '\n', 'utf8')
  } catch {}

  return score
}

/** Score all managed projects and return results */
export function scoreAllProjects(projectPaths: string[]): SessionScore[] {
  return projectPaths.map((p) => scoreSession(p))
}

/** Load historical scores for a project */
export function loadScoreHistory(project: string): SessionScore[] {
  const scoresDir = join(FOREMAN_HOME, 'traces', 'session-scores')
  try {
    const files = execFileSync('ls', ['-t', scoresDir], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split('\n')
      .filter((f) => f.startsWith(project) && f.endsWith('.json'))
    return files.map((f) => {
      try { return JSON.parse(readFileSync(join(scoresDir, f), 'utf8')) }
      catch { return null }
    }).filter(Boolean) as SessionScore[]
  } catch {
    return []
  }
}
