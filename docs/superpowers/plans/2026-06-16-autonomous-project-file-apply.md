# Autonomous Project File Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the next bounded filesystem-write slice: an explicitly opted-in `evolve` assignment can apply one existing assignment-owned project-file draft to the repository working tree and roll it back through autonomous mutation ledger evidence.

**Architecture:** Reuse the existing `ProjectFileDraftStore` path/content validation and extend it with applied-file status metadata. Add a small filesystem applier module that resolves normalized draft paths under the real repository root, rejects symlinked path components, snapshots existing file bytes, writes only safe text content, and restores the prior byte state on rollback. Register a high-risk `project_file.apply_draft` autonomous mutation adapter that references an existing active draft id, records before/after/rollback evidence, uses a conservative global stale-rollback guard for the mutation class, and never stages, commits, pushes, installs, or exposes MCP write tools.

**Tech Stack:** TypeScript ESM, Node built-in `node:fs`, `node:path`, `node:crypto`, SQLite via `AppDatabase`, Node `node:test`, GitNexus CLI, tmux + Claude Code reviewer.

---

## Scope

### In Scope

- Mutation class: `project_file.apply_draft`.
- Target/type: `target: "project_file"`, `mutationType: "apply_draft"`.
- Apply only an existing `project_file_drafts` row created by the same assignment.
- Require draft status `active`; applied or rolled-back drafts cannot be applied again.
- Apply writes exactly the draft content to the draft path in the current repo working tree.
- Supported text content is inherited from `project_file.draft` validation.
- Rollback restores the prior file state:
  - if the file did not exist before apply, delete the created file;
  - if the file existed before apply, restore exact prior bytes.
- Apply stores rollback evidence in `assignment_mutations.rollback`:
  - `draftId`
  - normalized path
  - `beforeFile` existence, size, sha256, and base64 bytes when the file existed
  - `afterFile` size and sha256
- Apply marks the draft as applied with applied mutation id, applied timestamp, and path hash metadata.
- Rollback marks the draft as active again when the applied mutation is rolled back.
- Stale rollback is conservative and global for the mutation class: a newer applied `project_file.apply_draft` blocks rollback until path-scoped ledger conflict checks are added in a later slice.
- Admin/internal API uses the existing `/admin/assignments/:id/mutations/apply` and rollback routes.
- Planner markers can request `project_file.apply_draft` when explicitly allow-listed.
- MCP assignment mutation tooling remains read-only.

### Out Of Scope

- Applying arbitrary inline content directly; this slice only applies an existing draft id.
- Applying patches, diffs, multi-file changes, binary draft content, generated files, symlinked paths, or protected paths.
- Staging, committing, pushing, installing dependencies, running shell commands, changing `.env`, `.git`, `node_modules`, `dist`, `coverage`, hidden paths, or write-capable MCP tools.
- Proposal-based project-file apply; proposals remain separate from assignment-authorized autonomous apply.
- Operator UI for browsing/applying drafts.

## Required Skills

- `tdd`: implement one behavior test at a time using red-green-refactor.
- `superpowers:writing-plans`: this plan.
- `superpowers:executing-plans`: execute the plan task-by-task in this branch.
- `superpowers:verification-before-completion`: run full gates before claiming completion, committing, PR creation, and merge.
- `tmux-workflows`: run the required Claude Code reviewer loop in tmux using the default Claude Code model.
- `gitnexus-impact-analysis`: run before editing existing symbols.
- `gitnexus-pr-review` or `gitnexus-debugging`: use in reviewer prompt and any follow-up diagnosis.
- `mcp-builder`: use only as a safety lens for MCP exposure; this slice must not add write-capable MCP tools.

## GitNexus Impact Targets

Run impact analysis before editing these existing symbols:

```bash
npx gitnexus impact ProjectFileDraftStore --repo codex-phantom --direction upstream
npx gitnexus impact AutonomousMutationExecutor --repo codex-phantom --direction upstream
npx gitnexus impact AppDatabase --repo codex-phantom --direction upstream
npx gitnexus impact AssignmentWakeupPlanner --repo codex-phantom --direction upstream
npx gitnexus impact HttpServer --repo codex-phantom --direction upstream
```

If any result is HIGH or CRITICAL, report the blast radius before editing and expand focused regression tests around the affected flows.

## Files

