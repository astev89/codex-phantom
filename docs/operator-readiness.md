# Operator Readiness

Operator readiness is the production setup gate. It is stricter than `GET /health`: health answers whether the process is running, while readiness answers whether the deployment is safe enough for real operation.

## Surfaces

- `GET /health`: public liveness plus a small readiness envelope. With operator auth, it includes setup readiness details.
- `GET /admin/readiness`: authenticated readiness report. Returns `200` when ready and `503` when blocked.
- `GET /admin/summary`: includes the same readiness object alongside diagnostics, channel state, and settings.

## Checked Areas

Readiness checks cover:

- secrets: operator, MCP, and external webhook secrets must be non-default;
- storage: SQLite must be open and data/database paths must be configured;
- roles/config: `ROLE_CONFIG_PATH` and `OPERATOR_CONFIG_PATH` must point to readable, valid YAML files;
- channels: required channels come from `OPERATOR_CONFIG_PATH`; enabled channels must have required secrets;
- model: missing `OPENAI_API_KEY` is a production blocker and a development warning;
- memory: enabled Qdrant memory must be configured and reachable.

Bundled defaults live in `config/roles.yaml` and `config/operator.yaml` and are copied into the production Docker image. Treat them as the first-run baseline; override the paths only when an operator wants environment-specific policy files.

`ROLE_CONFIG_PATH` is loaded at startup and overlays the compiled role baselines used for subagent policy narrowing. The runtime currently supports the internal roles `explorer`, `builder`, `verifier`, and `researcher`; unknown roles or invalid policy shapes fail startup with an actionable error. `/admin/summary` and `/admin/diagnostics` expose the active role-policy source and validation status.

## Example

```bash
curl -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  http://localhost:3210/admin/readiness
```

Readiness responses include `status`, pass/warn/fail counts, and actionable `checks[].action` text for blocked items.
