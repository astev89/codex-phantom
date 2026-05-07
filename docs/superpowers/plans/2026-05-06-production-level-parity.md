# Production-Level Parity Implementation Plan

Goal: reach Phantom feature parity, excluding Telegram, with every completed parity feature meeting the production-safe bar.

Authoritative references:

- `CONTEXT.md` defines canonical terms.
- `docs/adr/0001-define-production-level-parity-scope.md` records the durable scope decision.
- `docs/phantom-parity.md` owns the parity matrix, exclusions, and priority order.
- `docs/project-status.md` records completed waves and verification evidence.

## Wave 1: Production Proof

This wave blocks later feature waves until smoke evidence is recorded.

- Run `scripts/deployment-smoke.sh` with production-like secrets.
- Run `scripts/backup-restore-smoke.sh` only against disposable Docker volumes.
- Record exact commands, environment notes, pass/fail evidence, and follow-ups in `docs/project-status.md`.

Evidence standard:

- Record branch and commit SHA.
- Record Docker/Compose state before and after.
- List required environment variable names with secret values redacted.
- Record `scripts/deployment-smoke.sh` success and the covered endpoints.
- Record `scripts/backup-restore-smoke.sh` success and explicit confirmation that `codex-phantom-data` was disposable.
- If a script fails, record the failing step, relevant output excerpt, and remediation owner before continuing.

## Wave 2: Slack Parity

Write a fresh Slack production parity plan after Wave 1 passes. Treat `docs/superpowers/plans/2026-05-01-slack-inbound-parity.md` as historical technical context only.

- Add progressive Slack thread updates during coordinator execution.
- Add status reactions for queued, running, completed, and failed states.
- Preserve Slack thread context for app mentions, DMs, channel/group messages, and replies.
- Add feedback buttons and reaction feedback handling.
- Ensure Slack side-effect failures are audited and operator-visible without breaking already-acked inbound requests.

## Wave 3: Operator Onboarding Parity

- Add YAML-first role/config layers for internal operation.
- Add first-run setup readiness checks for required secrets, channels, roles, and storage.
- Keep magic-link auth out of scope unless the user base changes.
- Route risky config changes through governed proposals or explicit operator actions.

## Wave 4: Managed Memory Parity

- Add contradiction and supersession handling.
- Add scheduled consolidation plus promote/prune behavior.
- Add decay and reinforcement signals.
- Tune richer hybrid retrieval only after lifecycle controls exist.

## Wave 5: Governed Self-Evolution

- Let the agent propose changes to prompts, memory policy, tools, roles, and configuration.
- Add policy gates, audit trails, approvals for risky mutations, and rollback metadata.
- Keep unrestricted self-mutation out of scope.

## Wave 6: Internal Tool Parity

- Add internal governed tool bundle manifests.
- Add import, approval, enable, disable, and uninstall lifecycle.
- Add audit and operator visibility.
- Do not build a public marketplace.

## Wave 7: Artifact Intelligence

- Add automatic artifact extraction from selected tool events or structured run outputs.
- Add searchable contents for safe text-like attachments.
- Preserve current explicit artifact APIs.

## Wave 8: Future Channel Parity

- Recompare against Phantom for any non-Telegram channels not yet represented.
- Treat discovered channels as in scope unless explicitly carved out in `CONTEXT.md` and, if durable, an ADR.

## Verification Standard

Every wave must include:

- focused unit or integration tests;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- `git diff --check`;
- GitNexus impact analysis before symbol edits and change detection before commit;
- docs updates to `docs/project-status.md` and `docs/phantom-parity.md` when status changes.
