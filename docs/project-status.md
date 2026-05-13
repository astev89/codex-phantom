# Project Status

This is the living status ledger for `codex-phantom`. Update it at the end of each development wave, after tests pass and before handing off or opening a PR.

Last updated: 2026-05-13
Branch: `jarvis/transcript-artifact-continuity`
Latest verified commit: `61942bf4c9f093e74d7448aa42956586ec9568ba`

## Current State

`codex-phantom` is a Codex-first autonomous agent runtime with a working single-process Node service, SQLite persistence, resumable sessions, scoped subagents, MCP tool exposure, scheduling, operator APIs, a browser operator console, a Codex-native `/chat` product surface with durable/searchable attachment continuity, explicit artifacts, and bounded automatic artifact extraction, hybrid long-term memory with Qdrant-backed vector recall, SQLite fallback, lifecycle controls, restart-safe maintenance, decay/reinforcement-aware ranking, governed self-evolution proposals with operator-approved apply/rollback for settings changes, and governed internal tool bundles with preview, approval, enable, disable, and uninstall lifecycle.

The project is now past its first serious production-hardening pass. It is not yet equivalent to the original Phantom project, but the core runtime is materially safer to run: request sizes are bounded, secrets are rejected in production when defaults are used, outbound model calls have timeouts, scheduler jobs recover deterministically after restarts, MCP events are durably audited, external webhooks are signed, Slack sends retry transient failures, operator-console workflows have browser coverage, and the Docker image runs compiled JavaScript instead of stripped TypeScript.

## Just Completed

Phantom non-Telegram channel recompare completed locally on 2026-05-13:

