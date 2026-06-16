# Project Status

This is the living status ledger for `codex-phantom`. Update it at the end of each development wave, after tests pass and before handing off or opening a PR.

Last updated: 2026-06-16
Branch: `jarvis/autonomous-runtime-config-limits`
Latest verified implementation commit: `e40c01e feat(assignments): add runtime config limits mutation`

## Current State

`codex-phantom` is a Codex-first autonomous agent runtime with a working single-process Node service, SQLite persistence, durable autonomous assignment records with operator controls, retention-aware assignment events with bounded summary compaction, deterministic scheduler-backed wakeup planning, bounded planner-promoted child assignment execution, explicit channel/API assignment intake, assignment-scoped autonomous mutation ledger evidence with read-only MCP/operator/export visibility, assignment-authorized autonomous operator-settings, opt-in assignment-policy, opt-in runtime config-limit overlay, opt-in approved read-only tool-bundle, opt-in prompt runtime-guidance, opt-in memory-policy runtime-bound, opt-in role permission-policy, and opt-in project-file draft-record self-evolution execution with rollback, planner-driven autonomous mutation markers routed through the assignment mutation executor, resumable sessions, scoped subagents, MCP tool exposure, scheduling, operator APIs, a browser operator console, module-backed operator exports, a Codex-native `/chat` product surface with durable/searchable attachment continuity, explicit artifacts, and bounded automatic artifact extraction, hybrid long-term memory with Qdrant-backed vector recall, SQLite fallback, lifecycle controls, restart-safe maintenance, decay/reinforcement-aware ranking, governed self-evolution proposals with mutation module-backed operator-approved apply/rollback for settings changes, governed internal tool bundles with preview, approval, enable, disable, and uninstall lifecycle, and a disabled-by-default Email runtime channel with bounded IMAP polling and audited SMTP replies.

The project is now past its first serious production-hardening pass. It is not yet equivalent to the original Phantom project, but the core runtime is materially safer to run: request sizes are bounded, secrets are rejected in production when defaults are used, outbound model calls have timeouts, scheduler jobs recover deterministically after restarts, MCP events are durably audited, external webhooks are signed, Slack sends retry transient failures, operator-console workflows have browser coverage, and the Docker image runs compiled JavaScript instead of stripped TypeScript.

## Just Completed

Autonomous runtime config-limit mutation wave completed locally on 2026-06-16:

- Added a sparse durable `runtime_config_limits` overlay and a bounded `configuration.runtime_limits` autonomous mutation class for explicitly opted-in `evolve` assignments.
- Limited the mutation surface to numeric runtime bounds for run timeout, max tool calls, outbound OpenAI request timeout, email polling cadence, email poll batch size, and maximum email message bytes.
- Preserved startup/env-derived defaults until an explicit overlay is applied; partial mutations persist only requested fields and unchanged fields continue resolving from startup config.
- Enforced strict bounded apply validation, a minimum `medium` effective risk class, explicit policy allow-listing, and global stale-rollback protection.
- Excluded secrets, auth, model/base URLs, file paths, channel enablement, source/project-file writes, prompts, memory entries, roles, tool installs, and write-capable MCP behavior from this mutation class.
- Routed admin/internal apply, rollback, planner `ASSIGNMENT_MUTATION:` markers, ledger evidence, timelines, HTTP listings, MCP read-only guards, and operator export visibility through existing autonomous mutation surfaces.
- Captured rollback evidence with the prior effective values and prior overlay state, including deletion of the overlay row when no prior overlay existed.
- Added compatibility handling for transient earlier full-row/legacy rollback evidence without loosening new apply bounds: ambiguous full-row overlays are dropped during migration, legacy value rollbacks are marked explicitly, and normal updates sanitize out-of-range legacy siblings before writing.
- Completed a GPT-5.4 xhigh reviewer loop. Important findings around startup clamping, risk understatement, sparse rollback/persistence, legacy compatibility, and legacy-state rollback replay were addressed; final follow-up reported no Critical or Important findings.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
node --experimental-strip-types --test tests/assignment-mutation-ledger.test.ts tests/self-evolution-mutations.test.ts tests/operator-export.test.ts tests/config.test.ts tests/adapter.test.ts tests/email-channel.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npm_config_cache=/tmp/codex-npm-cache-runtime-limits-final4 npx gitnexus detect-changes --scope staged --repo codex-phantom
GPT-5.4 xhigh reviewer: initial Important findings addressed; final follow-up clean
commit hook: prettier --ignore-unknown --write, npm run typecheck, npm test
```

Autonomous project-file draft-record mutation wave completed locally on 2026-06-16:

- Added durable `project_file_drafts` persistence and a bounded `project_file.draft` autonomous mutation class for explicitly opted-in `evolve` assignments.
- Kept this slice draft-row-only: mutations create auditable assignment-owned draft records and do not write repository files, patches, staged changes, commits, installs, or MCP write tools.
- Rejected unsafe draft input, including absolute paths, Windows drive paths, backslashes, control characters, parent traversal, hidden path segments, protected generated paths, unsafe content types, empty content, and content over 200 KB.
- Routed admin/internal apply, rollback, and planner `ASSIGNMENT_MUTATION:` markers through the autonomous mutation executor with before, after, rollback, affected-resource, verification, and assignment timeline evidence.
- Implemented rollback by marking draft rows `rolled_back` while preserving content and audit metadata, with stale rollback protection when a newer assignment draft exists for the same path.
- Preserved the default `evolve` policy as `configuration.operator_settings` only; `project_file.draft` must be explicitly allow-listed, proposal-based self-evolution remains unchanged, and MCP assignment tooling stays read-only.
- Completed a GPT-5.4 xhigh reviewer loop. The reviewer reported no Critical or Important findings; minor path-validation and coverage polish was addressed before commit.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
node --experimental-strip-types --test tests/assignment-mutation-ledger.test.ts tests/self-evolution-mutations.test.ts tests/operator-export.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
GPT-5.4 xhigh reviewer: no Critical or Important findings; Minor path-validation and coverage polish addressed
commit hook: prettier --ignore-unknown --write, npm run typecheck, npm test
```

Autonomous role permission-policy mutation wave completed locally on 2026-06-16:

- Added a durable `role_policy_overrides` overlay and bounded `role.permission_policy` autonomous mutation class for explicitly opted-in `evolve` assignments.
- Wired new subagent spawns through `OrchestrationService` to read the runtime role-policy overlay live while keeping startup role baselines as the authority envelope.
- Restricted mutations to narrowing known subagent roles relative to the loaded startup role policy; rejected `full_access`, unknown roles, new tool IDs, new MCP servers, and broader scoped-write file globs.
- Routed admin/internal apply, rollback, and planner `ASSIGNMENT_MUTATION:` markers through the autonomous mutation executor with before, after, rollback, affected-resource, verification, and assignment timeline evidence.
- Preserved the default `evolve` policy as `configuration.operator_settings` only; `role.permission_policy` must be explicitly allow-listed and cannot edit role YAML, source files, prompts, memory, auth, channel policy, tool installs, or MCP write capability.
- Protected shared role-policy rollback with global stale-rollback checks across assignments and kept MCP assignment tooling read-only.
- Completed a GPT-5.4 xhigh reviewer loop. The reviewer reported no Critical or Important findings; minor feedback for read-only glob documentation and direct read-only-to-scoped-write coverage was addressed before commit.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/orchestration.test.ts tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
node --experimental-strip-types --test tests/assignment-mutation-ledger.test.ts tests/self-evolution-mutations.test.ts tests/operator-export.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
GPT-5.4 xhigh reviewer: no Critical or Important findings; Minor coverage/comment polish addressed
commit hook: prettier --ignore-unknown --write, npm run typecheck, npm test
```

Autonomous memory-policy runtime-bounds mutation wave completed locally on 2026-06-16:

- Added a durable `memory_policy_settings` overlay and bounded `memory_policy.runtime_bounds` autonomous mutation class for explicitly opted-in `evolve` assignments.
- Wired `MemoryStore` query, consolidation, and maintenance paths to use the runtime overlay for top-K retrieval, summary and per-category limits, summary trigger and cluster sizing, and semantic, procedural, and episodic prune limits.
- Routed admin/internal apply, rollback, and planner `ASSIGNMENT_MUTATION:` markers through the autonomous mutation executor with before, after, rollback, affected-resource, verification, and assignment timeline evidence.
- Preserved the default `evolve` policy as `configuration.operator_settings` only; `memory_policy.runtime_bounds` must be explicitly allow-listed and cannot edit memory entries, embeddings, vector stores, prompts, roles, files, or MCP write tools.
- Hardened runtime policy handling with bounded config-derived defaults, invalid persisted-row repair before use, strict mutation validation, and global stale-rollback protection.
- Completed a GPT-5.4 xhigh reviewer loop. The first pass found Important issues for fallback top-K enforcement, config default clamping, and persisted-row repair; all were addressed, and follow-up review reported no remaining Critical or Important findings.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/memory.test.ts tests/memory-maintenance.test.ts tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
node --experimental-strip-types --test tests/assignment-mutation-ledger.test.ts tests/self-evolution-mutations.test.ts tests/operator-export.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
GPT-5.4 xhigh reviewer: initial Important findings addressed; follow-up clean
```

