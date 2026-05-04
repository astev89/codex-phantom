import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/platform/database.ts";
import { makeConfig } from "./helpers.ts";
import { ChannelRegistry } from "../src/channels/registry.ts";
import { InboundChannelEventStore, InboundChannelRouter } from "../src/channels/inbound.ts";
import {
  mapSlackEventToInboundMessage,
  validateSlackRequest,
  type SlackEventsPayload
} from "../src/channels/slack-events.ts";

function signedSlackHeaders(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000).toString()): Headers {
  const signature = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return new Headers({
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${signature}`
  });
}

test("slack request validation accepts current signatures and rejects invalid requests", () => {
  const secret = "slack-signing-secret";
  const body = JSON.stringify({ type: "event_callback", event_id: "Ev123" });
  const nowSeconds = Math.floor(Date.now() / 1000);

  assert.equal(validateSlackRequest(signedSlackHeaders(secret, body, `${nowSeconds}`), secret, body), true);
  assert.equal(validateSlackRequest(new Headers(), secret, body), false);
  assert.equal(validateSlackRequest(signedSlackHeaders("wrong-secret", body, `${nowSeconds}`), secret, body), false);
  assert.equal(validateSlackRequest(signedSlackHeaders(secret, body, `${nowSeconds - 600}`), secret, body, nowSeconds * 1000), false);
  assert.equal(
    validateSlackRequest(new Headers({ "x-slack-request-timestamp": `${nowSeconds}`, "x-slack-signature": "sha1=bad" }), secret, body),
    false
  );
});

test("slack event mapper handles supported events and ignores noise", () => {
  const appMention: SlackEventsPayload = {
    type: "event_callback",
    event_id: "EvMention",
    event: {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      text: "<@B999> please summarize",
      ts: "1713900000.000100",
      thread_ts: "1713900000.000000"
    }
  };
  const mentionMessage = mapSlackEventToInboundMessage(appMention, { botUserId: "B999" });
  assert.equal(mentionMessage?.providerEventId, "EvMention");
  assert.equal(mentionMessage?.conversationId, "slack:C123:1713900000.000000");
  assert.equal(mentionMessage?.message, "please summarize");
  assert.deepEqual(mentionMessage?.responseTarget, {
    type: "slack_thread",
    channel: "C123",
    threadTs: "1713900000.000000"
  });

  const directMessage: SlackEventsPayload = {
    type: "event_callback",
    event_id: "EvDm",
    event: {
      type: "message",
      channel_type: "im",
      user: "U123",
      channel: "D123",
      text: "hello in dm",
      ts: "1713900001.000100"
    }
  };
  assert.equal(mapSlackEventToInboundMessage(directMessage, { botUserId: "B999" })?.message, "hello in dm");

  const channelMention: SlackEventsPayload = {
    type: "event_callback",
    event_id: "EvChannel",
    event: {
      type: "message",
      channel_type: "channel",
      user: "U123",
      channel: "C123",
      text: "hey <@B999> run checks",
      ts: "1713900002.000100"
    }
  };
  assert.equal(mapSlackEventToInboundMessage(channelMention, { botUserId: "B999" })?.message, "hey run checks");

  const reaction: SlackEventsPayload = {
    type: "event_callback",
    event_id: "EvReaction",
    event: {
      type: "reaction_added",
      user: "U123",
      reaction: "thumbsup",
      item: { channel: "C123", ts: "1713900003.000100" }
    }
  };
  assert.equal(mapSlackEventToInboundMessage(reaction, { botUserId: "B999" })?.message, "Slack reaction :thumbsup: from U123");

  assert.equal(mapSlackEventToInboundMessage({ ...directMessage, event_id: "EvBot", event: { ...directMessage.event, bot_id: "B1" } }, { botUserId: "B999" }), null);
  assert.equal(mapSlackEventToInboundMessage({ ...directMessage, event_id: "EvSelf", event: { ...directMessage.event, user: "B999" } }, { botUserId: "B999" }), null);
  assert.equal(
    mapSlackEventToInboundMessage({ ...channelMention, event_id: "EvNoMention", event: { ...channelMention.event, text: "no bot here" } }, { botUserId: "B999" }),
    null
  );
});

test("inbound event store records lifecycle states and dedupes provider events", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-inbound-"));
  const config = makeConfig(dataDir, { slackSigningSecret: "slack-signing-secret" });
  const database = new AppDatabase(join(dataDir, "inbound.sqlite"));
  const channels = new ChannelRegistry(database, config);
  const store = new InboundChannelEventStore(database);

  try {
    channels.upsert({ id: "slack", enabled: true });
    const first = store.recordReceived({
      channelId: "slack",
      providerEventId: "Ev123",
      conversationId: "slack:C123:1713900000.000000",
      senderId: "U123",
      message: "hello",
      threadId: "1713900000.000000",
      responseTarget: { type: "slack_thread", channel: "C123", threadTs: "1713900000.000000" },
      rawPayload: { event_id: "Ev123" }
    });
    const duplicate = store.recordReceived({
      channelId: "slack",
      providerEventId: "Ev123",
      conversationId: "slack:C123:1713900000.000000",
      senderId: "U123",
      message: "hello again",
      rawPayload: { event_id: "Ev123" }
    });

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.record.id, first.record.id);

    store.markRunning(first.record.id);
    store.markCompleted(first.record.id, { sessionId: "session_123", runId: "run_123", outputText: "done" });
    const [record] = store.list({ channelId: "slack" });
    assert.equal(record?.status, "completed");
    assert.equal(record?.runId, "run_123");
    assert.equal(record?.outputText, "done");
    assert.doesNotThrow(() => store.list({ channelId: "slack", limit: Number.NaN }));
    assert.equal(store.summary().completed, 1);
  } finally {
    database.close();
  }
});

test("inbound async completion side effects do not mark successful runs failed", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-inbound-router-"));
  const config = makeConfig(dataDir, { slackSigningSecret: "slack-signing-secret" });
  const database = new AppDatabase(join(dataDir, "router.sqlite"));
  const channels = new ChannelRegistry(database, config);
  const store = new InboundChannelEventStore(database);
  const orchestration = {
    async runCoordinator() {
      return {
        sessionId: "session_123",
        runId: "run_123",
        outputText: "done"
      };
    }
  };
  const router = new InboundChannelRouter(channels, store, orchestration as never);

  try {
    channels.upsert({ id: "slack", enabled: true });
    const routed = router.routeAsync(
      {
        channelId: "slack",
        providerEventId: "EvCallbackFailure",
        conversationId: "slack:C123:1713900000.000000",
        senderId: "U123",
        message: "hello",
        responseTarget: { type: "slack_thread", channel: "C123", threadTs: "1713900000.000000" },
        rawPayload: { event_id: "EvCallbackFailure" }
      },
      {
        async onComplete() {
          throw new Error("Slack delivery failed");
        }
      }
    );
    const completed = await routed.completion;

    assert.equal(completed.status, "completed");
    assert.equal(completed.runId, "run_123");
    assert.equal(store.summary().failed, 0);
  } finally {
    database.close();
  }
});