- Recompared Phantom channel source/docs through GitNexus and source search.
- Confirmed built-in Phantom channels: Slack, Web Chat, Webhook, Telegram, and Email.
- Preserved Telegram as explicitly excluded.
- Classified Phantom Email as the remaining non-Telegram channel parity gap and opened [#21](https://github.com/astev89/codex-phantom/issues/21).
- Treated Discord as a README self-extension story, not a shipped built-in channel requiring an ADR carve-out.

Verification from this wave:

```bash
rg -n "telegram|slack|webhook|web chat|/chat|channel|notification|push|gmail|email|discord|whatsapp|sms|twilio" /Users/aaronstevens/dev/phantom/src /Users/aaronstevens/dev/phantom/docs /Users/aaronstevens/dev/phantom -g"*.ts" -g"*.tsx" -g"*.md"
GitNexus query(repo="phantom", query="channel integrations Slack Telegram web chat webhook inbound outbound events notifications")
GitNexus query(repo="codex-phantom", query="channel integrations Slack web chat webhook inbound outbound events notifications")
```

Searchable safe text attachment wave completed locally on 2026-05-13:

- Added bounded safe text indexing for uploaded chat attachments.
- Added authenticated `/chat/attachments/search?q=...` with session/run context, excerpts, and download links.
- Recorded skipped index reasons for unsafe binary attachments while preserving downloads.
- Surfaced attachment text index status in chat session detail and chat exports.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Automatic artifact extraction wave completed locally on 2026-05-13:

- Added extraction for explicit `artifact` / `artifacts` JSON envelopes from successful tool output events and final structured output text.
- Persisted extracted artifacts through the existing chat artifact/blob system with source session, run, tool, and tool-call metadata.
- Bounded automatic extraction to five artifacts per run, 1 MB per artifact, and safe text-like or JSON content types.
- Preserved explicit artifact APIs and session detail visibility.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/artifact-extraction.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Internal tool bundle lifecycle wave completed locally on 2026-05-13:

- Added approval, enable, disable, and uninstall lifecycle transitions for valid internal tool bundle imports.
- Added durable lifecycle audit records and recent failure visibility.
- Enabled bundles materialize read-only tools through the existing approved dynamic-tool path so runtime execution still respects tool scopes and permission policy.
- Disabled bundles unregister runtime tools and remove their dynamic tool rows while preserving bundle records; uninstalled bundles perform the same cleanup and mark the import uninstalled.
- Kept public marketplace behavior and installation execution out of scope.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/tool-bundles.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Internal tool bundle manifest wave completed locally on 2026-05-13:

- Added durable `tool_bundle_imports` records for valid and invalid internal bundle previews.
- Added manifest validation for bundle metadata, tool metadata, read-only scopes, duplicate ids, and bounded tool counts.
- Added operator-only preview/list APIs under `/admin/tools/bundles`.
- Surfaced bundle import summaries through governance, summary, timeline, and export views.
- Kept previews non-activating: no tools are registered and installation requirements are recorded only.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/tool-bundles.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Governed self-evolution apply/rollback wave completed locally on 2026-05-13:

- Added review states for governed self-evolution proposals: approved, rejected, applied, failed, and rolled back.
- Added durable mutation records with before/after/rollback metadata and operator attribution.
- Added operator-only approve, reject, apply, and rollback endpoints.
- Implemented the first safe apply class: `configuration` proposals that update operator settings.
- Required explicit `confirmHighRisk: true` before high- or critical-risk approved proposals can apply.
- Kept prompt, memory policy, tool, role, auth, filesystem, and runtime policy mutation out of the apply path until each has a safe mutation class.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/self-evolution.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Governed self-evolution proposal wave completed locally on 2026-05-13:

- Added durable `self_evolution_proposals` records for prompts, memory policy, tools, roles, and configuration.
- Added operator APIs for proposal creation/listing and surfaced proposal summaries in admin summary, timeline, and governance export.
- Added the `self_evolution.propose` in-process tool so agents can create auditable proposals without applying mutations.
- Rejected malformed proposals and direct-apply requests such as `applyNow: true` and `mutationMode: "direct"`.
- Documented the proposal-only contract in `docs/self-evolution.md` and `docs/superpowers/plans/2026-05-13-governed-self-evolution-proposals.md`.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/self-evolution.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Managed memory retrieval tuning wave completed locally on 2026-05-13:

- Added durable memory reinforcement events and bounded `reinforcement_score` / `decay_score` fields.
- Tuned retrieval ranking to combine lifecycle filtering, semantic/vector score, keyword matches, importance, category, summaries, recency, reinforcement, access count, and bounded age decay.
- Persisted retrieval reinforcement and query-time decay for operator visibility.
- Kept superseded and contradicted memories excluded before any ranking signal is applied.
- Documented scoring behavior in `docs/memory.md`.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/memory.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Managed memory maintenance wave completed locally on 2026-05-13:

- Added a persisted memory-maintenance scheduler with startup recovery for interrupted runs.
- Added deterministic maintenance that summarizes raw episodic clusters, treats the summary as the promoted durable memory, and prunes active memory rows within bounded caps.
- Kept superseded and contradicted audit rows out of active pruning so lifecycle evidence remains inspectable.
- Exposed maintenance runs through `/admin/memory/maintenance`, manual trigger through `/admin/memory/maintenance/run`, timeline/export surfaces, and `docs/memory.md`.
- Covered scheduled outcomes, persistence, bounded pruning, failure recovery, and admin route visibility in tests.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/memory-maintenance.test.ts tests/memory.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Managed memory lifecycle wave completed locally on 2026-05-13:

- Added durable memory lifecycle links for supersession and contradiction relationships.
- Marked superseded and contradicted memories on the target memory rows while preserving the correcting memory as active.
- Excluded superseded and contradicted rows from retrieval and duplicate checks so stale memory does not re-enter prompts.
- Exposed lifecycle state and relationship detail through memory list/detail surfaces for operator auditability.
- Covered persistence across a store reload, link reasons, lifecycle state, and retrieval exclusion in `tests/memory.test.ts`.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/memory.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Operator YAML policy loading wave completed locally on 2026-05-13:

- Promoted `yaml` to a runtime dependency for production-safe config parsing.
- Added startup loading and validation for `ROLE_CONFIG_PATH`.
- Routed validated YAML role baselines into subagent policy narrowing while preserving compiled fallback baselines for tests/internal construction.
- Exposed active role-policy source and validation status through `/admin/summary` and `/admin/diagnostics`.
- Kept risky unknown roles rejected so future governed self-evolution proposals cannot silently expand runtime authority.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/orchestration.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Review fix wave completed locally on 2026-05-13:

- Copied bundled `config/` files into the production Docker image.
- Changed readiness from readable-file checks to YAML validation and operator-configured required channel checks.
- Preserved inbound thread context when Slack reaction feedback is mapped from a known response/progress message.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/readiness.test.ts tests/deployment.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Operator first-run readiness wave completed locally on 2026-05-13:

- Added bundled `config/roles.yaml` and `config/operator.yaml` first-run setup inventories.
- Added `ROLE_CONFIG_PATH` and `OPERATOR_CONFIG_PATH` runtime configuration with docs and `.env.example` entries.
- Added setup readiness checks for non-default secrets, storage, valid role/config YAML files, operator-configured required channels, OpenAI model access, and memory backend status.
- Exposed readiness through authenticated `GET /admin/readiness`, `/admin/summary`, detailed `/health`, and the operator console.
- Documented how setup readiness differs from generic process health.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/readiness.test.ts tests/config.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Slack feedback wave completed locally on 2026-05-13:

- Added signed Slack interaction handling for final-reply feedback buttons.
- Added durable Slack feedback records with inbound event, run, channel, user, message/thread, provider event, and raw payload context.
- Mapped selected Slack reactions on known response/progress messages into feedback records without stealing unrelated reaction-triggered runs.
- Added operator visibility through `/admin/channels/feedback`, `/admin/summary`, channel exports, and timeline exports.
- Kept duplicate Slack feedback events idempotent and invalid Slack signatures rejected before parsing.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/channels-inbound.test.ts
node --experimental-strip-types --test tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Slack progress/status wave completed locally on 2026-05-13:

- Expanded Slack transport support beyond `chat.postMessage` to include `chat.update`, `reactions.add`, `reactions.remove`, and Block Kit-ready message payloads.
- Added durable inbound progress records for queued, running, completed, and failed Slack run states.
- Added progressive Slack thread updates and status reactions for acked inbound Slack runs.
- Preserved triggering Slack message timestamps separately from response thread timestamps so reactions attach to the right message while replies stay in the right thread.
- Kept Slack progress/reaction failures best-effort and operator-visible through delivery/progress records without corrupting inbound completion state.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/channels-inbound.test.ts
node --experimental-strip-types --test tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Production proof wave completed locally on 2026-05-13:

- Confirmed `codex-phantom-data` was disposable before backup/restore validation.
- Recorded preflight state: branch `jarvis/transcript-artifact-continuity`, base commit `2dd4086`, Docker volumes `codex-phantom-data` and `codex-phantom-qdrant-data` present.
- Ran deployment smoke with required production-like environment names set and values redacted: `APP_ENV`, `OPERATOR_BEARER_TOKEN`, `MCP_BEARER_TOKEN`, `EXTERNAL_CHANNEL_SECRET`, and `OPENAI_API_KEY`.
- Fixed the production Docker runtime install so dev-only `prepare` scripts do not run when installing production dependencies.
- Ran backup/restore smoke against disposable `codex-phantom-data`; the script seeded deterministic SQLite state, archived the volume, removed and recreated it, restored the archive, restarted Compose, and verified state through HTTP APIs.
- Recorded post-smoke state: `codex-phantom-codex-phantom-1` healthy on `3210`, `codex-phantom-qdrant-1` running on `6333`, and both named volumes present.

Verification from this wave:

```bash
APP_ENV=production OPERATOR_BEARER_TOKEN=<redacted> MCP_BEARER_TOKEN=<redacted> EXTERNAL_CHANNEL_SECRET=<redacted> OPENAI_API_KEY=<redacted> scripts/deployment-smoke.sh
APP_ENV=production OPERATOR_BEARER_TOKEN=<redacted> MCP_BEARER_TOKEN=<redacted> EXTERNAL_CHANNEL_SECRET=<redacted> OPENAI_API_KEY=<redacted> scripts/backup-restore-smoke.sh
node --experimental-strip-types --test tests/deployment.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Transcript and artifact continuity wave completed locally on 2026-05-04:

- Added file-backed chat blob storage under `CODEX_PHANTOM_DATA_DIR/chat-blobs/`.
- Extended chat attachments from metadata-only rows to optional durable uploads with SHA-256, download URLs, and run linkage.
- Added explicit `text`, `json`, and `file` artifact records linked to sessions and optional runs.
- Added authenticated upload/download APIs for attachments and artifacts.
- Extended `GET /chat/sessions/:sessionId` and `scope=chat` operator exports with attachment/artifact summaries.
- Updated `/chat` to upload files for existing sessions and show attachment/artifact continuity links.
- Kept automatic artifact extraction, searchable attachment content, service-worker push, offline cache, and Phantom's full 32-event protocol deferred.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

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

Use `docs/phantom-parity.md` as the canonical production-level parity roadmap. Keep this section limited to immediate handoff notes and proof gaps.

### P1: Email Channel Parity

Suggested work:

- Add a production-safe Email channel modeled on Phantom's built-in channel.
- Support IMAP/SMTP configuration, inbound thread routing, outbound replies, and attachment-aware metadata.
- Add auth/secret validation, bounded body and attachment handling, delivery audit, retries, operator visibility, and docs.
- Keep Discord out of scope unless it becomes a shipped Phantom channel rather than a self-extension story.

Tracking issue: [#21](https://github.com/astev89/codex-phantom/issues/21).

## Known Constraints

- Production-level parity means Phantom feature parity excluding Telegram, implemented as production-safe features.
- `docs/phantom-parity.md` owns the parity matrix, exclusions, and priority order.
- `CONTEXT.md` owns canonical project language.
- ADRs under `docs/adr/` own durable scope decisions.
- Metrics reset on process restart unless scraped externally.

## Update Protocol

After each development wave:

1. Update `Last updated`, branch, and latest verified commit.
2. Move completed items from `Next Tasks` into `Just Completed`.
3. Add exact verification commands that passed.
4. Add new blockers or risks under `Next Tasks`, ordered by production impact.
5. Update `docs/phantom-parity.md` when the wave changes parity matrix status or priority.
6. Keep this document concise; link to detailed plans under `docs/superpowers/plans/` instead of duplicating implementation detail.
