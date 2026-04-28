# Phantom Parity Snapshot

This snapshot tracks production-readiness parity against the reference Phantom repo as of the current hardening branch.

## Matched or intentionally covered

- Single-process runtime wiring for config, SQLite state, memory, scheduler, MCP, HTTP, and operator surfaces.
- Operator-authenticated admin/API surfaces with public lean `/health` and authenticated diagnostics.
- Docker and Compose boot path with non-root container execution, healthcheck, Qdrant, restart policy, and named persistent volumes.
- Compiled production runtime path via `npm run build`, emitted `dist/`, and Docker startup from `node dist/index.js`.
- Repeatable deployment smoke for health, auth rejection/acceptance, SQLite-backed settings persistence, and restart persistence.
- MCP bearer authentication without retaining the raw token, process-local metrics counters, and durable SQLite MCP audit logs for auth, method, and tool outcomes.
- JSON metrics snapshot and Prometheus text output at `/metrics?format=prometheus`.

## Deferred or consciously divergent

- Full Phantom-style self-evolution is not enabled; config/memory mutation should remain explicit until governance rules are stronger.
- Dynamic shell/script MCP tools remain intentionally constrained to template-style dynamic tools.
- Docker socket mounting is not part of the default deployment path.
- Metrics are process-local and reset on restart; external scraping is supported, but durable metric storage is deferred.
- Multi-channel inbound chat parity remains partial; Slack is currently outbound-focused.
