#!/usr/bin/env bash
# foreman.sh — CLI wrapper for Foreman HTTP API
# Commands: status, sessions, approve ID, reject ID

set -euo pipefail

FOREMAN_URL="${FOREMAN_URL:-http://127.0.0.1:7374}"
API="$FOREMAN_URL/api"

die() { echo "error: $*" >&2; exit 1; }

require_jq() {
  command -v jq >/dev/null 2>&1 || die "jq is required but not installed"
}

usage() {
  cat <<'EOF'
Usage: foreman.sh <command> [args]

Commands:
  status             Portfolio overview (goals, sessions, decisions)
  sessions           List all sessions with liveness status
  approve <id>       Approve a plan by ID (converts to goal)
  reject <id>        Reject a plan by ID
EOF
}

cmd_status() {
  curl -sf "$API/status" | jq .
}

cmd_sessions() {
  curl -sf "$API/sessions" | jq .
}

cmd_approve() {
  local id="${1:?plan ID required}"
  curl -sf -X PATCH "$API/plans/$id" \
    -H 'Content-Type: application/json' \
    -d '{"status":"approved"}' | jq .
}

cmd_reject() {
  local id="${1:?plan ID required}"
  curl -sf -X PATCH "$API/plans/$id" \
    -H 'Content-Type: application/json' \
    -d '{"status":"rejected"}' | jq .
}

require_jq

case "${1:-help}" in
  status)    cmd_status ;;
  sessions)  cmd_sessions ;;
  approve)   cmd_approve "${2:-}" ;;
  reject)    cmd_reject "${2:-}" ;;
  help|--help|-h) usage ;;
  *) echo "Unknown command: $1" >&2; usage; exit 1 ;;
esac
