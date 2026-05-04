# Project Status

This is the living status ledger for `codex-phantom`. Update it at the end of each development wave, after tests pass and before handing off or opening a PR.

Last updated: 2026-05-04
Branch: `main`
Latest verified commit: `c091e77` on PR #2, merged to `main` as `c00da6a`

## Current State

`codex-phantom` is a Codex-first autonomous agent runtime with a working single-process Node service, SQLite persistence, resumable sessions, scoped subagents, MCP tool exposure, scheduling, operator APIs, a browser operator console, a Codex-native `/chat` product surface, and hybrid long-term memory with Qdrant-backed vector recall plus SQLite fallback.

The project is now past its first serious production-hardening pass. It is not yet equivalent to the original Phantom project, but the core runtime is materially safer to run: request sizes are bounded, secrets are rejected in production when defaults are used, outbound model calls have timeouts, scheduler jobs recover deterministically after restarts, MCP events are durably audited, external webhooks are signed, Slack sends retry transient failures, operator-console workflows have browser coverage, and the Docker image runs compiled JavaScript instead of stripped TypeScript.

## Just Completed

Docs runbook wave completed locally on 2026-05-01:

- Added a decision-ready plan for the Docker smoke documentation pass under `docs/superpowers/plans/`.
- Added `docs/deployment-smoke-runbook.md` with required environment, preflight checks, destructive-volume warnings, script order, expected pass evidence, ledger update notes, and failure handling.
- Refined the remaining P1 next task so it points operators at the runbook instead of repeating command details in the ledger.

Phantom parity review completed locally on 2026-05-01:

- Compared indexed `phantom` and `codex-phantom` surfaces with GitNexus plus local docs/source review.
- Updated `docs/phantom-parity.md` with the remaining parity queue.
- Marked Phantom's full browser chat product and Telegram support as accepted divergences for now.
- Kept the remaining queue focused on Docker proof, normalized inbound routing, Slack inbound events, Codex-useful transcript/artifact continuity, role/config/onboarding, plugin marketplace, and advanced memory behavior.

Inbound channel routing wave completed locally on 2026-05-01:

- Added a normalized inbound message envelope, SQLite inbound event audit store, and inbound router.
- Routed signed webhook requests through the inbound router while preserving synchronous webhook responses.
- Added Slack Events API ingestion with Slack signature validation, URL verification, event mapping, duplicate detection, ack-then-run execution, and one final thread reply.
- Added operator visibility through `/admin/channels/inbound`, `/admin/summary`, timeline, and channel exports.
- Kept Web Chat and Telegram out of scope; Slack progressive updates, status reactions, and richer feedback remain follow-up work.

Web chat product surface wave completed locally on 2026-05-01:

