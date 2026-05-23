# Email Channel Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production-safe Email channel parity with Phantom by supporting bounded IMAP inbound polling, SMTP replies, threading, attachment-aware metadata, audit, readiness, and operator visibility.

**Architecture:** Email is a disabled-by-default first-class runtime channel. When enabled, it requires both IMAP and SMTP configuration, polls unread email in bounded batches, durably accepts/dedupes inbound messages before marking them seen, routes accepted messages through `InboundChannelRouter`, and sends threaded SMTP replies from the async completion callback. Real provider libraries live behind transport interfaces so tests use deterministic fake IMAP/SMTP transports.

**Tech Stack:** TypeScript ESM, Node `node:test`, SQLite via `AppDatabase`, existing channel stores/router, `imapflow`, `mailparser`, `nodemailer`, Pino logging, existing admin/readiness surfaces.

---

## Resolved Design Decisions

- Email is a first-class runtime channel, not an SMTP notification helper.
- Email is disabled by default.
- Enabling Email requires complete IMAP and SMTP config; no inbound-only or outbound-only mode in this parity slice.
- Use bounded IMAP polling first, not Phantom's long-lived IMAP IDLE loop.
- Thread identity is header-first using `Message-ID`, `In-Reply-To`, and `References`, with sender plus normalized subject fallback.
- Attachment handling is metadata-first with safe bounded text extraction only when it can reuse existing audited storage/indexing paths.
- SMTP reply delivery has bounded retries and a separate delivery failure state; SMTP failure does not make a completed agent run fail.
- Mark inbound messages seen only after durable inbound accept/dedupe succeeds.
- Operator scope is visibility plus enable/disable only; no manual poll/retry/resend controls in the first slice.
- Verification uses fake IMAP/SMTP transport integration tests and docs; no real mailbox smoke test is required to land the first slice.

## File Map

- Modify `package.json`: add runtime dependencies for `imapflow`, `mailparser`, and `nodemailer`.
- Modify `src/config.ts`: add Email config fields, env parsing, timeout/batch limits, and enabled-channel validation helpers.
- Modify `.env.example`: document Email env vars and safe defaults.
- Modify `docs/configuration.md`: document Email config and production behavior.
- Modify `src/channels/registry.ts`: add default `email` channel with required secret/config metadata.
- Create `src/channels/email-types.ts`: shared Email message, thread, attachment, poll, and send types.
- Create `src/channels/email-transports.ts`: real IMAP/SMTP adapters behind narrow interfaces.
- Create `src/channels/email.ts`: Email channel service, polling lifecycle, parse-to-inbound mapping, mark-seen semantics, reply sending, retry, and delivery audit.
- Modify `src/index.ts`: construct/start/stop the Email channel service when runtime starts/stops.
- Modify `src/server/readiness.ts`: report missing Email config when `email` is enabled.
- Modify `src/server/diagnostics.ts`: include Email config/readiness hints.
- Modify `src/server/http-server.ts`: expose Email status in admin summaries using existing channel surfaces.
- Modify `src/server/ui.ts`: ensure the operator console can inspect Email status through existing channel panels.
- Modify `src/platform/database.ts` only if thread metadata needs a durable table beyond `inbound_channel_events.raw_payload_json`; prefer avoiding a schema change unless tests prove raw payload is insufficient.
- Add `tests/email-channel.test.ts`: fake transport unit/integration coverage for Email service behavior.
- Modify `tests/server.test.ts`, `tests/readiness.test.ts`, and `tests/channels-inbound.test.ts` as needed for admin/readiness/channel integration coverage.
- Modify `docs/phantom-parity.md` and `docs/project-status.md` at closure after implementation and verification.

## Task 1: Config, Registry, And Readiness Skeleton

**Files:**

