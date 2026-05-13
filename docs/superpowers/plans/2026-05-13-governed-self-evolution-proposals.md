# Governed Self-Evolution Proposals Plan

## Goal

Add the first production-safe governed self-evolution slice: durable proposal records and operator/agent creation paths without applying mutations.

## Implementation

- Add `self_evolution_proposals` to SQLite with indexes for status and target review.
- Add `SelfEvolutionProposalStore` for create, get, list, summary, and validation.
- Accept only known targets: `prompt`, `memory_policy`, `tool`, `role`, and `configuration`.
- Accept only known risk classes: `low`, `medium`, `high`, and `critical`.
- Reject malformed payloads and direct-apply requests such as `applyNow: true` or `mutationMode: "direct"`.
- Expose authenticated operator APIs under `/admin/self-evolution/proposals`.
- Include proposals in `/admin/summary`, `/admin/timeline`, and governance exports.
- Register `self_evolution.propose` as an in-process write tool that creates proposals only.

## Explicit Non-Goals

- No automatic prompt edits.
- No runtime configuration mutation.
- No filesystem changes.
- No approval/apply or rollback execution in this slice.

## Verification

```bash
node --experimental-strip-types --test tests/self-evolution.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```
