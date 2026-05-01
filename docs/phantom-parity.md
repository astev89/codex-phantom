# Phantom Parity Snapshot

This snapshot tracks production-readiness parity against the reference Phantom repo as of the current hardening branch.

## Matched or intentionally covered

- Single-process runtime wiring for config, SQLite state, memory, scheduler, MCP, HTTP, and operator surfaces.
- Operator-authenticated admin/API surfaces with public lean `/health` and authenticated diagnostics.
- Docker and Compose boot path with non-root container execution, healthcheck, Qdrant, restart policy, and named persistent volumes.
- Compiled production runtime path via `npm run build`, emitted `dist/`, and Docker startup from `node dist/index.js`.
- Repeatable deployment smoke for health, auth rejection/acceptance, MCP listing, MCP audit, Prometheus metrics, scheduler routing, rate limiting, SQLite-backed settings persistence, and restart persistence.
- Restore smoke path for deterministic SQLite volume backup/restore validation across settings, sessions, runs, jobs, memory, dynamic tool governance, MCP audit, and timeline APIs.
- MCP bearer authentication without retaining the raw token, process-local metrics counters, and durable SQLite MCP audit logs for auth, method, and tool outcomes.
- JSON metrics snapshot and Prometheus text output at `/metrics?format=prometheus`.
- Operator console workflow coverage through Playwright for auth, settings, dynamic tool approval, MCP audit visibility, and scheduler panels.
- Signed inbound webhook contract using timestamped HMAC verification and bounded replay tolerance.
- Slack outbound delivery retries for transient `429` and `5xx` responses, with attempt counts and recent failed deliveries visible to operators.

## Deferred or consciously divergent

- **Accepted divergence:** Full Phantom-style self-evolution is not enabled; config/memory mutation should remain explicit until governance rules are stronger.
- **Accepted divergence:** Dynamic shell/script MCP tools remain intentionally constrained to template-style dynamic tools.
- **Accepted divergence:** Docker socket mounting is not part of the default deployment path.
- **Accepted divergence:** Metrics are process-local and reset on restart; external scraping through Prometheus/Grafana is the durable metrics path for this wave.
- **Not implemented yet:** Multi-channel inbound chat parity remains partial; Slack is currently outbound-focused.
