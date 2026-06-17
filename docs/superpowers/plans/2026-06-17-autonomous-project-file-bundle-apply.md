# Autonomous Project File Bundle Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the next bounded filesystem-write slice: an explicitly opted-in `evolve` assignment can atomically apply a small bundle of existing assignment-owned project-file drafts and roll the bundle back through autonomous mutation ledger evidence.

**Architecture:** Reuse the single-file `ProjectFileApplyService` and `ProjectFileDraftStore` rather than introducing patch parsing or direct content writes. Add an autonomous mutation adapter for `project_file.apply_bundle` that validates all draft IDs and paths before writing, applies each draft with per-file byte snapshots, rolls back already-applied files if any later file fails, and stores bundle-level rollback evidence. Keep this high-risk, explicitly allow-listed, admin/internal and planner-marker only, with no MCP write surface.

**Tech Stack:** TypeScript ESM, SQLite via `AppDatabase`, existing autonomous mutation executor/ledger, existing project-file draft/apply services, Node `node:test`, GitNexus CLI, GPT-5.4 xhigh reviewer loop.

---

## Scope

### In Scope

- Mutation class: `project_file.apply_bundle`.
- Target/type: `target: "project_file"`, `mutationType: "apply_bundle"`.
- Request shape:

```json
{
  "target": "project_file",
  "mutationType": "apply_bundle",
  "riskClass": "high",
  "rationale": "Apply coordinated docs drafts.",
  "proposedChange": {
    "projectFileBundle": {
      "draftIds": ["pfd_1", "pfd_2"]
    }
  }
}
```

- Apply only existing `project_file_drafts` rows created by the same assignment.
- Require every draft status to be `active`.
- Require `draftIds` to be an array of 1 to 10 unique non-empty strings.
- Reject duplicate normalized draft paths before writing.
- Apply each draft through `ProjectFileApplyService.apply()`, preserving its symlink rejection, real-root path confinement, safe text draft content, and byte-exact prior-state snapshots.
- On any mid-bundle failure, immediately roll back already-applied file writes and restore their draft statuses to active before recording the autonomous mutation as failed.
- Mark all successfully applied drafts as `applied` with the bundle mutation id and applied SHA-256.
- Store rollback evidence for every applied file:
  - `draftId`
  - normalized path
  - before file byte snapshot
  - after file size and SHA-256
- Rollback restores every file from its stored byte snapshot and marks every draft active again.
- Stale rollback is conservative and global for the mutation class: a newer applied `project_file.apply_bundle` blocks rollback until path-scoped ledger conflict checks are added in a later slice.
- Admin/internal API uses existing `/admin/assignments/:id/mutations/apply` and rollback routes.
- Planner markers can request `project_file.apply_bundle` only when explicitly allow-listed.
- MCP assignment mutation tooling remains read-only.

### Out Of Scope

- Direct inline file content.
- Patch parsing, diffs, multi-hunk editing, generated file writes, staging, committing, pushing, package installs, command execution, and write-capable MCP tools.
- Applying drafts owned by other assignments.
- Mixing draft creation and bundle apply in one mutation.
- Partial success semantics. A bundle either fully applies or leaves the filesystem and draft statuses as they were before the bundle started.
- Path-scoped stale rollback matching. This slice keeps the existing conservative global guard.

## Required Skills

- `tdd`: use one failing behavior test at a time.
- `gitnexus-impact-analysis`: run before editing existing symbols.
- `superpowers:executing-plans` or `superpowers:subagent-driven-development`: execute this plan task-by-task.
- `superpowers:requesting-code-review`: run an independent reviewer before completion.
- `superpowers:receiving-code-review`: evaluate and address reviewer feedback.
- `superpowers:verification-before-completion`: verify before claims, commits, PR, and merge.
- `tmux-workflows` or multi-agent reviewer tooling: run the required reviewer loop.

## GitNexus Impact Targets

Run before editing existing symbols:

```bash
npx gitnexus impact ProjectFileApplyService --repo codex-phantom --direction upstream
npx gitnexus impact ProjectFileDraftStore --repo codex-phantom --direction upstream
npx gitnexus impact AutonomousMutationExecutor --repo codex-phantom --direction upstream
npx gitnexus impact AssignmentWakeupPlanner --repo codex-phantom --direction upstream
npx gitnexus impact HttpServer --repo codex-phantom --direction upstream
```

If any impact result is HIGH or CRITICAL, report the blast radius before editing and expand regression tests around the affected flows.

## Files

- Modify `src/assignments/autonomous-mutations.ts`
  - Register `project_file.apply_bundle`.
  - Add bundle validation helpers.
  - Add atomic apply and rollback adapter behavior.
- Modify `src/assignments/wakeup-planner.ts`
  - Add a planner marker example for `project_file.apply_bundle`.
- Modify `tests/assignment-autonomous-mutations.test.ts`
  - Add service-level happy path, atomic failure, safety, rollback, and stale rollback coverage.
- Modify `tests/assignment-wakeup-planner.test.ts`
  - Add planner marker coverage.
- Modify `tests/server.test.ts`
  - Add HTTP apply/rollback/list/timeline coverage through existing admin routes.
- Modify `tests/mcp.test.ts`
  - Extend read-only guard to include `bundle`.
- Modify docs:
  - `docs/self-evolution.md`
  - `docs/phantom-parity.md`
  - `docs/project-status.md` at wave end after verification.

## Task 1: Service-Level Happy Path

**Files:**

- Modify: `tests/assignment-autonomous-mutations.test.ts`

- [ ] **Step 1: Add a failing behavior test**

Add this test near the project-file apply tests:

```ts
test("AutonomousMutationExecutor atomically applies a project file draft bundle", (t) => {
  const { assignments, database, executor, projectFileDrafts } =
    createProjectFileDraftHarness();
  const firstPath = join(process.cwd(), "docs/bundle-apply-first.md");
  const secondPath = join(process.cwd(), "docs/bundle-apply-second.md");
  t.after(() => {
    unlinkIfPresent(firstPath);
    unlinkIfPresent(secondPath);
    database.close();
  });
  const assignment = assignments.create({
    objective: "Apply coordinated docs drafts",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "project_file.apply_bundle",
        ],
        maxRiskClass: "high",
      },
    },
  });
  const firstDraft = projectFileDrafts.create({
    assignmentId: assignment.assignment.id,
    path: "docs/bundle-apply-first.md",
    content: "First bundle file\n",
  });
  const secondDraft = projectFileDrafts.create({
    assignmentId: assignment.assignment.id,
    path: "docs/bundle-apply-second.md",
    content: "Second bundle file\n",
  });

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    runId: "coord_project_file_apply_bundle",
    target: "project_file",
    mutationType: "apply_bundle",
    riskClass: "high",
    rationale: "Apply coordinated docs drafts.",
    proposedChange: {
      projectFileBundle: {
        draftIds: [firstDraft.id, secondDraft.id],
      },
    },
  });

  assert.equal(readFileSync(firstPath, "utf8"), "First bundle file\n");
  assert.equal(readFileSync(secondPath, "utf8"), "Second bundle file\n");
  assert.equal(applied.mutation.status, "applied");
  assert.equal(applied.mutation.target, "project_file");
  assert.equal(applied.mutation.mutationType, "apply_bundle");
  assert.deepEqual(applied.mutation.affectedResources, [
    {
      type: "project_file",
      id: "docs/bundle-apply-first.md",
      path: "docs/bundle-apply-first.md",
    },
    {
      type: "project_file",
      id: "docs/bundle-apply-second.md",
      path: "docs/bundle-apply-second.md",
    },
  ]);
  assert.equal(projectFileDrafts.get(firstDraft.id)?.status, "applied");
  assert.equal(projectFileDrafts.get(secondDraft.id)?.status, "applied");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: FAIL with unsupported `project_file.apply_bundle`.

## Task 2: Bundle Adapter Implementation

**Files:**

- Modify: `src/assignments/autonomous-mutations.ts`
- Test: `tests/assignment-autonomous-mutations.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

