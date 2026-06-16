# Autonomous Tool Bundle Enable Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one bounded autonomous mutation class, `tool.bundle_enable`, so an `evolve` assignment with explicit self-evolution policy can enable an already-approved, valid, read-only internal tool bundle and roll it back by disabling that same bundle.

**Architecture:** Keep governed tool bundle lifecycle rules in a small reusable service/helper that both HTTP and autonomous mutation adapters can call. The autonomous adapter must not preview, approve, install arbitrary files, or widen tool permissions. It may only enable an existing valid + approved bundle already present in `tool_bundle_imports`, then record before/after/rollback evidence through the autonomous mutation ledger.

**Tech Stack:** TypeScript ESM, Node `node:test`, SQLite through `AppDatabase`, existing `ToolBundleImportStore`, `DynamicToolRegistry`, admin HTTP routes, assignment autonomous mutation executor, GitNexus, tmux-driven Claude Code review.

---

## Skills To Use

- `$superpowers:writing-plans` for this implementation plan.
- `$tdd` for red/green service, HTTP, and MCP no-write regression slices.
- `$gitnexus-impact-analysis` before editing `AutonomousMutationExecutor`, `HttpServer`, `ToolBundleImportStore`, `DynamicToolRegistry`, and any extracted tool-bundle lifecycle helper.
- `$mcp-builder` as a guardrail lens only: MCP remains read-only and this slice must not add MCP write tools.
- `$superpowers:receiving-code-review` before acting on Claude or Copilot findings.
- `$tmux-workflows` for the reviewer loop: start a detached tmux session, launch Claude Code with the default model, pass the staged diff and requirements, wait on a sentinel file, then harvest the report.
- `$superpowers:verification-before-completion` before any completion, commit, PR, or merge claim.

## Files

- Add or modify: `src/tools/bundle-lifecycle.ts`
  - Extract/reuse tool bundle enable and disable orchestration currently private to `HttpServer`.
  - Preserve existing HTTP semantics: valid bundle imports only, approved/disabled can enable, enabled can disable, read-only manifest validation remains owned by `ToolBundleImportStore.preview`.
- Modify: `src/server/http-server.ts`
  - Replace private duplicated enable/disable lifecycle logic with the shared helper.
- Modify: `src/assignments/autonomous-mutations.ts`
  - Add optional tool bundle lifecycle dependency and built-in `target: "tool"`, `mutationType: "bundle_enable"`, `mutationClass: "tool.bundle_enable"` adapter when the dependency is provided.
  - Preserve the existing constructor path for tests that inject custom adapters.
- Modify: `src/index.ts`
  - Wire the runtime `ToolBundleImportStore`/`DynamicToolRegistry` lifecycle helper into the default `AutonomousMutationExecutor`.
- Modify: `tests/assignment-autonomous-mutations.test.ts`
  - Add service-level apply/rollback coverage for `tool.bundle_enable`.
  - Assert default assignment self-evolution policy does not allow the class.
  - Assert invalid/unapproved/malformed requests fail without enabling tools and are audited.
- Modify: `tests/server.test.ts`
  - Add HTTP apply/rollback coverage for an assignment policy that explicitly allow-lists `tool.bundle_enable`.
  - Assert successful apply is visible in assignment mutation/timeline surfaces.
- Modify: `tests/mcp.test.ts`
  - Assert MCP assignment mutation tooling remains read-only and no tool-bundle mutation write tool appears.
- Modify: `docs/self-evolution.md`, `docs/phantom-parity.md`, and `docs/project-status.md`
  - Update after verification with the new bounded tool mutation class and wave evidence.

## Acceptance Criteria

