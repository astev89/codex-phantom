# Assignment Event Retention Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded assignment event retention compaction path that turns expired compactable assignment timeline details into durable non-compactable summary evidence without deleting audit or milestone history.

**Architecture:** Keep assignment event retention owned by `AutonomousAssignmentService`. Add one service method that selects expired compactable detail events per assignment, writes a non-compactable `events_compacted` milestone summary, and deletes only the compacted detail rows. Expose it through a small operator-authenticated admin route and keep MCP assignment timeline read-only.

**Tech Stack:** TypeScript ESM, Node `node:test`, SQLite through `AppDatabase`, existing HTTP server/admin auth, GitNexus, tmux-driven Claude Code review.

---

## Skills To Use

- `$superpowers:writing-plans` for this implementation plan.
- `$tdd` for red/green behavior slices through public service and HTTP surfaces.
- `$tmux-workflows` for the reviewer loop: start a detached tmux session, launch Claude Code with the default model, pass the staged diff and requirements, wait on a sentinel file, then harvest the report.
- `$gitnexus-impact-analysis` before editing `AutonomousAssignmentService`, `HttpServer`, and validation helpers.
- `$superpowers:receiving-code-review` before acting on Claude or Copilot findings.
- `$superpowers:verification-before-completion` before any completion, commit, PR, or merge claim.
- `$mcp-builder` is not needed for this slice because MCP remains read-only and no MCP server/tool write capability is added.

## Files

- Modify: `src/assignments/types.ts`
  - Add compaction input/result record types.
- Modify: `src/assignments/service.ts`
  - Add `compactEvents()` on `AutonomousAssignmentService`.
  - Add small private helpers for selecting/deleting compactable rows and building the summary payload.
- Modify: `src/server/validation.ts`
  - Add `AssignmentCompactionBodyInput` and `validateAssignmentCompactionBody()` using the existing private `optionalString`, `optionalPositiveInteger`, and `optionalIsoDate` helpers.
- Modify: `src/server/http-server.ts`
  - Add `POST /admin/assignments/:id/timeline/compact`.
- Modify: `tests/assignments.test.ts`
  - Add service-level compaction tests.
- Modify: `tests/server.test.ts`
  - Add authenticated HTTP route coverage.
- Modify: `tests/mcp.test.ts`
  - Assert assignment MCP tools remain read-only and do not expose compaction.
- Modify: `docs/project-status.md`, `docs/phantom-parity.md`, and `CONTEXT.md`
  - Update only after verification passes.

## Acceptance Criteria

- Expired compactable assignment events can be compacted for a single assignment.
- Compaction writes one non-compactable `events_compacted` milestone event with counts, time range, event type counts, and actor/reason evidence.
- Compaction deletes only the compacted compactable detail events.
- Audit and milestone events are never deleted by compaction, even when their `expires_at` is in the past.
- Non-expired compactable events are preserved unless an explicit `compactBefore` cutoff includes them.
- Re-running compaction with no eligible events is a no-op that returns `compactedCount: 0` and does not create another summary event.
- `assignment.timeline` and `/admin/assignments/:id/timeline` continue to return retention-aware events in chronological order.
- MCP assignment tools remain read-only; no write-capable MCP compaction tool is added.
- Project status and parity docs are updated after verification with branch, verified commit, commands, and completed slice.

## Testing Plan

- Service tests in `tests/assignments.test.ts`:
  - expired compactable detail events are replaced by one non-compactable summary event.
  - audit/milestone rows survive compaction.
  - no-op compaction creates no summary event.
  - explicit `compactBefore` cutoff can compact older compactable detail events while preserving newer detail events.
- HTTP tests in `tests/server.test.ts`:
  - unauthenticated compaction is rejected.
  - authenticated compaction returns `{ requestId, result, timeline }`.
  - route validates `limit`/`compactBefore` and does not mutate on malformed input.
- MCP tests in `tests/mcp.test.ts`:
  - `assignment.timeline` still reads events.
  - no assignment compaction write tool appears in `tools/list`.
- Final gates:
  - `node --experimental-strip-types --test tests/assignments.test.ts tests/server.test.ts tests/mcp.test.ts`
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `git diff --check`
  - `npx gitnexus detect-changes --scope staged --repo codex-phantom`