Autonomous prompt runtime-guidance mutation wave completed locally on 2026-06-16:

- Added a persisted `prompt_runtime_guidance` overlay that is appended to assembled runtime system prompts only when non-empty.
- Added `prompt.runtime_guidance` as an explicit-policy autonomous mutation class for `evolve` assignments, with before/after/rollback evidence in the autonomous mutation ledger.
- Kept the default `evolve` policy unchanged: prompt runtime-guidance mutation remains opt-in, proposal-based prompt changes remain proposal-only, and MCP assignment mutation tooling remains read-only.
- Wired admin/internal apply and rollback plus planner `ASSIGNMENT_MUTATION:` markers through the existing autonomous mutation executor.
- Protected the shared prompt overlay from stale rollback across assignments by giving global mutation resources global newer-applied rollback conflict checks.
- Added regression coverage for opt-in apply, malformed guidance rejection, rollback to the default empty overlay, cross-assignment stale rollback blocking, planner-driven prompt mutation, HTTP apply/list/timeline/rollback visibility, runtime prompt assembly, and MCP read-only guards.
- Completed a GPT-5.4 xhigh reviewer loop. The first pass found one Important global-resource rollback finding and one Minor blank-overlay test gap; both were addressed, and follow-up review reported no remaining Critical or Important findings.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/orchestration.test.ts tests/server.test.ts tests/mcp.test.ts tests/self-evolution-mutations.test.ts tests/operator-export.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
GPT-5.4 xhigh reviewer: initial Important addressed; follow-up clean
commit hook: prettier --ignore-unknown --write, npm run typecheck, npm test
```

Autonomous tool-bundle mutation wave completed locally on 2026-06-16:

- Added `tool.bundle_enable` as an explicit-policy autonomous mutation class for `evolve` assignments, limited to already-approved valid read-only tool bundle imports.
- Extracted shared tool bundle lifecycle orchestration so existing HTTP bundle enable/disable/uninstall paths and autonomous mutation execution use the same lifecycle rules.
- Wired the runtime `AssignmentWakeupPlanner` executor through `src/index.ts` so planner `ASSIGNMENT_MUTATION:` markers can apply explicitly allowed tool-bundle mutations without a separate write path.
- Recorded autonomous ledger before/after/rollback evidence, affected bundle/tool resources, timeline milestones, and rollback by disabling the same bundle and unregistering its tools.
- Kept default `evolve` policy unchanged: `tool.bundle_enable` remains opt-in and MCP assignment mutation tooling remains read-only.
- Hardened reviewer findings by blocking bundled tool-id collisions before registration, preserving existing dynamic tools, preserving operator approval provenance during autonomous/planner activation, and writing tool governance audit rows for bundle-activated dynamic tools.
- Completed a GPT-5.4 xhigh reviewer loop. The first pass found one Critical collision/provenance issue and one Important governance-provenance issue; follow-up review confirmed both were resolved with no remaining Critical or Important findings.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/tool-bundles.test.ts
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
node --experimental-strip-types --test tests/assignment-wakeup-planner.test.ts tests/assignment-autonomous-mutations.test.ts tests/server.test.ts tests/mcp.test.ts tests/tool-bundles.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
GPT-5.4 xhigh reviewer: initial Critical/Important addressed; follow-up clean
```