- Modify `src/project-files/drafts.ts`
  - Add applied draft status fields and store methods:
    - `markApplied(id, input)`
    - `markActiveAfterApplyRollback(id)`
  - Keep existing draft validation unchanged.
- Create `src/project-files/apply.ts`
  - `ProjectFileApplyService`
  - `ProjectFileApplyBeforeSnapshot`
  - `ProjectFileApplyResult`
  - `restoreProjectFileApplySnapshot`
  - repo-root path resolution and parent-directory creation.
- Modify `src/platform/database.ts`
  - Add nullable applied metadata columns to `project_file_drafts`:
    - `applied_mutation_id`
    - `applied_at`
    - `applied_sha256`
- Modify `src/assignments/autonomous-mutations.ts`
  - Add `projectFileApply?: ProjectFileApplyService` to options.
  - Register `project_file.apply_draft`.
  - Add high-risk floor for apply.
  - Add path-scoped affected resource evidence.
  - Add rollback implementation.
- Modify `src/index.ts`
  - Instantiate `ProjectFileApplyService` with the repo root and pass it to the executor.
- Modify `src/server/http-server.ts`
  - Create/pass `ProjectFileApplyService` for test/server constructor flows.
- Modify `src/assignments/wakeup-planner.ts`
  - Add a planner marker example for `project_file.apply_draft`.
- Modify `tests/assignment-autonomous-mutations.test.ts`
  - Add service-level apply, safety, and rollback coverage.
- Modify `tests/assignment-wakeup-planner.test.ts`
  - Add planner marker coverage.
- Modify `tests/server.test.ts`
  - Add HTTP apply/rollback/list/timeline coverage.
- Modify `tests/mcp.test.ts`
  - Keep guard that MCP exposes no write-capable project-file apply tools.
- Modify docs:
  - `docs/self-evolution.md`
  - `docs/phantom-parity.md`
  - `docs/project-status.md` at wave end after verification.

## Task 1: Failing Service-Level Happy Path

**Files:**

- Modify: `tests/assignment-autonomous-mutations.test.ts`

- [ ] **Step 1: Add a failing behavior test**

Add a test near the existing project-file draft tests:

```ts
test("AutonomousMutationExecutor applies an existing project file draft to the repository filesystem", (t) => {
  const { assignments, database, executor, projectFileDrafts } =
    createProjectFileDraftHarness();
  const cleanupPath = join(
    process.cwd(),
    "docs/autonomous-project-file-apply-test.md"
  );
  t.after(() => {
    if (existsSync(cleanupPath)) {
      unlinkSync(cleanupPath);
    }
    database.close();
  });
  const assignment = assignments.create({
    objective: "Apply docs draft",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "project_file.draft",
          "project_file.apply_draft",
        ],
        maxRiskClass: "high",
      },
    },
  });
  const draftApply = executor.apply({
    assignmentId: assignment.assignment.id,
    runId: "coord_project_file_apply_draft",
    target: "project_file",
    mutationType: "draft",
    rationale: "Create draft before applying.",
    proposedChange: {
      projectFileDraft: {
        path: "docs/autonomous-project-file-apply-test.md",
        content: "# Applied Draft\n",
        contentType: "text/markdown",
      },
    },
  });
  const draftId = (
    draftApply.mutation.rollback as { projectFileDraft: { id: string } }
  ).projectFileDraft.id;

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    runId: "coord_project_file_apply",
    target: "project_file",
    mutationType: "apply_draft",
    riskClass: "high",
    rationale: "Apply the already-audited project file draft.",
    proposedChange: {
      projectFileApply: { draftId },
    },
  });

  assert.equal(readFileSync(cleanupPath, "utf8"), "# Applied Draft\n");
  assert.equal(applied.mutation.status, "applied");
  assert.equal(applied.mutation.target, "project_file");
  assert.equal(applied.mutation.mutationType, "apply_draft");
  assert.deepEqual(applied.mutation.affectedResources, [
    {
      type: "project_file",
      id: "docs/autonomous-project-file-apply-test.md",
      path: "docs/autonomous-project-file-apply-test.md",
    },
  ]);
  assert.equal(projectFileDrafts.get(draftId)?.status, "applied");
  assert.deepEqual(
    assignments
      .timeline(assignment.assignment.id)
      .events.map((event) => event.type),
    [
      "created",
      "mutation_planned",
      "mutation_applied",
      "mutation_planned",
      "mutation_applied",
    ]
  );
});
```

