# Autonomous Prompt Runtime Guidance Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one bounded prompt mutation class, `prompt.runtime_guidance`, so an `evolve` assignment with explicit self-evolution policy can update a durable runtime guidance prompt overlay and roll it back.

**Architecture:** Keep the prompt mutation deliberately narrow: it may update only one persisted runtime guidance overlay that is appended to the assembled system prompt under a dedicated `# Runtime Guidance Overlay` section. The autonomous mutation adapter applies and rolls back through a small `PromptRuntimeGuidanceStore`, records before/after/rollback evidence in the autonomous mutation ledger, and does not edit source files, role YAML, MCP tools, memory, or arbitrary prompt sections.

**Tech Stack:** TypeScript ESM, SQLite via `AppDatabase`, existing Node `node:test` suites, `AutonomousMutationExecutor`, `AssignmentWakeupPlanner`, admin HTTP routes, GitNexus, tmux-driven Claude Code review.

---

## Skills To Use

- `$superpowers:writing-plans` for this plan.
- `$tdd` for one red/green behavior at a time across prompt assembly, autonomous service, planner, and HTTP coverage.
- `$gitnexus-impact-analysis` before editing `assemblePrompt`, `AgentRuntime`, `AutonomousMutationExecutor`, `AssignmentWakeupPlanner`, `HttpServer`, and `AppDatabase`.
- `$mcp-builder` as a guardrail lens only: MCP mutation tooling must remain read-only and no MCP write tool should be added.
- `$tmux-workflows` for the required Claude Code reviewer loop with the default model (opus 4.8).
- `$superpowers:receiving-code-review` before acting on Claude or Copilot findings.
- `$superpowers:verification-before-completion` before commit, PR, merge, or completion claims.

## Files

- Create: `src/prompts/runtime-guidance.ts`
  - Owns `PromptRuntimeGuidanceStore`, `PromptRuntimeGuidanceRecord`, default empty guidance, validation, update, and reset.
- Modify: `src/platform/database.ts`
  - Adds a `prompt_runtime_guidance` singleton table with `id`, `guidance_text`, `updated_by`, `created_at`, and `updated_at`.
- Modify: `src/prompts/assembler.ts`
  - Accepts optional runtime guidance text and appends a dedicated section only when non-empty.
- Modify: `src/agent/runtime.ts`
  - Accepts an optional `PromptRuntimeGuidanceStore` dependency and passes current guidance into `assemblePrompt`.
- Modify: `src/index.ts`
  - Constructs one `PromptRuntimeGuidanceStore`, passes it to `AgentRuntime`, and passes it to `AutonomousMutationExecutor`.
- Modify: `src/assignments/autonomous-mutations.ts`
  - Adds optional `promptGuidance?: PromptRuntimeGuidanceStore` dependency and built-in adapter for `target: "prompt"`, `mutationType: "runtime_guidance"`, `mutationClass: "prompt.runtime_guidance"`.
- Modify: `src/server/http-server.ts`
  - Creates/passes the same prompt guidance dependency for admin assignment mutation apply/rollback route execution.
- Modify: `tests/orchestration.test.ts`
  - Adds runtime prompt assembly coverage proving stored guidance reaches adapter `systemPrompt`.
- Modify: `tests/assignment-autonomous-mutations.test.ts`
  - Adds service-level apply, rollback, opt-in policy denial, malformed/oversized failure, and rollback guard coverage.
- Modify: `tests/assignment-wakeup-planner.test.ts`
  - Adds planner marker coverage for explicitly allowed `prompt.runtime_guidance`.
- Modify: `tests/server.test.ts`
  - Adds HTTP apply/rollback coverage through existing admin assignment mutation routes and mutation/timeline surfaces.
- Modify: `tests/mcp.test.ts`
  - Extends no-write regression to assert no prompt mutation apply/rollback MCP tool appears.
- Modify: `docs/self-evolution.md`, `docs/phantom-parity.md`, and `docs/project-status.md`
  - Document this bounded prompt mutation class and update status only after verification and implementation commit.

## Acceptance Criteria