Assignment event retention compaction wave completed locally on 2026-06-16:

- Added `AutonomousAssignmentService.compactEvents()` to replace expired compactable assignment detail events with one non-compactable `events_compacted` milestone summary.
- Preserved audit and milestone rows by selecting and deleting only `compactable = 1` rows with expired `expires_at` values, with the summary insert and detail deletion in one transaction.
- Added operator-authenticated `POST /admin/assignments/:id/timeline/compact` with validated `compactBefore` and `limit` inputs and a refreshed timeline response.
- Kept MCP assignment tooling read-only while ensuring `assignment.timeline` can read retention compaction summaries.
- Updated the parity/context docs to mark bounded assignment event retention compaction as implemented.
- Completed the tmux/Claude Code reviewer loop with no Critical or Important findings; report: `/private/tmp/codex-phantom-retention-review.md`.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/assignments.test.ts
node --experimental-strip-types --test tests/server.test.ts
node --experimental-strip-types --test tests/mcp.test.ts
node --experimental-strip-types --test tests/assignments.test.ts tests/server.test.ts tests/mcp.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
tmux reviewer loop: /private/tmp/codex-phantom-retention-review.md
```

Child assignment execution wave completed locally on 2026-06-16:

- Added assignment policy child-execution bounds with default depth/fan-out limits and fail-closed normalization for legacy or corrupt stored policy rows.
- Added `AutonomousAssignmentService.promoteChild()` plus create-with-parent delegation, parent and child timeline evidence, authority capping, active-child budget reservation, and waited-child wakeup parking.
- Added planner `ASSIGNMENT_CHILD:` markers for execute-or-higher assignments when child policy permits, with malformed/rejected marker safety and durable `child_assignment_failed` evidence.
- Scheduled child wakeups due-now and real parent follow-up jobs when `waitForChild` is requested, while preventing the parent from consuming wakeups until waited-on children complete.
- Kept proposal-based self-evolution and read-only MCP mutation tooling unchanged while extending assignment-policy mutation compatibility and API/MCP response shapes for `childAssignments`.
- Cleared the GPT-5.4 xhigh reviewer loop after fixing child authority widening, spare-budget `waitForChild` parking, and child policy delay/notification relaxation findings.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/assignments.test.ts tests/assignment-wakeup-planner.test.ts tests/assignment-autonomous-mutations.test.ts tests/server.test.ts tests/mcp.test.ts
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/assignment-mutation-ledger.test.ts tests/self-evolution-mutations.test.ts tests/server.test.ts tests/operator-export.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
```

Planner-driven autonomous mutation marker wave completed locally on 2026-06-16:

