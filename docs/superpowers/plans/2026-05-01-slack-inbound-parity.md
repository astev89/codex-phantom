# Slack Inbound Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Slack inbound behavior closer to Phantom by adding progressive thread updates, status reactions, thread reply context, and feedback handling on top of the existing Slack Events API route.

**Architecture:** Keep Slack-specific behavior in focused channel files and leave `OrchestrationService.runCoordinator` unchanged. The inbound router remains the execution boundary; Slack progress and feedback are side effects driven by agent events and Slack interactions.

**Tech Stack:** TypeScript ESM, Node `node:test`, SQLite through `AppDatabase`, Slack Web API methods, existing channel stores and `HttpServer`.

---

## File Structure

- Create `src/channels/slack-progress.ts`: translates `AgentRunEvent` values into throttled Slack progress messages and status-reaction actions.
- Create `src/channels/slack-feedback.ts`: maps Slack block actions and reaction feedback into durable feedback records.
- Modify `src/channels/slack.ts`: extend the transport with `chat.update`, `reactions.add`, `reactions.remove`, and optional Block Kit payloads.
- Modify `src/channels/inbound.ts`: persist progress metadata and feedback references without changing coordinator execution.
- Modify `src/platform/database.ts`: add additive SQLite tables/columns for inbound progress and Slack feedback.
- Modify `src/channels/slack-events.ts`: preserve thread reply context and map feedback reactions separately from normal run-triggering reactions.
- Modify `src/server/http-server.ts`: wire Slack progress callbacks, Slack interactive payload verification, and admin visibility.
- Modify `tests/channels-inbound.test.ts` and `tests/server.test.ts`: cover progress, reactions, thread context, feedback actions, and failure behavior.
- Modify `docs/channels.md`, `docs/phantom-parity.md`, and `docs/project-status.md`: document the completed parity slice and remaining non-targets.

---

### Task 1: Slack Transport Parity Primitives

**Files:**
- Modify: `src/channels/slack.ts`
- Test: `tests/channels-inbound.test.ts`

- [ ] **Step 1: Write the failing transport-shape test**

Add a test fake that implements the expanded `SlackTransport` and assert `SlackChannel` can send, update, add a reaction, remove a reaction, and send feedback blocks:

```ts
test("slack channel supports messages, updates, reactions, and feedback blocks", async () => {
  const transport = new RecordingSlackTransport();
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-slack-transport-"));
  const database = new AppDatabase(join(dataDir, "transport.sqlite"));
  const config = makeConfig(dataDir, { slackBotToken: "xoxb-token" });
  const registry = new ChannelRegistry(database, config);
  const deliveries = new ChannelDeliveryStore(database);
  const slack = new SlackChannel(config, registry, deliveries, transport);
  registry.upsert({ id: "slack", enabled: true });

  await slack.sendMessage({ channel: "C123", text: "Queued", threadTs: "100.1", blocks: feedbackBlocks("inbound_1") });
  await slack.updateMessage({ channel: "C123", ts: "101.1", text: "Running" });
  await slack.addReaction({ channel: "C123", timestamp: "100.1", name: "hourglass_flowing_sand" });
  await slack.removeReaction({ channel: "C123", timestamp: "100.1", name: "hourglass_flowing_sand" });

  assert.equal(transport.messages[0]?.blocks?.[0]?.type, "actions");
  assert.equal(transport.updates[0]?.text, "Running");
  assert.equal(transport.reactions[0]?.name, "hourglass_flowing_sand");
  assert.equal(transport.removedReactions[0]?.name, "hourglass_flowing_sand");
});
```

- [ ] **Step 2: Run the focused test**

Run: `node --experimental-strip-types --test tests/channels-inbound.test.ts`

Expected: FAIL because `SlackChannel.updateMessage`, `addReaction`, `removeReaction`, and `blocks` do not exist yet.

- [ ] **Step 3: Implement the minimal Slack transport expansion**

Add these public methods and transport functions:

```ts
export type SlackBlock = Record<string, JsonValue>;

export type SlackTransport = {
  sendMessage(input: { token: string; channel: string; text: string; threadTs?: string; blocks?: SlackBlock[] }): Promise<SlackApiResult>;
  updateMessage(input: { token: string; channel: string; ts: string; text: string; blocks?: SlackBlock[] }): Promise<SlackApiResult>;
  addReaction(input: { token: string; channel: string; timestamp: string; name: string }): Promise<SlackApiResult>;
  removeReaction(input: { token: string; channel: string; timestamp: string; name: string }): Promise<SlackApiResult>;
};
```

