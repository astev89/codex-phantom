# Autonomous Runtime Config Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicitly opted-in `configuration.runtime_limits` autonomous mutation class for bounded runtime limit changes with durable rollback evidence.

**Architecture:** Introduce a small runtime config limits store that persists a safe sparse numeric overlay in SQLite and applies effective values to the shared `AppConfig` object. Register a new autonomous mutation adapter that validates `proposedChange.runtimeLimits`, records before/after/rollback evidence including the prior overlay state, and blocks stale rollback globally because the runtime limits are shared process-wide configuration. Keep this slice limited to already-runtime-read numeric fields: `defaultRunTimeoutMs`, `defaultMaxToolCalls`, `openAiRequestTimeoutMs`, `emailPollIntervalMs`, `emailPollBatchSize`, and `emailMaxMessageBytes`.

**Tech Stack:** TypeScript ESM, Node `node:test`, SQLite via `AppDatabase`, existing autonomous assignment mutation ledger, GitNexus CLI, tmux/Claude reviewer loop.

---

## Scope

In scope:

- `target: "configuration"`, `mutationType: "runtime_limits"`, mutation class `configuration.runtime_limits`.
- Explicit allow-list only; default `evolve` policy remains `configuration.operator_settings`.
- Strict bounded integer validation:
  - `defaultRunTimeoutMs`: 1,000..300,000
  - `defaultMaxToolCalls`: 1..50
  - `openAiRequestTimeoutMs`: 1,000..300,000
  - `emailPollIntervalMs`: 1,000..3,600,000
  - `emailPollBatchSize`: 1..100
  - `emailMaxMessageBytes`: 1,024..10,485,760
- Durable sparse overlay row with changed limit fields and `updatedBy`, `createdAt`, `updatedAt`; unchanged fields continue to resolve from startup/env config.
- Apply writes only explicit overlay fields and mutates the shared `AppConfig` object so existing runtime consumers that read config at call time see the effective values.
- Rollback restores the previous overlay state, including deleting the overlay row when no prior overlay existed, and records `rolled_back`.
- Global stale rollback protection.

Out of scope:

- Secrets, auth tokens, file paths, model names, base URLs, channel enablement, role config, operator settings, memory policy, prompt text, tool bundles, project files, installs, MCP write capability.
- Runtime fields captured by already-created transports or services, such as embedding timeout, Qdrant timeout, SMTP send timeout, and IMAP attachment max bytes.
- Proposal-based apply support for broader configuration.

## Files

- Create `src/config/runtime-limits.ts`: runtime limit types, defaults from `AppConfig`, strict patch validation, store, and helper to apply limits to `AppConfig`.
- Modify `src/platform/database.ts`: add `runtime_config_limits` table and index.
- Modify `src/assignments/autonomous-mutations.ts`: register `configuration.runtime_limits` adapter and unsupported-class message.
- Modify `src/index.ts`: instantiate `RuntimeConfigLimitsStore` before runtime/adapter/channel setup and pass it to the executor.
- Modify `src/server/http-server.ts`: accept or create `RuntimeConfigLimitsStore` and pass it to the executor.
- Modify `src/assignments/wakeup-planner.ts`: include a runtime-limits marker example for mutation-authorized assignments.
- Modify `tests/assignment-autonomous-mutations.test.ts`: service-level apply, opt-in denial, malformed input, rollback, and stale rollback coverage.
- Modify `tests/assignment-wakeup-planner.test.ts`: planner marker coverage.
- Modify `tests/server.test.ts`: authenticated HTTP apply/list/timeline/rollback visibility.
- Modify `tests/mcp.test.ts`: read-only guard does not expose runtime-limits write tools.
- Modify `docs/self-evolution.md`, `docs/phantom-parity.md`, and eventually `docs/project-status.md`.

## Required Skills

- `tdd`: use vertical red-green cycles; add one failing behavior test and only then implement the minimum code for it.
- `superpowers:executing-plans`: execute this plan task-by-task in the current branch.
- `tmux-workflows`: launch the reviewer loop in a plain tmux session.
- `gitnexus-impact-analysis`: run before editing existing symbols.
- `gitnexus-pr-review` or `gitnexus-debugging`: give the reviewer access for correctness, audit, rollback, and policy-bypass checks.
- `superpowers:requesting-code-review`: perform the reviewer loop before PR completion.
- `superpowers:verification-before-completion`: run verification before claiming completion, committing, or merging.