Import `readFileSync` and `unlinkSync` from `node:fs` if not already imported.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: FAIL because `project_file.apply_draft` is unsupported or no apply service exists.

## Task 2: Draft Store Status And Migration

**Files:**

- Modify: `src/project-files/drafts.ts`
- Modify: `src/platform/database.ts`
- Test: `tests/assignment-autonomous-mutations.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

Run:

```bash
npx gitnexus impact ProjectFileDraftStore --repo codex-phantom --direction upstream
npx gitnexus impact AppDatabase --repo codex-phantom --direction upstream
```

Report HIGH/CRITICAL blast radius before editing.

- [ ] **Step 2: Extend draft status and row shape**

Change `ProjectFileDraftStatus`:

```ts
export type ProjectFileDraftStatus = "active" | "applied" | "rolled_back";
```

Add these optional fields to `ProjectFileDraftRecord`:

```ts
appliedMutationId?: string;
appliedAt?: string;
appliedSha256?: string;
```

Add matching nullable fields to `ProjectFileDraftRow`, `toProjectFileDraftRecord()`, and `projectFileDraftSummary()`.

- [ ] **Step 3: Add database migration columns**

In `AppDatabase.migrate()`, add idempotent column migrations:

```ts
this.addColumnIfMissing("project_file_drafts", "applied_mutation_id", "TEXT");
this.addColumnIfMissing("project_file_drafts", "applied_at", "TEXT");
this.addColumnIfMissing("project_file_drafts", "applied_sha256", "TEXT");
```

Use the existing local migration helper pattern in `src/platform/database.ts`.

- [ ] **Step 4: Add draft store methods**

Add:

```ts
markApplied(
  id: string,
  input: { mutationId: string; sha256: string }
): ProjectFileDraftRecord
```

Behavior:

- throw `"Project file draft not found"` if missing;
- throw `"Project file draft is not active"` if status is not `active`;
- set status `applied`, `applied_mutation_id`, `applied_at`, `applied_sha256`, and `updated_at`.

Add:

```ts
markActiveAfterApplyRollback(id: string): ProjectFileDraftRecord
```

Behavior:

- throw `"Project file draft not found"` if missing;
- if status is `applied`, restore status to `active`, clear applied columns, and update `updated_at`;
- if status is already `active`, return it unchanged;
- if status is `rolled_back`, throw `"Rolled back project file draft cannot be reactivated"`.

- [ ] **Step 5: Run focused tests**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: still FAIL until the apply adapter is added.

## Task 3: Filesystem Apply Service

**Files:**

- Create: `src/project-files/apply.ts`
- Test: `tests/assignment-autonomous-mutations.test.ts`

- [ ] **Step 1: Implement `ProjectFileApplyService`**

Create a small service with:

```ts
export type ProjectFileApplyBeforeSnapshot = {
  path: string;
  existed: boolean;
  contentBase64?: string;
  sizeBytes?: number;
  sha256?: string;
};

export type ProjectFileApplyResult = {
  path: string;
  before: ProjectFileApplyBeforeSnapshot;
  after: {
    path: string;
    sizeBytes: number;
    sha256: string;
  };
};

export class ProjectFileApplyService {
  constructor(input: { repoRoot: string }) {}
  apply(input: { path: string; content: string }): ProjectFileApplyResult {}
  rollback(snapshot: ProjectFileApplyBeforeSnapshot): void {}
}
```

Implementation rules:

- normalize paths with `normalizeProjectFilePath()`;
- resolve path under the real `repoRoot`;
- reject path escapes after resolution;
- reject existing symlinked path components before writing or rolling back;
- create parent directories with `mkdirSync(parent, { recursive: true })`;
- snapshot existing bytes with `readFileSync(...)` and store rollback bytes as base64;
- write draft content with `writeFileSync(..., content, "utf8")`;
- compute SHA-256 from UTF-8 content;
- rollback deletes created files with `unlinkSync` if `existed === false`;
- rollback restores prior bytes if `existed === true`;
- cleanup empty parent directories is optional and not required.

- [ ] **Step 2: Wire the harness**

Update `createProjectFileDraftHarness()` to construct:

```ts
const projectFileApply = new ProjectFileApplyService({
  repoRoot: process.cwd(),
});
```

Pass `projectFileApply` into `AutonomousMutationExecutor`.

- [ ] **Step 3: Run focused test**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: still FAIL until executor registers `project_file.apply_draft`.

## Task 4: Autonomous Mutation Adapter

**Files:**

- Modify: `src/assignments/autonomous-mutations.ts`
- Test: `tests/assignment-autonomous-mutations.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

