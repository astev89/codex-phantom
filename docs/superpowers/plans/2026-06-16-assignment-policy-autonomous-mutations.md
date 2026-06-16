# Assignment Policy Autonomous Mutations

## Goal

Add the first non-settings autonomous mutation adapter without broadening default behavior: `configuration.assignment_policy` lets an `evolve` assignment adjust its own execution policy when, and only when, its self-evolution policy explicitly allows that mutation class.

## Scope

- Add a built-in autonomous mutation adapter for `target: "configuration"` and `mutationType: "assignment_policy"`.
- Require `configuration.assignment_policy` in `assignment.policy.selfEvolution.allowedMutationClasses`.
- Apply policy patches through `AutonomousAssignmentService.control({ action: "change_policy" })` so existing validation owns bounds and shape.
- Reject any `proposedChange.assignmentPolicy.selfEvolution` patch so an assignment cannot broaden its own mutation authority.
- Capture full policy `before`, `after`, and rollback evidence.
- Keep planner-driven mutation decisions, MCP writes, prompt/tool/role/file mutation, and default policy expansion out of scope.

## Testing Plan

- Add service-level tests for explicit opt-in apply and rollback.
- Add safety tests for default disallow, `selfEvolution` escalation attempts, and malformed policy patches.
- Add HTTP coverage for authenticated apply and rollback using an explicitly opted-in assignment.
- Run focused mutation/server tests, typecheck, full test suite, build, `git diff --check`, and GitNexus staged change detection.
- Run a GPT-5.4 xhigh reviewer loop focused on policy bypasses, rollback integrity, audit evidence, API compatibility, and missing tests.

## Acceptance Criteria

- `configuration.assignment_policy` applies only for `evolve` assignments with explicit self-evolution policy allow-list entry.
- Default assignments still allow only `configuration.operator_settings`.
- Autonomous assignment-policy mutations cannot change `selfEvolution`.
- Malformed policy patches fail without changing assignment policy and produce failed ledger evidence.
- Successful apply and rollback record before/after/rollback evidence and assignment timeline milestones.
- Existing operator-settings autonomous mutation behavior is unchanged.