Record delivery rows for each method with payload metadata `{ method: "chat.update" }`, `{ method: "reactions.add" }`, or `{ method: "reactions.remove" }`.

- [ ] **Step 4: Run tests and commit**

Run: `node --experimental-strip-types --test tests/channels-inbound.test.ts`

Commit:

```bash
git add src/channels/slack.ts tests/channels-inbound.test.ts
git commit -m "feat(slack): add inbound progress transport primitives"
```

---

### Task 2: Durable Inbound Progress State

**Files:**
- Modify: `src/platform/database.ts`
- Modify: `src/channels/inbound.ts`
- Test: `tests/channels-inbound.test.ts`

- [ ] **Step 1: Write the failing progress-store test**

Add coverage for progress metadata and recent progress events:

```ts
store.recordProgress(first.record.id, {
  state: "running",
  messageTs: "101.000",
  statusReaction: "hourglass_flowing_sand",
  summary: "Coordinator started"
});

const progress = store.listProgress(first.record.id);
assert.equal(progress[0]?.state, "running");
assert.equal(progress[0]?.summary, "Coordinator started");
assert.equal(store.get(first.record.id)?.progressState, "running");
```

- [ ] **Step 2: Run the focused test**

Run: `node --experimental-strip-types --test tests/channels-inbound.test.ts`

Expected: FAIL because progress methods and columns are missing.

- [ ] **Step 3: Add additive SQLite persistence**

In `AppDatabase.migrate()`, add:

```sql
ALTER TABLE inbound_channel_events ADD COLUMN progress_state TEXT;
ALTER TABLE inbound_channel_events ADD COLUMN progress_message_ts TEXT;
CREATE TABLE IF NOT EXISTS inbound_channel_progress (
  id TEXT PRIMARY KEY,
  inbound_event_id TEXT NOT NULL,
  state TEXT NOT NULL,
  message_ts TEXT,
  status_reaction TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (inbound_event_id) REFERENCES inbound_channel_events(id)
);
```

Use existing `ensureColumn` for the two new columns.

- [ ] **Step 4: Implement store APIs**

Add:

```ts
recordProgress(id: string, input: { state: "queued" | "running" | "completed" | "failed"; messageTs?: string; statusReaction?: string; summary: string }): InboundChannelProgressRecord
listProgress(id: string, limit?: number): InboundChannelProgressRecord[]
```

Update `InboundChannelEventRecord` with `progressState?: string` and `progressMessageTs?: string`.

- [ ] **Step 5: Run tests and commit**

Run: `node --experimental-strip-types --test tests/channels-inbound.test.ts`

Commit:

```bash
git add src/platform/database.ts src/channels/inbound.ts tests/channels-inbound.test.ts
git commit -m "feat(channels): persist inbound progress state"
```

---

### Task 3: Progressive Slack Thread Updates

**Files:**
- Create: `src/channels/slack-progress.ts`
- Modify: `src/server/http-server.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write the failing server integration test**

Extend the Slack inbound test to assert that one progress message is posted, updated, and completed:

```ts
assert.equal(fakeSlack.sent.some((message) => message.text.includes("Queued")), true);
await eventually(() => assert.equal(fakeSlack.updated.some((message) => message.text.includes("Completed")), true));
const inbound = await getInboundEvent(inboundEventId);
assert.equal(inbound.progressState, "completed");
```

- [ ] **Step 2: Run the focused integration test**

Run: `node --experimental-strip-types --test tests/server.test.ts`

Expected: FAIL because Slack inbound only posts one final reply.

- [ ] **Step 3: Implement `SlackProgressReporter`**

Create a reporter with this public API:

```ts
export class SlackProgressReporter {
  constructor(input: { slack: SlackChannel; store: InboundChannelEventStore; recordId: string; target: Extract<InboundResponseTarget, { type: "slack_thread" }> }) {}
  async queued(): Promise<void> {}
  async onEvent(event: AgentRunEvent): Promise<void> {}
  async completed(outputText: string): Promise<void> {}
  async failed(message: string): Promise<void> {}
}
```

Behavior:
- `queued()` posts `Queued...` in the target thread and records `queued`.
- `onEvent(init)` updates the progress message to `Running...`.
- `onEvent(tool_call_started)` updates to `Running tool: <toolName>`.
- `onEvent(subagent_progress)` updates to the subagent summary.
- throttle update calls to at most one per 750 ms, but always allow final updates.
- `completed()` updates the progress message to `Completed` and posts the final output with feedback buttons.
- `failed()` updates the progress message to `Failed: <message>`.

- [ ] **Step 4: Wire the reporter in `/channels/slack/events`**

In `HttpServer`, create the reporter immediately after `routeAsync` returns for non-duplicate Slack events. Pass `onEvent`, `onComplete`, and `onFailure` callbacks into the router so the reporter receives lifecycle events.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node --experimental-strip-types --test tests/server.test.ts
npm run typecheck
```

