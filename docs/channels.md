# Channel Contracts

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

The old `x-channel-secret` shared-secret header is no longer accepted.

## Slack Channel

Slack is currently outbound-focused. Operators must enable the `slack` channel and configure `SLACK_BOT_TOKEN` before calling `POST /channels/slack/message`.

Slack sends retry transient `429` and `5xx` transport responses up to three total attempts. Each final delivery record stores `attemptCount`, final status, response payload, and any error message; `/admin/summary` includes recent failed deliveries for operator visibility.
