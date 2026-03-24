#!/usr/bin/env bash
# TerminalBench Runner
#
# Runs terminal tasks through Claude Code with two conditions:
# - raw: just the task description
# - foreman: task + structured approach hints + constraints
#
# Usage: bash research/experiments/terminalbench/run.sh [--tasks N] [--timeout N] [--tier TIER]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASKS_FILE="$SCRIPT_DIR/tasks.json"
CLAUDE_BIN="${CLAUDE_PATH:-$HOME/.local/bin/claude}"
MAX_TASKS=30
TIMEOUT=120
TIER="all"
MODEL="claude-sonnet-4-6"

while [[ $# -gt 0 ]]; do
  case $1 in
    --tasks) MAX_TASKS="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --tier) TIER="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    *) shift;;
  esac
done

RESULTS_DIR="$HOME/.foreman/experiments/terminalbench-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"

echo "TerminalBench | Max tasks: $MAX_TASKS | Timeout: ${TIMEOUT}s | Tier: $TIER | Model: $MODEL"
echo "Results: $RESULTS_DIR"

python3 << PYEOF
import json, subprocess, os, time, tempfile

TASKS_FILE = "$TASKS_FILE"
RESULTS_DIR = "$RESULTS_DIR"
TIMEOUT = $TIMEOUT
MAX_TASKS = $MAX_TASKS
TIER = "$TIER"
MODEL = "$MODEL"
CLAUDE_BIN = "$CLAUDE_BIN"

tasks = json.load(open(TASKS_FILE))
if TIER != "all":
    tasks = [t for t in tasks if t["tier"] == TIER]
tasks = tasks[:MAX_TASKS]

conditions = ["raw", "foreman"]
all_results = []
PID = os.getpid()

def run_claude(prompt: str, work_dir: str, timeout: int) -> tuple[str, bool, float]:
    prompt_file = tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False)
    prompt_file.write(prompt)
    prompt_file.close()
    start = time.time()
    try:
        r = subprocess.run(
            f'cat "{prompt_file.name}" | {CLAUDE_BIN} --dangerously-skip-permissions --model {MODEL} -p',
            shell=True, capture_output=True, text=True, timeout=timeout, cwd=work_dir,
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

for i, task in enumerate(tasks):
    tid = task["id"]
    tier = task["tier"]
    desc = task["description"]
    setup_cmd = task["setup"].replace("$$", str(PID))
    verify_cmd = task["verify"]
    cleanup_cmd = task.get("cleanup", "").replace("$$", str(PID))

    print(f"\n{'='*60}")
    print(f"[{i+1}/{len(tasks)}] {tid} ({tier})")
    print(f"  {desc[:80]}")
    print(f"{'='*60}")

    for cond in conditions:
        # Setup workspace
        work_dir = f"/tmp/tb-{PID}-{tid.split('-')[-1]}" if "$$" in task["setup"] else f"/tmp/tb-{PID}-{i}"
        actual_setup = setup_cmd
        actual_verify = verify_cmd
        actual_cleanup = cleanup_cmd

        # Run setup
        subprocess.run(actual_setup, shell=True, capture_output=True, timeout=30)

        # Build prompt
        if cond == "raw":
            prompt = desc
        else:
            prompt = f"""Complete this terminal task. You have full shell access.

## Task
{desc}

## Working Directory
You are in {work_dir}. All files should be created here.

## Approach
1. Understand exactly what's needed
2. Create any files/scripts required
3. Test your work before finishing
4. Keep solutions minimal and portable (bash, standard tools)

## Constraints
- Use standard Unix tools (no pip install unless necessary)
- Scripts must be executable and handle edge cases
- Verify your work actually produces the expected output"""

        result_dir = os.path.join(RESULTS_DIR, f"{tid}-{cond}")
        os.makedirs(result_dir, exist_ok=True)
        open(os.path.join(result_dir, "prompt.txt"), "w").write(prompt)

        print(f"\n  [{cond}] Running ({len(prompt)} chars)...")
        stdout, timed_out, duration = run_claude(prompt, work_dir, TIMEOUT)
        open(os.path.join(result_dir, "stdout.txt"), "w").write(stdout or "TIMEOUT")

        # Verify
        success = False
        verify_output = ""
        if not timed_out:
            try:
                v = subprocess.run(actual_verify, shell=True, capture_output=True, text=True,
                                  timeout=30, cwd=work_dir)
                success = v.returncode == 0
                verify_output = v.stdout + v.stderr
            except Exception as e:
                verify_output = str(e)

        icon = "⏱️" if timed_out else ("✅" if success else "❌")
        print(f"  [{cond}] {icon} {'timeout' if timed_out else ('pass' if success else 'fail')} | {duration:.0f}s")

        result = {
            "task": tid, "tier": tier, "condition": cond,
            "success": success, "timed_out": timed_out,
            "duration_s": round(duration),
            "prompt_length": len(prompt),
            "verify_output": verify_output[:500],
        }
        all_results.append(result)
        json.dump(result, open(os.path.join(result_dir, "result.json"), "w"), indent=2)

        # Cleanup
        if actual_cleanup:
            subprocess.run(actual_cleanup, shell=True, capture_output=True, timeout=10)

# === SUMMARY ===
print(f"\n{'='*60}")
print("RESULTS SUMMARY")
print(f"{'='*60}\n")

for cond in conditions:
    cr = [r for r in all_results if r["condition"] == cond]
    by_tier = {}
    for r in cr:
        t = r["tier"]
        by_tier.setdefault(t, {"total": 0, "pass": 0})
        by_tier[t]["total"] += 1
        if r["success"]: by_tier[t]["pass"] += 1

    total = len(cr)
    passes = sum(1 for r in cr if r["success"])
    avg_dur = sum(r["duration_s"] for r in cr) / total if total else 0
    print(f"{cond:8s}: {passes}/{total} ({100*passes/total:.0f}%) | avg {avg_dur:.0f}s")
    for t in ["easy", "medium", "hard"]:
        if t in by_tier:
            d = by_tier[t]
            print(f"  {t:8s}: {d['pass']}/{d['total']}")

print(f"\nPer-task:")
seen = set()
for r in all_results:
    if r["task"] in seen: continue
    seen.add(r["task"])
    raw = next((x for x in all_results if x["task"] == r["task"] and x["condition"] == "raw"), None)
    fore = next((x for x in all_results if x["task"] == r["task"] and x["condition"] == "foreman"), None)
    ri = "✅" if raw and raw["success"] else ("⏱️" if raw and raw["timed_out"] else "❌")
    fi = "✅" if fore and fore["success"] else ("⏱️" if fore and fore["timed_out"] else "❌")
    print(f"  {r['task']:20s} ({r['tier']:6s}) raw={ri} foreman={fi}")

json.dump({"results": all_results, "config": {"tasks": MAX_TASKS, "timeout": TIMEOUT, "tier": TIER, "model": MODEL}},
          open(os.path.join(RESULTS_DIR, "aggregate.json"), "w"), indent=2)
print(f"\nSaved to: {RESULTS_DIR}")
PYEOF