Commit:

```bash
git add src/channels/slack-progress.ts src/server/http-server.ts tests/server.test.ts
git commit -m "feat(slack): add progressive inbound thread updates"
```

---

### Task 4: Slack Status Reactions

**Files:**
- Modify: `src/channels/slack-progress.ts`
- Modify: `src/server/http-server.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write the failing reaction lifecycle test**

Assert Slack reactions transition across queued, running, and completed:

```ts
assert.deepEqual(fakeSlack.reactions.map((reaction) => reaction.name), [
  "eyes",
  "hourglass_flowing_sand",
  "white_check_mark"
]);
assert.equal(fakeSlack.removedReactions.some((reaction) => reaction.name === "hourglass_flowing_sand"), true);
```

- [ ] **Step 2: Run the focused integration test**

Run: `node --experimental-strip-types --test tests/server.test.ts`

Expected: FAIL because reactions are not called.

- [ ] **Step 3: Implement best-effort reaction transitions**

Map states:
- queued: add `eyes`
- running: remove `eyes`, add `hourglass_flowing_sand`
- completed: remove `hourglass_flowing_sand`, add `white_check_mark`
- failed: remove `hourglass_flowing_sand`, add `x`

Catch and log Slack reaction failures without failing the inbound coordinator run.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
node --experimental-strip-types --test tests/server.test.ts
npm run typecheck
```

Commit:

```bash
git add src/channels/slack-progress.ts src/server/http-server.ts tests/server.test.ts
git commit -m "feat(slack): add inbound status reactions"
```

---

### Task 5: Thread Reply Context

**Files:**
- Modify: `src/channels/slack-events.ts`
- Modify: `src/channels/inbound.ts`
- Test: `tests/channels-inbound.test.ts`

- [ ] **Step 1: Write failing mapper tests for thread replies**

Add assertions that Slack replies keep thread context:

```ts
const reply = mapSlackEventToInboundMessage({
  type: "event_callback",
  event_id: "EvThreadReply",
  event: {
    type: "message",
    channel_type: "channel",
    user: "U123",
    channel: "C123",
    text: "<@B999> continue from above",
    ts: "200.2",
    thread_ts: "100.1"
  }
}, { botUserId: "B999" });

assert.equal(reply?.conversationId, "slack:C123:100.1");
assert.deepEqual(reply?.metadata?.slack, { channel: "C123", ts: "200.2", threadTs: "100.1", isThreadReply: true });
```

- [ ] **Step 2: Run the mapper test**

Run: `node --experimental-strip-types --test tests/channels-inbound.test.ts`

Expected: FAIL because `metadata` is not part of the inbound message contract.

- [ ] **Step 3: Add inbound metadata support**

Add `metadata?: Record<string, JsonValue>` to `InboundChannelMessage` and `InboundChannelEventRecord`, persist it as `metadata_json`, and pass it into the coordinator request metadata if that request type already accepts metadata. If the coordinator request type does not accept metadata, persist it only and do not widen `runCoordinator`.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
node --experimental-strip-types --test tests/channels-inbound.test.ts
npm run typecheck
```

Commit:

```bash
git add src/channels/slack-events.ts src/channels/inbound.ts src/platform/database.ts tests/channels-inbound.test.ts
git commit -m "feat(slack): preserve inbound thread context"
```

---

### Task 6: Feedback Buttons And Reaction Feedback

**Files:**
- Create: `src/channels/slack-feedback.ts`
- Modify: `src/platform/database.ts`
- Modify: `src/server/http-server.ts`
- Modify: `src/channels/slack-events.ts`
- Test: `tests/channels-inbound.test.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write failing feedback tests**

Cover both Block Kit actions and reaction feedback:

```ts
const payload = signSlackInteractivePayload({
  type: "block_actions",
  user: { id: "U123" },
  channel: { id: "C123" },
  message: { ts: "300.1" },
  actions: [{ action_id: "codex_feedback_positive", value: "inbound_1" }]
});

const response = await fetch(`${baseUrl}/channels/slack/interactions`, {
  method: "POST",
  headers: payload.headers,
  body: payload.body
});

assert.equal(response.status, 200);
assert.equal(feedbackStore.list({ inboundEventId: "inbound_1" })[0]?.rating, "positive");
```

For reactions, map `thumbsup`, `white_check_mark`, and `heavy_plus_sign` to positive; map `thumbsdown`, `x`, and `warning` to negative.

