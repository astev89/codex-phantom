# Autonomous Memory Policy Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one bounded memory-policy mutation class, `memory_policy.runtime_bounds`, so an `evolve` assignment with explicit self-evolution policy can tune durable memory retrieval and maintenance bounds and roll them back.

**Architecture:** Keep the memory-policy mutation deliberately narrow: it may update only a persisted memory policy overlay containing numeric retrieval and maintenance bounds. `MemoryStore` reads the overlay at query, consolidation, and maintenance time; the autonomous mutation adapter records before/after/rollback evidence in the autonomous mutation ledger and does not edit memory entries, lifecycle links, embeddings, vector stores, source files, role YAML, prompt text, or MCP tooling.

**Tech Stack:** TypeScript ESM, SQLite via `AppDatabase`, existing Node `node:test` suites, `MemoryStore`, `MemoryRetrievalPolicy`, `AutonomousMutationExecutor`, `AssignmentWakeupPlanner`, admin HTTP routes, GitNexus, tmux-driven Claude Code review.

---

## Skills To Use

- `$superpowers:writing-plans` for this plan.
- `$tdd` for one red/green behavior at a time across memory policy, autonomous executor, planner, and HTTP coverage.
- `$gitnexus-impact-analysis` before editing `MemoryStore`, `MemoryMaintenanceService` if needed, `AutonomousMutationExecutor`, `AssignmentWakeupPlanner`, `HttpServer`, and `AppDatabase`.
- `$mcp-builder` as a guardrail lens only: MCP mutation tooling must remain read-only and no MCP write tool should be added.
- `$tmux-workflows` for the required Claude Code reviewer loop with the default model (opus 4.8).
- `$superpowers:receiving-code-review` before acting on Claude or Copilot findings.
- `$superpowers:verification-before-completion` before commit, PR, merge, or completion claims.

## Files

- Create: `src/memory/policy.ts`
  - Owns `MemoryPolicyStore`, `MemoryPolicyRecord`, default policy derivation from `AppConfig`, validation, update, and rollback-safe normalization.
- Modify: `src/platform/database.ts`
  - Adds a `memory_policy_settings` singleton table with `id`, numeric policy fields, `updated_by`, `created_at`, and `updated_at`.
- Modify: `src/memory/store.ts`
  - Accepts optional `MemoryPolicyStore` and uses current policy values for query limits, consolidation summary/prune thresholds, and scheduled maintenance thresholds.
- Modify: `src/index.ts`
  - Constructs one `MemoryPolicyStore`, passes it to `MemoryStore`, and passes it to `AutonomousMutationExecutor`.
- Modify: `src/assignments/autonomous-mutations.ts`
  - Adds optional `memoryPolicy?: MemoryPolicyStore` dependency and built-in adapter for `target: "memory_policy"`, `mutationType: "runtime_bounds"`, `mutationClass: "memory_policy.runtime_bounds"`.
- Modify: `src/server/http-server.ts`
  - Creates/passes the same memory policy dependency for admin assignment mutation apply/rollback route execution.
- Modify: `tests/memory.test.ts`
  - Adds behavioral coverage proving the policy overlay affects retrieval bounds through `MemoryStore.query()`.
- Modify: `tests/memory-maintenance.test.ts`
  - Adds behavioral coverage proving maintenance prune/summary thresholds come from the policy overlay.
- Modify: `tests/assignment-autonomous-mutations.test.ts`
  - Adds service-level apply, rollback, opt-in policy denial, malformed/out-of-range failure, and global stale rollback guard coverage.
- Modify: `tests/assignment-wakeup-planner.test.ts`
  - Adds planner marker coverage for explicitly allowed `memory_policy.runtime_bounds`.
- Modify: `tests/server.test.ts`
  - Adds HTTP apply/rollback coverage through existing admin assignment mutation routes and mutation/timeline surfaces.
- Modify: `tests/mcp.test.ts`
  - Extends no-write regression to assert no memory-policy apply/rollback MCP tool appears.
- Modify: `docs/self-evolution.md`, `docs/phantom-parity.md`, and `docs/project-status.md`
  - Document this bounded memory-policy mutation class and update status only after verification and implementation commit.

## Policy Shape

`MemoryPolicyRecord` should contain exactly these mutable fields:

```ts
export type MemoryPolicyRecord = {
  id: "runtime";
  memoryTopK: number;
  memoryPerCategoryLimit: number;
  memorySummaryLimit: number;
  memorySummaryTriggerCount: number;
  memorySummaryClusterSize: number;
  semanticPruneLimit: number;
  proceduralPruneLimit: number;
  episodicPruneLimit: number;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};
```

Default values should be derived from `AppConfig` for existing config-backed values:

```ts
{
  memoryTopK: config.memoryTopK,
  memoryPerCategoryLimit: config.memoryPerCategoryLimit,
  memorySummaryLimit: config.memorySummaryLimit,
  memorySummaryTriggerCount: config.memorySummaryTriggerCount,
  memorySummaryClusterSize: config.memorySummaryClusterSize,
  semanticPruneLimit: 80,
  proceduralPruneLimit: 60,
  episodicPruneLimit: 120
}
```

Validation bounds:

```ts
memoryTopK: 1..50
memoryPerCategoryLimit: 1..20
memorySummaryLimit: 0..20
memorySummaryTriggerCount: 2..50
memorySummaryClusterSize: 2..50
semanticPruneLimit: 10..500
proceduralPruneLimit: 10..500
episodicPruneLimit: 10..500
```

`memorySummaryClusterSize` must be less than or equal to `memorySummaryTriggerCount`.

## Acceptance Criteria

- An `evolve` assignment with explicit `selfEvolution.allowedMutationClasses: ["memory_policy.runtime_bounds"]` can apply a `target: "memory_policy"`, `mutationType: "runtime_bounds"` mutation with `proposedChange.memoryPolicy`.
- Default `evolve` assignments do not allow `memory_policy.runtime_bounds`.
- Non-`evolve` assignments still cannot apply autonomous memory policy mutations.
- The mutation updates only the durable memory policy overlay; it does not create, delete, rewrite, reinforce, supersede, contradict, or re-embed memory entries.
- `MemoryStore.query()` uses the latest overlay values for `memoryTopK`, `memorySummaryLimit`, and `memoryPerCategoryLimit`.
- `MemoryStore.consolidate()` and `MemoryStore.runMaintenance()` use the latest overlay values for summary trigger/cluster and prune limits.
- Apply records `before`, `after`, `rollback`, `affectedResources`, and verification evidence in `assignment_mutations`.
- Rollback restores the prior policy and records `rolled_back`.
- Stale rollback over a newer applied `memory_policy.runtime_bounds` mutation is blocked globally because the policy overlay is a shared runtime resource.
- Malformed or out-of-range memory policy attempts fail without changing the overlay and create failed ledger evidence when they reach the executor.
- Planner `ASSIGNMENT_MUTATION:` markers can request this class only through existing mutation executor routing and explicit assignment policy.
- Existing proposal-based self-evolution APIs remain unchanged.
- MCP assignment mutation tooling remains read-only; no memory-policy mutation write tool is added.

## Testing Plan

- Memory policy tests:
  - `tests/memory.test.ts` proves `MemoryStore.query()` respects overlaid summary and per-category limits.
  - `tests/memory-maintenance.test.ts` proves `MemoryStore.runMaintenance()` respects overlaid summary trigger/cluster and prune limits.
- Service tests:
  - `tests/assignment-autonomous-mutations.test.ts` covers apply/rollback, default-policy denial, malformed/out-of-range failure, stale cross-assignment rollback blocking, and unchanged non-`evolve` behavior.
- Planner tests:
  - `tests/assignment-wakeup-planner.test.ts` covers an explicitly allowed planner `ASSIGNMENT_MUTATION:` marker for `memory_policy.runtime_bounds`.
- HTTP tests:
  - `tests/server.test.ts` covers authenticated apply/rollback through existing admin assignment mutation routes and visibility through assignment mutation/timeline surfaces.
- MCP tests:
  - `tests/mcp.test.ts` asserts no MCP apply/rollback or memory-policy mutation write tool appears.
- Final gates:
  - `node --experimental-strip-types --test tests/memory.test.ts tests/memory-maintenance.test.ts tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts`
  - `node --experimental-strip-types --test tests/assignment-mutation-ledger.test.ts tests/self-evolution-mutations.test.ts tests/operator-export.test.ts`
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `git diff --check`
  - `npx gitnexus detect-changes --scope staged --repo codex-phantom`