- Modify: `package.json`
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `docs/configuration.md`
- Modify: `src/channels/registry.ts`
- Modify: `src/server/readiness.ts`
- Modify: `src/server/diagnostics.ts`
- Test: `tests/readiness.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis before editing symbols**

Run impact analysis for the symbols this task will edit:

```ts
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "loadConfig",
  direction: "upstream",
});
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "validateConfig",
  direction: "upstream",
});
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "ChannelRegistry",
  direction: "upstream",
});
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "buildSetupReadiness",
  direction: "upstream",
});
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "buildStartupDiagnostics",
  direction: "upstream",
});
```

Expected: report blast radius before editing. Stop and warn the user if any result is HIGH or CRITICAL.

- [ ] **Step 2: Write failing readiness tests for disabled Email**

Add coverage in `tests/readiness.test.ts` proving the default `email` channel exists, is disabled, and does not fail readiness when Email env vars are absent.

Test intent:

```ts
test("email channel is available but disabled by default", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "codex-phantom-email-readiness-"));
  const config = makeConfig(dataDir);
  const database = new AppDatabase(join(dataDir, "readiness.sqlite"));
  const channels = new ChannelRegistry(database, config);

  try {
    const email = channels.get("email");
    assert.ok(email);
    assert.equal(email.enabled, false);
    assert.equal(email.secretPresent, false);
  } finally {
    database.close();
  }
});
```

Run:

```bash
node --experimental-strip-types --test tests/readiness.test.ts
```

Expected: FAIL because `email` is not seeded yet.

- [ ] **Step 3: Add Email config shape and defaults**

Extend `AppConfig` in `src/config.ts` with:

```ts
emailImapHost?: string;
emailImapPort: number;
emailImapUsername?: string;
emailImapPassword?: string;
emailImapTls: boolean;
emailSmtpHost?: string;
emailSmtpPort: number;
emailSmtpUsername?: string;
emailSmtpPassword?: string;
emailSmtpTls: boolean;
emailFromAddress?: string;
emailFromName: string;
emailPollIntervalMs: number;
emailPollBatchSize: number;
emailMaxMessageBytes: number;
emailMaxAttachmentBytes: number;
emailSendTimeoutMs: number;
```

Parse env vars:

```ts
EMAIL_IMAP_HOST;
EMAIL_IMAP_PORT;
EMAIL_IMAP_USERNAME;
EMAIL_IMAP_PASSWORD;
EMAIL_IMAP_TLS;
EMAIL_SMTP_HOST;
EMAIL_SMTP_PORT;
EMAIL_SMTP_USERNAME;
EMAIL_SMTP_PASSWORD;
EMAIL_SMTP_TLS;
EMAIL_FROM_ADDRESS;
EMAIL_FROM_NAME;
EMAIL_POLL_INTERVAL_MS;
EMAIL_POLL_BATCH_SIZE;
EMAIL_MAX_MESSAGE_BYTES;
EMAIL_MAX_ATTACHMENT_BYTES;
EMAIL_SEND_TIMEOUT_MS;
```

Use safe defaults:

```ts
EMAIL_IMAP_PORT: 993;
EMAIL_IMAP_TLS: true;
EMAIL_SMTP_PORT: 587;
EMAIL_SMTP_TLS: true;
EMAIL_FROM_NAME: config.agentName;
EMAIL_POLL_INTERVAL_MS: 30000;
EMAIL_POLL_BATCH_SIZE: 10;
EMAIL_MAX_MESSAGE_BYTES: 1048576;
EMAIL_MAX_ATTACHMENT_BYTES: 200000;
EMAIL_SEND_TIMEOUT_MS: 10000;
```

Add helper:

```ts
export function emailConfigComplete(config: AppConfig): boolean {
  return Boolean(
    config.emailImapHost &&
    config.emailImapUsername &&
    config.emailImapPassword &&
    config.emailSmtpHost &&
    config.emailSmtpUsername &&
    config.emailSmtpPassword &&
    config.emailFromAddress
  );
}
```

- [ ] **Step 4: Add default `email` channel**

In `src/channels/registry.ts`, add:

```ts
{
  id: "email",
  kind: "external_chat",
  displayName: "Email",
  description: "Email channel with bounded IMAP polling and SMTP replies.",
  enabled: false,
  secretEnvVar: "EMAIL_IMAP_PASSWORD",
  config: {
    transport: "email",
    status: "available",
    requiredSecretEnvVars: [
      "EMAIL_IMAP_HOST",
      "EMAIL_IMAP_USERNAME",
      "EMAIL_IMAP_PASSWORD",
      "EMAIL_SMTP_HOST",
      "EMAIL_SMTP_USERNAME",
      "EMAIL_SMTP_PASSWORD",
      "EMAIL_FROM_ADDRESS"
    ],
    optionalSecretEnvVars: [
      "EMAIL_FROM_NAME"
    ]
  }
}
```

Update `resolveSecretPresence` to check Email config fields from `AppConfig` rather than reading all values directly from `process.env`.

- [ ] **Step 5: Add readiness diagnostics**

In `src/server/readiness.ts`, keep the existing generic channel secret check, but ensure the missing action for Email lists the full required env set. In `src/server/diagnostics.ts`, add Email missing recommended env entries only when `email` is enabled.

- [ ] **Step 6: Update env/docs**

Add Email vars to `.env.example` and `docs/configuration.md`. Document that Email is disabled by default, requires both IMAP and SMTP when enabled, uses bounded polling, and should use app passwords or provider-specific credentials.

- [ ] **Step 7: Verify Task 1**

Run:

```bash
node --experimental-strip-types --test tests/readiness.test.ts
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add package.json src/config.ts .env.example docs/configuration.md src/channels/registry.ts src/server/readiness.ts src/server/diagnostics.ts tests/readiness.test.ts
git commit -m "feat(channels): add email readiness skeleton"
```

## Task 2: Email Transport Interfaces And Real Adapters

**Files:**

- Create: `src/channels/email-types.ts`
- Create: `src/channels/email-transports.ts`
- Test: `tests/email-channel.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis before editing symbols**

