#!/usr/bin/env bash
# SWE-bench Experiment Harness
#
# Clones real repos at the exact commit, dispatches Claude to fix real GitHub issues.
# Tests with bare vs full Foreman-style prompts.
#
# Usage: bash research/experiments/swe-bench-harness.sh [--tasks 3] [--timeout 600]

set -euo pipefail

TASKS_FILE="$HOME/.foreman/experiments/swe-bench-tasks.json"
MAX_TASKS=${1:-3}
TIMEOUT=${2:-600}
MODEL="claude-sonnet-4-6"
RESULTS_DIR="$HOME/.foreman/experiments/swe-bench-$(date +%Y%m%d-%H%M%S)"

mkdir -p "$RESULTS_DIR"

echo "╔══════════════════════════════════════════════╗"
echo "║  SWE-bench Experiment — Real Production Bugs  ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Tasks: $MAX_TASKS | Timeout: ${TIMEOUT}s | Model: $MODEL"
echo "Results: $RESULTS_DIR"
echo ""

python3 << PYEOF
import json, subprocess, os, time, shutil

tasks = json.load(open("$TASKS_FILE"))[:$MAX_TASKS]
RESULTS_DIR = "$RESULTS_DIR"
TIMEOUT = $TIMEOUT
MODEL = "$MODEL"
conditions = ["bare", "full"]

all_results = []

for i, task in enumerate(tasks):
    tid = task["instance_id"]
    repo = task["repo"]
    commit = task["base_commit"]
    problem = task["problem_statement"]
    expected_patch = task["patch"]
    hints = task.get("hints_text", "")

    print(f"\n{'='*60}")
    print(f"[{i+1}/{len(tasks)}] {tid}")
    print(f"Repo: {repo} @ {commit[:8]}")
    print(f"Patch: {len(expected_patch.splitlines())} lines expected")
    print(f"{'='*60}")

    for cond in conditions:
        work_dir = f"{RESULTS_DIR}/{tid}/{cond}"
        repo_dir = f"{work_dir}/repo"
        os.makedirs(work_dir, exist_ok=True)

        # Clone at exact commit
        print(f"\n  [{cond}] Cloning {repo}...")
        clone_start = time.time()
        try:
            subprocess.run(
                ["git", "clone", "--depth", "200", f"https://github.com/{repo}.git", repo_dir],
                capture_output=True, timeout=120
            )
            subprocess.run(["git", "checkout", commit], cwd=repo_dir, capture_output=True, timeout=10)
        except Exception as e:
            print(f"  [{cond}] Clone failed: {e}")
            all_results.append({"task": tid, "condition": cond, "success": False, "error": "clone_failed"})
            continue
        clone_time = time.time() - clone_start
        print(f"  [{cond}] Cloned in {clone_time:.0f}s")

        # Build prompt
        if cond == "bare":
            prompt = problem
        else:
            prompt = f"""## Task — Fix a Real Bug in {repo}

{problem}

## Standards
- This is a PRODUCTION codebase with hundreds of files. Navigate carefully.
- Use grep and find to locate relevant code. Do NOT read every file.
- The fix should be MINIMAL — change as few lines as possible.
- The expected fix is roughly {len(expected_patch.splitlines())} lines of diff.
- Run the relevant test file after your fix to verify.

## Approach
1. Parse the issue description — understand EXACTLY what's wrong
2. Use grep to find the relevant source file(s): grep -r "ClassName" --include="*.py" -l
3. Read the specific function/method mentioned in the issue
4. Make the minimal fix
5. Run the test: python -m pytest <test_file> -x -v (find the right test file first)

## Constraints
- Do NOT install new dependencies
- Do NOT refactor unrelated code
- Do NOT add new test files — just fix the source
- The repo is checked out at commit {commit[:8]} — this is the EXACT state where the bug exists

{f"## Hints" + chr(10) + hints if hints else ""}"""

        prompt_len = len(prompt)
        open(f"{work_dir}/prompt.txt", "w").write(prompt)

        # Run Claude
        print(f"  [{cond}] Running Claude ({prompt_len} chars, {TIMEOUT}s timeout)...")
        start = time.time()
        try:
            r = subprocess.run(
                ["claude", "-p", prompt, "--dangerously-skip-permissions", "--model", MODEL],
                capture_output=True, text=True, timeout=TIMEOUT,
                cwd=repo_dir
            )
            open(f"{work_dir}/claude-stdout.txt", "w").write(r.stdout)
            open(f"{work_dir}/claude-stderr.txt", "w").write(r.stderr)
            timed_out = False
        except subprocess.TimeoutExpired:
            timed_out = True
            open(f"{work_dir}/claude-stdout.txt", "w").write("TIMEOUT")
        duration = time.time() - start

        # Capture the diff Claude produced
        try:
            diff = subprocess.run(["git", "diff"], capture_output=True, text=True, cwd=repo_dir, timeout=10)
            actual_diff = diff.stdout
            open(f"{work_dir}/actual.diff", "w").write(actual_diff)
            diff_lines = len(actual_diff.splitlines())
        except:
            actual_diff = ""
            diff_lines = 0

        # Save expected patch for comparison
        open(f"{work_dir}/expected.diff", "w").write(expected_patch)

        # Check if Claude's diff touches the same files as the expected patch
        expected_files = set()
        actual_files = set()
        for line in expected_patch.splitlines():
            if line.startswith("--- a/") or line.startswith("+++ b/"):
                f = line.split("/", 1)[1] if "/" in line else line
                expected_files.add(f.strip())
        for line in actual_diff.splitlines():
            if line.startswith("--- a/") or line.startswith("+++ b/"):
                f = line.split("/", 1)[1] if "/" in line else line
                actual_files.add(f.strip())

        files_overlap = len(expected_files & actual_files)
        correct_files = files_overlap > 0

        # Try running the test patch to see if Claude's fix passes
        # Apply test patch first
        test_patch = task.get("test_patch", "")
        tests_pass = False
        if test_patch and actual_diff:
            try:
                # Apply test patch
                proc = subprocess.run(
                    ["git", "apply", "--allow-empty", "-"],
                    input=test_patch, capture_output=True, text=True, cwd=repo_dir, timeout=10
                )
                # Run tests (simplified — real SWE-bench uses specific test commands)
                test_result = subprocess.run(
                    ["python", "-m", "pytest", "-x", "--timeout=30", "-q"],
                    capture_output=True, text=True, cwd=repo_dir, timeout=60
                )
                tests_pass = test_result.returncode == 0
            except:
                pass

        status = "timeout" if timed_out else ("pass" if tests_pass else ("partial" if correct_files else ("changed" if diff_lines > 0 else "no_change")))
        icon = {"pass": "✅", "partial": "🟡", "changed": "🔵", "no_change": "❌", "timeout": "⏱️"}[status]

        print(f"  [{cond}] {icon} {status} | {duration:.0f}s | {diff_lines} diff lines | correct files: {correct_files}")

        result = {
            "task": tid,
            "repo": repo,
            "condition": cond,
            "status": status,
            "success": tests_pass,
            "correct_files": correct_files,
            "diff_lines": diff_lines,
            "expected_diff_lines": len(expected_patch.splitlines()),
            "duration_s": round(duration),
            "timed_out": timed_out,
            "prompt_length": prompt_len,
        }
        all_results.append(result)
        json.dump(result, open(f"{work_dir}/result.json", "w"), indent=2)

        # Cleanup repo to save disk (keep diffs)
        shutil.rmtree(repo_dir, ignore_errors=True)