## Reviewer Loop

- After local verification, use `$tmux-workflows` to launch a Claude Code reviewer in tmux:

```bash
tmux new-session -d -s codex-phantom-retention-review -n review
PANE=$(tmux new-window -t codex-phantom-retention-review -n claude-review -P -F '#{pane_id}')
tmux send-keys -t "$PANE" 'cd /Users/aaronstevens/dev/codex-phantom && claude' Enter
```

- Send this prompt through a tmux buffer, then wait for `/private/tmp/codex-phantom-retention-review.done`:

```text
Review the staged assignment event retention compaction slice in /Users/aaronstevens/dev/codex-phantom.

Use the default Claude Code model. Do not edit files. Focus on correctness, audit preservation, accidental deletion, route auth/validation, MCP read-only compatibility, missing tests, and API compatibility.

Read:
- docs/superpowers/plans/2026-06-16-assignment-event-retention-compaction.md
- git diff --cached

Report Critical, Important, and Minor findings with file/line references. If no Critical or Important findings remain, say so explicitly.

When finished, write the report to /private/tmp/codex-phantom-retention-review.md and run:
touch /private/tmp/codex-phantom-retention-review.done
```

- Address all Critical and Important findings that are technically valid.
- For Minor findings, fix only those that are cheap and align with the slice boundaries.
- Rerun focused tests plus full gates after fixes.
- Before PR, request Copilot review after push, poll until Copilot has either posted a review/comment or no pending review/comment remains after CI is green, and address warranted comments.

## Implementation Tasks

### Task 1: Service-Level Compaction

**Files:**

- Modify: `src/assignments/types.ts`
- Modify: `src/assignments/service.ts`
- Test: `tests/assignments.test.ts`

- [ ] **Step 1: Write failing service tests**

Add tests named:

```ts
test("AutonomousAssignmentService compacts expired compactable assignment events", () => {
  // Create an assignment.
  // Record compactable detail events through public controls/wakeup methods.
  // Backdate their expires_at values directly in the test database.
  // Call assignments.compactEvents({ assignmentId, actor, reason }).
  // Assert compactedCount, deleted event ids, summary payload, and timeline.
});

test("AutonomousAssignmentService leaves audit and milestone events untouched during compaction", () => {
  // Backdate both compactable and non-compactable rows.
  // Call compactEvents().
  // Assert non-compactable created/policy/mutation milestones remain.
});

test("AutonomousAssignmentService no-ops when no assignment events are eligible for compaction", () => {
  // Call compactEvents() on a fresh assignment.
  // Assert compactedCount is 0 and no events_compacted event is created.
});
```

- [ ] **Step 2: Run the failing tests**

```bash
node --experimental-strip-types --test tests/assignments.test.ts
```

Expected: fails because `compactEvents` is not defined.

- [ ] **Step 3: Add public types**

Add to `src/assignments/types.ts`:

```ts
export type CompactAssignmentEventsInput = {
  assignmentId: string;
  actor?: string;
  reason?: string;
  compactBefore?: string;
  limit?: number;
};

export type CompactAssignmentEventsResult = {
  assignmentId: string;
  compactedCount: number;
  deletedEventIds: string[];
  summaryEvent?: AssignmentEventRecord;
};
```

- [ ] **Step 4: Implement minimal service compaction**

Add `compactEvents(input: CompactAssignmentEventsInput): CompactAssignmentEventsResult` to `AutonomousAssignmentService`.

Required behavior:

- call `getRequired(input.assignmentId)` first.
- default cutoff to `new Date().toISOString()`.
- select compactable rows where `expires_at IS NOT NULL AND expires_at <= cutoff`.
- order by `created_at ASC, rowid ASC`.
- bound `limit` with the existing positive limit helper.
- if no rows, return `compactedCount: 0` and no summary event.
- write one non-compactable `events_compacted` event with payload containing `actor`, `reason`, `compactedCount`, `eventTypes`, `firstEventAt`, `lastEventAt`, and `deletedEventIds`.
- delete selected rows after summary insertion in the same transaction.

- [ ] **Step 5: Run service tests**

```bash
node --experimental-strip-types --test tests/assignments.test.ts
```

