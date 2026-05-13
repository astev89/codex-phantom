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

| Area                       | Status          | Production-level parity target                                                                                                                                                                                                                                                                                   |
| -------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web Chat parity            | Mostly complete | Match user-visible Phantom chat capabilities without requiring exact 32-event wire protocol compatibility. Remaining gaps: service-worker push, offline cache only if needed, and any discovered product behavior not yet covered.                                                                               |
| Slack parity               | Mostly complete | App mentions, DMs, channel/group mentions, reactions, thread replies, progressive updates, status reactions, feedback buttons, and reaction feedback are implemented. Remaining gaps are polish-level unless a new Phantom Slack behavior is discovered.                                                         |
| Channel parity             | Partial         | Slack, Web Chat, signed webhook, and future discovered non-Telegram Phantom channels are in scope. Telegram is excluded.                                                                                                                                                                                         |
| Operator onboarding parity | Mostly complete | Bundled YAML role/operator config files, first-run readiness checks, startup YAML role-policy loading, and admin source/status visibility exist. Magic-link auth is not required for this internal project. Remaining gaps are polish-level unless new Phantom setup behavior is discovered.                     |
| Managed memory parity      | Mostly complete | Contradiction/supersession lifecycle links, restart-safe scheduled maintenance, deterministic summarization/promotion, bounded active-row pruning, decay/reinforcement scoring, and hybrid retrieval ranking are implemented. Remaining gaps are polish-level unless new Phantom memory behavior is discovered.  |
| Governed self-evolution    | Mostly complete | Durable proposal records, operator APIs, agent proposal tool, approval/rejection, high-risk confirmation, operator-settings apply, rollback metadata, mutation audit, and malformed/direct-apply rejection are implemented. Remaining gaps: safe mutation classes for prompts, memory policy, tools, and roles.  |
| Internal tool parity       | Mostly complete | Governed internal tool bundle manifests, import preview, approval, enable, disable, uninstall, lifecycle audit, recent failure visibility, and runtime permission boundaries are implemented. Remaining gaps are polish-level unless a new internal tool behavior is discovered. No public marketplace required. |
| Artifact intelligence      | Mostly complete | Uploaded attachments, searchable safe text attachment contents, explicit artifacts, and bounded automatic artifact extraction from selected tool events/final structured outputs exist. Remaining gaps are polish-level unless a new Phantom artifact behavior is discovered.                                    |

## Explicit Exclusions

- Telegram support.
- Public plugin marketplace.
- Magic-link auth unless the user base changes.
- Exact Phantom Web Chat 32-event wire protocol unless a compatibility consumer appears.
- Unrestricted self-mutation of prompts, tools, auth, channel policy, runtime config, or filesystem state.

## Priority Order

1. Newly discovered non-Telegram channel gaps.