- An `evolve` assignment with explicit `selfEvolution.allowedMutationClasses: ["prompt.runtime_guidance"]` can apply a `target: "prompt"`, `mutationType: "runtime_guidance"` mutation with `proposedChange.runtimeGuidance.text`.
- Default `evolve` assignments do not allow `prompt.runtime_guidance`.
- Non-`evolve` assignments still cannot apply autonomous prompt mutations.
- The mutation updates only the durable runtime guidance overlay; it does not edit source prompt files, YAML role policy, memory entries, MCP tools, or arbitrary config.
- `assemblePrompt()` includes a `# Runtime Guidance Overlay` section only when the overlay text is non-empty.
- The runtime `AgentRuntime` uses the latest persisted guidance for coordinator/subagent prompt assembly.
- Apply records `before`, `after`, `rollback`, `affectedResources`, and verification evidence in `assignment_mutations`.
- Rollback restores the prior guidance text and records `rolled_back`.
- Existing newer-applied mutation guard blocks rollback over a newer applied `prompt.runtime_guidance` mutation.
- Malformed, blank, or oversized runtime guidance attempts fail without changing the overlay and create failed ledger evidence when they reach the executor.
- Planner `ASSIGNMENT_MUTATION:` markers can request this class only through existing mutation executor routing and explicit assignment policy.
- Existing proposal-based self-evolution APIs remain unchanged.
- MCP assignment mutation tooling remains read-only; no prompt mutation write tool is added.

## Testing Plan

- Prompt store and runtime tests:
  - `tests/orchestration.test.ts` proves a stored overlay appears in the adapter `systemPrompt`.
  - Empty overlay does not add an empty section to `assemblePrompt()`.
- Service tests:
  - `tests/assignment-autonomous-mutations.test.ts` covers apply/rollback, default-policy denial, malformed/blank/oversized failure, newer-mutation rollback guard, and unchanged non-`evolve` behavior.
- Planner tests:
  - `tests/assignment-wakeup-planner.test.ts` covers an explicitly allowed planner `ASSIGNMENT_MUTATION:` marker for `prompt.runtime_guidance`.
- HTTP tests:
  - `tests/server.test.ts` covers authenticated apply/rollback through existing admin assignment mutation routes and visibility through assignment mutation/timeline surfaces.
- MCP tests:
  - `tests/mcp.test.ts` asserts no MCP apply/rollback or prompt mutation write tool appears.
- Final gates:
  - `node --experimental-strip-types --test tests/orchestration.test.ts tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts`
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `git diff --check`
  - `npx gitnexus detect-changes --scope staged --repo codex-phantom`

## Reviewer Loop

- After local verification, use `$tmux-workflows` to launch Claude Code with the default model:

```bash
tmux new-session -d -s codex-phantom-prompt-guidance-review -n review
PANE=$(tmux new-window -t codex-phantom-prompt-guidance-review -n claude-review -P -F '#{pane_id}')
tmux send-keys -t "$PANE" 'cd /Users/aaronstevens/dev/codex-phantom && claude' Enter
```

- Send this prompt through a tmux buffer and wait for `/private/tmp/codex-phantom-prompt-guidance-review.done`:

```text
Review the staged autonomous prompt runtime guidance mutation slice in /Users/aaronstevens/dev/codex-phantom.

Use the default Claude Code model. Do not edit files. Focus on correctness, policy bypasses, prompt-injection/scope expansion risks, rollback integrity, ledger/audit gaps, runtime prompt wiring, HTTP API compatibility, MCP read-only compatibility, missing tests, and docs accuracy.

Read:
- docs/superpowers/plans/2026-06-16-autonomous-prompt-runtime-guidance-mutation.md
- git diff --cached

Report Critical, Important, and Minor findings with file/line references. If no Critical or Important findings remain, say so explicitly.

When finished, write the report to /private/tmp/codex-phantom-prompt-guidance-review.md and run:
touch /private/tmp/codex-phantom-prompt-guidance-review.done
```

- Address all technically valid Critical and Important findings.
- Fix Minor findings only if they are low-risk and in slice scope.
- Rerun focused tests and full gates after fixes.
- Before merge, request Copilot review on the PR, poll CI/review/comment surfaces, and address warranted comments.