This task creates new symbols and does not edit existing code. Record that impact analysis is not required for new-only files.

- [ ] **Step 2: Write fake-transport tests first**

Create `tests/email-channel.test.ts` with fake transports and type-level expectations for:

```ts
type FakeEmailPollTransport = {
  listUnread(input: {
    maxMessages: number;
    maxBytes: number;
  }): Promise<EmailInboundMessage[]>;
  markSeen(providerMessageId: string): Promise<void>;
  close(): Promise<void>;
};

type FakeEmailSendTransport = {
  send(input: EmailSendInput): Promise<EmailSendResult>;
  close(): Promise<void>;
};
```

Run:

```bash
node --experimental-strip-types --test tests/email-channel.test.ts
```

Expected: FAIL because Email types do not exist.

- [ ] **Step 3: Add shared Email types**

Create `src/channels/email-types.ts`:

```ts
import type { JsonValue } from "../shared/types.ts";

export type EmailAddress = {
  address: string;
  name?: string;
};

export type EmailAttachmentMetadata = {
  filename?: string;
  contentType: string;
  sizeBytes: number;
  contentId?: string;
  disposition?: string;
  indexedText?: string;
  indexedBytes?: number;
  skippedReason?: string;
};

export type EmailThreadMetadata = {
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  normalizedSubject: string;
  fallbackThreadKey: string;
};

export type EmailInboundMessage = {
  providerMessageId: string;
  uid: string;
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  text: string;
  html?: string;
  date: string;
  thread: EmailThreadMetadata;
  attachments: EmailAttachmentMetadata[];
  rawPayload: JsonValue;
};

export type EmailSendInput = {
  to: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  inReplyTo?: string;
  references: string[];
};

export type EmailSendResult = {
  providerMessageId?: string;
  response: JsonValue;
};

export type EmailPollTransport = {
  listUnread(input: {
    maxMessages: number;
    maxBytes: number;
  }): Promise<EmailInboundMessage[]>;
  markSeen(providerMessageId: string): Promise<void>;
  close(): Promise<void>;
};

export type EmailSendTransport = {
  send(input: EmailSendInput): Promise<EmailSendResult>;
  close(): Promise<void>;
};
```

- [ ] **Step 4: Add real transport adapters**

Create `src/channels/email-transports.ts` with:

- `ImapEmailPollTransport implements EmailPollTransport`
- `SmtpEmailSendTransport implements EmailSendTransport`
- a `parseEmailMessage` helper using `mailparser`
- bounded `maxMessages`, `maxBytes`, and attachment metadata extraction

Do not route messages or send replies here. This file only adapts provider libraries to internal types.

- [ ] **Step 5: Verify Task 2**

