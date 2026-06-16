# Planner-Driven Autonomous Mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let assignment wakeup coordinator output request one bounded autonomous mutation through the existing assignment mutation executor.

**Architecture:** Extend `AssignmentWakeupPlanner` with an optional autonomous mutation executor dependency. Parse one `ASSIGNMENT_MUTATION: {json}` marker from coordinator output after the wakeup run is durably linked, execute it through `AutonomousMutationExecutor`, and then continue the existing status/next-wakeup flow. The executor remains the authority gate for `evolve`, policy allow-list, risk, validation, ledger evidence, and rollback.

**Tech Stack:** TypeScript ESM, Node `node:test`, SQLite-backed assignment services, GitNexus impact/detect, tmux + Claude Code reviewer loop.

---

## Skills And Tools

- `$tdd`: Write one failing planner behavior at a time, then implement the smallest runtime change.
- `$superpowers:writing-plans`: This plan defines the slice, file ownership, acceptance criteria, and test gates.
- `$tmux-workflows`: Use a detached tmux session to launch a default Claude Code reviewer (`claude`) after local verification. The reviewer writes findings to `/private/tmp/codex-phantom-planner-mutations-review.md` and touches `/private/tmp/done.planner-mutations-review`.
- GitNexus impact analysis: Run before editing `AssignmentWakeupPlanner`, `parsePlannerMarkers`, `buildWakeupPrompt`, and `AutonomousMutationExecutor` call sites.
- `$mcp-builder`: Not active for this slice because MCP tooling remains read-only and no MCP server/tool implementation changes are planned.

## Acceptance Criteria

- A coordinator wakeup response may include one line `ASSIGNMENT_MUTATION: <json object>` for an assignment-scoped mutation request.
- The planner executes that request only through `AutonomousMutationExecutor`; no planner code mutates settings or assignment policy directly.
- The mutation request is bound to the current assignment id and coordinator run id, and defaults actor to `planner`.
- Existing executor policy gates remain authoritative: non-`evolve`, disabled self-evolution, unsupported classes, disallowed classes, malformed payloads, and excessive risk all fail without direct state mutation.
- Failed mutation execution is captured in the autonomous mutation ledger by the executor and does not cause the wakeup itself to fail.
- Existing `ASSIGNMENT_STATUS` and `NEXT_WAKEUP_MINUTES` behavior remains unchanged.
- The wakeup prompt documents the mutation marker format and warns that it only works when assignment policy allows the class.
- MCP mutation tooling remains read-only.

## Testing Plan

- Focused service tests in `tests/assignment-wakeup-planner.test.ts`:
  - Red 1: planner applies an allowed `configuration.operator_settings` marker and records an applied ledger mutation with `runId` equal to the coordinator run.
  - Red 2: planner applies an explicitly allowed `configuration.assignment_policy` marker without changing `selfEvolution`.
  - Red 3: planner records failed mutation evidence for a disallowed/default `configuration.assignment_policy` marker and still schedules/finishes the wakeup normally.
  - Red 4: malformed marker JSON is ignored safely or recorded as failed without crashing the wakeup, depending on whether it reaches the executor.
  - Red 5: existing no-marker wakeup tests remain unchanged.
- Focused command:
  - `node --experimental-strip-types --test tests/assignment-wakeup-planner.test.ts tests/assignment-autonomous-mutations.test.ts`
- Full verification:
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `git diff --check`
  - `node .gitnexus/run.cjs detect-changes --scope staged --repo codex-phantom`

## Reviewer Loop

- After local verification passes, start a tmux reviewer:

```bash
tmux new-session -d -s codex-phantom-planner-review -n review
PANE=$(tmux list-panes -t codex-phantom-planner-review -F '#{pane_id}' | head -1)
tmux send-keys -t "$PANE" 'cd /Users/aaronstevens/dev/codex-phantom && claude' Enter
```