```bash
npx gitnexus impact AutonomousMutationExecutor --repo codex-phantom --direction upstream
```

Report HIGH/CRITICAL before editing.

- [ ] **Step 2: Add executor option and mutation class**

Add:

```ts
projectFileApply?: ProjectFileApplyService;
```

Add:

```ts
const PROJECT_FILE_APPLY_DRAFT_MUTATION_CLASS = "project_file.apply_draft";
```

Register the adapter only when both `projectFileDrafts` and `projectFileApply` are present.

- [ ] **Step 3: Add apply behavior**

Adapter behavior:

- `target: "project_file"`;
- `mutationType: "apply_draft"`;
- `mutationClass: "project_file.apply_draft"`;
- `minimumRiskClass: "high"`;
- `rollbackConflictScope: "global"`;
- parse `proposedChange.projectFileApply.draftId`;
- load draft by id;
- reject missing draft with 404-style execution error or adapter error that becomes failed ledger evidence;
- reject draft whose assignment id differs from the current assignment;
- reject draft whose status is not `active`;
- call `projectFileApply.apply({ path: draft.path, content: draft.content })`;
- mark draft applied using the current mutation id. If the adapter does not know the mutation id, add `mutationId` to `AutonomousMutationAdapter.apply()` input from the planned ledger row before adapter apply.
- return before/after/rollback evidence:

```ts
{
  before: result.before,
  after: {
    draft: projectFileDraftSummary(appliedDraft),
    file: result.after,
  },
  rollback: {
    projectFileApply: {
      draftId: draft.id,
      path: draft.path,
      beforeFile: result.before,
    },
  },
  affectedResources: [
    { type: "project_file", id: draft.path, path: draft.path },
  ],
  verificationMethod: "project_file_apply_draft_write"
}
```

- [ ] **Step 4: Add rollback behavior**

Rollback behavior:

- parse `rollback.projectFileApply`;
- restore `beforeFile` via `ProjectFileApplyService.rollback()`;
- mark the draft active again using `markActiveAfterApplyRollback(draftId)`;
- return `verificationMethod: "project_file_apply_draft_rollback"`.

- [ ] **Step 5: Run focused test and verify GREEN for happy path**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: the new happy-path test passes.

## Task 5: Safety, Authorization, And Rollback Tests

**Files:**

- Modify: `tests/assignment-autonomous-mutations.test.ts`
- Modify implementation files as needed.

- [ ] **Step 1: Add opt-in/risk test**

Add a test named:

```ts
test("AutonomousMutationExecutor keeps project file apply explicitly opt-in and high risk", () => {});
```

Cover:

- default `evolve` assignment denies `project_file.apply_draft`;
- `execute`, `draft`, and `observe` deny even when allow-listed;
- an `evolve` assignment with allow-list but `maxRiskClass: "medium"` denies even if caller omits `riskClass`.

- [ ] **Step 2: Add malformed/stale draft tests**

Add a test named:

```ts
test("AutonomousMutationExecutor rejects unsafe project file apply requests without writing files", () => {});
```

Cover:

- missing `projectFileApply`;
- missing `draftId`;
- draft id not found;
- draft belongs to another assignment;
- draft status is `rolled_back`;
- apply does not create or change the target file for any rejected attempt;
- failed ledger evidence is created when the request reaches the executor policy gate.

- [ ] **Step 3: Add rollback restore tests**

Add:

```ts
test("AutonomousMutationExecutor rolls back project file apply mutations", () => {});
```

Cover:

- when no file existed before apply, rollback deletes the file and marks the draft active again;
- when a file existed before apply, rollback restores the exact previous bytes and marks the draft active again;
- ledger status becomes `rolled_back`;
- assignment timeline records `mutation_rolled_back`.

- [ ] **Step 4: Add stale rollback test**

Add:

```ts
test("AutonomousMutationExecutor blocks stale project file apply rollback across assignments", () => {});
```

Cover:

- assignment A applies draft to `docs/shared.md`;
- assignment B applies a newer draft to the same path, demonstrating the conservative global mutation-class conflict guard;
- rollback of assignment A apply fails with 409;
- file remains at assignment B content.

- [ ] **Step 5: Run focused tests**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: all project-file apply tests pass.