- An `evolve` assignment with explicit `selfEvolution.allowedMutationClasses: ["tool.bundle_enable"]` can apply a `target: "tool"`, `mutationType: "bundle_enable"` mutation for an already-approved valid tool bundle import.
- Default `evolve` assignment policy remains unchanged and does not allow tool-bundle enablement.
- Non-`evolve` assignments still cannot apply autonomous mutations.
- Invalid, unapproved, disabled-state-invalid, missing, malformed, or unsafe bundle requests fail without registering dynamic tools, and failed attempts are audited when they reach the autonomous mutation executor.
- Successful apply registers the bundle's read-only tools, marks the bundle enabled, and records autonomous ledger `before`, `after`, `rollback`, `affectedResources`, and verification evidence.
- Rollback disables the same bundle, unregisters the bundle tools, and records `rolled_back` mutation evidence.
- Rollback is blocked by the existing newer-applied mutation guard for the same `tool.bundle_enable` class.
- Existing operator HTTP tool bundle lifecycle APIs behave unchanged.
- Existing proposal-based self-evolution APIs behave unchanged.
- MCP assignment mutation tooling remains read-only; no write-capable MCP tool is added.
- Project docs and ledger are updated only after verification passes.

## Testing Plan

- Service tests in `tests/assignment-autonomous-mutations.test.ts`:
  - approved valid read-only bundle can be enabled through explicit assignment policy.
  - rollback disables the bundle and unregisters its tools.
  - default policy denies `tool.bundle_enable`.
  - unapproved or missing bundle fails and does not register tools.
  - malformed proposedChange fails and records failed mutation evidence.
- HTTP tests in `tests/server.test.ts`:
  - authenticated apply/rollback routes work for an explicitly allow-listed assignment.
  - unauthenticated calls remain rejected by existing route coverage.
  - mutation appears in `/admin/assignments/:id/mutations`, `/admin/mutations`, and timeline surfaces already backed by the ledger.
- MCP tests in `tests/mcp.test.ts`:
  - no assignment mutation apply/rollback or tool-bundle enable tool appears in MCP `tools/list`.
  - read-only assignment mutation timeline/list tools still surface ledger evidence.
- Final gates:
  - `node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/server.test.ts tests/mcp.test.ts tests/tool-bundles.test.ts`
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `git diff --check`
  - `npx gitnexus detect-changes --scope staged --repo codex-phantom`

## Reviewer Loop

- After local verification, use `$tmux-workflows` to launch a Claude Code reviewer in tmux:

```bash
tmux new-session -d -s codex-phantom-tool-bundle-review -n review
PANE=$(tmux new-window -t codex-phantom-tool-bundle-review -n claude-review -P -F '#{pane_id}')
tmux send-keys -t "$PANE" 'cd /Users/aaronstevens/dev/codex-phantom && claude' Enter
```

- Send this prompt through a tmux buffer, then wait for `/private/tmp/codex-phantom-tool-bundle-review.done`:

```text
Review the staged autonomous tool bundle enable mutation slice in /Users/aaronstevens/dev/codex-phantom.

Use the default Claude Code model. Do not edit files. Focus on correctness, policy bypasses, unsafe tool enablement, rollback integrity, ledger/audit gaps, HTTP API compatibility, MCP read-only compatibility, missing tests, and docs accuracy.

Read:
- docs/superpowers/plans/2026-06-16-autonomous-tool-bundle-mutation.md
- git diff --cached

Report Critical, Important, and Minor findings with file/line references. If no Critical or Important findings remain, say so explicitly.

When finished, write the report to /private/tmp/codex-phantom-tool-bundle-review.md and run:
touch /private/tmp/codex-phantom-tool-bundle-review.done
```

- Address all Critical and Important findings that are technically valid.
- For Minor findings, fix only those that are cheap and align with the slice boundaries.
- Rerun focused tests plus full gates after fixes.
- Before PR, request Copilot review after push, poll until Copilot has either posted a review/comment or no pending review/comment remains after CI is green, and address warranted comments.

## Implementation Tasks

### Task 1: Shared Tool Bundle Lifecycle Helper

**Files:**