## Reviewer Loop

- After local verification, use `$tmux-workflows` to launch Claude Code with the default model:

```bash
tmux new-session -d -s codex-phantom-memory-policy-review -n review
PANE=$(tmux new-window -t codex-phantom-memory-policy-review -n claude-review -P -F '#{pane_id}')
tmux send-keys -t "$PANE" 'cd /Users/aaronstevens/dev/codex-phantom && claude' Enter
```

- Send this prompt through a tmux buffer and wait for `/private/tmp/codex-phantom-memory-policy-review.done`:

```text
Review the staged autonomous memory policy runtime-bounds mutation slice in /Users/aaronstevens/dev/codex-phantom.

Use the default Claude Code model. Do not edit files. Focus on correctness, policy bypasses, memory-entry mutation risks, rollback integrity, ledger/audit gaps, retrieval/maintenance behavior, HTTP API compatibility, MCP read-only compatibility, missing tests, and docs accuracy.

Read:
- docs/superpowers/plans/2026-06-16-autonomous-memory-policy-mutation.md
- git diff --cached

Report Critical, Important, and Minor findings with file/line references. If no Critical or Important findings remain, say so explicitly.

When finished, write the report to /private/tmp/codex-phantom-memory-policy-review.md and run:
touch /private/tmp/codex-phantom-memory-policy-review.done
```

- Address all technically valid Critical and Important findings.
- Fix Minor findings only if they are low-risk and in slice scope.
- Rerun focused tests and full gates after fixes.
- Before merge, request Copilot review on the PR, poll CI/review/comment surfaces, and address warranted comments.

## Implementation Tasks

### Task 1: Memory Policy Store And Runtime Wiring

**Files:**

- Create: `src/memory/policy.ts`
- Modify: `src/platform/database.ts`
- Modify: `src/memory/store.ts`
- Test: `tests/memory.test.ts`
- Test: `tests/memory-maintenance.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

```bash
npx gitnexus impact MemoryStore --direction upstream --repo codex-phantom --include-tests --summary-only
npx gitnexus impact AppDatabase --direction upstream --repo codex-phantom --include-tests --summary-only
```

- [ ] **Step 2: Write failing retrieval policy overlay test**

Add a test to `tests/memory.test.ts` that:

- creates `MemoryPolicyStore` with normal config defaults;
- calls `memoryPolicy.update({ memoryPerCategoryLimit: 1, memorySummaryLimit: 1 }, "operator")`;
- constructs `MemoryStore(database, config, embeddings, primary, fallback, memoryPolicy)`;
- stores two semantic entries, two procedural entries, and two summary entries that match a query;
- calls `memory.query("release restore")`;
- asserts one summary, one semantic, and one procedural result are returned.

Expected failing command:

```bash
node --experimental-strip-types --test tests/memory.test.ts
```

Expected failure: `Cannot find module '../src/memory/policy.ts'` or `MemoryStore` constructor does not accept policy store.

- [ ] **Step 3: Write failing maintenance policy overlay test**

Add a test to `tests/memory-maintenance.test.ts` that:

- creates `MemoryPolicyStore` and updates `{ memorySummaryTriggerCount: 4, memorySummaryClusterSize: 3, semanticPruneLimit: 3 }`;
- constructs `MemoryStore` with the policy store;
- records four episodic turns and five semantic facts;
- calls `memory.runMaintenance()`;
- asserts `summarizedCount === 3`, one summary was promoted, `prunedCount === 2`, and only three semantic entries remain active.

Expected failing command:

```bash
node --experimental-strip-types --test tests/memory-maintenance.test.ts
```

Expected failure: `MemoryPolicyStore` missing or hard-coded maintenance thresholds still used.

- [ ] **Step 4: Add database table and policy store**

Create `src/memory/policy.ts` with:

```ts
import type { AppConfig } from "../config.ts";
import type { JsonValue } from "../shared/types.ts";
import type { AppDatabase } from "../platform/database.ts";