- Added a bounded `ASSIGNMENT_MUTATION:` wakeup marker parser so a coordinator wakeup can request one autonomous mutation decision in its normal text output.
- Routed planner-requested mutations through `AutonomousMutationExecutor` with the current `assignmentId`, current wakeup `runId`, and `actor: "planner"` instead of adding direct planner write paths.
- Covered default `configuration.operator_settings` apply, explicitly allow-listed `configuration.assignment_policy` apply, policy-denied mutation evidence, and malformed marker ignore behavior.
- Gated planner mutation marker instructions to mutation-authorized `evolve` assignments so default `execute` assignments are not invited into unaudited self-mutation attempts.
- Refreshed assignment policy after planner-applied policy mutations so same-wakeup continuation and expiry decisions use the updated policy.
- Preserved existing status and next-wakeup handling when a mutation is denied, and kept MCP mutation tooling read-only.
- Updated self-evolution docs to distinguish proposal apply, admin/internal assignment apply, and planner marker apply.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/assignment-wakeup-planner.test.ts tests/assignment-autonomous-mutations.test.ts
npm run typecheck
npm test
npm run build
git diff --check
node .gitnexus/run.cjs detect-changes --scope staged --repo codex-phantom
```

Autonomous assignment-policy mutation wave completed locally on 2026-06-16:

- Added `configuration.assignment_policy` as the first non-settings autonomous mutation adapter, available only when an `evolve` assignment explicitly allow-lists the class.
- Applied and rolled back assignment policy changes through `AutonomousAssignmentService.control({ action: "change_policy" })` so existing policy validation owns execution bounds.
- Blocked `assignmentPolicy.selfEvolution` changes during autonomous apply so assignments cannot widen their own mutation authority.
- Added service and HTTP coverage for opt-in apply/rollback, default-policy denial, malformed policy failures, rollback evidence, timeline milestones, and unchanged operator-settings behavior.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
node .gitnexus/run.cjs detect-changes --scope staged --repo codex-phantom
```

Autonomous mutation adapter registry wave completed locally on 2026-06-16:

- Refactored assignment-authorized autonomous mutation execution behind a small adapter registry while keeping `configuration.operator_settings` as the only built-in production adapter.
- Preserved the existing operator-settings apply and rollback behavior, policy checks, failed ledger evidence, and HTTP surface while making future mutation classes plug into the same evidence path.
- Added regression coverage for injected adapter apply/rollback, duplicate adapter rejection, rollback failure when the matching adapter is unavailable, and `mutationClass` audit evidence on applied and policy-denied mutations.
- Kept planner-driven mutation decisions, MCP write capability, and new production mutation classes out of this slice.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/assignment-mutation-ledger.test.ts tests/server.test.ts tests/self-evolution-mutations.test.ts
npm run typecheck
npm test
npm run build
git diff --check
node .gitnexus/run.cjs detect-changes --scope staged --repo codex-phantom
```

Delegated autonomous self-evolution execution wave completed locally on 2026-06-12:

- Added assignment-authorized autonomous mutation execution for `evolve` assignments, limited to `configuration.operator_settings` under assignment self-evolution policy.
- Added default assignment self-evolution policy allowing low/medium `configuration.operator_settings` only, with failed ledger evidence for unsupported, policy-blocked, and malformed attempts.
- Added operator-authenticated apply and rollback routes, settings rollback evidence, actor-aware assignment mutation milestones, and visibility through the existing mutation, timeline, and export surfaces.
- Preserved proposal-based self-evolution apply/rollback as a separate governed path and kept MCP assignment mutation tooling read-only.
- Hardened rollback integrity so older settings mutations cannot roll back over newer applied settings mutations, including same-millisecond ledger ordering edge cases.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/assignment-mutation-ledger.test.ts tests/assignments.test.ts tests/server.test.ts tests/mcp.test.ts tests/operator-export.test.ts tests/self-evolution.test.ts tests/self-evolution-mutations.test.ts
npm run typecheck
npm test
npm run build
git diff --check
node .gitnexus/run.cjs detect-changes --scope staged --repo codex-phantom
```

Autonomous mutation ledger wave completed locally on 2026-06-12:

- Added a deep autonomous mutation ledger Module for assignment-scoped planned, applied, failed, rolled-back, and operator-notified mutation evidence without executing autonomous mutations.
- Added SQLite persistence for `assignment_mutations` with `asgnmut` ids, bounded read filters, rollback evidence requirements for applied records, and non-compactable assignment timeline milestone links.
- Added operator-authenticated mutation read routes, global timeline/export visibility, and read-only MCP access through `assignment.mutations`.
- Kept proposal-based self-evolution mutation behavior separate and unchanged while creating the audit surface needed for future delegated autonomous mutation adapters.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/assignment-mutation-ledger.test.ts tests/assignments.test.ts tests/server.test.ts tests/mcp.test.ts tests/operator-export.test.ts tests/self-evolution.test.ts tests/self-evolution-mutations.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
```

Assignment channel intake wave completed locally on 2026-06-11:

- Added an assignment intake service that classifies explicit persistence intent, creates durable assignments from chat, webhook, Slack, and Email inputs, records source metadata, and schedules a due-now first wakeup through the assignment wakeup planner.
- Preserved existing one-shot behavior by default: ordinary chat, webhook, Slack, and Email messages still route through their previous coordinator paths unless structured assignment input or persistence language is present.
- Added visible assignment-created acknowledgements for chat SSE, signed webhook responses, and Slack threads, while keeping the full assignment notification lifecycle deferred.
- Wired Email polling to create assignments for persistent intake messages without fabricating SMTP completion replies in this slice.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/assignment-intake.test.ts tests/email-channel.test.ts tests/server.test.ts tests/assignment-wakeup-planner.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="staged")
```

