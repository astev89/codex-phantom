# Internal Tool Bundles

Internal tool bundles replace Phantom marketplace expectations for this internal project. A bundle manifest describes tools that may later become governed dynamic tools, but previewing a bundle never activates runtime capabilities.

## Manifest Shape

```json
{
  "id": "internal.research",
  "name": "Internal Research Tools",
  "version": "1.0.0",
  "tools": [
    {
      "id": "internal.research.lookup",
      "description": "Lookup internal research notes.",
      "scopes": ["read"],
      "inputSchema": { "type": "object" },
      "responseTemplate": "lookup:{{query}}"
    }
  ]
}
```

Bundle and tool ids must start with a lowercase letter and may contain lowercase letters, numbers, dots, underscores, or dashes. Preview accepts 1 to 20 tools. Tool scopes must be read-only; `write`, `admin`, and `full_access` are rejected during preview.

## Preview API

```bash
curl -X POST http://localhost:3210/admin/tools/bundles/preview \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"manifest": { "id": "internal.research", "name": "Internal Research Tools", "version": "1.0.0", "tools": [{ "id": "internal.research.lookup", "description": "Lookup notes.", "scopes": ["read"], "responseTemplate": "lookup:{{query}}" }] }}'
```

Valid previews return `200` with diagnostics and are stored as `valid`. Invalid previews return `400`, but the failed attempt is still stored as `invalid` for audit.

## Lifecycle API

Bundle previews must be approved before they can be enabled:

```bash
curl -X POST http://localhost:3210/admin/tools/bundles/tbi_123/approve \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actor":"operator","notes":"Read-only tools reviewed."}'
```

Enable registers the bundle's tools as approved dynamic tools using the existing runtime permission checks:

```bash
curl -X POST http://localhost:3210/admin/tools/bundles/tbi_123/enable \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actor":"operator"}'
```

Disable removes the bundle tools from the runtime registry and dynamic tool table while keeping the bundle import and audit trail. Uninstall performs the same cleanup and marks the bundle import uninstalled:

```bash
curl -X POST http://localhost:3210/admin/tools/bundles/tbi_123/disable \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actor":"operator"}'
```

```bash
curl -X POST http://localhost:3210/admin/tools/bundles/tbi_123/uninstall \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actor":"operator"}'
```

Recent imports and lifecycle audit records are available at:

- `GET /admin/tools/bundles`
- `GET /admin/tools/governance`
- `GET /admin/summary`
- `GET /admin/timeline`
- `GET /admin/export?scope=governance`

Installation requirements may be recorded in a manifest, but preview and enable do not execute them. Runtime execution remains bounded by the bundle manifest's read-only scopes and the existing tool permission policy.
