#!/usr/bin/env bash
# Foreman Prompt Ablation Experiment
#
# Tests whether Foreman's rich prompt composition improves dispatch success.
# Uses PiGraph's eval task suite with 4 prompt conditions.
#
# Usage:
#   bash research/experiments/run-prompt-ablation.sh [--tasks 5] [--reps 3] [--tier easy]
#
# Requires: Foreman service running, PiGraph eval tasks at ~/foreman-projects/PiGraph/

set -euo pipefail

TASKS=${1:-5}
REPS=${2:-1}
TIER=${3:-easy}
MODEL="claude-sonnet-4-6"
EVAL_DIR="$HOME/foreman-projects/PiGraph/repo/pigraph-run-ready/eval"
TASKS_JSON="$EVAL_DIR/eval-tasks.json"
RESULTS_DIR="$HOME/.foreman/experiments/prompt-ablation-$(date +%Y%m%d-%H%M%S)"
SERVICE_URL="http://127.0.0.1:7374"

mkdir -p "$RESULTS_DIR"

echo "=== Foreman Prompt Ablation Experiment ==="
echo "Tasks: $TASKS | Reps: $REPS | Tier: $TIER | Model: $MODEL"
echo "Results: $RESULTS_DIR"
echo ""

# Check service is running
if ! curl -s "$SERVICE_URL/api/health" > /dev/null 2>&1; then
  echo "ERROR: Foreman service not running at $SERVICE_URL"
  exit 1
fi

