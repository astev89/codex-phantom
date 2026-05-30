# Deployment Smoke Runbook

Use this runbook after deployment, Docker, persistence, auth, scheduler, MCP, or backup/restore changes. The goal is to prove the Compose runtime can boot, reject unauthenticated traffic, expose expected operator surfaces, persist state across restart, and restore SQLite-backed state from a volume backup.

## Safety Notes

- `scripts/deployment-smoke.sh` is non-destructive to Docker volumes.
- `scripts/backup-restore-smoke.sh` is destructive to the local `codex-phantom-data` Docker volume. It backs up the volume, removes and recreates it, restores the archive, and then verifies restored state.
- Do not run backup/restore validation against a volume that contains data you still need unless you have an independent backup.
- Both scripts require Docker and Docker Compose.

## Required Environment

`docker-compose.yml` defaults to `APP_ENV=development` for local live testing. Set production-like, non-default values before running either smoke script:

```bash
export APP_ENV=production
export OPERATOR_BEARER_TOKEN='replace-with-operator-secret'
export MCP_BEARER_TOKEN='replace-with-mcp-secret'
export EXTERNAL_CHANNEL_SECRET='replace-with-channel-secret'
export OPENAI_API_KEY='replace-with-openai-key'
```

Optional overrides:

```bash
export BASE_URL='http://127.0.0.1:3210'
export LOG_LEVEL=info
```

## Preflight

Confirm the target repo, branch, and Docker volume state:

```bash
git status --short
docker compose config >/dev/null
docker volume ls | grep codex-phantom || true
```

If `codex-phantom-data` exists, decide whether it is disposable before running the restore smoke.

## Deployment Smoke

Run this first. It builds and boots Compose, checks health/auth, exercises MCP listing and audit, verifies Prometheus metrics, schedules a future job, confirms MCP rate limiting, updates operator settings, restarts the app, and verifies settings persistence.

```bash
scripts/deployment-smoke.sh
```

Expected final line:

```text
Deployment smoke passed
```

## Backup/Restore Smoke

Run this only after confirming the local Docker volume can be recreated. It seeds deterministic SQLite state, verifies it through HTTP APIs, archives the app-data volume, removes and recreates `codex-phantom-data`, restores the archive, restarts Compose, and verifies the same state again.

```bash
scripts/backup-restore-smoke.sh
```

Expected final line:

```text
Backup/restore smoke passed
```

## Evidence To Record

After both scripts pass, update `docs/project-status.md` with:

- date and branch
- exact commands run
- whether `codex-phantom-data` existed before restore validation
- final pass lines from both scripts
- any operator notes, such as custom `BASE_URL` or cleanup performed

## Failure Handling

- If Compose does not start, run `docker compose logs codex-phantom qdrant`.
- If auth checks fail, verify the exported tokens match the script environment and are not default placeholders.
- If MCP or metrics checks fail, inspect `/admin/mcp/audit` and `/metrics?format=prometheus` with the operator token.
- If restore verification fails, do not delete the backup tarball until the failure is understood. The restore script creates its temporary archive in a local temp directory and removes it on normal exit.
- To stop the stack after investigation, run `docker compose down`.
