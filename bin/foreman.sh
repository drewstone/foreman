#!/usr/bin/env bash
# foreman.sh — CLI wrapper for Foreman HTTP API (curl + jq)
set -euo pipefail

FOREMAN_URL="${FOREMAN_URL:-http://127.0.0.1:7374}"
API="$FOREMAN_URL/api"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

require_jq() { command -v jq >/dev/null 2>&1 || die "jq is required but not installed"; }

usage() {
  cat <<'EOF'
Usage: foreman.sh <command> [args]

Commands:
  status          Goals, active sessions, and recent decisions
  sessions        List sessions (name, status, alive)
  approve <ID>    Approve a decision by ID
  reject <ID>    Reject a decision by ID
EOF
  exit 0
}

cmd_status() {
  local raw
  raw=$(curl -sf "$API/status") || die "cannot reach foreman at $FOREMAN_URL"

  echo "=== Goals ==="
  echo "$raw" | jq -r '
    .goals[] |
    "  [\(.id)] \(.intent) (priority: \(.priority // 0), status: \(.status // "active"))"
  ' 2>/dev/null || echo "  (none)"

  echo ""
  echo "=== Active Sessions ==="
  echo "$raw" | jq -r '
    .sessions[] |
    "  \(.name)  status=\(.status)  alive=\(.alive)"
  ' 2>/dev/null || echo "  (none)"

  echo ""
  echo "=== Recent Decisions ==="
  echo "$raw" | jq -r '
    .recentDecisions[:5][] |
    "  [\(.id)] \(.skill // "direct"): \(.task[:80] // "(no task)") → \(.status // "pending")"
  ' 2>/dev/null || echo "  (none)"
}

cmd_sessions() {
  local raw
  raw=$(curl -sf "$API/sessions") || die "cannot reach foreman at $FOREMAN_URL"
  echo "$raw" | jq -r '.[] | "\(.name)\t\(.status)\t\(.alive)"' |
    column -t -s $'\t' -N NAME,STATUS,ALIVE 2>/dev/null ||
    echo "$raw" | jq -r '.[] | "  \(.name)  status=\(.status)  alive=\(.alive)"'
}

cmd_approve() {
  local id="$1"
  curl -sf -X POST "$API/outcomes" \
    -H 'Content-Type: application/json' \
    -d "{\"decision_id\": $id, \"taste_signal\": \"approved\"}" |
    jq . || die "failed to approve decision $id"
}

cmd_reject() {
  local id="$1"
  curl -sf -X POST "$API/outcomes" \
    -H 'Content-Type: application/json' \
    -d "{\"decision_id\": $id, \"taste_signal\": \"rejected\"}" |
    jq . || die "failed to reject decision $id"
}

require_jq

case "${1:-}" in
  status)   cmd_status ;;
  sessions) cmd_sessions ;;
  approve)
    [[ -n "${2:-}" ]] || die "usage: foreman.sh approve <decision_id>"
    cmd_approve "$2"
    ;;
  reject)
    [[ -n "${2:-}" ]] || die "usage: foreman.sh reject <decision_id>"
    cmd_reject "$2"
    ;;
  help|--help|-h) usage ;;
  "") usage ;;
  *) die "unknown command: $1" ;;
esac
