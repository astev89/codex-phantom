# Production-Level Parity Matrix

This matrix tracks `codex-phantom` against Phantom feature parity, excluding Telegram, with every completed feature required to meet the production-safe bar. Canonical terms live in `CONTEXT.md`; the scope decision is recorded in `docs/adr/0001-define-production-level-parity-scope.md`.

## Production Safety Baseline

Completed or intentionally covered:

- Single-process runtime wiring for config, SQLite state, memory, scheduler, MCP, HTTP, and operator surfaces.
- Operator-authenticated admin/API surfaces with public lean `/health` and authenticated diagnostics.
- Docker and Compose boot path with non-root container execution, healthcheck, Qdrant, restart policy, and named persistent volumes.
- Compiled production runtime through `npm run build`, emitted `dist/`, and Docker startup from `node dist/index.js`.
- Deployment smoke evidence for health/auth, MCP listing and audit, Prometheus metrics, scheduler routes, rate limiting, restart persistence, and operator settings.
- Backup/restore smoke evidence for deterministic SQLite state restored through the `codex-phantom-data` Docker volume and verified through HTTP APIs.
- MCP bearer authentication without retaining the raw token, durable SQLite MCP audit logs, and Prometheus metrics output.
- Operator console workflow coverage through Playwright.
- Signed inbound webhook contract with timestamped HMAC verification and bounded replay tolerance.
- Slack inbound progressive thread updates, status reactions, feedback buttons, reaction feedback, and durable progress/feedback records.
- Operator first-run readiness checks for secrets, storage, role/config files, required channels, model access, and memory backend status.
- YAML-first role policy loading with compiled baselines as fallback for tests/internal construction.

## Parity Matrix

| Area                       | Status          | Production-level parity target                                                                                                                                                                                                                                                               |
| -------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web Chat parity            | Mostly complete | Match user-visible Phantom chat capabilities without requiring exact 32-event wire protocol compatibility. Remaining gaps: service-worker push, offline cache only if needed, and any discovered product behavior not yet covered.                                                           |
| Slack parity               | Mostly complete | App mentions, DMs, channel/group mentions, reactions, thread replies, progressive updates, status reactions, feedback buttons, and reaction feedback are implemented. Remaining gaps are polish-level unless a new Phantom Slack behavior is discovered.                                     |
| Channel parity             | Partial         | Slack, Web Chat, signed webhook, and future discovered non-Telegram Phantom channels are in scope. Telegram is excluded.                                                                                                                                                                     |
| Operator onboarding parity | Mostly complete | Bundled YAML role/operator config files, first-run readiness checks, startup YAML role-policy loading, and admin source/status visibility exist. Magic-link auth is not required for this internal project. Remaining gaps are polish-level unless new Phantom setup behavior is discovered. |
| Managed memory parity      | Partial         | Contradiction/supersession lifecycle links, restart-safe scheduled maintenance, deterministic summarization/promotion, and bounded active-row pruning are implemented. Remaining gaps: decay/reinforcement scoring and richer hybrid retrieval tuning.                                       |
| Governed self-evolution    | Not implemented | Match Phantom adaptive/self-evolving behavior through proposals, policy gates, audit trails, approval for risky changes, and rollback. Unrestricted self-mutation remains out of scope.                                                                                                      |
| Internal tool parity       | Partial         | Replace Phantom marketplace expectations with governed internal tool bundles, manifests, import/enable/disable lifecycle, approval state, and audit. No public marketplace required.                                                                                                         |
| Artifact intelligence      | Partial         | Uploaded attachments and explicit artifacts exist. Remaining gaps: automatic artifact extraction from selected tool events or structured outputs and searchable attachment contents for safe text-like files.                                                                                |

## Explicit Exclusions

- Telegram support.
- Public plugin marketplace.
- Magic-link auth unless the user base changes.
- Exact Phantom Web Chat 32-event wire protocol unless a compatibility consumer appears.
- Unrestricted self-mutation of prompts, tools, auth, channel policy, runtime config, or filesystem state.

## Priority Order

1. Managed memory parity: decay/reinforcement scoring and hybrid retrieval tuning.
2. Governed self-evolution.
3. Internal tool parity.
4. Artifact intelligence.
5. Newly discovered non-Telegram channel gaps.