## Task 6: HTTP, Planner, MCP, And Docs

**Files:**

- Modify: `src/index.ts`
- Modify: `src/server/http-server.ts`
- Modify: `src/assignments/wakeup-planner.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/assignment-wakeup-planner.test.ts`
- Modify: `tests/mcp.test.ts`
- Modify: `docs/self-evolution.md`
- Modify: `docs/phantom-parity.md`

- [ ] **Step 1: Run impact analysis**

```bash
npx gitnexus impact AssignmentWakeupPlanner --repo codex-phantom --direction upstream
npx gitnexus impact HttpServer --repo codex-phantom --direction upstream
```

Report HIGH/CRITICAL before editing.

- [ ] **Step 2: Wire runtime constructors**

In `src/index.ts`, instantiate `ProjectFileApplyService` with `repoRoot: process.cwd()` near `ProjectFileDraftStore`.

In `HttpServer`, accept optional `projectFileApply?: ProjectFileApplyService`, create a fallback when absent, and pass it to its internal `AutonomousMutationExecutor`.

- [ ] **Step 3: Add HTTP coverage**

In the existing autonomous mutation server coverage, add:

- create `evolve` assignment with `project_file.draft` and `project_file.apply_draft`;
- apply draft;
- apply draft id through HTTP;
- assert file exists with content;
- assert mutation appears in `/admin/assignments/:id/mutations`, `/admin/mutations`, `/admin/timeline`;
- rollback through HTTP;
- assert file restored/deleted.

- [ ] **Step 4: Add planner marker coverage**

Add planner marker example:

```text
ASSIGNMENT_MUTATION: {"target":"project_file","mutationType":"apply_draft","riskClass":"high","rationale":"Apply reviewed project file draft.","proposedChange":{"projectFileApply":{"draftId":"pfd_..."}}}
```

Add test `AssignmentWakeupPlanner applies explicitly allowed project file apply draft markers`.

- [ ] **Step 5: Extend MCP guard**

Ensure no MCP tool id exposes `apply_draft`, `project_file_apply`, `write_project_file`, `commit`, or `stage`.

- [ ] **Step 6: Update docs**

Update `docs/self-evolution.md`:

- document `project_file.apply_draft`;
- state it is explicit opt-in and high risk;
- state it applies only an existing same-assignment draft id;
- state rollback restores previous file bytes or deletes a newly-created file;
- state it never stages, commits, pushes, installs, follows symlinks, or exposes MCP write tools.

Update `docs/phantom-parity.md`:

- move filesystem-write gap forward to “bounded single-draft apply exists”;
- keep broader filesystem mutation, multi-file patches, staging, commits, and installs as out of scope.