## Implementation Tasks

### Task 1: Prompt Runtime Guidance Store And Prompt Assembly

**Files:**

- Create: `src/prompts/runtime-guidance.ts`
- Modify: `src/platform/database.ts`
- Modify: `src/prompts/assembler.ts`
- Modify: `src/agent/runtime.ts`
- Test: `tests/orchestration.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

```bash
npx gitnexus impact assemblePrompt --direction upstream --repo codex-phantom --include-tests --summary-only
npx gitnexus impact AgentRuntime --direction upstream --repo codex-phantom --include-tests --summary-only
npx gitnexus impact AppDatabase --direction upstream --repo codex-phantom --include-tests --summary-only
```

- [ ] **Step 2: Write failing runtime prompt test**

Add a test to `tests/orchestration.test.ts` that constructs `PromptRuntimeGuidanceStore`, updates it with `Prefer concise verification summaries.`, passes it into `AgentRuntime`, runs the capturing adapter, and asserts the first non-memory request `systemPrompt` includes:

```text
# Runtime Guidance Overlay
Prefer concise verification summaries.
```

Expected failing command:

```bash
node --experimental-strip-types --test tests/orchestration.test.ts
```

Expected failure: `Cannot find module '../src/prompts/runtime-guidance.ts'` or missing constructor support.

- [ ] **Step 3: Add database table and store**

Create `src/prompts/runtime-guidance.ts` with:

```ts
import type { AppDatabase } from "../platform/database.ts";

type PromptRuntimeGuidanceRow = {
  id: string;
  guidance_text: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type PromptRuntimeGuidanceRecord = {
  id: "runtime";
  text: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

const ROW_ID = "runtime";
const MAX_RUNTIME_GUIDANCE_CHARS = 2000;

export class PromptRuntimeGuidanceStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
    this.seedDefault();
  }

  get(): PromptRuntimeGuidanceRecord {
    const row = this.database.get<PromptRuntimeGuidanceRow>(
      "SELECT id, guidance_text, updated_by, created_at, updated_at FROM prompt_runtime_guidance WHERE id = ?",
      ROW_ID
    );
    if (!row) {
      this.seedDefault();
      return this.get();
    }
    return toRecord(row);
  }

  update(text: string, actor?: string): PromptRuntimeGuidanceRecord {
    const normalized = normalizeRuntimeGuidanceText(text);
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE prompt_runtime_guidance
        SET guidance_text = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
      `,
      normalized,
      actor ?? null,
      now,
      ROW_ID
    );
    return this.get();
  }

  private seedDefault(): void {
    const now = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO prompt_runtime_guidance (id, guidance_text, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `,
      ROW_ID,
      "",
      null,
      now,
      now
    );
  }
}

export function normalizeRuntimeGuidanceText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("runtimeGuidance.text must be a string");
  }
  const text = value.trim();
  if (!text) {
    throw new Error("runtimeGuidance.text must be a non-empty string");
  }
  if (text.length > MAX_RUNTIME_GUIDANCE_CHARS) {
    throw new Error("runtimeGuidance.text must be 2000 characters or less");
  }
  return text;
}