Assignment wakeup planner wave completed locally on 2026-06-10:

- Added a deterministic assignment wakeup planner that runs one coordinator attempt per wakeup, links the run, records retention-aware wakeup events, applies `completed`, `blocked`, `expired`, `failed`, or `waiting` outcomes, and schedules bounded follow-up wakeups.
- Added assignment service wakeup lifecycle methods so the assignment Module remains the state owner for counters, lifecycle transitions, run links, and retention-aware events.
- Added scheduler custom job handlers so `assignment.wakeup` jobs run through the planner without changing the jobs schema, while preserving generic scheduler job behavior and `lastRunId` visibility.
- Changed `force_wakeup` assignment control from placeholder-only to a due-now scheduler job while preserving the existing admin route response shape.
- Hardened review findings by making wakeup run completion atomic, skipping overlapping in-process wakeups, deduplicating pending wakeup jobs per assignment, and returning an explicit warning when forced wakeup scheduling fails after control persistence.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/assignment-wakeup-planner.test.ts tests/assignments.test.ts tests/scheduler.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="staged")
```

Autonomous assignment core wave completed locally on 2026-06-02:

- Added a deep autonomous assignment Module with durable assignment state, policy defaults, lifecycle controls, retention-aware events, run links, and read models.
- Added SQLite assignment, assignment event, and assignment-run link tables using `asgn`, `asgnevt`, and `asgnrun` ids.
- Added operator-authenticated admin routes for assignment create, list, detail, control, and timeline without adding planner wakeups or Slack intake yet.
- Registered read-only MCP/in-process tools for `assignment.list`, `assignment.get`, and `assignment.timeline` with focused filters and actionable missing-id errors.
- Recorded ADR-0003 and glossary terms for delegated autonomous assignments, bounded autonomy, retention, and future self-evolution delegation.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/assignments.test.ts tests/server.test.ts tests/mcp.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="staged")
```

OpenAI model and reasoning config wave completed locally on 2026-05-29:

- Kept `OPENAI_MODEL` explicit across config, `.env.example`, and the Compose dev stack with a `gpt-5` default.
- Added `OPENAI_REASONING_EFFORT` for normal agent/coordinator Responses calls, defaulting to `medium`.
- Added `OPENAI_MEMORY_REASONING_EFFORT` for background memory insight extraction, defaulting to `low`.
- Validated reasoning effort values as `low`, `medium`, or `high`, and surfaced the configured model/reasoning values in startup diagnostics.
- Replaced hardcoded runtime reasoning values with the configured defaults while preserving existing behavior unless env overrides are supplied.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/config.test.ts tests/orchestration.test.ts tests/deployment.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
docker compose config --quiet
git diff --check
GitNexus detect_changes(scope="staged")
```

OpenAI tool-name adapter and Slack tunnel live-test wave completed locally on 2026-05-29:

- Sanitized OpenAI function tool names while preserving original runtime tool IDs for local tool execution.
- Added regression coverage proving dotted runtime IDs such as `memory.query` are sent to OpenAI as valid function names and restored before runtime tool dispatch.
- Verified a Cloudflare Quick Tunnel can expose the local Compose app to Slack Event Subscriptions.
- Proved signed Slack URL verification and a synthetic signed Slack `app_mention` event through the tunnel complete through the coordinator and post a Slack thread reply.
- Added a parameterized Slack tunnel smoke script so ephemeral Cloudflare Quick Tunnel URLs stay runtime input instead of repo constants.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/adapter.test.ts
npm run typecheck
npm test
npm run build
git diff --check
docker compose up -d --build codex-phantom
curl --max-time 8 -sS "$PUBLIC_TUNNEL_URL/health"
Signed Slack url_verification through /channels/slack/events
BASE_URL="$PUBLIC_TUNNEL_URL" SLACK_SMOKE_CHANNEL_ID="$SLACK_CHANNEL_ID" node scripts/slack-tunnel-smoke.mjs
GitNexus detect_changes(scope="staged")
```