- Add or modify: `src/tools/bundle-lifecycle.ts`
- Modify: `src/server/http-server.ts`
- Test: existing `tests/server.test.ts` and `tests/tool-bundles.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

```bash
npx gitnexus impact HttpServer --direction upstream --repo codex-phantom --include-tests --summary-only
npx gitnexus impact ToolBundleImportStore --direction upstream --repo codex-phantom --include-tests --summary-only
npx gitnexus impact DynamicToolRegistry --direction upstream --repo codex-phantom --include-tests --summary-only
```

- [ ] **Step 2: Extract helper without behavior changes**

Create a helper that owns:

- `enableToolBundle(importId, actor, notes?)`
- `disableToolBundle(importId, actor, notes?)`
- optional `getBundle(importId)` for adapter evidence

The helper must use `ToolBundleImportStore.get()`, `extractBundleTools`, `DynamicToolRegistry.registerApproved()`, `DynamicToolRegistry.unregister()`, and existing store lifecycle methods.

- [ ] **Step 3: Replace `HttpServer` private lifecycle methods**

The HTTP routes should call the helper and preserve status/error mapping.

- [ ] **Step 4: Run behavior-preservation tests**

```bash
node --experimental-strip-types --test tests/server.test.ts tests/tool-bundles.test.ts
```

### Task 2: Autonomous Adapter

**Files:**

- Modify: `src/assignments/autonomous-mutations.ts`
- Modify: `src/index.ts`
- Test: `tests/assignment-autonomous-mutations.test.ts`

- [ ] **Step 1: Write failing service tests**

Add tests for explicit policy apply, rollback, default-policy denial, missing/unapproved bundle failure, and malformed proposedChange failure.

- [ ] **Step 2: Run failing tests**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: fails because no built-in `tool.bundle_enable` adapter exists.

- [ ] **Step 3: Add optional adapter dependency**

Extend `AutonomousMutationExecutorOptions` with optional `toolBundles` lifecycle dependency. Include the adapter in default built-ins only when provided so isolated tests can still inject custom adapters without constructing tool-bundle services.

- [ ] **Step 4: Implement `tool.bundle_enable` adapter**

Required proposedChange shape:

```json
{
  "toolBundle": {
    "importId": "tbi_..."
  }
}
```

Apply behavior:

- validate JSON object shape and `toolBundle.importId`.
- fetch the bundle before apply and require valid + approved/disabled state through the lifecycle helper.
- enable the bundle.
- record `before` and `after` bundle lifecycle records.
- set rollback to `{ "toolBundle": { "importId": "..." } }`.
- set affected resources to the bundle import and contained tool ids.

Rollback behavior:

- validate rollback import id.
- disable the bundle through the lifecycle helper.

- [ ] **Step 5: Run service tests**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

### Task 3: HTTP And MCP Coverage

**Files:**

- Modify: `tests/server.test.ts`
- Modify: `tests/mcp.test.ts`
- Modify: docs after verification

- [ ] **Step 1: Add HTTP coverage**

Add an approved valid tool bundle import, create an `evolve` assignment with `tool.bundle_enable` allow-listed, call existing autonomous mutation apply/rollback routes, and assert tools become visible/hidden through existing MCP `tools/list` behavior or dynamic tool registry read APIs.

- [ ] **Step 2: Add MCP no-write regression**

Assert no MCP tool id exposes autonomous mutation apply/rollback or tool bundle enablement.

- [ ] **Step 3: Run focused tests**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/server.test.ts tests/mcp.test.ts tests/tool-bundles.test.ts
```

### Task 4: Docs, Verification, Review, PR

- [ ] **Step 1: Update docs after local verification**

Update `docs/self-evolution.md`, `docs/phantom-parity.md`, and `docs/project-status.md` with this bounded class and verification evidence.

- [ ] **Step 2: Run final gates**

```bash
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
```

- [ ] **Step 3: Run tmux/Claude reviewer loop**

Use the Reviewer Loop section above and address valid Critical/Important findings.

- [ ] **Step 4: Commit, push, PR, Copilot, merge**

Use atomic Conventional Commits, request Copilot review, poll CI/review/comment surfaces, address warranted findings, and merge only after gates are green.
