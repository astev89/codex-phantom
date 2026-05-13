# Slack Production Parity Plan

Goal: bring Slack behavior to production-level Phantom parity, excluding Telegram, now that deployment and backup/restore proof has passed.

Historical context: `docs/superpowers/plans/2026-05-01-slack-inbound-parity.md` is superseded for implementation and should be used only as technical reference. This plan owns the current Slack work order.

## Parity Target

Slack parity means the Slack path supports:

- app mentions, DMs, channel/group mention events, reactions, and thread replies;
- progressive thread updates while the coordinator runs;
- status reactions for queued, running, completed, and failed states;
- feedback buttons on final replies;
- reaction feedback mapped into durable operator-visible records.

## Production-Safe Bar

Every Slack slice must preserve:

- auth: verify Slack signatures for Events API and interaction payloads;
- limits: bounded request bodies, throttled progress updates, and capped Slack retries;
- auditability: durable inbound, delivery, progress, and feedback records;
- operator visibility: admin summaries, inbound views, exports, and recent failure surfaces;
- recovery behavior: restart-safe persisted state, with no promise of replaying already-acked work in this wave;
- failure isolation: Slack side-effect failures must not change an already-sent Slack HTTP ack or fail a successful coordinator run;
- verification: focused `node:test` coverage plus `npm run typecheck`, `npm test`, `npm run build`, and GitNexus change detection.

## Mergeable Slices

### 1. Slack Transport Primitives

Add typed Slack support for `chat.update`, `reactions.add`, `reactions.remove`, and Block Kit blocks on `chat.postMessage`. Record delivery rows with method metadata and retry behavior consistent with existing `chat.postMessage`.

Unlocks: progressive updates, status reactions, feedback buttons.

### 2. Durable Inbound Progress State

Add inbound progress persistence for queued, running, completed, and failed states, including Slack message timestamp and status reaction metadata. Expose progress in inbound admin detail/export surfaces.

Unlocks: restart-visible Slack progress and operator diagnosis.

### 3. Progressive Thread Updates

Post a queued progress message in the Slack thread, update it during coordinator lifecycle events, and finalize it as completed or failed. Throttle non-final updates and treat Slack update failures as delivery/progress failures, not coordinator failures.

Unlocks: visible in-thread execution status.

### 4. Status Reactions

Add best-effort reaction transitions on the triggering Slack event: queued, running, completed, and failed. Reaction failures should be logged and recorded without changing inbound event completion.

Unlocks: Phantom-style lightweight Slack status signaling.

### 5. Thread Context Preservation

Preserve Slack thread identity for app mentions, DMs, channel/group messages, and replies. Store Slack event metadata needed to explain which message triggered a run and where responses should land.

Unlocks: accurate replies and audit trails across thread workflows.

### 6. Feedback Buttons And Reaction Feedback

Add signed Slack interaction handling for positive/negative final-reply buttons. Map selected Slack reactions into feedback records with provider event dedupe. Surface feedback in inbound admin views and exports.

Unlocks: operator-visible quality signals.

### 7. Docs And Status Closure

Document Slack Events and interactions setup in `docs/channels.md`, update the parity matrix, and move Slack parity from partial to completed only after the slices pass verification.

## Suggested Execution Order

1. Transport primitives.
2. Durable progress state.
3. Progressive thread updates.
4. Status reactions.
5. Thread context preservation.
6. Feedback buttons and reaction feedback.
7. Operator visibility/docs closure.

Transport and progress state should land before user-visible Slack behavior. Thread context can proceed in parallel with status reactions once transport primitives exist. Feedback should wait until final reply Block Kit support exists.

## Verification Checklist

For each implementation slice:

```bash
node --experimental-strip-types --test tests/channels-inbound.test.ts
node --experimental-strip-types --test tests/server.test.ts
npm run typecheck
npm test
npm run build
git diff --check
```

Before committing, run GitNexus impact analysis for any edited TypeScript symbols and GitNexus change detection for the final diff.