- [ ] **Step 2: Run focused tests**

Run:

```bash
node --experimental-strip-types --test tests/channels-inbound.test.ts
node --experimental-strip-types --test tests/server.test.ts
```

Expected: FAIL because feedback storage and `/channels/slack/interactions` do not exist.

- [ ] **Step 3: Add feedback persistence and mapping**

Create table:

```sql
CREATE TABLE IF NOT EXISTS inbound_channel_feedback (
  id TEXT PRIMARY KEY,
  inbound_event_id TEXT,
  channel_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  conversation_id TEXT,
  sender_id TEXT,
  rating TEXT NOT NULL,
  source TEXT NOT NULL,
  raw_payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_feedback_provider_event
ON inbound_channel_feedback(channel_id, provider_event_id);
```

Implement `SlackFeedbackStore.record()` and `mapSlackFeedback()` for block actions and reaction payloads.

- [ ] **Step 4: Wire Slack interactions**

Add `POST /channels/slack/interactions`:
- verify the same Slack signing headers against the raw form body.
- parse `application/x-www-form-urlencoded` body key `payload`.
- record feedback and return `200 { status: "recorded" }`.
- reject missing signing secret with `412` and bad signatures with `401`.

- [ ] **Step 5: Add feedback buttons to final Slack replies**

Add Block Kit buttons to completed final replies:
- `codex_feedback_positive` with value `<inboundEventId>`
- `codex_feedback_negative` with value `<inboundEventId>`

- [ ] **Step 6: Run tests and commit**

Run:

```bash
node --experimental-strip-types --test tests/channels-inbound.test.ts tests/server.test.ts
npm run typecheck
```

Commit:

```bash
git add src/channels/slack-feedback.ts src/channels/slack-progress.ts src/server/http-server.ts src/platform/database.ts src/channels/slack-events.ts tests/channels-inbound.test.ts tests/server.test.ts
git commit -m "feat(slack): record inbound feedback signals"
```

---

### Task 7: Operator Visibility And Docs

**Files:**
- Modify: `src/server/http-server.ts`
- Modify: `docs/channels.md`
- Modify: `docs/phantom-parity.md`
- Modify: `docs/project-status.md`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write failing admin visibility tests**

Assert `/admin/channels/inbound` includes progress and feedback summaries:

```ts
const response = await fetch(`${baseUrl}/admin/channels/inbound`, { headers: operatorHeaders });
const body = await response.json() as { events: Array<{ progress: unknown[]; feedback: unknown[] }> };
assert.equal(body.events[0]?.progress.length > 0, true);
assert.equal(body.events[0]?.feedback.length > 0, true);
```

- [ ] **Step 2: Run the server test**

Run: `node --experimental-strip-types --test tests/server.test.ts`

Expected: FAIL because admin inbound responses only include event records.

- [ ] **Step 3: Extend admin output**

Include `progress` and `feedback` arrays for inbound event records in:
- `GET /admin/channels/inbound`
- `/admin/summary` recent inbound failures
- channel export payload
- timeline export payload

- [ ] **Step 4: Update docs**

Document:
- progressive Slack thread updates.
- status reaction lifecycle.
- feedback buttons and reaction feedback mapping.
- thread reply conversation handling.
- remaining explicit non-targets: Web Chat and Telegram.

Move Slack inbound parity from `Not implemented yet` to matched coverage in `docs/phantom-parity.md`, leaving any richer Phantom-only behavior as a named follow-up.

- [ ] **Step 5: Final verification and commit**

Run:

```bash
node --experimental-strip-types --test tests/channels-inbound.test.ts tests/server.test.ts
npm run typecheck
npm test
npm run build
```

Run GitNexus before commit:

```bash
npx gitnexus detect-changes --scope staged
```

Commit:

```bash
git add src/server/http-server.ts docs/channels.md docs/phantom-parity.md docs/project-status.md tests/server.test.ts
git commit -m "docs(slack): document inbound parity behavior"
```

---

## Self-Review

- Spec coverage: app mentions, DMs, channel/group mention events, reactions, thread replies, progressive updates, feedback buttons, and status reactions are covered. Web Chat and Telegram remain out of scope.
- Boundary check: no task changes `OrchestrationService.runCoordinator`; all behavior is wired through inbound routing callbacks and Slack channel side effects.
- Test coverage: focused unit tests cover mappers/stores; server tests cover signed Slack HTTP routes and operator visibility.
- Risk: Slack API side effects are best-effort after the HTTP ack. Failures must be recorded in delivery logs and inbound progress state without changing the already-sent Slack `202` response.