```bash
npx gitnexus impact AutonomousMutationExecutor --repo codex-phantom --direction upstream
```

Expected: report risk and impacted flows before edits.

- [ ] **Step 2: Add constants and registration**

Add beside the existing project-file constants:

```ts
const PROJECT_FILE_APPLY_BUNDLE_MUTATION_CLASS = "project_file.apply_bundle";
const MAX_PROJECT_FILE_BUNDLE_DRAFTS = 10;
```

Register after the single-draft apply adapter when `projectFileDrafts` and `projectFileApply` exist:

```ts
adapters.push(
  createProjectFileApplyBundleAutonomousMutationAdapter(
    projectFileDrafts,
    projectFileApply
  )
);
```

Update the unsupported mutation error string to include `project_file.apply_bundle`.

- [ ] **Step 3: Add bundle helper types**

Add near the project-file helper functions:

```ts
type ProjectFileBundleApplyItem = {
  draftId: string;
  path: string;
  beforeFile: ProjectFileApplyBeforeSnapshot;
  afterFile: {
    path: string;
    sizeBytes: number;
    sha256: string;
  };
};

type ProjectFileBundleApplyRollback = {
  projectFileBundle: {
    items: ProjectFileBundleApplyItem[];
  };
};
```

- [ ] **Step 4: Add draft ID validation**

Add:

```ts
function requireProjectFileBundleDraftIds(value: JsonValue): string[] {
  if (!Array.isArray(value)) {
    throw new Error("projectFileBundle.draftIds must be an array");
  }
  if (value.length < 1 || value.length > MAX_PROJECT_FILE_BUNDLE_DRAFTS) {
    throw new Error(
      `projectFileBundle.draftIds must contain 1 to ${MAX_PROJECT_FILE_BUNDLE_DRAFTS} draft ids`
    );
  }
  const ids = value.map((item, index) =>
    requiredString(item, `projectFileBundle.draftIds[${index}]`)
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error("projectFileBundle.draftIds must be unique");
  }
  return ids;
}
```

- [ ] **Step 5: Implement the adapter**

Add:

```ts
function createProjectFileApplyBundleAutonomousMutationAdapter(
  projectFileDrafts: ProjectFileDraftStore,
  projectFileApply: ProjectFileApplyService
): AutonomousMutationAdapter {
  return {
    target: "project_file",
    mutationType: "apply_bundle",
    mutationClass: PROJECT_FILE_APPLY_BUNDLE_MUTATION_CLASS,
    minimumRiskClass: "high",
    rollbackConflictScope: "global",
    affectedResources: [{ type: "project_file_bundle" }],
    apply(input) {
      const proposedChange = asJsonObject(
        input.request.proposedChange,
        "proposedChange"
      );
      const bundleInput = asJsonObject(
        proposedChange.projectFileBundle,
        "proposedChange.projectFileBundle"
      );
      const draftIds = requireProjectFileBundleDraftIds(bundleInput.draftIds);
      const drafts = draftIds.map((draftId) => {
        const draft = projectFileDrafts.get(draftId);
        if (!draft) {
          throw new Error(`Project file draft not found: ${draftId}`);
        }
        if (draft.assignmentId !== input.assignment.id) {
          throw new Error("Project file draft does not belong to assignment");
        }
        if (draft.status !== "active") {
          throw new Error("Project file draft is not active");
        }
        return draft;
      });
      const paths = drafts.map((draft) => draft.path);
      if (new Set(paths).size !== paths.length) {
        throw new Error(
          "projectFileBundle.draftIds cannot target duplicate paths"
        );
      }

      const applied: ProjectFileBundleApplyItem[] = [];
      const appliedDraftIds: string[] = [];
      const appliedDraftSummaries = new Map<
        string,
        ReturnType<typeof projectFileDraftSummary>
      >();
      try {
        for (const draft of drafts) {
          const result = projectFileApply.apply({
            path: draft.path,
            content: draft.content,
          });
          applied.push({
            draftId: draft.id,
            path: draft.path,
            beforeFile: result.before,
            afterFile: result.after,
          });
          const appliedDraft = projectFileDrafts.markApplied(draft.id, {
            mutationId: input.mutationId,
            sha256: result.after.sha256,
          });
          appliedDraftIds.push(draft.id);
          appliedDraftSummaries.set(
            draft.id,
            projectFileDraftSummary(appliedDraft)
          );
        }
      } catch (error) {
        for (const item of applied.slice().reverse()) {
          projectFileApply.rollback(item.beforeFile);
        }
        for (const draftId of appliedDraftIds.reverse()) {
          projectFileDrafts.markActiveAfterApplyRollback(draftId);
        }
        throw error;
      }

      const affectedResources = applied.map((item) => ({
        type: "project_file",
        id: item.path,
        path: item.path,
      }));
      return {
        before: {
          files: applied.map((item) => ({
            draftId: item.draftId,
            path: item.path,
            beforeFile: item.beforeFile,
          })),
        } as unknown as JsonValue,
        after: {
          files: applied.map((item) => ({
            draft: appliedDraftSummaries.get(item.draftId),
            file: item.afterFile,
          })),
        } as unknown as JsonValue,
        rollback: {
          projectFileBundle: {
            items: applied,
          },
        } as unknown as JsonValue,
        affectedResources,
        verificationMethod: "project_file_apply_bundle_write",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const bundle = asJsonObject(
        rollback.projectFileBundle,
        "rollback.projectFileBundle"
      );
      if (!Array.isArray(bundle.items)) {
        throw new Error("rollback.projectFileBundle.items must be an array");
      }
      for (const itemValue of bundle.items.slice().reverse()) {
        const item = normalizeProjectFileBundleRollbackItem(itemValue);
        projectFileApply.rollback(item.beforeFile);
        projectFileDrafts.markActiveAfterApplyRollback(item.draftId);
      }
      return { verificationMethod: "project_file_apply_bundle_rollback" };
    },
  };
}
```

- [ ] **Step 6: Add rollback item normalization**

Add:

```ts
function normalizeProjectFileBundleRollbackItem(
  value: JsonValue
): ProjectFileBundleApplyItem {
  const item = asJsonObject(value, "rollback.projectFileBundle.items[]");
  const draftId = requiredString(
    item.draftId,
    "rollback.projectFileBundle.item.draftId"
  );
  const path = requiredString(
    item.path,
    "rollback.projectFileBundle.item.path"
  );
  const afterFile = asJsonObject(
    item.afterFile,
    "rollback.projectFileBundle.item.afterFile"
  );
  if (typeof afterFile.sizeBytes !== "number") {
    throw new Error(
      "rollback.projectFileBundle.item.afterFile.sizeBytes must be a number"
    );
  }
  return {
    draftId,
    path,
    beforeFile: normalizeProjectFileApplyBeforeSnapshot(item.beforeFile),
    afterFile: {
      path: requiredString(
        afterFile.path,
        "rollback.projectFileBundle.item.afterFile.path"
      ),
      sizeBytes: afterFile.sizeBytes,
      sha256: requiredString(
        afterFile.sha256,
        "rollback.projectFileBundle.item.afterFile.sha256"
      ),
    },
  };
}
```

- [ ] **Step 7: Run focused tests and verify GREEN**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: PASS for the new happy path and existing autonomous mutation tests.

## Task 3: Safety And Atomicity Coverage

**Files:**

- Modify: `tests/assignment-autonomous-mutations.test.ts`
- Modify: `src/assignments/autonomous-mutations.ts`

- [ ] **Step 1: Add policy and risk test**