function toRecord(row: PromptRuntimeGuidanceRow): PromptRuntimeGuidanceRecord {
  return {
    id: "runtime",
    text: row.guidance_text,
    updatedBy: row.updated_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

Add this table to `AppDatabase.migrate()`:

```sql
CREATE TABLE IF NOT EXISTS prompt_runtime_guidance (
  id TEXT PRIMARY KEY,
  guidance_text TEXT NOT NULL,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_runtime_guidance_updated_at ON prompt_runtime_guidance(updated_at DESC);
```

- [ ] **Step 4: Wire prompt assembly and runtime**

Change `assemblePrompt(config, memory)` to `assemblePrompt(config, memory, runtimeGuidanceText = "")`, add:

```ts
function buildRuntimeGuidanceSection(
  runtimeGuidanceText: string
): string | null {
  const text = runtimeGuidanceText.trim();
  return text ? ["# Runtime Guidance Overlay", text].join("\n") : null;
}
```

Filter null sections before joining.

Update `AgentRuntime` constructor to accept optional `PromptRuntimeGuidanceStore`, and pass `this.promptGuidance?.get().text ?? ""` to `assemblePrompt()`.

- [ ] **Step 5: Run prompt/runtime tests**

```bash
node --experimental-strip-types --test tests/orchestration.test.ts
```

Expected: PASS.

### Task 2: Autonomous Prompt Mutation Adapter

**Files:**

- Modify: `src/assignments/autonomous-mutations.ts`
- Modify: `src/index.ts`
- Test: `tests/assignment-autonomous-mutations.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

```bash
npx gitnexus impact AutonomousMutationExecutor --direction upstream --repo codex-phantom --include-tests --summary-only
npx gitnexus impact createOperatorSettingsAutonomousMutationAdapter --direction upstream --repo codex-phantom --include-tests --summary-only
```

- [ ] **Step 2: Write failing service tests**

Add service tests that:

- apply `prompt.runtime_guidance` with explicit assignment policy and assert store text changes, ledger records before/after/rollback, affected resource `{ type: "prompt", id: "runtime_guidance" }`, and verification method `prompt_runtime_guidance_update`;
- roll back and assert prior text is restored with verification method `prompt_runtime_guidance_rollback`;
- assert default `evolve` policy denies the class without changing text;
- assert blank and oversized text fail without changing text and create failed ledger evidence.

Expected failing command:

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected failure: unsupported mutation class or missing executor dependency.

- [ ] **Step 3: Add optional adapter dependency**

Extend `AutonomousMutationExecutorOptions`:

```ts
promptGuidance?: PromptRuntimeGuidanceStore;
```

Add `createPromptRuntimeGuidanceAutonomousMutationAdapter(options.promptGuidance)` to built-ins only when provided.

- [ ] **Step 4: Implement adapter**

Adapter contract:

```json
{
  "target": "prompt",
  "mutationType": "runtime_guidance",
  "proposedChange": {
    "runtimeGuidance": {
      "text": "..."
    }
  }
}
```

Behavior:

- `mutationClass: "prompt.runtime_guidance"`.
- Validate `proposedChange.runtimeGuidance.text` through `normalizeRuntimeGuidanceText`.
- `before` is `promptGuidance.get()`.
- `after` is `promptGuidance.update(text, actor ?? "autonomous_mutation")`.
- `rollback` is `{ "runtimeGuidance": { "text": before.text } }`.
- `affectedResources` is `[{ "type": "prompt", "id": "runtime_guidance" }]`.
- rollback validates `rollback.runtimeGuidance.text` as a string, then calls `promptGuidance.update(text, actor ?? "autonomous_mutation_rollback")`.

- [ ] **Step 5: Wire runtime dependency**

In `src/index.ts`, construct:

```ts
const promptGuidance = new PromptRuntimeGuidanceStore(database);
```

Pass it to `AgentRuntime` and `AutonomousMutationExecutor`.

- [ ] **Step 6: Run service tests**

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts
```

Expected: PASS.

### Task 3: Planner, HTTP, And MCP Coverage

**Files:**

- Modify: `src/server/http-server.ts`
- Modify: `tests/assignment-wakeup-planner.test.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/mcp.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

```bash
npx gitnexus impact HttpServer --direction upstream --repo codex-phantom --include-tests --summary-only
npx gitnexus impact AssignmentWakeupPlanner --direction upstream --repo codex-phantom --include-tests --summary-only
```

- [ ] **Step 2: Add planner coverage**

In `tests/assignment-wakeup-planner.test.ts`, construct `PromptRuntimeGuidanceStore`, pass it into `AutonomousMutationExecutor`, emit:

```text
ASSIGNMENT_MUTATION: {"target":"prompt","mutationType":"runtime_guidance","rationale":"Tighten runtime guidance.","proposedChange":{"runtimeGuidance":{"text":"Prefer evidence-first wakeup summaries."}}}
```

Assert completed wakeup, store text changed, ledger mutation has `runId: "coord_wakeup_1"`, and authorizing policy includes `prompt.runtime_guidance`.

- [ ] **Step 3: Add HTTP coverage**

In `tests/server.test.ts`, create an explicitly allow-listed `evolve` assignment and call:

```http
POST /admin/assignments/:id/mutations/apply
```

with `target: "prompt"`, `mutationType: "runtime_guidance"`, then assert the mutation is visible in `/admin/assignments/:id/mutations`, `/admin/mutations`, and timeline surfaces. Roll back with the existing rollback route and assert the returned mutation status is `rolled_back`.

- [ ] **Step 4: Add MCP no-write regression**

In `tests/mcp.test.ts`, extend the MCP tool list assertion so no tool id includes `runtime_guidance`, `prompt`, `apply`, or `rollback` in a write-capable mutation name.

- [ ] **Step 5: Run focused tests**

```bash
node --experimental-strip-types --test tests/assignment-wakeup-planner.test.ts tests/assignment-autonomous-mutations.test.ts tests/server.test.ts tests/mcp.test.ts tests/orchestration.test.ts
```

Expected: PASS.

### Task 4: Docs, Verification, Review, PR

**Files:**

- Modify: `docs/self-evolution.md`
- Modify: `docs/phantom-parity.md`
- Modify after implementation commit: `docs/project-status.md`

- [ ] **Step 1: Update docs**

Document `prompt.runtime_guidance` as an assignment-authorized autonomous prompt overlay mutation:

- not in default policy;
- requires explicit `allowedMutationClasses`;
- only changes the runtime guidance overlay;
- rollback restores previous overlay text;
- proposal apply remains unchanged;
- MCP remains read-only.

- [ ] **Step 2: Run final gates**

```bash
node --experimental-strip-types --test tests/orchestration.test.ts tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
```

- [ ] **Step 3: Run tmux/Claude reviewer loop**

Use the Reviewer Loop section above. Address all valid Critical and Important findings, then rerun focused tests and final gates.

- [ ] **Step 4: Commit implementation**

```bash
git add src/prompts/runtime-guidance.ts src/platform/database.ts src/prompts/assembler.ts src/agent/runtime.ts src/index.ts src/assignments/autonomous-mutations.ts src/server/http-server.ts tests/orchestration.test.ts tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts docs/self-evolution.md docs/phantom-parity.md docs/superpowers/plans/2026-06-16-autonomous-prompt-runtime-guidance-mutation.md
git commit -m "feat(assignments): apply prompt guidance mutations autonomously"
```

- [ ] **Step 5: Update status ledger and commit docs**

After the implementation commit exists, update `docs/project-status.md` with branch, verified commit, verification commands, reviewer evidence, and the completed slice. Then:

```bash
git add docs/project-status.md
git commit -m "docs(status): record autonomous prompt guidance mutation"
```

- [ ] **Step 6: Push, PR, Copilot, merge**

```bash
git push -u origin jarvis/autonomous-prompt-guidance-mutation
gh pr create --base main --head jarvis/autonomous-prompt-guidance-mutation --title "feat(assignments): apply prompt guidance mutations autonomously" --body-file /private/tmp/codex-phantom-prompt-guidance-pr-body.md
gh pr edit <PR_NUMBER> --add-reviewer copilot-pull-request-reviewer
gh pr checks <PR_NUMBER> --watch --interval 10
```

Poll PR reviews, inline comments, issue comments, and review requests. Address warranted Copilot comments, rerun required verification, push fixes, and merge only after CI is green and no pending actionable review/comment remains.

## Self-Review

- Spec coverage: The plan implements one remaining governed self-evolution prompt mutation class with explicit assignment policy, rollback evidence, planner/HTTP surfaces, MCP no-write regression, docs, reviewer loop, and PR flow.
- Placeholder scan: No `TBD`, open-ended TODO, or unspecified test command remains.
- Type consistency: The mutation class is consistently `prompt.runtime_guidance`, with `target: "prompt"`, `mutationType: "runtime_guidance"`, and `proposedChange.runtimeGuidance.text`.