Run:

```bash
node --experimental-strip-types --test tests/email-channel.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add package.json src/channels/email-types.ts src/channels/email-transports.ts tests/email-channel.test.ts
git commit -m "feat(channels): add email transport adapters"
```

## Task 3: Email Channel Polling And Inbound Routing

**Files:**

- Create: `src/channels/email.ts`
- Modify: `src/index.ts`
- Test: `tests/email-channel.test.ts`
- Test: `tests/channels-inbound.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis before editing symbols**

Run:

```ts
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "InboundChannelRouter",
  direction: "upstream",
});
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "ChannelDeliveryStore",
  direction: "upstream",
});
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "index.ts",
  direction: "upstream",
});
```

Expected: report blast radius before edits. Stop and warn the user if HIGH or CRITICAL.

- [ ] **Step 2: Write failing tests for durable accept and mark-seen behavior**

In `tests/email-channel.test.ts`, add tests proving:

- poll processes at most `emailPollBatchSize`
- auto-replies are skipped
- inbound message is recorded through `InboundChannelRouter.routeAsync`
- fake transport `markSeen` is called only after route accept/dedupe succeeds
- route failure before durable accept leaves the message unseen

Run:

```bash
node --experimental-strip-types --test tests/email-channel.test.ts
```

Expected: FAIL because `EmailChannelService` does not exist.

- [ ] **Step 3: Implement `EmailChannelService`**

Create `src/channels/email.ts` with a service shaped like:

```ts
export class EmailChannelService {
  constructor(input: {
    config: AppConfig;
    channels: ChannelRegistry;
    inboundRouter: InboundChannelRouter;
    deliveries: ChannelDeliveryStore;
    pollTransport: EmailPollTransport;
    sendTransport: EmailSendTransport;
    logger: Logger;
  });

  start(): Promise<void>;
  stop(): Promise<void>;
  pollOnce(): Promise<EmailPollSummary>;
  status(): EmailChannelStatus;
}
```

Core behavior:

- `start()` checks `channels.get("email")?.enabled`; if disabled, it does not poll.
- If enabled but config incomplete, it records status failure and does not silently run.
- `pollOnce()` fetches a bounded batch from `pollTransport.listUnread`.
- Each message maps to `InboundChannelMessage` with `channelId: "email"`.
- `providerEventId` uses the provider UID/message ID.
- `conversationId` uses header-first thread identity with fallback key.
- `responseTarget` can be `{ type: "email_reply", ... }` only after `InboundResponseTarget` is extended in Task 4; until then store reply metadata in raw payload and keep delivery disabled in tests.

- [ ] **Step 4: Extend inbound response target for Email**

In `src/channels/inbound.ts`, add:

```ts
| {
    type: "email_reply";
    to: string;
    subject: string;
    messageId?: string;
    references: string[];
    fromMessageProviderId: string;
  }
```

Update `toRecord` decoding only if needed; the existing JSON field should carry the new shape.

- [ ] **Step 5: Wire service lifecycle**

In `src/index.ts`, construct Email service with real transports when channel config is complete enough to instantiate. Start it after `server.listen()` or before, as long as shutdown stops it before closing the database.

Shutdown order:

```ts
await email?.stop();
await memoryMaintenance.stop();
await scheduler.stop();
await server.close();
```

- [ ] **Step 6: Verify Task 3**

Run:

```bash
node --experimental-strip-types --test tests/email-channel.test.ts tests/channels-inbound.test.ts
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/channels/email.ts src/channels/inbound.ts src/index.ts tests/email-channel.test.ts tests/channels-inbound.test.ts
git commit -m "feat(channels): route inbound email messages"
```

## Task 4: SMTP Replies, Retry, And Delivery Audit

**Files:**

- Modify: `src/channels/email.ts`
- Modify: `src/channels/delivery-log.ts` only if existing payload fields cannot represent Email delivery metadata
- Test: `tests/email-channel.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis before editing symbols**

Run:

```ts
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "EmailChannelService",
  direction: "upstream",
});
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "ChannelDeliveryStore",
  direction: "upstream",
});
```

Expected: report blast radius before edits. Stop and warn the user if HIGH or CRITICAL.