- Added authenticated `GET /chat` as a Codex-native browser chat surface separate from the operator console.
- Added versioned named SSE envelopes for `POST /chat/message` while preserving raw agent event compatibility.
- Added `GET /chat/sessions` and `GET /chat/sessions/:sessionId` for session management, run transcripts, and attachment metadata.
- Added SQLite-backed chat attachment metadata and additive session title fields.
- Added browser-local multi-tab refresh, markdown rendering, notification permission affordance, file metadata capture, and automatic first-message session titles.
- Addressed PR #2 review and CI follow-up by hardening chat HTML/script escaping, preserving fenced code blocks in markdown rendering, stabilizing attachment ordering, filtering session run detail to persisted run graph IDs, and draining oversized request bodies before returning `413`.
- Kept binary upload storage, service-worker push delivery, and Phantom's full 32-event chat protocol as follow-up work.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/server.test.ts
npm run typecheck
npm test
npm run build
gh pr checks 2 --watch
```

Production agenda wave completed locally on 2026-05-01:

- Added expanded deployment smoke coverage for MCP listing, MCP audit, Prometheus metrics, scheduler routes, unauthenticated admin rejection, MCP rate limiting, restart persistence, and required Compose secrets.
- Added deterministic backup/restore smoke scripts that seed SQLite operator state, archive the `codex-phantom-data` volume, recreate it, restore the archive, and verify restored state through HTTP APIs.
- Added `docs/configuration.md` as the runtime environment variable inventory and test coverage that keeps it aligned with `src/config.ts` and `.env.example`.
- Added GitHub Actions CI for Node 24 install, typecheck, tests, production build, and a dependent Docker image build.
- Added Playwright operator-console coverage using local Chrome for auth, settings, dynamic tool approval, MCP audit visibility, and scheduler jobs.
- Added stable console `data-testid` hooks and an MCP audit console panel.
- Replaced plain webhook secret validation with timestamped HMAC signatures and documented the inbound webhook contract.
- Added Slack retry handling for transient `429` and `5xx` responses, delivery `attemptCount`, and recent failed deliveries in channel summaries.
- Fixed far-future scheduler timers so long-delay jobs re-arm instead of overflowing Node's timer limit.
- Classified Phantom parity deferrals as accepted divergences versus not-yet-implemented work, and documented Prometheus/Grafana as the durable metrics path for this wave.

Verification from this wave:

```bash
npm run typecheck
node --experimental-strip-types --test tests/scheduler.test.ts tests/config.test.ts tests/deployment.test.ts tests/server.test.ts
npm test
npm run build
npm run test:e2e
```

Notes:

- `npm run test:e2e` passed using the local Chrome channel. A bundled Chromium install attempt hung and was stopped.
- `scripts/deployment-smoke.sh` and `scripts/backup-restore-smoke.sh` were added and covered by static tests, but not executed in this run because they boot Docker Compose and the backup/restore script recreates the `codex-phantom-data` Docker volume.

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

### P1: Execute Docker Production Smoke Scripts

The deployment and backup/restore smoke scripts now exist, but this local implementation run did not execute them because the restore script recreates the `codex-phantom-data` Docker volume. Use `docs/deployment-smoke-runbook.md` to run and record the validation safely.

Suggested work:

- Run the preflight, deployment smoke, and backup/restore smoke from the runbook.
- If both scripts pass, update this ledger with the evidence listed in the runbook.

### P1: Expand Slack Inbound Progress

Use `docs/phantom-parity.md` as the source of truth for what remains. The inbound router now exists; the next Slack parity slice should make inbound Slack runs easier to follow while they are executing. Full Phantom browser chat and Telegram support are not current targets.

Implementation plan: `docs/superpowers/plans/2026-05-01-slack-inbound-parity.md`.

Suggested work:

- Add progressive Slack thread updates during coordinator execution.
- Add status reactions for queued, running, completed, and failed states.
- Map useful Slack reaction/button feedback into durable inbound event metadata or a follow-up feedback store.
- Keep UI scope limited to operator visibility unless a Codex-native chat surface becomes a product requirement.

### P2: Deepen Web Chat Continuity

The first `/chat` product surface now exists. The next web-chat slice should avoid re-cloning Phantom wholesale and instead add continuity where Codex operations need it.

Suggested work:

- Add durable binary attachment storage with size limits and operator export coverage.
- Add artifact views linked to run outputs and tool results.
- Decide whether Phantom's full 32-event browser wire protocol is worth matching or whether the current versioned Codex envelope should remain the stable contract.
- Add service-worker-backed push notifications only after there is a concrete notification source beyond browser permission state.

## Known Constraints

- Full Phantom-style self-evolution remains intentionally disabled.
- Dynamic shell/script MCP tools remain constrained to template-style dynamic tools.
- Docker socket mounting is not part of the default deployment path.
- Metrics reset on process restart unless scraped externally.
- Multi-channel inbound chat parity is intentionally narrowed to webhook and Slack for now.
- Phantom's full browser chat internals are not a clone target; `codex-phantom` has a narrower Codex-native `/chat` surface.
- Telegram support is not a parity target.

## Update Protocol

After each development wave:

1. Update `Last updated`, branch, and latest verified commit.
2. Move completed items from `Next Tasks` into `Just Completed`.
3. Add exact verification commands that passed.
4. Add new blockers or risks under `Next Tasks`, ordered by production impact.
5. Update `docs/phantom-parity.md` when the wave changes Phantom match/defer status.
6. Keep this document concise; link to detailed plans under `docs/superpowers/plans/` instead of duplicating implementation detail.