- Send a prompt asking Claude Code default model (opus 4.8) to review only outstanding branch changes for correctness, policy bypasses, ledger/audit gaps, rollback integrity, wakeup lifecycle regressions, API compatibility, and missing tests. It must write `/private/tmp/codex-phantom-planner-mutations-review.md` and then `touch /private/tmp/done.planner-mutations-review`.
- Poll for the sentinel file. Read the report. Address Critical and Important findings that are technically valid, then rerun focused tests and full verification.
- If Claude reports no Critical or Important findings, proceed to PR.

## Task 1: Planner Marker Parsing And Prompt Contract

**Files:**

- Modify: `src/assignments/wakeup-planner.ts`
- Test: `tests/assignment-wakeup-planner.test.ts`

- [ ] **Step 1: Write failing tests**

Add a test showing that coordinator output with `ASSIGNMENT_MUTATION` produces an applied mutation and that no-marker behavior still schedules normally.

- [ ] **Step 2: Run focused tests**

Run:

```bash
node --experimental-strip-types --test tests/assignment-wakeup-planner.test.ts
```

Expected: new mutation-marker test fails because the planner ignores the marker.

- [ ] **Step 3: Implement marker parser**

Extend `parsePlannerMarkers` to return at most one parsed mutation request object. Use JSON parsing only; do not accept freeform pseudo-JSON.

- [ ] **Step 4: Update prompt contract**

Add a line to `buildWakeupPrompt` documenting `ASSIGNMENT_MUTATION: {"target":"configuration","mutationType":"operator_settings","rationale":"...","proposedChange":{...}}`.

## Task 2: Planner Execution Through AutonomousMutationExecutor

**Files:**

- Modify: `src/assignments/wakeup-planner.ts`
- Test: `tests/assignment-wakeup-planner.test.ts`

- [ ] **Step 1: Write failing execution tests**

Add tests for allowed `operator_settings`, explicitly allowed `assignment_policy`, and default-policy denied `assignment_policy`.

- [ ] **Step 2: Run focused tests**

Run:

```bash
node --experimental-strip-types --test tests/assignment-wakeup-planner.test.ts tests/assignment-autonomous-mutations.test.ts
```

Expected: new execution tests fail until the planner receives and invokes the executor.

- [ ] **Step 3: Add optional executor dependency**

Add `mutations?: Pick<AutonomousMutationExecutor, "apply">` to the planner constructor input. Existing tests and production wiring should continue to work when omitted.

- [ ] **Step 4: Execute mutation after run completion**

After `completeWakeupRun`, if a marker exists and a mutation executor is configured, call `mutations.apply({ assignmentId, runId, target, mutationType, rationale, riskClass, proposedChange, actor: "planner" })`.

- [ ] **Step 5: Preserve wakeup flow on mutation failure**

Catch `AutonomousMutationExecutionError` from the executor and continue to process `ASSIGNMENT_STATUS` / `NEXT_WAKEUP_MINUTES`. The executor-created failed ledger record is the audit evidence.

## Task 3: Wiring, Docs, Verification, And Review

**Files:**

- Modify: `src/index.ts` or server composition file if the runtime constructs `AssignmentWakeupPlanner` there.
- Modify: `docs/self-evolution.md`
- Modify: `docs/project-status.md` after verification passes.

- [ ] **Step 1: Wire production planner to executor**

Pass the existing assignment autonomous mutation executor into `AssignmentWakeupPlanner`.

- [ ] **Step 2: Update docs**

Document the planner marker as admin/internal autonomous assignment behavior, not MCP write tooling.

- [ ] **Step 3: Verify**

Run focused tests, typecheck, full tests, build, whitespace check, and GitNexus detect.

- [ ] **Step 4: Reviewer loop**

Run the tmux Claude reviewer loop. Address Critical/Important findings and rerun verification.

- [ ] **Step 5: PR loop**

Commit, push `jarvis/planner-driven-autonomous-mutations`, open a PR, request Copilot, poll for comments/checks, address warranted comments, merge, delete branch, sync `main`, and continue to the next slice.