## GitNexus Impact Analysis

Before editing existing symbols, run impact analysis for:

```bash
npx gitnexus impact --repo codex-phantom AppDatabase
npx gitnexus impact --repo codex-phantom AutonomousMutationExecutor
npx gitnexus impact --repo codex-phantom HttpServer
npx gitnexus impact --repo codex-phantom AssignmentWakeupPlanner
npx gitnexus impact --repo codex-phantom parseSelfEvolutionToolInput
```

If any result is HIGH or CRITICAL, report the blast radius before editing and expand focused tests around affected flows.

## Task 1: Runtime Limits Store

**Files:**

- Create: `src/config/runtime-limits.ts`
- Modify: `src/platform/database.ts`
- Test: `tests/assignment-autonomous-mutations.test.ts`

- [ ] **Step 1: Write the failing service test for explicit apply**

Add a test named `AutonomousMutationExecutor applies explicit runtime config limit mutations` that:

- creates a harness with `RuntimeConfigLimitsStore(database, config)`;
- creates an `evolve` assignment whose self-evolution policy allow-lists `configuration.runtime_limits`;
- applies `target: "configuration"`, `mutationType: "runtime_limits"`, `proposedChange.runtimeLimits` with `defaultRunTimeoutMs: 45000`, `defaultMaxToolCalls: 9`, `openAiRequestTimeoutMs: 25000`, `emailPollIntervalMs: 15000`, `emailPollBatchSize: 4`, `emailMaxMessageBytes: 524288`;
- asserts the shared `config` object and the store both expose those values;
- asserts the ledger status is `applied`, `before`, `after`, `rollback.runtimeLimits`, and `affectedResources: [{ type: "runtime_config", id: "limits" }]`.

Run:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: FAIL because `RuntimeConfigLimitsStore` and the adapter do not exist.

- [ ] **Step 2: Add the database table**

Add `runtime_config_limits` in `AppDatabase.migrate()`:

```sql
CREATE TABLE IF NOT EXISTS runtime_config_limits (
  id TEXT PRIMARY KEY,
  default_run_timeout_ms INTEGER,
  default_max_tool_calls INTEGER,
  openai_request_timeout_ms INTEGER,
  email_poll_interval_ms INTEGER,
  email_poll_batch_size INTEGER,
  email_max_message_bytes INTEGER,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_config_limits_updated_at
  ON runtime_config_limits(updated_at DESC);
```

- [ ] **Step 3: Implement `src/config/runtime-limits.ts`**

Expose:

```ts
export type RuntimeConfigLimitValues = {
  defaultRunTimeoutMs: number;
  defaultMaxToolCalls: number;
  openAiRequestTimeoutMs: number;
  emailPollIntervalMs: number;
  emailPollBatchSize: number;
  emailMaxMessageBytes: number;
};

export type RuntimeConfigLimitsRecord = RuntimeConfigLimitValues & {
  id: "runtime";
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeConfigLimitsPatch = Partial<RuntimeConfigLimitValues>;

export function runtimeConfigLimitValues(
  limits: RuntimeConfigLimitsRecord | RuntimeConfigLimitValues
): RuntimeConfigLimitValues;

export function normalizeRuntimeConfigLimitsPatch(
  input: unknown
): RuntimeConfigLimitsPatch;

export class RuntimeConfigLimitsStore {
  constructor(database: AppDatabase, config: AppConfig);
  get(): RuntimeConfigLimitsRecord;
  update(
    patch: RuntimeConfigLimitsPatch,
    actor?: string
  ): RuntimeConfigLimitsRecord;
}
```

Rules:

- seed defaults from the current `AppConfig`;
- validate each supported key with strict bounded integer checks;
- reject unknown keys with `runtimeLimits.<key> is not supported`;
- reject non-objects with `runtimeLimits must be an object`;
- preserve env-derived startup values without clamping or persisting an overlay until an explicit runtime-limits mutation is applied;
- `get()` applies effective values from startup/env defaults plus the sparse overlay into the shared config object before returning;
- `update()` applies the merged effective values into config while persisting only explicit overlay fields.

