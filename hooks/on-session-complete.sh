#!/usr/bin/env bash
# Foreman session-complete hook for Claude Code.
# Receives JSON on stdin with: session_id, transcript_path, cwd, last_assistant_message
# POSTs to Foreman service so it can read the full JSONL and drive next dispatch.

set -euo pipefail

FOREMAN_URL="${FOREMAN_URL:-http://127.0.0.1:7374}"

# Read hook input from stdin
hook_input=$(cat)

# Extract fields
session_id=$(echo "$hook_input" | jq -r '.session_id // empty')
transcript_path=$(echo "$hook_input" | jq -r '.transcript_path // empty')
cwd=$(echo "$hook_input" | jq -r '.cwd // empty')
last_message=$(echo "$hook_input" | jq -r '.last_assistant_message // empty')

# Skip if no session ID
[ -z "$session_id" ] && exit 0

# POST to Foreman (fire-and-forget, don't block Claude Code)
curl -s -X POST "${FOREMAN_URL}/api/session-complete" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg sid "$session_id" \
    --arg tp "$transcript_path" \
    --arg cwd "$cwd" \
    --arg lm "$last_message" \
    '{session_id: $sid, transcript_path: $tp, cwd: $cwd, last_assistant_message: $lm}'
  )" &>/dev/null &

# Also fire the desktop notification
case "$(uname -s)" in
  Darwin) osascript -e 'display notification "Task finished" with title "Claude Code"' 2>/dev/null ;;
  Linux) command -v notify-send &>/dev/null && notify-send "Claude Code" "Task finished" 2>/dev/null ;;
esac

exit 0