# === AGGREGATE ===
print(f"\n{'='*60}")
print("RESULTS SUMMARY")
print(f"{'='*60}\n")

for cond in conditions:
    cr = [r for r in all_results if r["condition"] == cond]
    passes = sum(1 for r in cr if r["success"])
    partials = sum(1 for r in cr if r["correct_files"] and not r["success"])
    changes = sum(1 for r in cr if r["diff_lines"] > 0)
    timeouts = sum(1 for r in cr if r["timed_out"])
    avg_dur = sum(r["duration_s"] for r in cr) / len(cr) if cr else 0

    print(f"{cond:6s}: {passes}/{len(cr)} pass | {partials} partial | {changes} changed | {timeouts} timeout | avg {avg_dur:.0f}s")

print("\nPer-task:")
for tid in dict.fromkeys(r["task"] for r in all_results):
    bare = next((r for r in all_results if r["task"] == tid and r["condition"] == "bare"), None)
    full = next((r for r in all_results if r["task"] == tid and r["condition"] == "full"), None)
    bi = {"pass":"✅","partial":"🟡","changed":"🔵","no_change":"❌","timeout":"⏱️"}.get(bare["status"],"?") if bare else "—"
    fi = {"pass":"✅","partial":"🟡","changed":"🔵","no_change":"❌","timeout":"⏱️"}.get(full["status"],"?") if full else "—"
    print(f"  {tid:45s} bare={bi} full={fi}")

json.dump({"results": all_results}, open(f"{RESULTS_DIR}/aggregate.json", "w"), indent=2)
print(f"\nSaved to: {RESULTS_DIR}")
PYEOF