- [ ] **Step 4: Run the focused test**

Run:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: still FAIL because the autonomous adapter is not registered.

## Task 2: Autonomous Mutation Adapter

**Files:**

- Modify: `src/assignments/autonomous-mutations.ts`
- Modify: `src/index.ts`
- Modify: `src/server/http-server.ts`
- Test: `tests/assignment-autonomous-mutations.test.ts`

- [ ] **Step 1: Implement the adapter**

In `AutonomousMutationExecutorOptions`, add `runtimeConfigLimits?: RuntimeConfigLimitsStore`.

Register `createRuntimeConfigLimitsAutonomousMutationAdapter(options.runtimeConfigLimits)` when present.

The adapter:

- uses `target: "configuration"`;
- uses `mutationType: "runtime_limits"`;
- uses `mutationClass: "configuration.runtime_limits"`;
- uses `rollbackConflictScope: "global"`;
- uses `affectedResources: [{ type: "runtime_config", id: "limits" }]`;
- reads `proposedChange.runtimeLimits`;
- records `before = runtimeConfigLimitValues(store.get())`;
- writes `after = runtimeConfigLimitValues(store.update(patch, actor))`;
- records `rollback: { runtimeLimits: before, runtimeLimitsOverlay: beforeOverlaySnapshot }`;
- uses verification methods `runtime_config_limits_update` and `runtime_config_limits_rollback`.

- [ ] **Step 2: Wire store construction**

In `src/index.ts`, create:

```ts
const runtimeConfigLimits = new RuntimeConfigLimitsStore(database, config);
```

before constructing `AgentRuntime`, `CodexAdapter`, `EmailChannel`, or `HttpServer`, then pass `runtimeConfigLimits` to `AutonomousMutationExecutor` and `HttpServer`.

In `HttpServer`, accept optional `runtimeConfigLimits?: RuntimeConfigLimitsStore`, create a fallback with `new RuntimeConfigLimitsStore(database, config)`, and pass it to its internal `AutonomousMutationExecutor`.

- [ ] **Step 3: Run the apply test**

Run:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: PASS for the new apply test.

## Task 3: Authorization, Validation, And Rollback

**Files:**

- Modify: `tests/assignment-autonomous-mutations.test.ts`
- Modify: `src/assignments/autonomous-mutations.ts`
- Test: `tests/assignment-autonomous-mutations.test.ts`

- [ ] **Step 1: Add opt-in and autonomy tests**

Add a test named `AutonomousMutationExecutor keeps runtime config limits explicitly opt-in`:

- default `evolve` assignment rejects `configuration.runtime_limits` with policy denial and does not change config;
- `execute`, `draft`, and `observe` assignments reject even when their policy allow-lists `configuration.runtime_limits`;
- failed ledger evidence exists only where existing executor behavior creates it.

- [ ] **Step 2: Add malformed-input tests**

Add a test named `AutonomousMutationExecutor rejects malformed runtime config limits without changing config` covering:

- `runtimeLimits` missing or non-object;
- unknown key;
- non-integer;
- below minimum;
- above maximum.

Assert no config/store values change and failed ledger evidence is recorded for policy-authorized malformed attempts.

- [ ] **Step 3: Add rollback tests**

Add:

- `AutonomousMutationExecutor rolls back runtime config limit mutations`: apply two fields, rollback, assert config/store restored and ledger status `rolled_back`.
- `AutonomousMutationExecutor blocks stale runtime config limit rollback across assignments`: two assignments apply runtime limits; rollback the older mutation fails with 409 and config remains at newer values.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: PASS.

## Task 4: Planner And HTTP Surfaces

**Files:**

- Modify: `src/assignments/wakeup-planner.ts`
- Modify: `tests/assignment-wakeup-planner.test.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/mcp.test.ts`

- [ ] **Step 1: Planner marker coverage**

Add the planner prompt example:

```text
ASSIGNMENT_MUTATION: {"target":"configuration","mutationType":"runtime_limits","riskClass":"medium","rationale":"...","proposedChange":{"runtimeLimits":{"defaultRunTimeoutMs":45000}}}
```

Add a test named `AssignmentWakeupPlanner applies explicitly allowed runtime config limit mutation markers` and assert the shared config/default run timeout changes, ledger status is `applied`, and the assignment continues normally.

