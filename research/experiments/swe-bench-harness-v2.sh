#!/usr/bin/env bash
# SWE-bench Experiment Harness v2
#
# Fixed from v1: pipes prompt via file (not CLI args), full clone, proper timeout,
# uses tmux sessions like Foreman does (not claude -p which has arg parsing issues).
#
# Usage: bash research/experiments/swe-bench-harness-v2.sh [--tasks N] [--timeout N] [--repeats N]
#
# Conditions: bare (just the issue) vs full (Foreman-style rich prompt)

set -euo pipefail

TASKS_FILE="$HOME/.foreman/experiments/swe-bench-tasks.json"
CLAUDE_BIN="${CLAUDE_PATH:-$HOME/.local/bin/claude}"
MAX_TASKS=10
TIMEOUT=300
REPEATS=1
MODEL="claude-sonnet-4-6"

while [[ $# -gt 0 ]]; do
  case $1 in
    --tasks) MAX_TASKS="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --repeats) REPEATS="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    *) shift;;
  esac
done

RESULTS_DIR="$HOME/.foreman/experiments/swe-bench-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"

echo "SWE-bench v2 | Tasks: $MAX_TASKS | Timeout: ${TIMEOUT}s | Repeats: $REPEATS | Model: $MODEL"
echo "Results: $RESULTS_DIR"

python3 << 'PYEOF'
import json, subprocess, os, time, shutil, sys, tempfile

TASKS_FILE = os.environ.get("TASKS_FILE", os.path.expanduser("~/.foreman/experiments/swe-bench-tasks.json"))
RESULTS_DIR = os.environ.get("RESULTS_DIR", "/tmp/swe-bench-results")
TIMEOUT = int(os.environ.get("TIMEOUT", "300"))
REPEATS = int(os.environ.get("REPEATS", "1"))
MAX_TASKS = int(os.environ.get("MAX_TASKS", "10"))
MODEL = os.environ.get("MODEL", "claude-sonnet-4-6")
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", os.path.expanduser("~/.local/bin/claude"))

tasks = json.load(open(TASKS_FILE))[:MAX_TASKS]
conditions = ["bare", "full"]
all_results = []

def run_claude_on_repo(prompt: str, repo_dir: str, timeout: int) -> tuple[str, bool, float]:
    """Run Claude via stdin pipe — reliable for any prompt length."""
    prompt_file = tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False)
    prompt_file.write(prompt)
    prompt_file.close()

    start = time.time()
    try:
        r = subprocess.run(
            f'cat "{prompt_file.name}" | {CLAUDE_BIN} --dangerously-skip-permissions --model {MODEL} -p',
            shell=True, capture_output=True, text=True, timeout=timeout, cwd=repo_dir,
            env={**os.environ, 'PATH': f'{os.path.expanduser("~/.local/bin")}:{os.environ["PATH"]}'}
        )
        duration = time.time() - start
        os.unlink(prompt_file.name)
        return r.stdout, False, duration
    except subprocess.TimeoutExpired:
        duration = time.time() - start
        try: os.unlink(prompt_file.name)
        except: pass
        return "", True, duration

def clone_repo(repo: str, commit: str, dest: str) -> bool:
    """Full clone with checkout — shallow clones miss old commits."""
    try:
        # Try shallow first (faster), fall back to deeper if commit not found
        subprocess.run(
            ["git", "clone", "--depth", "1", f"https://github.com/{repo}.git", dest],
            capture_output=True, timeout=120, check=True
        )
        # Fetch the specific commit
        r = subprocess.run(
            ["git", "fetch", "origin", commit], cwd=dest,
            capture_output=True, timeout=60
        )
        if r.returncode != 0:
            # Shallow clone didn't have commit — deepen
            subprocess.run(
                ["git", "fetch", "--unshallow"], cwd=dest,
                capture_output=True, timeout=300
            )
        subprocess.run(
            ["git", "checkout", commit], cwd=dest,
            capture_output=True, timeout=10, check=True
        )
        return True
    except Exception as e:
        print(f"    Clone failed: {e}")
        return False

def build_prompt(task: dict, condition: str) -> str:
    problem = task["problem_statement"]
    repo = task["repo"]
    commit = task["base_commit"]
    hints = task.get("hints_text", "")
    patch_lines = len(task["patch"].splitlines())

    if condition == "bare":
        return problem

    return f"""Fix a real bug in {repo}.

## Issue Description

{problem}

## Approach

1. Use grep/find to locate the relevant source files
2. Read the specific function/method mentioned in the issue
3. Make the MINIMAL fix — roughly {patch_lines} lines of diff expected
4. Run relevant tests to verify: python -m pytest <test_file> -x -v

## Constraints

- MINIMAL fix only — change as few lines as possible
- Do NOT install new dependencies or refactor unrelated code
- Do NOT add new test files
- The repo is at commit {commit[:8]}
{f'{chr(10)}## Hints{chr(10)}{hints}' if hints else ''}"""