Add a test that asserts:

- default `evolve` policy rejects `project_file.apply_bundle`;
- `execute`, `draft`, and `observe` assignments reject it;
- `maxRiskClass: "medium"` rejects it and failed ledger evidence uses `riskClass: "high"`;
- no files are written.

Use the existing `AutonomousMutationExecutor keeps project file apply explicitly opt-in and high risk` test as the local template.

- [ ] **Step 2: Add malformed input test**

Add a test that asserts each attempt creates failed ledger evidence and writes no files:

```ts
const attempts: Array<{ proposedChange: JsonValue; message: RegExp }> = [
  {
    proposedChange: {},
    message: /proposedChange.projectFileBundle must be a JSON object/,
  },
  {
    proposedChange: { projectFileBundle: {} },
    message: /projectFileBundle.draftIds must be an array/,
  },
  {
    proposedChange: { projectFileBundle: { draftIds: [] } },
    message: /draftIds must contain 1 to 10/,
  },
  {
    proposedChange: {
      projectFileBundle: { draftIds: [validDraft.id, validDraft.id] },
    },
    message: /draftIds must be unique/,
  },
  {
    proposedChange: {
      projectFileBundle: { draftIds: [wrongAssignmentDraft.id] },
    },
    message: /does not belong to assignment/,
  },
  {
    proposedChange: { projectFileBundle: { draftIds: [rolledBackDraft.id] } },
    message: /Project file draft is not active/,
  },
  {
    proposedChange: {
      projectFileBundle: { draftIds: [firstPathDraft.id, secondPathDraft.id] },
    },
    message: /duplicate paths/,
  },
];
```

- [ ] **Step 3: Add mid-bundle rollback test**

Create two drafts where the first writes a normal file and the second targets a symlink path. Assert:

- executor throws a 400 failed mutation;
- the first file is absent or restored to its prior content;
- both draft statuses remain `active`;
- symlink target outside the repo is unchanged.

Use `symlinkSync()` and `unlinkIfPresent()` patterns from the single-draft apply tests.

- [ ] **Step 4: Run focused tests**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: PASS.

## Task 4: Rollback Coverage

**Files:**

- Modify: `tests/assignment-autonomous-mutations.test.ts`
- Modify: `src/assignments/autonomous-mutations.ts`

- [ ] **Step 1: Add bundle rollback test**

Add a test that:

- writes one preexisting binary/non-UTF8 file;
- applies a bundle with one new file and one replacement file;
- asserts both drafts are `applied`;
- rolls back the bundle mutation;
- asserts the new file is deleted;
- asserts the preexisting file bytes are restored exactly;
- asserts both drafts are `active`;
- asserts mutation status is `rolled_back`.

- [ ] **Step 2: Add rollback-order test**

Add a test that:

- creates two draft mutations;
- applies them as a bundle;
- tries to roll back one original draft mutation before bundle rollback;
- expects a 400 and no filesystem change;
- rolls back the bundle;
- then rolls back the original draft mutations successfully.

- [ ] **Step 3: Add stale rollback test**

Add a test that:

- assignment A applies bundle A;
- assignment B applies bundle B afterward;
- rollback of bundle A fails with 409 because a newer `project_file.apply_bundle` exists;
- files remain at bundle B content.

- [ ] **Step 4: Run focused tests**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: PASS.

## Task 5: Planner And HTTP Coverage

**Files:**