- [ ] **Step 2: HTTP coverage**

Extend the authenticated admin mutation route test to:

- create an `evolve` assignment with `configuration.runtime_limits`;
- `POST /admin/assignments/:id/mutations/apply`;
- assert config/store changed;
- assert mutation appears in `/admin/assignments/:id/mutations`, `/admin/mutations`, and `/admin/timeline`;
- `POST /admin/assignments/:id/mutations/:mutationId/rollback`;
- assert config/store restored.

- [ ] **Step 3: MCP read-only guard**

Extend the MCP guard so no tool id exposes `runtime_limits`, `runtime-config`, `apply`, or `rollback` write behavior.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
```

Expected: PASS.

## Task 5: Docs, Review, Verification, PR, Merge

**Files:**

- Modify: `docs/self-evolution.md`
- Modify: `docs/phantom-parity.md`
- Modify after verification: `docs/project-status.md`

- [ ] **Step 1: Update docs**

Update `docs/self-evolution.md` to describe `configuration.runtime_limits`, its explicit opt-in, supported fields/ranges, rollback, and exclusions.

Update `docs/phantom-parity.md` to move broader configuration forward while keeping secrets/auth/channel enablement/model identity/file paths out of scope.

- [ ] **Step 2: Run full local verification**

Run:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
node --experimental-strip-types --test tests/assignment-mutation-ledger.test.ts tests/self-evolution-mutations.test.ts tests/operator-export.test.ts tests/config.test.ts tests/adapter.test.ts tests/email-channel.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
```

- [ ] **Step 3: Reviewer loop**

Use tmux to start a reviewer session with Claude Code default model (opus 4.8 as requested in the goal), or the available GPT-5.4 xhigh reviewer if Claude is not available in this environment. Give it:

- `gitnexus-impact-analysis`
- `gitnexus-pr-review` or `gitnexus-debugging`
- `tdd`
- `superpowers:requesting-code-review`
- `superpowers:verification-before-completion`

Reviewer prompt must ask for:

- policy bypasses;
- unsafe config expansion;
- stale rollback gaps;
- runtime config not actually affecting consumers;
- audit/ledger evidence gaps;
- HTTP/API compatibility;
- missing tests.

Address all Critical and Important findings, and any cheap Minor correctness/test gaps. Rerun focused tests plus full verification.

- [ ] **Step 4: Commit, PR, Copilot, merge**

Commit implementation:

```bash
git add src/config/runtime-limits.ts src/platform/database.ts src/assignments/autonomous-mutations.ts src/index.ts src/server/http-server.ts src/assignments/wakeup-planner.ts tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts docs/self-evolution.md docs/phantom-parity.md docs/superpowers/plans/2026-06-16-autonomous-runtime-config-limits.md
git commit -m "feat(assignments): add runtime config limits mutation"
```

Update `docs/project-status.md` with branch, verified commit, exact verification commands, reviewer result, and remaining queue. Commit:

```bash
git add docs/project-status.md
git commit -m "docs(status): record runtime config limits mutation wave"
```

Push explicitly:

```bash
git push -u origin jarvis/autonomous-runtime-config-limits
```

Open PR, request Copilot, poll CI and review threads, address warranted findings, and merge only after green checks plus clean review-thread polling.

## Acceptance Criteria

- An explicitly opted-in `evolve` assignment can apply and roll back `configuration.runtime_limits`.
- Default `evolve` assignments and all non-`evolve` assignments cannot apply it.
- Only the supported bounded numeric runtime limits can change.
- Secrets, auth, model identity, base URLs, file paths, channel enablement, prompts, memory entries, tools, roles, project files, and MCP write capability remain untouched.
- Apply records planned/applied autonomous mutation ledger evidence with before, after, rollback, affected resources, verification method, and timeline milestones.
- Rollback restores the prior complete runtime limits snapshot and records `rolled_back`.
- Stale rollback is blocked globally when a newer runtime-limits mutation has been applied.
- Planner markers and HTTP admin routes use the same executor path.
- Existing proposal-based self-evolution APIs and read-only MCP tools remain unchanged.
- Docs/status reflect the completed slice only after verification passes.
