# Channel Contracts

## Normalized Inbound Routing

Inbound channels normalize external events into one message envelope before running the coordinator:

```json
{
  "channelId": "slack",
  "providerEventId": "Ev123",
  "conversationId": "slack:C123:1713900000.000000",
  "senderId": "U123",
  "message": "Summarize the latest operator state",
  "threadId": "1713900000.000000",
  "responseTarget": {
    "type": "slack_thread",
    "channel": "C123",
    "threadTs": "1713900000.000000",
    "messageTs": "1713900000.000100"
  }
}
```

The router validates that the channel is enabled, records accepted events as `received`, `running`, `completed`, or `failed` in SQLite, and deduplicates by `(channelId, providerEventId)`. The `ignored` state is reserved for events that are deliberately persisted as ignored; Slack bot/self/subtype noise is currently dropped before persistence. Operators can inspect recent inbound events through `GET /admin/channels/inbound`; `/admin/summary` includes inbound counts and recent failures.

Web Chat and Telegram are not current parity targets.

## Web Chat Surface

`GET /chat` serves the authenticated Codex-native browser chat surface. It is separate from the operator console at `/` and uses the same operator auth.

The chat app supports:

- streamed coordinator runs through `POST /chat/message`;
- recent session listing through `GET /chat/sessions`;
- transcript, run, attachment, and artifact detail through `GET /chat/sessions/:sessionId`;
- browser-local multi-tab refresh using `BroadcastChannel` plus `localStorage`;
- markdown rendering for common headings, emphasis, links, and code blocks;
- durable uploaded and searchable safe text attachments for existing sessions, with metadata fallback for first-message files;
- explicit generated artifact records;
- automatic artifact extraction from selected tool outputs and final structured output envelopes;
- browser notification permission prompts;
- automatic session titles derived from the first user message.

`POST /chat/message` emits named SSE events:

- `request.started`
- `agent.event`
- `run.completed`
- `request.completed`
- `request.failed`

Each event uses a versioned envelope with `version`, `type`, `requestId`, `sequence`, `createdAt`, optional `sessionId`/`runId`, and `payload`. Agent events also include `rawEvent` for compatibility with existing event consumers.

Continuity APIs:

- `POST /chat/attachments`: multipart upload with `sessionId`, optional `runId`, and one or more `file` parts.
- `GET /chat/attachments/:id`: authenticated attachment download.
- `GET /chat/attachments/search?q=term`: authenticated search across indexed safe text attachment contents.
- `POST /chat/artifacts`: create an explicit artifact with `sessionId`, optional `runId`, `title`, `kind`, `contentType`, `content`, and optional `metadata`.
- `GET /chat/artifacts/:id`: authenticated artifact download.

Attachment text indexing is bounded to the first 200 KB of safe text-like content types: `text/*`, JSON, Markdown, YAML, and NDJSON. Binary or unsafe MIME types remain downloadable but are recorded with a skipped index reason instead of searchable text.

Automatic extraction accepts bounded JSON envelopes shaped as `artifact` or `artifacts` from successful tool output events and final structured output text. Extracted records are linked to the source session/run, tagged with source metadata, capped at five artifacts and 1 MB each, and limited to safe text-like or JSON content types.

Uploaded blobs are stored under `CODEX_PHANTOM_DATA_DIR/chat-blobs/` with generated storage names. SQLite stores user filename, content type, size, SHA-256, session/run linkage, and timestamps. Artifact `kind` is one of `text`, `json`, or `file`.

This surface still does not register a service worker or Phantom's full 32-event browser wire protocol.

## Inbound Webhook Channel

`POST /channels/webhook` accepts external chat events and runs them through the coordinator as channel `webhook`.

Payload:

```json
{
  "conversationId": "external-thread-123",
  "message": "Summarize the latest operator state",
  "subagents": []
}
```

Headers:

- `Content-Type: application/json`
- `x-channel-timestamp`: Unix timestamp in seconds.
- `x-channel-signature`: `sha256=<hex hmac>`.

To sign a request, compute HMAC-SHA256 over `${timestamp}.${rawBody}` using `EXTERNAL_CHANNEL_SECRET`. Requests with missing headers, invalid signatures, or timestamps more than five minutes from server time are rejected with `401`.

The old `x-channel-secret` shared-secret header is no longer accepted. Webhook requests remain synchronous: successful responses include `sessionId`, `runId`, `outputText`, emitted events, and the recorded inbound event.

## Slack Channel

Operators must enable the `slack` channel before Slack sends or receives runs through the service.

Outbound sends require `SLACK_BOT_TOKEN` before calling `POST /channels/slack/message`.

Slack sends retry transient `429` and `5xx` transport responses up to three total attempts. Each final delivery record stores `attemptCount`, final status, response payload, and any error message; `/admin/summary` includes recent failed deliveries for operator visibility.

### Slack Events API

`POST /channels/slack/events` accepts Slack Events API requests when `SLACK_SIGNING_SECRET` is configured.

Slack headers:

- `x-slack-request-timestamp`: Unix timestamp in seconds.
- `x-slack-signature`: `v0=<hex hmac>`.

To sign or verify a request, compute HMAC-SHA256 over `v0:${timestamp}:${rawBody}` using `SLACK_SIGNING_SECRET`. Missing, invalid, or stale signatures are rejected before event parsing.

Supported payloads:

- `url_verification`: returns `{ "challenge": "..." }`.
- `event_callback` with `app_mention`.
- `event_callback` with direct-message `message.im`.
- `event_callback` with channel/group `message` events that mention `SLACK_BOT_USER_ID`.
- `event_callback` with `reaction_added`.