# Extract task IDs for the requested tier
TASK_IDS=$(python3 -c "
import json
tasks = json.load(open('$TASKS_JSON'))
# Map tier prefixes
tier_map = {'easy': 'e', 'medium': 'm', 'hard': 'h', 'challenge': 'c'}
prefix = tier_map.get('$TIER', '$TIER')
filtered = [t['id'] for t in tasks if t['id'].startswith(prefix)]
print('\n'.join(filtered[:$TASKS]))
")

echo "Tasks to run:"
echo "$TASK_IDS" | while read tid; do echo "  $tid"; done
echo ""

# For each task, for each condition, for each rep:
# 1. Copy workspace to temp dir
# 2. Compose prompt at the given condition level
# 3. Run claude -p with the prompt
# 4. Run verification
# 5. Record result

TOTAL=0
for TASK_ID in $TASK_IDS; do
  WORKSPACE="$EVAL_DIR/workspaces/$TASK_ID"
  if [ ! -d "$WORKSPACE" ]; then
    # Try eval-hard directory
    WORKSPACE="$EVAL_DIR/../examples/eval-hard/$TASK_ID"
  fi
  if [ ! -d "$WORKSPACE" ]; then
    echo "SKIP: workspace not found for $TASK_ID"
    continue
  fi

  # Get task prompt from eval-tasks.json
  TASK_PROMPT=$(python3 -c "
import json
tasks = json.load(open('$TASKS_JSON'))
for t in tasks:
    if t['id'] == '$TASK_ID':
        print(t['prompt'])
        break
")

  # Get verification command
  VERIFY_CMD=$(python3 -c "
import json
tasks = json.load(open('$TASKS_JSON'))
for t in tasks:
    if t['id'] == '$TASK_ID':
        print(t.get('verification', {}).get('command', 'node --test test.js'))
        break
")

  for CONDITION in bare basic rich full; do
    for REP in $(seq 1 $REPS); do
      TOTAL=$((TOTAL + 1))
      RUN_DIR="$RESULTS_DIR/$TASK_ID/$CONDITION-rep$REP"
      mkdir -p "$RUN_DIR"

      # Copy workspace
      cp -r "$WORKSPACE" "$RUN_DIR/workspace"

      # Compose prompt based on condition
      case $CONDITION in
        bare)
          PROMPT="$TASK_PROMPT"
          ;;
        basic)
          PROMPT="## Your Task
$TASK_PROMPT

## Standards
- Complete everything fully. No TODOs, no stubs.
- If tests exist, run them. Fix failures before moving on.
- Commit your work when done."
          ;;
        rich)
          # Get rich prompt from Foreman service
          PROMPT=$(curl -s "$SERVICE_URL/api/context?path=$WORKSPACE" | python3 -c "
import sys, json
ctx = json.load(sys.stdin)
parts = ['## Your Task', '$TASK_PROMPT', '', '## Standards', '- L7/L8 quality.', '- Run tests. Fix failures.', '- Commit when done.']
for k, v in ctx.items():
    if v: parts.append(f'## {k}\n{v[:500]}')
print('\n'.join(parts))
")
          ;;
        full)
          # Use Foreman's full composePrompt via dispatch (but capture the prompt)
          PROMPT=$(curl -s "$SERVICE_URL/api/context?path=$WORKSPACE" | python3 -c "
import sys, json
ctx = json.load(sys.stdin)
parts = ['## Your Task', '$TASK_PROMPT', '', '## Standards', '- L7/L8 staff engineer quality. Zero tolerance for slop.', '- Complete everything fully. No TODOs, no stubs.', '- ALWAYS commit your work.', '- If tests exist, run them. Fix failures before moving on.', '- Never ask for permission. Act.']
for k, v in ctx.items():
    if v: parts.append(f'## {k}\n{v[:800]}')
# Add fake history
parts.append('## What Has Been Tried Before')
parts.append('This is the first attempt on this task.')
parts.append('')
parts.append('## Operator Preferences')
parts.append('- No mocks. Use real objects for testing.')
parts.append('- Prefer architectural fixes over parameter tuning.')
print('\n'.join(parts))
")
          ;;
      esac

      echo "[$TOTAL] $TASK_ID | $CONDITION | rep$REP"

      # Save the prompt
      echo "$PROMPT" > "$RUN_DIR/prompt.txt"

      # Run claude
      cd "$RUN_DIR/workspace"
      timeout 120 claude -p "$PROMPT" --model "$MODEL" --output-format text > "$RUN_DIR/claude-stdout.txt" 2> "$RUN_DIR/claude-stderr.txt" || true

      # Run verification
      cd "$RUN_DIR/workspace"
      eval "$VERIFY_CMD" > "$RUN_DIR/verify-stdout.txt" 2> "$RUN_DIR/verify-stderr.txt" && PASSED=true || PASSED=false

      # Record result
      python3 -c "
import json
json.dump({
    'taskId': '$TASK_ID',
    'condition': '$CONDITION',
    'rep': $REP,
    'success': $([[ $PASSED == true ]] && echo 'True' || echo 'False'),
    'promptLength': $(wc -c < "$RUN_DIR/prompt.txt"),
    'model': '$MODEL',
}, open('$RUN_DIR/result.json', 'w'), indent=2)
"
      echo "  → $([[ $PASSED == true ]] && echo '✅ PASS' || echo '❌ FAIL') (prompt: $(wc -c < "$RUN_DIR/prompt.txt") chars)"

    done
  done
done

echo ""
echo "=== RESULTS ==="

# Aggregate
python3 -c "
import json, glob, os

results = []
for f in glob.glob('$RESULTS_DIR/*/*/result.json'):
    results.append(json.load(open(f)))

by_condition = {}
for r in results:
    c = r['condition']
    if c not in by_condition: by_condition[c] = {'total': 0, 'success': 0, 'prompt_lens': []}
    by_condition[c]['total'] += 1
    if r['success']: by_condition[c]['success'] += 1
    by_condition[c]['prompt_lens'].append(r['promptLength'])

print('Condition  | Pass Rate | Avg Prompt')
print('───────────┼───────────┼───────────')
for c in ['bare', 'basic', 'rich', 'full']:
    if c not in by_condition: continue
    d = by_condition[c]
    rate = d['success']/d['total']*100 if d['total'] > 0 else 0
    avg_len = sum(d['prompt_lens'])/len(d['prompt_lens']) if d['prompt_lens'] else 0
    print(f'{c:11s}| {d[\"success\"]:2d}/{d[\"total\"]:2d} ({rate:5.1f}%) | {avg_len:.0f} chars')

# Save full aggregate
json.dump({'results': results, 'aggregate': by_condition}, open('$RESULTS_DIR/aggregate.json', 'w'), indent=2)
print(f'\nSaved to: $RESULTS_DIR/aggregate.json')
"
