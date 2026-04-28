# Project Status

This is the living status ledger for `codex-phantom`. Update it at the end of each development wave, after tests pass and before handing off or opening a PR.

Last updated: 2026-04-28
Branch: `codex/production-readiness-slices`
Latest verified commit: `cde1e13 fix(ops): make mcp audit best effort`

## Current State

`codex-phantom` is a Codex-first autonomous agent runtime with a working single-process Node service, SQLite persistence, resumable sessions, scoped subagents, MCP tool exposure, scheduling, operator APIs, a browser operator console, and hybrid long-term memory with Qdrant-backed vector recall plus SQLite fallback.

The project is now past its first serious production-hardening pass. It is not yet equivalent to the original Phantom project, but the core runtime is materially safer to run: request sizes are bounded, secrets are rejected in production when defaults are used, outbound model calls have timeouts, scheduler jobs recover deterministically after restarts, MCP events are durably audited, and the Docker image runs compiled JavaScript instead of stripped TypeScript.

## Just Completed

Production readiness wave completed on 2026-04-28:

- Added bounded request-body handling for MCP and chat routes.
- Isolated request audit writes so audit persistence failures cannot break request handling.
- Added durable SQLite MCP audit logs for auth, method, and tool outcomes.
- Added `/admin/mcp/audit` and included MCP audit data in operator exports.
- Made MCP audit writes best-effort and added failure metrics.
- Normalized invalid MCP audit list limits to avoid SQLite `LIMIT` failures.
- Added scheduler stale-job recovery on startup.
- Bounded scheduler retry attempts and added capped exponential retry backoff.
- Added OpenAI Responses and Embeddings timeout configuration.
- Added memory fallback behavior when embedding requests fail.
- Added a production build path with `npm run build`, `dist/`, and Docker runtime startup through `node dist/index.js`.
- Updated deployment docs, parity docs, and tests around the new production runtime.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/mcp.test.ts
node --experimental-strip-types --test tests/server.test.ts
npm run typecheck
npm test
npm run build
```

## Next Tasks

### P1: Operator Backup And Restore Validation

The README documents backup and restore, but the current automated smoke path only verifies restart persistence. Add a restore-oriented smoke or test path that proves a saved SQLite volume can be restored and still serve expected operator state.

Suggested work:

- Add a script or documented test mode for backup/restore validation.
- Verify restored settings, sessions, jobs, memory, and MCP audit rows.
- Keep the test local and deterministic; avoid depending on external OpenAI or Slack services.

### P1: Runtime Configuration Inventory

The project has grown enough that operators need a single source of truth for required and optional environment variables.

Suggested work:

- Add a configuration reference covering secrets, ports, SQLite path, Qdrant, OpenAI, Slack, timeouts, and production mode.
- Include defaults, production requirements, and failure behavior.
- Link the reference from the README and deployment docs.

### P1: Deployment Smoke Coverage Expansion

The deployment smoke should cover more than boot and settings persistence now that MCP audit, scheduler recovery, and compiled runtime are part of the production contract.

Suggested work:

- Exercise `/mcp`, `/admin/mcp/audit`, `/metrics?format=prometheus`, and scheduler routes in `scripts/deployment-smoke.sh`.
- Confirm rate limiting and unauthenticated rejection behavior remains intact.
- Keep smoke failures explicit and easy to diagnose in CI logs.

### P2: CI Pipeline

Local verification is strong, but there is no visible CI contract in the current repo surface.

Suggested work:

- Add GitHub Actions for install, typecheck, tests, and production build.
- Consider a separate Docker build job once the basic pipeline is stable.
- Cache npm dependencies conservatively.

### P2: Admin Console Coverage

The HTTP APIs have good coverage, but the browser operator console still needs interaction-level coverage for the workflows operators will actually use.

Suggested work:

- Add Playwright coverage for the root console.
- Cover login/auth, health summary, settings update, dynamic tool approval, MCP audit viewing, and scheduler/job panels.
- Prefer stable data-test attributes over fragile text selectors.

### P2: External Channel Hardening

Slack is outbound-focused and operationally useful, but multi-channel inbound parity remains partial.

Suggested work:

- Define the intended inbound channel contract before expanding implementation.
- Add webhook signature/replay coverage if not already sufficient.
- Add delivery retry policy and operator-visible failure summaries for external sends.

### P3: Durable Metrics Strategy

Metrics are intentionally process-local today. That is acceptable for early self-hosting with Prometheus scraping, but not enough for standalone historical diagnostics.

Suggested work:

- Decide whether durable metrics belong in SQLite or should remain external-only.
- If SQLite-backed, define retention and aggregation to avoid unbounded growth.
- If external-only, document the Prometheus/Grafana deployment path.

### P3: Phantom Parity Decision Log

Some Phantom behaviors are intentionally deferred or divergent. Those decisions should stay explicit as the project evolves.

Suggested work:

- Expand `docs/phantom-parity.md` with rationale for each deferred item.
- Add "accepted divergence" versus "not implemented yet" classifications.
- Revisit after each production wave.

## Known Constraints

- Full Phantom-style self-evolution remains intentionally disabled.
- Dynamic shell/script MCP tools remain constrained to template-style dynamic tools.
- Docker socket mounting is not part of the default deployment path.
- Metrics reset on process restart unless scraped externally.
- Multi-channel inbound chat parity is incomplete.

## Update Protocol

After each development wave:

1. Update `Last updated`, branch, and latest verified commit.
2. Move completed items from `Next Tasks` into `Just Completed`.
3. Add exact verification commands that passed.
4. Add new blockers or risks under `Next Tasks`, ordered by production impact.
5. Update `docs/phantom-parity.md` when the wave changes Phantom match/defer status.
6. Keep this document concise; link to detailed plans under `docs/superpowers/plans/` instead of duplicating implementation detail.
