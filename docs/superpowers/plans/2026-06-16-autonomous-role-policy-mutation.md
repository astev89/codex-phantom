# Autonomous Role Policy Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the next bounded assignment-authorized autonomous mutation class, `role.permission_policy`, so explicitly opted-in `evolve` assignments can narrow subagent role permissions with ledger evidence and rollback.

**Architecture:** Introduce a durable role-policy runtime overlay that is initialized from the existing YAML/compiled role baselines and can only narrow known subagent roles. `OrchestrationService` reads the current effective role policy at subagent-spawn time, while `AutonomousMutationExecutor` owns apply/rollback through a new adapter with global stale-rollback protection.

**Tech Stack:** TypeScript ESM, SQLite via `AppDatabase`, Node `node:test`, existing autonomous mutation ledger, existing role policy parser, GitNexus impact/detect-changes, tmux-driven Claude Code reviewer loop.

---

## Skills

- `superpowers:writing-plans`: used to define this slice before edits.
- `tdd`: use one failing behavior test at a time, then minimal implementation.
- `gitnexus-impact-analysis`: already run for `AutonomousMutationExecutor`, `AssignmentWakeupPlanner`, `HttpServer`, `loadRolePolicyConfig`, `buildScopedPolicy`, `loadConfig`, and `AppDatabase`; `AppDatabase` is CRITICAL because schema edits affect the shared persistence hub.
- `tmux-workflows`: run the required Claude Code reviewer in tmux with sentinel-file completion.
- `mcp-builder`: keep MCP assignment mutation tooling read-only; add MCP regression coverage if tool descriptions or tool IDs could expose write capability.
- `superpowers:verification-before-completion`: run focused and full verification before claiming the slice is complete.

## File Map

- Create `src/orchestration/role-policy-runtime.ts`: durable runtime overlay store, normalization helpers, effective policy snapshots, and rollback payload normalization.
- Modify `src/platform/database.ts`: add `role_policy_overrides` table and updated-at index.
- Modify `src/orchestration/service.ts`: accept either a static loaded role policy or runtime provider and read effective baselines when spawning subagents.
- Modify `src/assignments/autonomous-mutations.ts`: add `role.permission_policy` adapter, unsupported-class text, constructor option, apply/rollback evidence, and global conflict scope.
- Modify `src/assignments/wakeup-planner.ts`: advertise `role.permission_policy` in planner mutation examples only when policy allows mutation markers.
- Modify `src/index.ts`: construct and wire `RolePolicyRuntimeStore` into orchestration and autonomous mutation executor.
- Modify `src/server/http-server.ts`: accept optional `RolePolicyRuntimeStore` and pass it to the internal `AutonomousMutationExecutor`.
- Modify tests:
  - `tests/orchestration.test.ts`: runtime overlay affects newly spawned subagents and cannot widen role baselines.
  - `tests/assignment-autonomous-mutations.test.ts`: service-level apply/rollback, default opt-in denial, malformed/widening failures, stale rollback blocking.
  - `tests/assignment-wakeup-planner.test.ts`: planner marker can apply explicit role-policy mutation.
  - `tests/server.test.ts`: HTTP apply/list/timeline/rollback visibility.
  - `tests/mcp.test.ts`: MCP mutation tools remain read-only and no write tool for role policy is exposed.
- Modify docs:
  - `docs/self-evolution.md`: document the new bounded role mutation class and exclusions.
  - `docs/phantom-parity.md`: update governed self-evolution remaining gaps.
  - `docs/project-status.md`: update only after verification and implementation commit.

## Slice Boundary

- Supported class: `target: "role"`, `mutationType: "permission_policy"`, mutation class `role.permission_policy`.
- Payload shape:

```json
{
  "rolePolicy": {
    "roles": {
      "verifier": {
        "mode": "read_only",
        "fileGlobs": ["src/**/*"],
        "allowedToolIds": ["echo.summary"],
        "allowedMcpServers": ["ci"]
      }
    }
  }
}
```

- Known roles only: `explorer`, `builder`, `verifier`, `researcher`.
- No `full_access` in autonomous role-policy mutations.
- Resulting role permissions must be a subset of the loaded startup baseline for that role:
  - `mode` cannot exceed the baseline mode.
  - `fileGlobs`, `allowedToolIds`, and `allowedMcpServers` must be members of the baseline arrays, except a baseline `fileGlobs: ["**/*"]` allows any requested read-only file glob for that role because the current baseline already grants all files.
