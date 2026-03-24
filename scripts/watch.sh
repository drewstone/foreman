#!/usr/bin/env bash
# Watch all active Foreman sessions in a tmux grid
# Usage: bash scripts/watch.sh

set -euo pipefail

WATCH_SESSION="foreman-watch"
tmux kill-session -t "$WATCH_SESSION" 2>/dev/null || true

SESSIONS=($(tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^foreman-" | grep -v "^foreman:" | grep -v "^foreman-watch" | head -6))

if [ ${#SESSIONS[@]} -eq 0 ]; then
  echo "No active Foreman sessions."
  exit 0
fi

echo "Watching ${#SESSIONS[@]} sessions (refresh every 2s):"

# Create watch session — each pane runs `watch` on tmux capture-pane
tmux new-session -d -s "$WATCH_SESSION" \
  "watch -n2 -t 'echo \"═══ ${SESSIONS[0]} ═══\"; tmux capture-pane -t ${SESSIONS[0]} -p -S -40 2>/dev/null | tail -35'"

for ((i=1; i<${#SESSIONS[@]}; i++)); do
  if (( i % 2 == 1 )); then
    tmux split-window -t "$WATCH_SESSION" -h \
      "watch -n2 -t 'echo \"═══ ${SESSIONS[$i]} ═══\"; tmux capture-pane -t ${SESSIONS[$i]} -p -S -40 2>/dev/null | tail -35'"
  else
    tmux split-window -t "$WATCH_SESSION" -v \
      "watch -n2 -t 'echo \"═══ ${SESSIONS[$i]} ═══\"; tmux capture-pane -t ${SESSIONS[$i]} -p -S -40 2>/dev/null | tail -35'"
  fi
done

tmux select-layout -t "$WATCH_SESSION" tiled
exec tmux attach -t "$WATCH_SESSION"
