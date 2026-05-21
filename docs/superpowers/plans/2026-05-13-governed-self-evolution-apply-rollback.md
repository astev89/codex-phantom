# Governed Self-Evolution Apply And Rollback Plan

## Goal

Complete the first approved mutation path for governed self-evolution without opening unrestricted self-mutation.

## Implementation

- Extend proposals from `proposed` into review and execution states: `approved`, `rejected`, `applied`, `failed`, and `rolled_back`.
- Store review actor, notes, apply actor, rollback actor, apply errors, and timestamps on the proposal.
- Add `self_evolution_mutations` records for before/after/rollback metadata and mutation status.
- Add operator-only actions:
  - `POST /admin/self-evolution/proposals/:id/approve`
  - `POST /admin/self-evolution/proposals/:id/reject`
  - `POST /admin/self-evolution/proposals/:id/apply`
  - `POST /admin/self-evolution/proposals/:id/rollback`
- Support one low-risk mutation class in v1: `configuration` proposals with `proposedChange.operatorSettings`.
- Require `confirmHighRisk: true` before high- or critical-risk proposals can apply.
- Keep prompt, memory policy, tool, role, filesystem, auth, and runtime policy mutation out of the apply path until their own safe mutation classes exist.

## Verification

```bash
node --experimental-strip-types --test tests/self-evolution.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
GitNexus detect_changes(scope="all")
```