- Modify: `src/assignments/wakeup-planner.ts`
- Modify: `tests/assignment-wakeup-planner.test.ts`
- Modify: `tests/server.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

```bash
npx gitnexus impact AssignmentWakeupPlanner --repo codex-phantom --direction upstream
npx gitnexus impact HttpServer --repo codex-phantom --direction upstream
```

Expected: report risk and impacted flows before edits.

- [ ] **Step 2: Add planner marker example**

Update the planner prompt examples to include:

```text
ASSIGNMENT_MUTATION: {"target":"project_file","mutationType":"apply_bundle","riskClass":"high","rationale":"Apply coordinated project-file drafts.","proposedChange":{"projectFileBundle":{"draftIds":["pfd_123","pfd_456"]}}}
```

- [ ] **Step 3: Add planner test**

Add a test that:

- creates an `evolve` assignment with `project_file.apply_bundle` allowed and `maxRiskClass: "high"`;
- creates two active drafts owned by that assignment;
- makes the fake coordinator return one `ASSIGNMENT_MUTATION:` marker for the bundle;
- runs the wakeup planner;
- asserts both files exist, both drafts are `applied`, and the ledger has an applied `project_file.apply_bundle` mutation.

- [ ] **Step 4: Add HTTP test coverage**

Extend the admin route coverage to:

- create an assignment with `project_file.apply_bundle` allowed;
- create two drafts;
- `POST /admin/assignments/:id/mutations/apply` with bundle body;
- assert response mutation is applied;
- assert `/admin/assignments/:id/mutations`, `/admin/mutations`, `/admin/timeline`, and export-backed surfaces include the bundle mutation through existing ledger paths;
- rollback via `/admin/assignments/:id/mutations/:mutationId/rollback`;
- assert files and draft statuses are restored.

- [ ] **Step 5: Run focused tests**

```bash
node --experimental-strip-types --test tests/assignment-wakeup-planner.test.ts tests/server.test.ts
```

Expected: PASS.

## Task 6: MCP And Docs

**Files:**

- Modify: `tests/mcp.test.ts`
- Modify: `docs/self-evolution.md`
- Modify: `docs/phantom-parity.md`
- Modify: `docs/project-status.md` after final verification only.

- [ ] **Step 1: Keep MCP read-only**

If current MCP guard does not already reject `bundle`, add `tool.id.includes("bundle")` to the forbidden write-capability assertion. Do not add any MCP tool for bundle apply.

- [ ] **Step 2: Update `docs/self-evolution.md`**

Document:

- `project_file.apply_bundle` is explicit opt-in and high risk;
- it applies only existing same-assignment active drafts;
- it validates all drafts before writing;
- it rejects duplicate paths and symlinked paths;
- it records per-file byte rollback evidence;
- rollback restores bytes or deletes newly-created files;
- no patches, direct content, staging, commits, pushes, installs, or MCP write capability.

- [ ] **Step 3: Update `docs/phantom-parity.md`**

Move the self-evolution row forward from single-draft apply to bounded draft-bundle apply. Keep broader patch semantics, direct source rewriting, staged changes, commits, and safe memory/prompt mutation classes as remaining gaps.

- [ ] **Step 4: Run docs/test focused checks**

```bash
node --experimental-strip-types --test tests/mcp.test.ts
git diff --check
```

Expected: PASS.

## Task 7: Final Verification, Reviewer Loop, PR, Merge

**Files:**

- Modify: `docs/project-status.md` after verification passes.

- [ ] **Step 1: Run full verification**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
node --experimental-strip-types --test tests/assignment-mutation-ledger.test.ts tests/self-evolution-mutations.test.ts tests/operator-export.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

Expected: all commands pass.

- [ ] **Step 2: Stage and run GitNexus change detection**

```bash
git add src/assignments/autonomous-mutations.ts src/assignments/wakeup-planner.ts tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts docs/self-evolution.md docs/phantom-parity.md docs/superpowers/plans/2026-06-17-autonomous-project-file-bundle-apply.md
npm_config_cache=/tmp/codex-npm-cache-project-file-bundle-detect npx gitnexus detect-changes --scope staged --repo codex-phantom
```

Expected: output lists only expected symbols and flows. If risk is HIGH or CRITICAL, include the blast radius in the PR body and reviewer prompt.

- [ ] **Step 3: Run independent reviewer loop**

Spawn a GPT-5.4 xhigh reviewer with:

- `gitnexus-impact-analysis`
- `gitnexus-pr-review` or `gitnexus-debugging`
- `tdd`
- `superpowers:requesting-code-review`
- `superpowers:verification-before-completion`

Reviewer prompt must ask for:

- correctness;
- policy bypasses;
- ledger/audit gaps;
- atomicity and rollback integrity;
- symlink/path safety;
- API compatibility;
- MCP read-only preservation;
- missing tests.

Address all Critical and Important findings. Address Minor findings when low-risk and relevant. Rerun focused tests after fixes, then rerun the full verification commands and GitNexus detect-changes.

- [ ] **Step 4: Commit implementation**

```bash
git commit -m "feat(assignments): apply project file draft bundles"
```

Expected: commit hook passes.

- [ ] **Step 5: Update project ledger**

Update `docs/project-status.md`:

- Last updated date;
- branch;
- latest verified implementation commit;
- Just Completed entry for `project_file.apply_bundle`;
- exact verification commands that passed;
- reviewer loop result.

Then commit:

```bash
git add docs/project-status.md
git commit -m "docs(status): record project file bundle apply wave"
```

- [ ] **Step 6: Push, PR, Copilot, CI, merge**

```bash
git push -u origin jarvis/autonomous-project-file-bundle-apply
gh pr create --base main --head jarvis/autonomous-project-file-bundle-apply --title "feat(assignments): apply project file draft bundles" --body-file /private/tmp/codex-phantom-project-file-bundle-apply-pr-body.md
gh pr edit <number> --add-reviewer copilot-pull-request-reviewer
gh pr checks <number> --watch
```

After CI passes and review threads are clear:

```bash
gh pr merge <number> --merge --delete-branch
```

## Testing Plan

- Service-level:
  - bundle apply creates multiple files from existing drafts;
  - default policy, non-evolve levels, and medium max risk are blocked;
  - malformed body, duplicate draft IDs, duplicate paths, missing draft, wrong assignment, and non-active drafts fail without writes;
  - mid-bundle failure rolls back already-applied files and draft statuses;
  - rollback deletes newly-created files and restores previous bytes;
  - draft mutation rollback is blocked until bundle apply rollback;
  - stale bundle rollback is blocked when a newer bundle exists.
- Planner:
  - explicitly allowed planner marker applies a bundle through the executor.
- HTTP:
  - authenticated apply and rollback through existing admin routes;
  - unauthenticated calls stay rejected by existing auth coverage;
  - mutation appears in assignment/global/timeline/export surfaces through ledger-backed routes.
- MCP:
  - assignment mutation tooling remains read-only and exposes no bundle apply/write/stage/commit/push/install tool.

## Acceptance Criteria

- An explicitly opted-in `evolve` assignment can atomically apply 1 to 10 existing same-assignment active project-file drafts.
- No file is changed when validation fails before apply.
- If a mid-bundle write fails, all earlier writes are rolled back and all draft statuses return to their prior active state.
- Successful apply records per-file before/after/rollback evidence in `assignment_mutations`.
- Rollback restores prior file bytes or deletes newly-created files and marks all bundle drafts active again.
- Original draft mutations cannot be rolled back while their drafts are applied by a bundle.
- `project_file.apply_bundle` is blocked by default policy, non-`evolve` assignments, and `maxRiskClass` below high.
- Existing single-draft apply behavior remains unchanged.
- Existing proposal-based self-evolution APIs remain unchanged.
- Existing read-only MCP assignment tooling remains read-only.
- Docs and project ledger describe the capability only after verification passes.

## Self-Review Checklist

- Spec coverage: every in-scope behavior maps to a task above.
- Placeholder scan: no task uses TBD/TODO/fill-in-later instructions.
- Type consistency: request shape uses `projectFileBundle.draftIds`; mutation class is `project_file.apply_bundle`; target/type is `project_file`/`apply_bundle`.
- Scope guard: no direct content, patch, staging, commit, push, install, or MCP write capability is introduced.