- [ ] **Step 7: Run focused surface tests**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
```

Expected: PASS.

## Task 7: Final Verification, Reviewer Loop, PR, Merge

**Files:**

- Modify: `docs/project-status.md` only after verification and reviewer are clean.

- [ ] **Step 1: Run full verification before reviewer**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
node --experimental-strip-types --test tests/assignment-mutation-ledger.test.ts tests/self-evolution-mutations.test.ts tests/operator-export.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

- [ ] **Step 2: Stage implementation and run GitNexus detect-changes**

```bash
git add src/project-files/drafts.ts src/project-files/apply.ts src/platform/database.ts src/assignments/autonomous-mutations.ts src/index.ts src/server/http-server.ts src/assignments/wakeup-planner.ts tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts docs/self-evolution.md docs/phantom-parity.md docs/superpowers/plans/2026-06-16-autonomous-project-file-apply.md
npx gitnexus detect-changes --scope staged --repo codex-phantom
```

- [ ] **Step 3: Run tmux Claude Code reviewer loop**

Use `tmux-workflows` with a sentinel file:

```bash
tmux new-session -d -s codex-phantom-project-file-apply-review -n review
PANE=$(tmux new-window -t codex-phantom-project-file-apply-review -n claude-review -P -F '#{pane_id}')
tmux send-keys -t "$PANE" 'cd /Users/aaronstevens/dev/codex-phantom && claude' Enter
```

After Claude Code starts, send a prompt requiring:

- default Claude Code model (opus 4.8);
- skills/lenses: `gitnexus-impact-analysis`, `gitnexus-pr-review` or `gitnexus-debugging`, `tdd`, `verification-before-completion`;
- review current staged diff only;
- check correctness, policy bypasses, path traversal, protected path writes, draft ownership, rollback integrity, stale rollback, ledger/audit evidence, HTTP compatibility, planner compatibility, MCP write exposure, missing tests;
- write report to `/private/tmp/codex-phantom-project-file-apply-review.md`;
- run `touch /private/tmp/codex-phantom-project-file-apply-review.done` when finished.

Poll:

```bash
until [ -f /private/tmp/codex-phantom-project-file-apply-review.done ]; do sleep 5; done
cat /private/tmp/codex-phantom-project-file-apply-review.md
```

Address all Critical and Important findings, rerun focused tests and full verification, and rerun reviewer if warranted.

- [ ] **Step 4: Commit implementation**

```bash
git commit -m "feat(assignments): apply project file drafts"
```

- [ ] **Step 5: Update project status**

Update `docs/project-status.md` with branch, latest verified implementation commit, wave summary, verification commands, reviewer result, and remaining next tasks.

Then:

```bash
git add docs/project-status.md
npx gitnexus detect-changes --scope staged --repo codex-phantom
git commit -m "docs(status): record project file apply wave"
```

- [ ] **Step 6: Push and open PR**

```bash
git push -u origin jarvis/autonomous-project-file-apply
gh pr create --draft --base main --head jarvis/autonomous-project-file-apply --title "feat(assignments): apply project file drafts" --body-file /private/tmp/codex-phantom-project-file-apply-pr-body.md
gh pr ready <number>
gh pr edit <number> --add-reviewer @copilot
gh pr checks <number> --watch --fail-fast
```

Poll review threads:

```bash
gh api graphql -f owner='astev89' -f name='codex-phantom' -F number=<number> -f query='query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { reviewThreads(first:50) { nodes { isResolved isOutdated path line comments(first:10) { nodes { author { login } body url } } } } reviews(first:20) { nodes { author { login } state body url submittedAt } } } } }'
```

Address warranted Copilot comments, rerun verification, push updates, then merge:

```bash
gh pr merge <number> --merge --delete-branch
```

## Testing Plan

- Service-level:
  - apply existing same-assignment draft to absent file;
  - apply existing same-assignment draft over existing file;
  - rollback deletes newly-created file;
  - rollback restores previous bytes;
  - stale rollback across assignments is blocked;
  - default policy, non-evolve levels, and medium max risk are blocked;
  - malformed draft id, missing draft id, missing draft, wrong assignment, and non-active draft are rejected without writes.
- HTTP:
  - authenticated apply/rollback works through existing admin mutation routes;
  - unauthenticated calls remain rejected by existing route coverage;
  - list/timeline/export surfaces show mutation evidence.
- Planner:
  - explicitly allow-listed marker can apply a known draft id;
  - denied/malformed markers do not fail wakeup.
- MCP:
  - no write-capable project-file apply/stage/commit/install tools are exposed.
- Full regression:
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `git diff --check`
  - GitNexus `detect-changes`.

## Acceptance Criteria

- An explicitly opted-in `evolve` assignment can apply an existing same-assignment project-file draft to the repo working tree.
- `project_file.apply_draft` is blocked by default `evolve` policy, all non-`evolve` autonomy levels, and `maxRiskClass` below high.
- Apply cannot target arbitrary inline content, another assignment's draft, a missing draft, a rolled-back draft, protected paths, hidden paths, generated paths, binary draft content, symlinked paths, or path escapes.
- Every successful apply records before/after/rollback evidence in `assignment_mutations` and assignment timeline milestones.
- Rollback restores prior file bytes or deletes a newly-created file and records `rolled_back`.
- Stale rollback is blocked when a newer project-file apply exists; path-scoped conflict matching is reserved for a later ledger slice.
- Existing proposal-based self-evolution APIs remain unchanged.
- Existing read-only MCP assignment mutation tooling remains read-only.
- No apply path stages, commits, pushes, installs dependencies, edits `.git`, edits `.env`, follows symlinks, or creates MCP write capability.
- Docs/status reflect the new bounded filesystem-write capability only after verification passes.

## Remaining Slice Queue After This Plan

- Broader prompt rewriting beyond the single runtime-guidance overlay.
- Broader memory mutation beyond numeric runtime bounds.
- Broader configuration beyond runtime limits.
- Deeper parent/child dependency orchestration.
- Optional channel polish/live mailbox smoke when credentials are available.
