#!/usr/bin/env bash
set -euo pipefail

BASE="http://127.0.0.1:7374/api"
FAIL=0

# Test 1: /api/health returns "ok"
echo "Testing GET $BASE/health ..."
HEALTH=$(curl -sf "$BASE/health" 2>/dev/null) || { echo "FAIL: /api/health unreachable"; exit 1; }
if echo "$HEALTH" | grep -q "ok"; then
  echo "PASS: /api/health contains 'ok'"
else
  echo "FAIL: /api/health response does not contain 'ok': $HEALTH"
  FAIL=1
fi

# Test 2: /api/status returns valid JSON
echo "Testing GET $BASE/status ..."
STATUS=$(curl -sf "$BASE/status" 2>/dev/null) || { echo "FAIL: /api/status unreachable"; exit 1; }
if echo "$STATUS" | python3 -m json.tool >/dev/null 2>&1; then
  echo "PASS: /api/status returns valid JSON"
else
  echo "FAIL: /api/status response is not valid JSON: $STATUS"
  FAIL=1
fi

exit $FAIL
