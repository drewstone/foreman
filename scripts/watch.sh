#!/usr/bin/env bash
# Watch all active Foreman sessions — live streaming output
# Usage: bash scripts/watch.sh

set -euo pipefail

WATCH_SESSION="foreman-watch"
FIFO_DIR="/tmp/foreman-watch-$$"
tmux kill-session -t "$WATCH_SESSION" 2>/dev/null || true
rm -rf /tmp/foreman-watch-* 2>/dev/null
mkdir -p "$FIFO_DIR"

SESSIONS=($(tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^foreman-" | grep -v "^foreman:" | grep -v "^foreman-watch" | head -6))

if [ ${#SESSIONS[@]} -eq 0 ]; then
  echo "No active Foreman sessions."
  exit 0
fi

echo "Streaming ${#SESSIONS[@]} sessions live..."

# Set up pipe-pane for each session to stream to a file
for s in "${SESSIONS[@]}"; do
  LOGFILE="$FIFO_DIR/$s.stream"
  touch "$LOGFILE"
  # Pipe pane output to the stream file (append mode, real-time)
  tmux pipe-pane -t "$s" -o "cat >> '$LOGFILE'"
done

# Build watch session — each pane tails a stream file
SHORT_NAME=$(echo "${SESSIONS[0]}" | sed 's/foreman-//' | head -c 30)
tmux new-session -d -s "$WATCH_SESSION" \
  "printf '\033[1;36m%s\033[0m\n' '═══ $SHORT_NAME ═══'; tail -f '$FIFO_DIR/${SESSIONS[0]}.stream' | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g'"

for ((i=1; i<${#SESSIONS[@]}; i++)); do
  SHORT_NAME=$(echo "${SESSIONS[$i]}" | sed 's/foreman-//' | head -c 30)
  if (( i % 2 == 1 )); then
    tmux split-window -t "$WATCH_SESSION" -h \
      "printf '\033[1;36m%s\033[0m\n' '═══ $SHORT_NAME ═══'; tail -f '$FIFO_DIR/${SESSIONS[$i]}.stream' | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g'"
  else
    tmux split-window -t "$WATCH_SESSION" -v \
      "printf '\033[1;36m%s\033[0m\n' '═══ $SHORT_NAME ═══'; tail -f '$FIFO_DIR/${SESSIONS[$i]}.stream' | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g'"
  fi
done

tmux select-layout -t "$WATCH_SESSION" tiled

# Cleanup on exit
trap "rm -rf '$FIFO_DIR'" EXIT

exec tmux attach -t "$WATCH_SESSION"
