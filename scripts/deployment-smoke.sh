#!/usr/bin/env bash
set -euo pipefail

: "${OPERATOR_BEARER_TOKEN:?Set OPERATOR_BEARER_TOKEN before running the deployment smoke}"

BASE_URL="${BASE_URL:-http://127.0.0.1:3210}"

wait_for_health() {
  for _ in $(seq 1 30); do
    if curl -fsS "$BASE_URL/health" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "Timed out waiting for $BASE_URL/health" >&2
  return 1
}

expect_status() {
  local expected="$1"
  shift
  local actual
  actual="$(curl -sS -o /dev/null -w "%{http_code}" "$@")"
  if [ "$actual" != "$expected" ]; then
    echo "Expected HTTP $expected, got $actual for: $*" >&2
    return 1
  fi
}

docker compose up -d --build
wait_for_health

expect_status 200 "$BASE_URL/health"
expect_status 401 "$BASE_URL/admin/summary"
expect_status 200 -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" "$BASE_URL/admin/summary"

curl -fsS \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"dashboardRefreshSeconds":7,"chatDefaultConversationId":"deployment-smoke","memoryTimelineLimit":17}' \
  "$BASE_URL/admin/settings" >/dev/null

docker compose restart codex-phantom
wait_for_health

curl -fsS -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" "$BASE_URL/admin/settings" |
  grep '"memoryTimelineLimit":17' >/dev/null

echo "Deployment smoke passed"
