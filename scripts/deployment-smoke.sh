#!/usr/bin/env bash
set -euo pipefail

: "${OPERATOR_BEARER_TOKEN:?Set OPERATOR_BEARER_TOKEN before running the deployment smoke}"
: "${MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN before running the deployment smoke}"
: "${EXTERNAL_CHANNEL_SECRET:?Set EXTERNAL_CHANNEL_SECRET before running the deployment smoke}"
: "${OPENAI_API_KEY:?Set OPENAI_API_KEY before running the deployment smoke}"

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
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"method":"tools/list"}' \
  "$BASE_URL/mcp" | grep '"echo.summary"' >/dev/null

expect_status 200 -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" "$BASE_URL/admin/mcp/audit"
curl -fsS -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" "$BASE_URL/metrics?format=prometheus" |
  grep 'codex_phantom_mcp_auth_success' >/dev/null

curl -fsS \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"deployment-smoke-future","message":"verify scheduler route","scheduledAt":"2099-01-01T00:00:00.000Z"}' \
  "$BASE_URL/scheduler/jobs" >/dev/null

curl -fsS -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" "$BASE_URL/scheduler/jobs" |
  grep 'deployment-smoke-future' >/dev/null

for _ in $(seq 1 13); do
  curl -sS -o /dev/null \
    -H "Authorization: Bearer wrong-token" \
    -H "Content-Type: application/json" \
    --data '{"method":"tools/list"}' \
    "$BASE_URL/mcp" >/dev/null
done
expect_status 429 \
  -H "Authorization: Bearer wrong-token" \
  -H "Content-Type: application/json" \
  --data '{"method":"tools/list"}' \
  "$BASE_URL/mcp"

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