Docker Compose local dev stack wave completed locally on 2026-05-29:

- Updated the existing Compose stack to default to a development runtime for local live testing.
- Made SQLite persistence explicit with `CODEX_PHANTOM_DATA_DIR=/app/data` and `CODEX_PHANTOM_DATABASE_PATH=/app/data/codex-phantom.sqlite` on the persistent `codex-phantom-data` volume.
- Kept Qdrant enabled by default in Compose with `QDRANT_URL=http://qdrant:6333` and persistent `codex-phantom-qdrant-data` storage.
- Added local-only fallback operator, MCP, and external webhook secrets so OpenAI/Slack-only `.env` files can boot the stack while production-like smoke runs can still override with explicit secrets and `APP_ENV=production`.
- Documented the local Compose defaults and the production-smoke override requirement.

Verification from this wave:

```bash
docker compose config --quiet
node --experimental-strip-types --test tests/deployment.test.ts tests/config.test.ts
npm run typecheck
npm run build
git diff --check
docker compose up -d --build
curl -sS http://127.0.0.1:3210/health
curl -sS -H 'Authorization: Bearer local-dev-operator-token' http://127.0.0.1:3210/admin/readiness
curl -sS http://127.0.0.1:6333/readyz
```

Operator export module wave completed locally on 2026-05-27:

- Expanded the operator export module from formatter-only into scope collection plus JSON/NDJSON formatting.
- Moved request, channel, governance, MCP, run, chat, and timeline export source collection out of HTTP while preserving existing limits and response shapes.
- Kept `/admin/export` as the authenticated HTTP adapter for query parsing, content type selection, and response writing.
- Added focused operator export service coverage for scope routing, source limits, governance kind tags, timeline fallback, and formatter envelopes.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/operator-export.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="staged")
```

Self-evolution mutation module wave completed locally on 2026-05-27:

- Extracted governed apply and rollback behavior into a self-evolution mutation service with target-specific adapters.
- Kept `SelfEvolutionProposalStore` focused on persistence while the mutation module owns risk confirmation, operator settings validation, before/after/rollback payloads, failure audit, and rollback effects.
- Refactored HTTP self-evolution apply and rollback routes back into adapter shape while preserving proposal, mutation, summary, timeline, and export visibility.
- Added focused mutation service coverage for successful apply, high-risk confirmation, failed apply audit, and rollback behavior.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/self-evolution-mutations.test.ts tests/self-evolution.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="staged")
```

Managed memory module split wave completed locally on 2026-05-27:

- Kept `MemoryStore` as the public facade while extracting shared memory row helpers, lifecycle behavior, and retrieval ranking into focused modules.
- Moved lifecycle links, active-only reinforcement, retrieval access effects, decay persistence, episodic compaction, and active-row pruning behind a memory lifecycle module.
- Moved active filtering, hybrid ranking, vector-score blending, decay calculation, and bounded context envelope shaping behind a memory retrieval policy.
- Added direct lifecycle and retrieval-policy coverage while preserving existing memory, maintenance, and server integration behavior.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/memory-lifecycle.test.ts tests/memory-retrieval-policy.test.ts tests/memory.test.ts tests/memory-maintenance.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="staged")
```

Chat artifact module wave completed locally on 2026-05-27:

- Introduced a chat artifact service that owns attachment upload, safe text indexing, artifact creation, automatic extraction persistence, search, session summaries, export collection, and download handles.
- Centralized artifact and attachment content policy for byte limits, safe text/JSON indexing and extraction, content-to-buffer conversion, generated filenames, and safe download names.
- Refactored HTTP routes back into adapter shape while preserving `/chat/attachments/:id`, `/chat/artifacts/:id`, session artifact summaries, SSE `run.completed.artifacts`, and chat export response shapes.
- Added focused service and policy coverage for upload/index/search/download behavior, manual artifacts, extracted artifacts, and no-op unsafe content outcomes.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/chat-artifacts.test.ts tests/artifact-extraction.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="staged")
```