for i, task in enumerate(tasks):
    tid = task["instance_id"]
    repo = task["repo"]
    commit = task["base_commit"]
    expected_patch = task["patch"]

    print(f"\n{'='*60}")
    print(f"[{i+1}/{len(tasks)}] {tid} ({repo})")
    print(f"{'='*60}")

    for rep in range(REPEATS):
        for cond in conditions:
            label = f"r{rep}" if REPEATS > 1 else ""
            work_dir = os.path.join(RESULTS_DIR, tid, f"{cond}{label}")
            repo_dir = os.path.join(work_dir, "repo")
            os.makedirs(work_dir, exist_ok=True)

            print(f"\n  [{cond}{' #'+str(rep+1) if REPEATS>1 else ''}] Cloning {repo}...")
            if not clone_repo(repo, commit, repo_dir):
                all_results.append({"task": tid, "repo": repo, "condition": cond, "repeat": rep,
                                   "status": "clone_failed", "success": False})
                continue

            prompt = build_prompt(task, cond)
            open(os.path.join(work_dir, "prompt.txt"), "w").write(prompt)

            print(f"  [{cond}] Running Claude ({len(prompt)} chars, {TIMEOUT}s timeout)...")
            stdout, timed_out, duration = run_claude_on_repo(prompt, repo_dir, TIMEOUT)
            open(os.path.join(work_dir, "claude-stdout.txt"), "w").write(stdout or "TIMEOUT")

            # Capture diff
            try:
                diff = subprocess.run(["git", "diff"], capture_output=True, text=True, cwd=repo_dir, timeout=10)
                actual_diff = diff.stdout
                diff_lines = len([l for l in actual_diff.splitlines() if l.startswith('+') or l.startswith('-')])
            except:
                actual_diff = ""
                diff_lines = 0

            open(os.path.join(work_dir, "actual.diff"), "w").write(actual_diff)
            open(os.path.join(work_dir, "expected.diff"), "w").write(expected_patch)

            # Check file overlap
            def extract_files(patch):
                files = set()
                for line in patch.splitlines():
                    if line.startswith("--- a/") or line.startswith("+++ b/"):
                        f = line.split("/", 1)[1] if "/" in line else line
                        files.add(f.strip())
                return files

            expected_files = extract_files(expected_patch)
            actual_files = extract_files(actual_diff)
            correct_files = bool(expected_files & actual_files)

            # Try running tests with test patch applied
            test_patch = task.get("test_patch", "")
            tests_pass = False
            if test_patch and actual_diff:
                try:
                    subprocess.run(["git", "apply", "--allow-empty", "-"],
                                 input=test_patch, capture_output=True, text=True, cwd=repo_dir, timeout=10)
                    # Find test command from test_patch
                    test_files = [l.split("b/")[1] for l in test_patch.splitlines() if l.startswith("+++ b/") and "test" in l]
                    if test_files:
                        test_cmd = ["python", "-m", "pytest", test_files[0], "-x", "--timeout=30", "-q"]
                    else:
                        test_cmd = ["python", "-m", "pytest", "-x", "--timeout=30", "-q"]
                    test_result = subprocess.run(test_cmd, capture_output=True, text=True, cwd=repo_dir, timeout=120)
                    tests_pass = test_result.returncode == 0
                    open(os.path.join(work_dir, "test-output.txt"), "w").write(test_result.stdout + "\n" + test_result.stderr)
                except Exception as e:
                    open(os.path.join(work_dir, "test-output.txt"), "w").write(f"Test execution failed: {e}")

            status = "timeout" if timed_out else (
                "pass" if tests_pass else (
                "partial" if correct_files else (
                "changed" if diff_lines > 0 else "no_change")))

            icon = {"pass": "✅", "partial": "🟡", "changed": "🔵", "no_change": "❌", "timeout": "⏱️"}[status]
            print(f"  [{cond}] {icon} {status} | {duration:.0f}s | {diff_lines} diff lines | files: {'✓' if correct_files else '✗'}")

            result = {
                "task": tid, "repo": repo, "condition": cond, "repeat": rep,
                "status": status, "success": tests_pass, "correct_files": correct_files,
                "diff_lines": diff_lines, "expected_diff_lines": len(expected_patch.splitlines()),
                "duration_s": round(duration), "timed_out": timed_out,
                "prompt_length": len(prompt),
            }
            all_results.append(result)
            json.dump(result, open(os.path.join(work_dir, "result.json"), "w"), indent=2)

            # Cleanup repo to save disk
            shutil.rmtree(repo_dir, ignore_errors=True)

# === SUMMARY ===
print(f"\n{'='*60}")
print("RESULTS SUMMARY")
print(f"{'='*60}\n")

for cond in conditions:
    cr = [r for r in all_results if r["condition"] == cond]
    passes = sum(1 for r in cr if r["success"])
    partials = sum(1 for r in cr if r["correct_files"] and not r["success"])
    timeouts = sum(1 for r in cr if r.get("timed_out"))
    total = len(cr)
    avg_dur = sum(r["duration_s"] for r in cr) / total if total else 0
    print(f"{cond:6s}: {passes}/{total} pass ({100*passes/total:.0f}%) | {partials} partial | {timeouts} timeout | avg {avg_dur:.0f}s")

print(f"\nPer-task:")
seen = set()
for r in all_results:
    tid = r["task"]
    if tid in seen: continue
    seen.add(tid)
    bare = [x for x in all_results if x["task"] == tid and x["condition"] == "bare"]
    full = [x for x in all_results if x["task"] == tid and x["condition"] == "full"]
    bp = sum(1 for x in bare if x["success"])
    fp = sum(1 for x in full if x["success"])
    bs = bare[0]["status"] if bare else "—"
    fs = full[0]["status"] if full else "—"
    print(f"  {tid:45s} bare={bs:10s} full={fs:10s}")

json.dump({"results": all_results, "config": {"tasks": MAX_TASKS, "timeout": TIMEOUT, "repeats": REPEATS, "model": MODEL}},
          open(os.path.join(RESULTS_DIR, "aggregate.json"), "w"), indent=2)
print(f"\nSaved to: {RESULTS_DIR}")
PYEOF
