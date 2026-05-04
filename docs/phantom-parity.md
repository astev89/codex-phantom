# Phantom Parity Snapshot

This snapshot tracks production-readiness parity against the reference Phantom repo as of the latest GitNexus-assisted comparison pass. The goal is useful Codex-oriented parity, not a feature-for-feature clone of every Phantom channel or UI.

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
- Normalized inbound channel routing for signed webhooks and Slack Events API ingestion, with durable inbound event state, dedupe, operator visibility, and Slack ack-then-run execution.
- Slack outbound delivery retries for transient `429` and `5xx` responses, with attempt counts and recent failed deliveries visible to operators.
- Codex-native `/chat` product surface with SSE streaming, session list/detail APIs, transcript rendering, browser-local multi-tab sync, durable uploaded attachments, explicit artifact records, notification permission affordance, markdown rendering, and auto-renamed sessions.

## Deferred or consciously divergent

- **Accepted divergence:** Full Phantom-style self-evolution is not enabled; config/memory mutation should remain explicit until governance rules are stronger.
- **Accepted divergence:** Dynamic shell/script MCP tools remain intentionally constrained to template-style dynamic tools.
- **Accepted divergence:** Docker socket mounting is not part of the default deployment path.
- **Accepted divergence:** Metrics are process-local and reset on restart; external scraping through Prometheus/Grafana is the durable metrics path for this wave.
- **Accepted divergence:** `codex-phantom` now has a Codex-native web chat product surface, but it intentionally does not clone Phantom's whole chat SPA internals when a smaller browser surface satisfies current operator needs.
- **Accepted divergence:** Telegram support is not a parity target.
- **Not implemented yet:** Slack inbound parity is still basic. `codex-phantom` accepts app mentions, direct messages, mention-gated channel messages, and reactions, then posts one final thread reply. Phantom's progressive updates, status reactions, and richer feedback signal loop remain follow-up work.
- **Not implemented yet:** Advanced artifact continuity is thinner than Phantom. `codex-phantom` now persists uploaded attachment blobs and explicit artifact records, but does not yet auto-extract artifacts from tool events, recover richer artifact views, or search attachment contents.
- **Not implemented yet:** Role/config/onboarding parity remains partial. `codex-phantom` has roles and prompt assembly, but not Phantom's YAML-first role system, first-run onboarding flow, magic-link auth, or evolved config file layers.
- **Not implemented yet:** Plugin marketplace and curated overlay parity remains open. Dynamic governed tools cover the safer core, but not Phantom's plugin seed, manifest, marketplace, audit, and curated overlay system.
- **Not implemented yet:** Advanced memory behavior remains partial. `codex-phantom` has Qdrant/OpenAI-backed retrieval with SQLite fallback, summaries, semantic facts, and procedural notes; Phantom also includes richer hybrid retrieval, contradiction/supersession handling, decay/reinforcement, and scheduled consolidation/promote/prune behavior.

## Current priority order

1. Execute and record Docker deployment plus backup/restore smoke evidence.
2. Add richer Slack inbound progress behavior: progressive message updates, status reactions, and feedback signal handling.
3. Add operator-visible inbound progress state beyond final run status.
4. Add only the remaining transcript/artifact continuity needed for Codex operations; auto-extracted artifacts, searchable attachment contents, and full 32-event chat protocol compatibility remain future work.
5. Revisit role/config/onboarding, plugin marketplace, and advanced memory behavior after inbound channel parity is stable.
