#!/usr/bin/env bash
# Watch all active Foreman sessions in a tmux grid
# Usage: bash scripts/watch.sh
#        bash scripts/watch.sh 4    # max 4 panes

set -euo pipefail

MAX_PANES=${1:-6}
WATCH_SESSION="foreman-watch"

# Kill existing watch session
tmux kill-session -t "$WATCH_SESSION" 2>/dev/null || true

# Get active foreman sessions
SESSIONS=($(tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^foreman-" | grep -v "^foreman:" | grep -v "^foreman-watch" | head -$MAX_PANES))

if [ ${#SESSIONS[@]} -eq 0 ]; then
  echo "No active Foreman sessions."
  exit 0
fi

echo "Watching ${#SESSIONS[@]} sessions:"
for s in "${SESSIONS[@]}"; do echo "  $s"; done
echo ""

# Create watch session with first pane
tmux new-session -d -s "$WATCH_SESSION"
tmux send-keys -t "$WATCH_SESSION" "tmux attach -t ${SESSIONS[0]} -r" Enter

# Add remaining panes
for ((i=1; i<${#SESSIONS[@]}; i++)); do
  if (( i % 2 == 1 )); then
    tmux split-window -t "$WATCH_SESSION" -h
  else
    tmux split-window -t "$WATCH_SESSION" -v
  fi
  tmux send-keys -t "$WATCH_SESSION" "tmux attach -t ${SESSIONS[$i]} -r" Enter
done

# Even out the layout
tmux select-layout -t "$WATCH_SESSION" tiled

# Attach
tmux attach -t "$WATCH_SESSION"