export type MemoryPolicyRecord = {
  id: "runtime";
  memoryTopK: number;
  memoryPerCategoryLimit: number;
  memorySummaryLimit: number;
  memorySummaryTriggerCount: number;
  memorySummaryClusterSize: number;
  semanticPruneLimit: number;
  proceduralPruneLimit: number;
  episodicPruneLimit: number;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoryPolicyPatch = Partial<
  Pick<
    MemoryPolicyRecord,
    | "memoryTopK"
    | "memoryPerCategoryLimit"
    | "memorySummaryLimit"
    | "memorySummaryTriggerCount"
    | "memorySummaryClusterSize"
    | "semanticPruneLimit"
    | "proceduralPruneLimit"
    | "episodicPruneLimit"
  >
>;

const ROW_ID = "runtime";

export class MemoryPolicyStore {
  private readonly database: AppDatabase;
  private readonly defaults: MemoryPolicyPatch;

  constructor(database: AppDatabase, config: AppConfig) {
    this.database = database;
    this.defaults = defaultMemoryPolicy(config);
    this.seedDefault();
  }

  get(): MemoryPolicyRecord {
    const row = this.database.get<MemoryPolicyRow>(
      "SELECT * FROM memory_policy_settings WHERE id = ?",
      ROW_ID
    );
    if (!row) {
      this.seedDefault();
      return this.get();
    }
    return toRecord(row);
  }

  update(patch: MemoryPolicyPatch, actor?: string): MemoryPolicyRecord {
    const current = this.get();
    const next = normalizeMemoryPolicyPatch({ ...current, ...patch });
    const now = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO memory_policy_settings (
          id, memory_top_k, memory_per_category_limit, memory_summary_limit,
          memory_summary_trigger_count, memory_summary_cluster_size,
          semantic_prune_limit, procedural_prune_limit, episodic_prune_limit,
          updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          memory_top_k = excluded.memory_top_k,
          memory_per_category_limit = excluded.memory_per_category_limit,
          memory_summary_limit = excluded.memory_summary_limit,
          memory_summary_trigger_count = excluded.memory_summary_trigger_count,
          memory_summary_cluster_size = excluded.memory_summary_cluster_size,
          semantic_prune_limit = excluded.semantic_prune_limit,
          procedural_prune_limit = excluded.procedural_prune_limit,
          episodic_prune_limit = excluded.episodic_prune_limit,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `,
      ROW_ID,
      next.memoryTopK,
      next.memoryPerCategoryLimit,
      next.memorySummaryLimit,
      next.memorySummaryTriggerCount,
      next.memorySummaryClusterSize,
      next.semanticPruneLimit,
      next.proceduralPruneLimit,
      next.episodicPruneLimit,
      actor ?? null,
      now,
      now
    );
    return this.get();
  }

  private seedDefault(): void {
    const now = new Date().toISOString();
    const next = normalizeMemoryPolicyPatch(this.defaults);
    this.database.run(
      `
        INSERT INTO memory_policy_settings (
          id, memory_top_k, memory_per_category_limit, memory_summary_limit,
          memory_summary_trigger_count, memory_summary_cluster_size,
          semantic_prune_limit, procedural_prune_limit, episodic_prune_limit,
          updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `,
      ROW_ID,
      next.memoryTopK,
      next.memoryPerCategoryLimit,
      next.memorySummaryLimit,
      next.memorySummaryTriggerCount,
      next.memorySummaryClusterSize,
      next.semanticPruneLimit,
      next.proceduralPruneLimit,
      next.episodicPruneLimit,
      null,
      now,
      now
    );
  }
}
```

Complete the file with `MemoryPolicyRow`, `defaultMemoryPolicy()`, `normalizeMemoryPolicyPatch()`, integer bound helpers, and `toRecord()`.

Add `memory_policy_settings` table and `idx_memory_policy_settings_updated_at` index in `src/platform/database.ts`.

- [ ] **Step 5: Wire MemoryStore to policy overlay**

Update `MemoryStore` constructor to accept optional `memoryPolicy?: MemoryPolicyStore`.

Use:

```ts
const policy = this.memoryPolicy?.get() ?? defaultMemoryPolicy(this.config);
```

Then replace these hard-coded/config uses:

- query vector search limit: `policy.memoryTopK`
- retrieval summary limit: `policy.memorySummaryLimit`
- retrieval per-category limit: `policy.memoryPerCategoryLimit`
- `compactEpisodicMemories()` trigger/cluster: pass policy values into lifecycle or update lifecycle methods to accept explicit options.
- prune limits in `consolidate()` and `runMaintenance()`: `policy.semanticPruneLimit`, `policy.proceduralPruneLimit`, `policy.episodicPruneLimit`

- [ ] **Step 6: Run focused memory tests**

```bash
node --experimental-strip-types --test tests/memory.test.ts tests/memory-maintenance.test.ts tests/memory-retrieval-policy.test.ts tests/memory-lifecycle.test.ts
```

Expected: PASS.

### Task 2: Autonomous Memory Policy Adapter

**Files:**

- Modify: `src/assignments/autonomous-mutations.ts`
- Test: `tests/assignment-autonomous-mutations.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

```bash
npx gitnexus impact AutonomousMutationExecutor --direction upstream --repo codex-phantom --include-tests --summary-only
npx gitnexus impact AutonomousMutationLedger --direction upstream --repo codex-phantom --include-tests --summary-only
```

- [ ] **Step 2: Write failing service tests**

Add tests to `tests/assignment-autonomous-mutations.test.ts` for:

- explicit `memory_policy.runtime_bounds` apply with before/after/rollback and affected resource `{ type: "memory_policy", id: "runtime_bounds" }`;
- rollback restores prior policy;
- default `evolve` policy denies `memory_policy.runtime_bounds`;
- malformed/out-of-range values fail without changing policy;
- cross-assignment stale rollback is blocked because the resource is global.

Expected failing command:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected failure: unsupported mutation class.

- [ ] **Step 3: Implement adapter**

In `AutonomousMutationExecutorOptions`, add:

```ts
memoryPolicy?: MemoryPolicyStore;
```

Add constant:

```ts
const MEMORY_POLICY_RUNTIME_BOUNDS_MUTATION_CLASS =
  "memory_policy.runtime_bounds";
```

Register built-in adapter when `options.memoryPolicy` exists.

Adapter behavior:

- `target: "memory_policy"`
- `mutationType: "runtime_bounds"`
- `mutationClass: "memory_policy.runtime_bounds"`
- `affectedResources: [{ type: "memory_policy", id: "runtime_bounds" }]`
- `rollbackConflictScope: "global"`
- apply reads `proposedChange.memoryPolicy` JSON object, validates through `normalizeMemoryPolicyPatch`, updates store, returns before/after/rollback.
- rollback reads `rollback.memoryPolicy`, validates, and updates store.
- verification methods:
  - `memory_policy_runtime_bounds_update`
  - `memory_policy_runtime_bounds_rollback`

- [ ] **Step 4: Run service tests**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: PASS.

### Task 3: Runtime, Planner, HTTP, And MCP Surfaces

**Files:**

- Modify: `src/index.ts`
- Modify: `src/server/http-server.ts`
- Modify: `tests/assignment-wakeup-planner.test.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/mcp.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

```bash
npx gitnexus impact AssignmentWakeupPlanner --direction upstream --repo codex-phantom --include-tests --summary-only
npx gitnexus impact HttpServer --direction upstream --repo codex-phantom --include-tests --summary-only
```

- [ ] **Step 2: Wire store in runtime/server**

In `src/index.ts`:

```ts
const memoryPolicy = new MemoryPolicyStore(database, config);
const memory = new MemoryStore(
  database,
  config,
  embeddings,
  undefined,
  undefined,
  memoryPolicy
);
```

Pass `memoryPolicy` into `AutonomousMutationExecutor`.

In `HttpServer`, construct or accept a `MemoryPolicyStore` and pass it into its internal `AutonomousMutationExecutor`.

- [ ] **Step 3: Add planner test**

In `tests/assignment-wakeup-planner.test.ts`, add a test where planner output includes:

```text
ASSIGNMENT_MUTATION: {"target":"memory_policy","mutationType":"runtime_bounds","rationale":"Reduce memory context for this work.","proposedChange":{"memoryPolicy":{"memoryPerCategoryLimit":1,"memorySummaryLimit":1}}}
```

Assignment policy must explicitly allow:

```ts
allowedMutationClasses: [
  "configuration.operator_settings",
  "memory_policy.runtime_bounds",
];
```

Assert completed wakeup, policy store values changed, ledger mutation has `runId: "coord_wakeup_1"`, and authorizing policy includes `memory_policy.runtime_bounds`.

- [ ] **Step 4: Add HTTP test**

In the existing server assignment mutation integration flow, create an `evolve` assignment with explicit `memory_policy.runtime_bounds`, call:

```http
POST /admin/assignments/:id/mutations/apply
```

with:

```json
{
  "target": "memory_policy",
  "mutationType": "runtime_bounds",
  "rationale": "Reduce memory retrieval context for autonomous work.",
  "proposedChange": {
    "memoryPolicy": {
      "memoryPerCategoryLimit": 1,
      "memorySummaryLimit": 1
    }
  }
}
```

Assert successful mutation response, before/after/rollback, assignment mutation listing, global mutation listing, timeline visibility, and rollback status.

- [ ] **Step 5: Add MCP no-write guard**

In `tests/mcp.test.ts`, extend the tool-list assertion so no assignment MCP tool id includes `memory_policy`, `runtime_bounds`, `apply`, or `rollback`.

- [ ] **Step 6: Run surface tests**

```bash
node --experimental-strip-types --test tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
```

Expected: PASS.

### Task 4: Docs, Verification, Review, PR, And Merge

**Files:**

- Modify: `docs/self-evolution.md`
- Modify: `docs/phantom-parity.md`
- Modify: `docs/project-status.md`

- [ ] **Step 1: Update docs after code verification**

Document `memory_policy.runtime_bounds` as an assignment-authorized autonomous memory policy overlay mutation:

- explicit opt-in only;
- not default allowed;
- updates retrieval/maintenance numeric bounds only;
- does not edit memory entries, embeddings, vector stores, source files, role policy, prompts, or MCP tools;
- rollback restores prior bounds and stale rollback is globally guarded.

- [ ] **Step 2: Run final verification**

```bash
node --experimental-strip-types --test tests/memory.test.ts tests/memory-maintenance.test.ts tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
node --experimental-strip-types --test tests/assignment-mutation-ledger.test.ts tests/self-evolution-mutations.test.ts tests/operator-export.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

- [ ] **Step 3: Run staged GitNexus change detection**

```bash
git add src/memory/policy.ts src/platform/database.ts src/memory/store.ts src/memory/lifecycle.ts src/index.ts src/assignments/autonomous-mutations.ts src/server/http-server.ts tests/memory.test.ts tests/memory-maintenance.test.ts tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts docs/self-evolution.md docs/phantom-parity.md docs/superpowers/plans/2026-06-16-autonomous-memory-policy-mutation.md
npx gitnexus detect-changes --scope staged --repo codex-phantom
```

- [ ] **Step 4: Run Claude reviewer loop**

Use the tmux commands in the Reviewer Loop section. Address Critical and Important findings, rerun focused tests and full gates, and request follow-up review until no Critical or Important findings remain.

- [ ] **Step 5: Commit implementation**

```bash
git commit -m "feat(assignments): add memory policy mutation"
```

- [ ] **Step 6: Update project status in a docs commit**

After the implementation commit exists, update `docs/project-status.md` with branch, verified implementation commit, verification commands, reviewer loop outcome, and completed slice.

```bash
git add docs/project-status.md
npx gitnexus detect-changes --scope staged --repo codex-phantom
git commit -m "docs(status): record memory policy mutation wave"
```

- [ ] **Step 7: Push, PR, review, and merge**

```bash
git push -u origin jarvis/autonomous-memory-policy-mutation
gh pr create --draft --base main --head jarvis/autonomous-memory-policy-mutation --title "feat(assignments): add memory policy mutation" --body "<summary and verification>"
gh pr ready <number>
gh pr edit <number> --add-reviewer 'github-copilot[bot]'
gh pr checks <number> --watch --fail-fast
gh pr view <number> --json comments,reviews,reviewDecision,statusCheckRollup,mergeable
gh pr merge <number> --merge --delete-branch
```

If GitHub cannot resolve Copilot reviewer through CLI, record the failure and continue with CI/review polling.

## Self-Review

- Spec coverage: This plan implements one remaining governed self-evolution memory-policy mutation class with explicit assignment policy, rollback evidence, planner/HTTP surfaces, MCP no-write regression, docs, reviewer loop, and PR flow.
- Placeholder scan: No `TBD`, `TODO`, or underspecified "write tests" placeholders remain; each test and command names the behavior and expected outcome.
- Type consistency: The mutation class is consistently `memory_policy.runtime_bounds`, with `target: "memory_policy"`, `mutationType: "runtime_bounds"`, and `proposedChange.memoryPolicy`.