Expected: pass.

### Task 2: Admin HTTP Route

**Files:**

- Modify: `src/server/http-server.ts`
- Modify: `src/server/validation.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write failing HTTP tests**

Add tests for:

- unauthenticated `POST /admin/assignments/:id/timeline/compact` returns `401`.
- authenticated call compacts eligible events and returns `result` plus refreshed `timeline`.
- malformed `compactBefore` returns `400` and leaves the timeline unchanged.

- [ ] **Step 2: Run the failing HTTP tests**

```bash
node --experimental-strip-types --test tests/server.test.ts
```

Expected: fails with route not found.

- [ ] **Step 3: Add the route**

In `HttpServer`, add the `validateAssignmentCompactionBody` import beside `validateAssignmentControlBody`, then place this route before the existing assignment timeline `GET` route:

```ts
if (
  req.method === "POST" &&
  url.pathname.startsWith("/admin/assignments/") &&
  trimTrailingSlash(url.pathname).endsWith("/timeline/compact")
) {
  this.requireOperatorAuth(req);
  const assignmentId = decodeURIComponent(
    url.pathname
      .replace("/admin/assignments/", "")
      .replace("/timeline/compact", "")
      .replace(/\/$/, "")
  );
  const body = validateAssignmentCompactionBody(
    parseJsonBody(await readTextBody(req))
  );
  const result = this.assignments.compactEvents({
    assignmentId,
    actor: body.actor,
    reason: body.reason,
    compactBefore: body.compactBefore,
    limit: body.limit,
  });
  this.json(res, 200, {
    requestId: getRequestId(req),
    result,
    timeline: this.assignments.timeline(assignmentId),
  });
  return;
}
```

Add this validator shape to `src/server/validation.ts`:

```ts
export type AssignmentCompactionBodyInput = {
  actor?: string;
  reason?: string;
  compactBefore?: string;
  limit?: number;
};

export function validateAssignmentCompactionBody(
  input: unknown
): AssignmentCompactionBodyInput {
  const value = asRecord(input);
  return {
    actor: optionalString(value.actor),
    reason: optionalString(value.reason),
    compactBefore: optionalIsoDate(value.compactBefore, "compactBefore"),
    limit: optionalPositiveInteger(value.limit, "limit"),
  };
}
```

- [ ] **Step 4: Run HTTP tests**

```bash
node --experimental-strip-types --test tests/server.test.ts
```

Expected: pass.

### Task 3: MCP Read-Only Compatibility

**Files:**

- Modify: `tests/mcp.test.ts`

- [ ] **Step 1: Add MCP compatibility assertion**

Extend the read-only assignment tool test to assert no tool id contains `compact` and that `assignment.timeline` still returns compacted summary events after service compaction.

- [ ] **Step 2: Run MCP tests**

```bash
node --experimental-strip-types --test tests/mcp.test.ts
```

Expected: pass.

### Task 4: Docs And Status

**Files:**

- Modify after verification only: `CONTEXT.md`
- Modify after verification only: `docs/phantom-parity.md`
- Modify after verification only: `docs/project-status.md`

- [ ] **Step 1: Update docs**

Document that assignment event retention compaction now exists and remove it from the remaining governed self-evolution gap list.

- [ ] **Step 2: Final verification**

Run:

```bash
node --experimental-strip-types --test tests/assignments.test.ts tests/server.test.ts tests/mcp.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
```

Expected: all pass. GitNexus may report broad assignment-service risk; inspect for unexpected changed symbols.

- [ ] **Step 3: Reviewer loop, PR, Copilot, merge**

Run the tmux Claude review loop described above. After clean local and reviewer verification:

```bash
git push -u origin jarvis/assignment-event-retention-compaction
gh pr create --base main --head jarvis/assignment-event-retention-compaction --title "feat(assignments): compact retained assignment events" --body-file /private/tmp/codex-phantom-retention-pr.md
gh pr edit <PR_NUMBER> --add-reviewer copilot-pull-request-reviewer
gh pr checks <PR_NUMBER> --watch
```

Poll PR reviews/comments. Address warranted Copilot comments, rerun verification, push fixes, and merge only when CI and review are clean.
