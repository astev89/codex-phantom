#!/usr/bin/env bash
set -euo pipefail

: "${OPERATOR_BEARER_TOKEN:?Set OPERATOR_BEARER_TOKEN before running the backup/restore smoke}"
: "${MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN before running the backup/restore smoke}"
: "${EXTERNAL_CHANNEL_SECRET:?Set EXTERNAL_CHANNEL_SECRET before running the backup/restore smoke}"
: "${OPENAI_API_KEY:?Set OPENAI_API_KEY before running the backup/restore smoke}"

BASE_URL="${BASE_URL:-http://127.0.0.1:3210}"
BACKUP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$BACKUP_DIR"
}
trap cleanup EXIT

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

expect_body() {
  local pattern="$1"
  shift
  local body
  body="$(curl -fsS "$@")"
  if ! printf '%s' "$body" | grep "$pattern" >/dev/null; then
    echo "Expected response to contain $pattern for: $*" >&2
    echo "$body" >&2
    return 1
  fi
}

seed_restore_data() {
  docker run --rm \
    -v codex-phantom-data:/app/data \
    -v "$PWD/scripts:/scripts:ro" \
    node:24-slim node /scripts/restore-smoke-seed.mjs
}

verify_restored_state() {
  expect_body '"memoryTimelineLimit":13' \
    -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
    "$BASE_URL/admin/settings"
  expect_body 'session_restore_smoke' \
    -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
    "$BASE_URL/sessions"
  expect_body 'run_restore_smoke' \
    -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
    "$BASE_URL/runs"
  expect_body 'job_restore_smoke' \
    -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
    "$BASE_URL/scheduler/jobs"
  expect_body 'mem_restore_smoke' \
    -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
    "$BASE_URL/memory"
  expect_body 'req_restore_smoke' \
    -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
    "$BASE_URL/admin/mcp/audit"
  expect_body 'restore.brief' \
    -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
    "$BASE_URL/admin/timeline"
}

docker compose up -d --build
wait_for_health
seed_restore_data
docker compose restart codex-phantom
wait_for_health
verify_restored_state

docker run --rm \
  -v codex-phantom-data:/data \
  -v "$BACKUP_DIR:/backup" \
  busybox tar czf /backup/codex-phantom-data.tgz -C /data .

docker compose down
docker volume rm codex-phantom-data >/dev/null
docker volume create codex-phantom-data >/dev/null

docker run --rm \
  -v codex-phantom-data:/data \
  -v "$BACKUP_DIR:/backup" \
  busybox tar xzf /backup/codex-phantom-data.tgz -C /data

docker compose up -d
wait_for_health
verify_restored_state

echo "Backup/restore smoke passed"
