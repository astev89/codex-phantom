# Autonomous Project-File Draft Mutation Plan

## Summary

Add the next bounded delegated self-evolution slice: an `evolve` assignment can create and roll back assignment-owned project-file draft records through `project_file.draft`.

This slice intentionally does **not** write to the repository filesystem, edit source files, apply patches, install packages, change prompts, change memory, or expose MCP write tooling. A project-file draft is durable evidence that an assignment proposed a file path and text content under explicit assignment self-evolution policy. Operators can inspect it through the autonomous mutation ledger and, if needed, future UI/export surfaces.

## Skills And Reviewer Loop

- Use `tdd` for red-green-refactor.
- Use `gitnexus-impact-analysis` before editing existing symbols.
- Use `superpowers:requesting-code-review` and `superpowers:verification-before-completion` before completion.
- Reviewer agent: GPT-5.4 xhigh via tmux/Claude Code with `gitnexus-impact-analysis`, `gitnexus-pr-review` or `gitnexus-debugging` as needed, `tdd`, `superpowers:requesting-code-review`, and `superpowers:verification-before-completion`.
- Reviewer prompt must ask for policy bypasses, filesystem-write bypasses, path validation gaps, content-size/content-type gaps, ledger/audit gaps, rollback integrity, HTTP/API compatibility, MCP read-only preservation, and missing tests.
- Address all Critical and Important reviewer findings before considering the slice complete.

## Current Impact Analysis

- `AutonomousMutationExecutor`: LOW.
- `HttpServer`: LOW.
- `validateChatArtifactBody`: LOW.
- `AppDatabase`: CRITICAL because it is the shared persistence hub across assignment, channel, memory, chat, tool, server, scheduler, MCP, and orchestration flows.

Because `AppDatabase` is CRITICAL, keep migration changes additive-only and focused on one new table/index pair, with focused persistence tests plus full regression verification.

## Slice Boundary

Implement:

- New mutation class `project_file.draft`.
- Target `project_file`, mutation type `draft`.
- Explicit assignment policy opt-in only; default `evolve` remains `configuration.operator_settings`.
- Proposed change shape:

```json
{
  "projectFileDraft": {
    "path": "docs/example.md",
    "content": "# Example\n",
    "contentType": "text/markdown"
  }
}
```

- Store draft records durably with assignment/run linkage, path, content type, byte size, SHA-256, content, metadata, status, and timestamps.
- Apply creates a draft record and records autonomous mutation before/after/rollback evidence.
- Rollback marks the draft `rolled_back` without deleting the audit row.
- Planner markers may request the class only when policy explicitly allows it.
- HTTP admin apply/rollback uses the existing autonomous mutation routes.
- MCP mutation tooling remains read-only.

Do not implement:

- Filesystem writes or patch application.
- Git staging, commits, PR creation, or file replacement from inside the mutation adapter.
- Broad prompt rewriting, memory entry mutation, auth/channel policy mutation, role/tool mutation, or package installation.
- Public unauthenticated draft APIs.

## Validation Rules

- `path` must be a relative project path.
- Reject absolute paths, empty paths, `.`/`..` segments, Windows drive prefixes, NUL/control characters, and backslashes.
- Reject hidden/system and generated paths such as `.git`, `.env`, `node_modules`, `dist`, and `coverage`.
- `content` must be a non-empty string whose UTF-8 byte length is <= 200 KB.
- `contentType` defaults to `text/plain` and must be a safe text-like content type already accepted by artifact content policy.
- Optional metadata must be JSON-safe and bounded to existing JSON storage behavior.

## Implementation Tasks

1. Add `project_file_drafts` persistence.
   - Add an additive table and indexes in `AppDatabase.migrate()`.
   - Add `src/project-files/drafts.ts` with `ProjectFileDraftStore`, validation helpers, create/list/get/markRolledBack APIs, and snapshot helpers.

2. Add autonomous mutation adapter.
   - Extend `AutonomousMutationTarget` if needed.
   - Add `PROJECT_FILE_DRAFT_MUTATION_CLASS`.
   - Register the adapter only when a `projectFileDrafts` store is supplied.
   - Apply validates proposed change, records before snapshot for active drafts at the path, creates one draft, and returns affected resource evidence.
   - Rollback validates rollback payload and marks the created draft `rolled_back`.

3. Wire runtime surfaces.
   - Instantiate `ProjectFileDraftStore` in `src/index.ts`.
   - Pass it into `AutonomousMutationExecutor` in index and `HttpServer`.
   - Update planner mutation guidance examples to include the new class only as an explicit-policy option.
   - Preserve MCP read-only behavior.

4. Update docs.
   - Update `docs/self-evolution.md` to distinguish project-file drafts from filesystem writes.
   - Update `docs/phantom-parity.md` to remove project-file drafts from remaining governed self-evolution gaps.
   - At wave end, update `docs/project-status.md` after verification passes and implementation commit exists.

## Testing Plan

TDD vertical slice 1, service-level happy path:

- Add project-file draft coverage to `tests/assignment-autonomous-mutations.test.ts`.
- Create an `evolve` assignment with explicit `project_file.draft` policy.
- Apply a markdown draft.
- Assert the draft row exists, no filesystem file is written, ledger records applied evidence, affected resources include the draft id/path, and assignment timeline records mutation milestones.

TDD vertical slice 2, authorization and validation:

- Assert default `evolve` policy denies `project_file.draft`.
- Assert `execute`, `draft`, and `observe` assignments cannot apply it.
- Assert absolute paths, `..`, `.env`, `node_modules`, unsafe content types, empty content, and oversize content fail without creating draft rows and with failed ledger evidence where appropriate.

TDD vertical slice 3, rollback and stale rollback:

- Assert rollback marks the draft `rolled_back`, preserves the content/audit row, and records `rolled_back` in the ledger/timeline.
- Assert stale rollback is blocked if a newer applied `project_file.draft` exists for the same path or globally if the implementation chooses global conflict scope.

TDD vertical slice 4, HTTP/planner/read-only surfaces:

- Add server coverage for authenticated apply/rollback through existing admin mutation routes.
- Assert unauthenticated calls are rejected.
- Assert successful apply appears in `/admin/assignments/:id/mutations`, `/admin/mutations`, `/admin/timeline`, and export/timeline surfaces already backed by the ledger.
- Add planner marker coverage for explicitly allowed `project_file.draft`.
- Add MCP guard coverage that no write-capable project-file draft tool is exposed.

## Verification Commands

```bash
node --experimental-strip-types --test tests/assignment-autonomous-mutations.test.ts tests/assignment-wakeup-planner.test.ts tests/server.test.ts tests/mcp.test.ts
node --experimental-strip-types --test tests/assignment-mutation-ledger.test.ts tests/self-evolution-mutations.test.ts tests/operator-export.test.ts
npm run typecheck
npm test
npm run build
git diff --check
npx gitnexus detect-changes --scope staged --repo codex-phantom
```

## Acceptance Criteria

- An explicitly authorized `evolve` assignment can create a bounded project-file draft record through the autonomous mutation executor.
- No mutation path writes to the repository filesystem.
- Non-`evolve` assignments and default `evolve` policy cannot create project-file drafts.
- Unsafe paths, unsafe content types, empty content, and oversize content are rejected without creating draft rows.
- Every successful apply records before/after/rollback evidence in `assignment_mutations`.
- Rollback marks the draft rolled back while preserving audit content.
- Existing proposal-based self-evolution APIs remain unchanged.
- Existing read-only MCP mutation tooling remains read-only.
- Reviewer loop has no unresolved Critical or Important findings.