- Empty role patches and unsupported fields fail without changing the overlay.
- Default `evolve` policy remains unchanged; `role.permission_policy` is explicit opt-in only.
- MCP assignment mutation tooling remains read-only.

## Tasks

### Task 1: Runtime Role Policy Overlay

**Files:**

- Create: `src/orchestration/role-policy-runtime.ts`
- Modify: `src/platform/database.ts`
- Test: `tests/orchestration.test.ts`

- [ ] **Step 1: Write the failing orchestration test**

Add a test that creates `RolePolicyRuntimeStore` from a loaded role policy, applies a verifier override with fewer globs/MCP servers, constructs `OrchestrationService` with the store, spawns a verifier subagent, and asserts the stored child run has the narrowed policy. Add a second assertion that widening verifier `allowedMcpServers` to a value outside the baseline throws.

Run:

```bash
node --experimental-strip-types --test tests/orchestration.test.ts
```

Expected: fail because `RolePolicyRuntimeStore` does not exist.

- [ ] **Step 2: Implement the store and schema**

Create `role_policy_overrides` with columns `id`, `overrides_json`, `updated_by`, `created_at`, `updated_at`. Implement:

```ts
export class RolePolicyRuntimeStore {
  constructor(database: AppDatabase, baseConfig: LoadedRolePolicyConfig);
  get(): RolePolicyRuntimeRecord;
  update(patch: RolePolicyPatch, actor?: string): RolePolicyRuntimeRecord;
}
```

Store records include `{ id: "runtime", overrides, baselines, status, updatedBy, createdAt, updatedAt }`. `normalizeRolePolicyPatch(input, baseBaselines)` validates the slice boundary above and returns `{ roles }`.

- [ ] **Step 3: Wire orchestration to the provider**

Update `OrchestrationService` to accept `LoadedRolePolicyConfig | RolePolicyRuntimeStore`. `getRolePolicyStatus()` returns the current provider status. `spawnSubagent()` calls the provider for fresh baselines before `buildScopedPolicy()`.

- [ ] **Step 4: Run the focused test**

Run:

```bash
node --experimental-strip-types --test tests/orchestration.test.ts
```

Expected: pass.

### Task 2: Autonomous Mutation Adapter

**Files:**

- Modify: `src/assignments/autonomous-mutations.ts`
- Test: `tests/assignment-autonomous-mutations.test.ts`

- [ ] **Step 1: Write the failing service-level apply/rollback test**

Add a test that creates an `evolve` assignment with `allowedMutationClasses: ["role.permission_policy"]`, applies a verifier policy narrowing mutation, asserts the store changed, the ledger status is `applied`, evidence contains before/after/rollback, and rollback restores the prior overlay and records `rolled_back`.

Run:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: fail because the adapter is unsupported.

- [ ] **Step 2: Add adapter and constructor wiring**

Add `rolePolicy?: RolePolicyRuntimeStore` to `AutonomousMutationExecutorOptions`. Register `createRolePermissionPolicyAutonomousMutationAdapter()` when present. Adapter details:

- `target: "role"`
- `mutationType: "permission_policy"`
- `mutationClass: "role.permission_policy"`
- `affectedResources: [{ type: "role_policy", id: "runtime" }]`
- `rollbackConflictScope: "global"`
- apply: validate `proposedChange.rolePolicy`, call `rolePolicy.update()`, return before/after/rollback and method `role_permission_policy_update`
- rollback: validate `rollback.rolePolicy`, restore previous overrides, return method `role_permission_policy_rollback`

- [ ] **Step 3: Add safety tests**

Add tests for:

- default `evolve` policy rejects `role.permission_policy`.
- unsupported role name fails without changing the overlay.
- widening `allowedMcpServers` fails without changing the overlay.
- stale rollback is blocked after a newer global role-policy mutation.

Run:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: pass.

### Task 3: Planner And HTTP Integration

**Files:**

