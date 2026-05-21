# Internal Tool Bundle Manifests Plan

## Goal

Add preview-only internal tool bundle manifests so operators can validate and audit proposed internal tools before anything is activated.

## Implementation

- Add `tool_bundle_imports` to SQLite.
- Add a `ToolBundleImportStore` that validates manifests and records every preview attempt.
- Accept bundle metadata, read-only tool metadata, input schema, response template, and optional installation notes.
- Reject invalid ids, duplicate tool ids, empty tool sets, overly large manifests, and over-broad scopes.
- Add operator APIs:
  - `POST /admin/tools/bundles/preview`
  - `GET /admin/tools/bundles`
- Surface import records in governance, summary, timeline, and export views.
- Do not register tools or execute installation requirements during preview.

## Verification

```bash
node --experimental-strip-types --test tests/tool-bundles.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```
