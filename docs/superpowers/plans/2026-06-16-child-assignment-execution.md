# Child Assignment Execution Slice

## Goal

Add the first durable child-assignment execution path for autonomous assignments. A parent assignment can promote a bounded child assignment that inherits parent authority without exceeding parent autonomy, depth, or active-child policy. Planner wakeups can request one child through an explicit marker, the child is scheduled for execution, and the parent timeline records why the child exists and whether the parent waits or continues.

## Scope

- Add narrow child-assignment policy fields with defaults:
  - `childAssignments.maxDepth: 2`
  - `childAssignments.maxActiveChildren: 3`
- Add a service-level child promotion API that:
  - requires the parent assignment to exist and be non-terminal,
  - inherits parent policy by default,
  - caps child autonomy at the parent autonomy level,
  - rejects children beyond parent depth, direct active-child limits, or unreserved parent wakeup budget,
  - allows `0` child limits to disable child promotion and treats missing stored child policy as fail-closed,
  - records parent and child timeline evidence.
- Add planner handling for one `ASSIGNMENT_CHILD:` marker after a wakeup run.
- Schedule a due-now child wakeup after planner-created children.
- Keep MCP assignment tools read-only and do not add autonomous mutation authority.

## Out Of Scope

- Full parent/child dependency orchestration or automatic parent resume on child completion.
- Dashboard-specific child assignment UX.
- Retention compaction.
- New mutation classes.

## Testing Plan

1. Service-level red/green tests:
   - Default policy includes child assignment limits.
   - Child promotion inherits policy, caps autonomy, records child metadata, and writes parent timeline evidence.
   - Promotion rejects terminal parents, over-depth children, and active-child overflow.
2. Planner-level red/green tests:
   - Prompt advertises the child marker for execute-or-higher assignments.
   - A valid `ASSIGNMENT_CHILD:` marker creates a child, records evidence, schedules a due-now child wakeup, and either waits or continues the parent according to the marker.
   - Malformed child markers are ignored without failing the wakeup.
3. HTTP/server coverage:
   - Existing create/list detail surfaces expose child policy and parent filters.
   - Authenticated create/control flows still validate child policy patches.
4. Verification:
   - Focused assignment and planner tests.
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
   - `git diff --check`
   - `node .gitnexus/run.cjs detect-changes --scope staged --repo codex-phantom`

## Acceptance Criteria

- A parent assignment can create a bounded child assignment with durable parent/child evidence.
- Child assignments inherit parent policy by default and cannot exceed parent autonomy.
- Child promotion respects `maxDepth` and `maxActiveChildren`.
- Planner-created children are scheduled for execution without adding MCP write capability.
- Parent wakeup behavior remains deterministic when child markers are absent or malformed.
- Existing self-evolution proposal and assignment mutation flows remain unchanged.
- Docs and project ledger are updated only after verification passes.

## Reviewer Loop

After implementation and local verification, request a GPT-5.4 xhigh reviewer with GitNexus access and the `gitnexus-impact-analysis`, `gitnexus-pr-review` or `gitnexus-debugging`, `tdd`, `superpowers:requesting-code-review`, and `superpowers:verification-before-completion` skills. Ask specifically for child policy bypasses, parent/child lifecycle gaps, scheduler evidence, API compatibility, and missing tests. Address all Critical and Important findings before merging.