Bot/self/subtype noise is ignored. Duplicate Slack `event_id` values return `202` with `status: "duplicate"` and do not create another coordinator run.

Slack inbound requests use ack-then-run semantics: the HTTP request returns `202` quickly with an `inboundEventId`, then the coordinator runs in-process.

During execution, Slack runs post a progress message in the target thread, update that message as coordinator events arrive, and record progress rows in SQLite. Status reactions are best-effort on the triggering Slack message:

- `hourglass`: queued
- `hourglass_flowing_sand`: running
- `white_check_mark`: completed
- `x`: failed

Slack progress updates and reactions are delivery side effects. Failures are recorded in channel delivery/progress state for operator visibility, but they do not change an already-sent Slack HTTP ack and do not fail an otherwise successful coordinator run. On completion, `codex-phantom` still posts the final assistant output as a thread reply when `SLACK_BOT_TOKEN` is available and includes feedback buttons on that final reply.

### Slack Feedback

`POST /channels/slack/interactions` accepts Slack interactive payloads for feedback buttons when `SLACK_SIGNING_SECRET` is configured. Slack signs this form-encoded request with the same `x-slack-request-timestamp` and `x-slack-signature` contract as Events API requests. The `payload` form field must contain Slack's `block_actions` JSON.

Final Slack replies include two Block Kit buttons:

- `Helpful`: records positive feedback.
- `Needs work`: records negative feedback.

Feedback is stored in SQLite with channel, provider event, user, Slack channel, message/thread timestamp, inbound event, optional run ID, raw payload, and creation time. Duplicate Slack action IDs for the same inbound event/user/action timestamp are deduped. Operators can inspect feedback through `GET /admin/channels/feedback`; `/admin/summary`, channel exports, and timeline exports include recent feedback.

Selected `reaction_added` events are also treated as feedback when the reaction targets a known Slack response or progress message:

- positive: `thumbsup`, `white_check_mark`, `heavy_plus_sign`
- negative: `thumbsdown`, `x`, `warning`

If the reaction does not target a known response/progress message, normal Slack reaction routing still applies and can trigger a coordinator run.

## Email Channel

Operators must enable the `email` channel before `codex-phantom` polls a mailbox or sends threaded Email replies. Email is disabled by default and this parity slice is intentionally all-or-nothing: enabling the channel requires a complete IMAP and SMTP configuration together.

Provider mailbox expectations:

- the mailbox must support IMAP unread polling and SMTP submission for the same runtime identity;
- the configured mailbox should have permission to mark messages seen after durable accept or dedupe succeeds;
- provider app passwords or scoped mailbox credentials are preferred over reusing a personal login password.

Required environment variables when Email is enabled:

- `EMAIL_IMAP_HOST`
- `EMAIL_IMAP_USERNAME`
- `EMAIL_IMAP_PASSWORD`
- `EMAIL_SMTP_HOST`
- `EMAIL_SMTP_USERNAME`
- `EMAIL_SMTP_PASSWORD`
- `EMAIL_FROM_ADDRESS`

Useful optional variables:

- `EMAIL_IMAP_PORT`
- `EMAIL_IMAP_TLS`
- `EMAIL_SMTP_PORT`
- `EMAIL_SMTP_TLS`
- `EMAIL_FROM_NAME`
- `EMAIL_POLL_INTERVAL_MS`
- `EMAIL_POLL_BATCH_SIZE`
- `EMAIL_MAX_MESSAGE_BYTES`
- `EMAIL_MAX_ATTACHMENT_BYTES`
- `EMAIL_SEND_TIMEOUT_MS`

Bounded Email behavior:

- polling uses `EMAIL_POLL_INTERVAL_MS` and `EMAIL_POLL_BATCH_SIZE`;
- per-message raw size acceptance is capped by `EMAIL_MAX_MESSAGE_BYTES`;
- attachment metadata is captured without storing raw mailbox blobs in SQLite;
- text-like attachments under `EMAIL_MAX_ATTACHMENT_BYTES` can include bounded `indexedText` metadata;
- oversized attachments record `skippedReason: "too_large"`;
- unsupported or binary attachments record `skippedReason: "unsupported_content_type"`.

Inbound Email is normalized through the same router and audit path as other channels. Operators can inspect Email activity through `GET /admin/channels/inbound?channelId=email`, `GET /admin/channels/deliveries?channelId=email`, and `/admin/summary`.

Outbound Email replies use SMTP-native retry behavior. Transient `4xx` `responseCode` failures and retryable transport errors are retried up to three total attempts; permanent `5xx` failures stop immediately. Final delivery outcomes are audited under channel `email`, and a delivery failure does not turn a completed inbound run into a failed run.

Fake IMAP/SMTP transport coverage remains the release gate for normal CI. A credential-gated live mailbox smoke is available for operator proof when provider credentials are present:

```bash
EMAIL_SMOKE_TO_ADDRESS=operator@example.com npm run smoke:mailbox:live
```

The live smoke reads the existing `EMAIL_IMAP_*`, `EMAIL_SMTP_*`, and sender configuration, logs in to IMAP, inspects mailbox status without consuming or marking messages, and sends a bounded SMTP probe only to an explicit `EMAIL_SMOKE_TO_ADDRESS` or `--to` recipient. Use a non-runtime mailbox for that sink so the proof message cannot become inbound agent work. Missing credentials or a missing smoke recipient produce a JSON `skipped` result and exit successfully so PR verification can record credential-blocked live proof without committing secrets.