- [ ] **Step 2: Write failing SMTP reply tests**

Add tests proving:

- successful inbound completion sends a threaded SMTP reply
- final delivery record uses `channelId: "email"`
- transient send failure retries up to 3 attempts
- final SMTP failure records failed delivery
- SMTP failure does not change completed inbound event status to failed

Run:

```bash
node --experimental-strip-types --test tests/email-channel.test.ts
```

Expected: FAIL until reply delivery is implemented.

- [ ] **Step 3: Implement reply sending**

In `EmailChannelService`, add `deliverInboundResponse(record: InboundChannelEventRecord)` for `responseTarget.type === "email_reply"`:

- build text body from `record.outputText`
- build escaped HTML body with fenced code preservation similar to existing chat rendering safety
- create a generated Message-ID
- set `In-Reply-To` and `References`
- call `sendTransport.send`
- record delivery success/failure in `ChannelDeliveryStore`

Retry policy:

```ts
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    const result = await this.sendTransport.send(input);
    record delivered;
    return;
  } catch (error) {
    if (attempt === 3 || !isRetryableEmailSendError(error)) {
      record failed;
      return;
    }
    await sleep(Math.min(attempt * 250, 1000));
  }
}
```

- [ ] **Step 4: Connect reply delivery to async completion**

When routing Email messages with `InboundChannelRouter.routeAsync`, pass `onComplete` that calls `deliverInboundResponse`. Use side-effect isolation like Slack: delivery failures are logged/audited but do not throw back into the completed run.

- [ ] **Step 5: Verify Task 4**

Run:

```bash
node --experimental-strip-types --test tests/email-channel.test.ts tests/channels-inbound.test.ts
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/channels/email.ts src/channels/delivery-log.ts tests/email-channel.test.ts
git commit -m "feat(channels): send audited email replies"
```

## Task 5: Attachment Metadata And Safe Text Extraction

**Files:**

- Modify: `src/channels/email-types.ts`
- Modify: `src/channels/email-transports.ts`
- Modify: `src/channels/email.ts`
- Modify: `src/chat/session-store.ts` only if reusing existing chat attachment indexing requires a public helper
- Test: `tests/email-channel.test.ts`
- Test: `tests/server.test.ts` only if admin/session visibility changes

- [ ] **Step 1: Run GitNexus impact analysis before editing symbols**

Run:

```ts
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "EmailChannelService",
  direction: "upstream",
});
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "SessionStore",
  direction: "upstream",
});
```

Expected: report blast radius before edits. Skip `SessionStore` edits if the safe metadata can stay in inbound raw payload for this slice.

- [ ] **Step 2: Write failing attachment metadata tests**

Add tests proving:

- text-like attachments below `EMAIL_MAX_ATTACHMENT_BYTES` expose bounded `indexedText`
- oversized attachments set `skippedReason: "too_large"`
- binary attachments set `skippedReason: "unsupported_content_type"`
- inbound raw payload preserves attachment metadata
- no unbounded binary body is written to SQLite

Run:

```bash
node --experimental-strip-types --test tests/email-channel.test.ts
```

Expected: FAIL until metadata extraction is implemented.

- [ ] **Step 3: Implement safe metadata extraction**

In `email-transports.ts`, parse attachments into `EmailAttachmentMetadata` with:

- `filename`
- `contentType`
- `sizeBytes`
- `contentId`
- `disposition`
- `indexedText` only for `text/plain`, `text/markdown`, `application/json`, and small safe UTF-8 content
- `indexedBytes`
- `skippedReason`

Do not store raw binary bodies in `rawPayload`.

- [ ] **Step 4: Verify Task 5**

Run:

```bash
node --experimental-strip-types --test tests/email-channel.test.ts
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/channels/email-types.ts src/channels/email-transports.ts src/channels/email.ts src/chat/session-store.ts tests/email-channel.test.ts tests/server.test.ts
git commit -m "feat(channels): capture safe email attachment metadata"
```

## Task 6: Admin Visibility And Operator Console

**Files:**