Inbound response dispatcher wave completed locally on 2026-05-27:

- Introduced an inbound response dispatcher module that owns completed and failed inbound run side effects through target-specific Slack and Email adapters.
- Moved Slack progress/final replies and Email SMTP reply audit/retry behavior out of HTTP and Email polling loops while preserving public response shapes and delivery rows.
- Added focused dispatcher coverage for Slack progress/final delivery, skipped Slack delivery, Email threaded replies, retry/failure outcomes, and no-op targets.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/inbound-response-dispatcher.test.ts tests/email-channel.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="staged")
```

Runtime channel capability wave completed locally on 2026-05-27:

- Introduced a runtime channel capability module as the source of channel metadata, config requirements, readiness inputs, diagnostics inputs, and optional lifecycle hooks.
- Refactored channel seeding, secret presence checks, setup readiness, startup diagnostics, and admin channel toggles to consume channel capabilities instead of duplicating channel semantics.
- Preserved Email as disabled-by-default and all-or-nothing for IMAP plus SMTP, while moving Email poller start/stop behind the generic runtime lifecycle seam.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/channel-capabilities.test.ts tests/readiness.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```

Email parity wave completed locally on 2026-05-23:

- Closed the remaining non-Telegram built-in channel gap by shipping Email as a first-class runtime channel.
- Kept Email disabled by default and all-or-nothing when enabled: complete IMAP and SMTP config is required together.
- Landed bounded IMAP polling, durable inbound routing, threaded SMTP replies, metadata-first attachment handling, SMTP-native retry semantics, and operator visibility through existing channel/admin surfaces.
- Documented the bounded-polling ADR decision, mailbox/config requirements, inspection endpoints, and first-slice verification stance without requiring a real mailbox smoke blocker.

Verification from this wave:

```bash
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="staged")
```

Continuity test-hardening wave completed locally on 2026-05-13:

- Added restart-visible coverage proving disabled internal tool bundle tools stay absent from MCP `tools/list` after a simulated service restart.
- Added bounded attachment text-index coverage proving searchable safe-text uploads stop at the 200 KB index window.
- Confirmed out-of-window attachment content does not appear in `/chat/attachments/search` while indexed attachment metadata remains visible in chat session detail.

Verification from this wave:

```bash
node --experimental-strip-types --test tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="staged")
```

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

### P1: Autonomous Mutation Adapter Expansion And Durable Assignment Execution

Suggested work:

- Add additional mutation classes one at a time only after each has explicit assignment self-evolution policy, adapter-level rollback evidence, and service/HTTP safety coverage.
- Continue with remaining mutation classes, such as broader configuration, bounded runtime prompt rewriting, broader memory mutation, or deeper parent/child execution controls, only when each class has explicit assignment self-evolution policy and rollback evidence.
- Keep deeper parent/child dependency orchestration separate from mutation-adapter expansion so mutation authority does not expand by accident.

### P2: Channel And Parity Polish

Suggested work:

- Run an optional live mailbox smoke once provider credentials are available to validate real provider behavior on top of the fake transport test matrix.
- Tighten operator-facing polish only if real mailbox usage reveals gaps in diagnostics, summaries, or delivery visibility.
- Keep roadmap detail in `docs/phantom-parity.md`; do not reopen Email as a missing parity feature.

Tracking note: keep Telegram excluded and Discord out of scope unless Phantom ships it as a built-in channel.

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