- Modify: `src/assignments/wakeup-planner.ts`
- Modify: `src/server/http-server.ts`
- Modify: `src/index.ts`
- Test: `tests/assignment-wakeup-planner.test.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write failing planner and HTTP tests**

Planner test: an explicitly opted-in `evolve` assignment receives an `ASSIGNMENT_MUTATION:` marker for `role.permission_policy`; after wakeup, the role store has the narrowed verifier policy and the ledger has an applied mutation.

HTTP test: authenticated `POST /admin/assignments/:id/mutations/apply` applies role policy, `GET /admin/assignments/:id/mutations`, `GET /admin/mutations`, and `GET /admin/timeline` expose it, and rollback restores the prior overlay.

Run:

```bash
node --experimental-strip-types --test tests/assignment-wakeup-planner.test.ts tests/server.test.ts
```

Expected: fail because `index`/server/planner are not wired to the role store.

- [ ] **Step 2: Wire runtime surfaces**

Instantiate `RolePolicyRuntimeStore` in `src/index.ts` after loading the YAML/compiled role policy. Pass it to `OrchestrationService`, `AutonomousMutationExecutor`, and `HttpServer`.

Update `HttpServer` constructor to accept an optional role store and pass it to the internal executor.

Update planner mutation instructions to include a compact `role.permission_policy` example alongside other explicit-policy examples.

- [ ] **Step 3: Run focused tests**

Run:

```bash
node --experimental-strip-types --test tests/assignment-wakeup-planner.test.ts tests/server.test.ts
```

Expected: pass.

### Task 4: Read-Only MCP Guard And Docs

**Files:**

- Modify: `tests/mcp.test.ts`
- Modify: `docs/self-evolution.md`
- Modify: `docs/phantom-parity.md`

- [ ] **Step 1: Add MCP guard**

Extend the existing no-write-tool regression so no MCP tool id contains `role.permission_policy`, `permission_policy`, `apply`, or `rollback` in an assignment mutation write context.

Run:

```bash
node --experimental-strip-types --test tests/mcp.test.ts
```

Expected: pass.

- [ ] **Step 2: Update docs**

Document `role.permission_policy` as explicit opt-in, narrowing-only, known roles only, rollbackable, and not a role YAML/source-file rewrite. Update parity remaining gaps to remove role policy from the future-work list while leaving project files, broader prompt rewriting, broader memory mutation, broader configuration, and deeper parent/child orchestration.

### Task 5: Verification, Review, PR, And Merge

**Verification commands:**

```bash
node --experimental-strip-types --test tests/orchestration.test.ts tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
node --experimental-strip-types --test tests/assignment-mutation-ledger.test.ts tests/self-evolution-mutations.test.ts tests/operator-export.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
```

**tmux Claude reviewer loop:**

```bash
tmux new-session -d -s codex-phantom-role-review -n review
PANE=$(tmux new-window -t codex-phantom-role-review -n claude-review -P -F '#{pane_id}')
tmux send-keys -t "$PANE" 'cd /Users/aaronstevens/dev/codex-phantom && claude' Enter
```

Prompt Claude Code default model, Opus 4.8, to review the outstanding diff for correctness, role-policy widening bypasses, ledger/audit gaps, rollback integrity, API compatibility, MCP write exposure, missing tests, and docs/status drift. Require it to write `/private/tmp/codex-phantom-role-policy-review.md` and `touch /private/tmp/codex-phantom-role-policy-review.done`.

Address all Critical and Important findings that withstand inspection, rerun focused tests plus the full verification gate, and rerun GitNexus detect-changes.

**PR loop:**

```bash
git push -u origin jarvis/autonomous-role-policy-mutation
gh pr create --draft --base main --head jarvis/autonomous-role-policy-mutation --title "feat(assignments): add role policy mutation" --body-file /private/tmp/codex-phantom-role-policy-pr-body.md
gh pr ready <number>
gh pr edit <number> --add-reviewer @copilot
gh pr checks <number> --watch --fail-fast
```

Poll Copilot review threads with GraphQL `reviewThreads`. Address warranted comments, rerun focused verification, push fixes, wait for green checks, then merge with:

```bash
gh pr merge <number> --merge --delete-branch
```

## Acceptance Criteria

- `role.permission_policy` can be applied only by `evolve` assignments whose self-evolution policy explicitly allows that mutation class.
- The mutation can only narrow known role permissions relative to the loaded startup role policy and cannot grant `full_access`, unknown roles, new tool ids, new MCP servers, or broader write globs.
- Apply records planned and applied autonomous mutation ledger evidence with before, after, rollback, affected resources, verification method, assignment timeline milestones, and operator/admin visibility.
- Rollback restores the prior role-policy overlay and records `rolled_back`.
- Stale rollback is blocked after a newer applied role-policy mutation because the overlay is global runtime state.
- New subagent spawns use the current effective role-policy overlay without restarting the service.
- Default `evolve` assignments remain limited to `configuration.operator_settings`; `execute`, `draft`, and `observe` assignments still cannot mutate.
- Proposal-based self-evolution APIs remain unchanged.
- MCP assignment mutation tooling remains read-only.
- Docs and project ledger are updated after verification passes.