- Modify: `src/server/http-server.ts`
- Modify: `src/server/ui.ts`
- Modify: `src/server/diagnostics.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis before editing symbols**

Run:

```ts
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "HttpServer",
  direction: "upstream",
});
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "renderOperatorConsole",
  direction: "upstream",
});
mcp__gitnexus__.impact({
  repo: "codex-phantom",
  target: "buildStartupDiagnostics",
  direction: "upstream",
});
```

Expected: report blast radius before edits. Stop and warn the user if HIGH or CRITICAL.

- [ ] **Step 2: Write failing admin tests**

In `tests/server.test.ts`, add tests proving:

- `/admin/channels` includes `email`
- enabling Email without config reports missing required Email env in `/admin/readiness`
- `/admin/channels/inbound?channelId=email` returns Email inbound events
- `/admin/channels/deliveries?channelId=email` returns Email delivery records
- `/admin/summary` includes Email in channel summaries and diagnostics

Run:

```bash
node --experimental-strip-types --test tests/server.test.ts
```

Expected: FAIL until surfaces include Email status correctly.

- [ ] **Step 3: Implement admin visibility**

Use existing channel endpoints wherever possible. Add only narrow Email-specific status fields if the generic channel summary cannot show:

- enabled/disabled state
- config completeness
- last poll time
- last poll error
- recent delivery failures

Prefer adding these fields to `EmailChannelStatus` and including them in `/admin/summary` over adding new mutating endpoints.

- [ ] **Step 4: Update operator console**

Keep the console simple: the existing Channels, Channel Deliveries, Readiness, and Diagnostics panels should show Email state. Add labels or placeholders only if tests show the generic JSON panel is ambiguous.

- [ ] **Step 5: Verify Task 6**

Run:

```bash
node --experimental-strip-types --test tests/server.test.ts tests/readiness.test.ts
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add src/server/http-server.ts src/server/ui.ts src/server/diagnostics.ts tests/server.test.ts tests/readiness.test.ts
git commit -m "feat(server): surface email channel operations"
```

## Task 7: Documentation, Parity Closure, And Final Verification

**Files:**

- Modify: `docs/channels.md` or create it if no channel guide exists
- Modify: `docs/configuration.md`
- Modify: `docs/phantom-parity.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-05-23-email-channel-parity.md` only for checked-off execution notes

- [ ] **Step 1: Document Email setup**

Document:

- provider mailbox requirements
- IMAP and SMTP env vars
- disabled-by-default behavior
- all-or-nothing enabled config
- polling interval and batch limits
- attachment metadata and skip reasons
- delivery retry behavior
- operator endpoints for inbound/delivery inspection
- no real mailbox smoke blocker for first implementation

- [ ] **Step 2: Update parity docs**

In `docs/phantom-parity.md`:

- move Channel parity from `Partial` to `Mostly complete` if Email tests/docs pass
- note Email uses bounded polling by ADR, not IMAP IDLE
- keep Telegram excluded and Discord out of scope

In `docs/project-status.md`:

- move Email parity into `Just Completed`
- update Last updated date, branch, and verified commit after commit exists
- remove or rewrite P1 Email next task
- include exact verification commands that passed

- [ ] **Step 3: Run final verification**

Run:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Run GitNexus change detection before the final commit:

```ts
mcp__gitnexus__.detect_changes({ repo: "codex-phantom", scope: "staged" });
```

Expected: low or expected risk, no surprising affected flows.

- [ ] **Step 4: Commit Task 7**

```bash
git add docs/channels.md docs/configuration.md docs/phantom-parity.md docs/project-status.md docs/superpowers/plans/2026-05-23-email-channel-parity.md
git commit -m "docs(channels): close email parity plan"
```

## Final Verification Checklist

Before declaring the wave complete:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

GitNexus:

- Impact analysis was run before editing every existing function/class/method.
- Change detection was run before each commit or at least before final commit.
- Any HIGH or CRITICAL finding was reported before proceeding.

Manual review:

- Email remains disabled by default.
- Missing Email config does not fail readiness unless `email` is enabled.
- Enabled Email requires complete IMAP and SMTP config.
- No raw mailbox binary blobs are stored in SQLite.
- SMTP delivery failure is visible as delivery failure, not inbound run failure.
- `docs/project-status.md` and `docs/phantom-parity.md` match the implemented state.
