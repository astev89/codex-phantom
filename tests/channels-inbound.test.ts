import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppDatabase } from "../src/platform/database.ts";
import { makeConfig } from "./helpers.ts";
import { ChannelRegistry } from "../src/channels/registry.ts";
import { ChannelDeliveryStore } from "../src/channels/delivery-log.ts";
import {
  InboundChannelEventStore,
  InboundChannelRouter,
} from "../src/channels/inbound.ts";
import {
  SlackChannel,
  type SlackBlock,
  type SlackTransport,
} from "../src/channels/slack.ts";
import {
  mapSlackEventToInboundMessage,
  validateSlackRequest,
  type SlackEventsPayload,
} from "../src/channels/slack-events.ts";
import {
  SlackFeedbackStore,
  mapSlackInteractionFeedback,
  mapSlackReactionFeedback,
  slackFeedbackBlocks,
} from "../src/channels/slack-feedback.ts";

class RecordingSlackTransport implements SlackTransport {
  readonly messages: Array<{
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: SlackBlock[];
  }> = [];
  readonly updates: Array<{
    channel: string;
    ts: string;
    text: string;
    blocks?: SlackBlock[];
  }> = [];
  readonly reactions: Array<{
    channel: string;
    timestamp: string;
    name: string;
  }> = [];
  readonly removedReactions: Array<{
    channel: string;
    timestamp: string;
    name: string;
  }> = [];

  async sendMessage(input: {
    token: string;
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: SlackBlock[];
  }) {
    this.messages.push({
      channel: input.channel,
      text: input.text,
      threadTs: input.threadTs,
      blocks: input.blocks,
    });
    return { ok: true, ts: "1713900000.000200", statusCode: 200 };
  }

  async updateMessage(input: {
    token: string;
    channel: string;
    ts: string;
    text: string;
    blocks?: SlackBlock[];
  }) {
    this.updates.push({
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      blocks: input.blocks,
    });
    return { ok: true, ts: input.ts, statusCode: 200 };
  }

  async addReaction(input: {
    token: string;
    channel: string;
    timestamp: string;
    name: string;
  }) {
    this.reactions.push({
      channel: input.channel,
      timestamp: input.timestamp,
      name: input.name,
    });
    return { ok: true, statusCode: 200 };
  }

  async removeReaction(input: {
    token: string;
    channel: string;
    timestamp: string;
    name: string;
  }) {
    this.removedReactions.push({
      channel: input.channel,
      timestamp: input.timestamp,
      name: input.name,
    });
    return { ok: true, statusCode: 200 };
  }
}

function signedSlackHeaders(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000).toString()
): Headers {
  const signature = createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return new Headers({
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${signature}`,
  });
}

test("slack request validation accepts current signatures and rejects invalid requests", () => {
  const secret = "slack-signing-secret";
  const body = JSON.stringify({ type: "event_callback", event_id: "Ev123" });
  const nowSeconds = Math.floor(Date.now() / 1000);

  assert.equal(
    validateSlackRequest(
      signedSlackHeaders(secret, body, `${nowSeconds}`),
      secret,
      body
    ),
    true
  );
  assert.equal(validateSlackRequest(new Headers(), secret, body), false);
  assert.equal(
    validateSlackRequest(
      signedSlackHeaders("wrong-secret", body, `${nowSeconds}`),
      secret,
      body
    ),
    false
  );
  assert.equal(
    validateSlackRequest(
      signedSlackHeaders(secret, body, `${nowSeconds - 600}`),
      secret,
      body,
      nowSeconds * 1000
    ),
    false
  );
  assert.equal(
    validateSlackRequest(
      new Headers({
        "x-slack-request-timestamp": `${nowSeconds}`,
        "x-slack-signature": "sha1=bad",
      }),
      secret,
      body
    ),
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
      thread_ts: "1713900000.000000",
    },
  };
  const mentionMessage = mapSlackEventToInboundMessage(appMention, {
    botUserId: "B999",
  });
  assert.equal(mentionMessage?.providerEventId, "EvMention");
  assert.equal(mentionMessage?.conversationId, "slack:C123:1713900000.000000");
  assert.equal(mentionMessage?.message, "please summarize");
  assert.deepEqual(mentionMessage?.responseTarget, {
    type: "slack_thread",
    channel: "C123",
    threadTs: "1713900000.000000",
    messageTs: "1713900000.000100",
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
      ts: "1713900001.000100",
    },
  };
  assert.equal(
    mapSlackEventToInboundMessage(directMessage, { botUserId: "B999" })
      ?.message,
    "hello in dm"
  );

  const channelMention: SlackEventsPayload = {
    type: "event_callback",
    event_id: "EvChannel",
    event: {
      type: "message",
      channel_type: "channel",
      user: "U123",
      channel: "C123",
      text: "hey <@B999> run checks",
      ts: "1713900002.000100",
    },
  };
  assert.equal(
    mapSlackEventToInboundMessage(channelMention, { botUserId: "B999" })
      ?.message,
    "hey run checks"
  );

  const reaction: SlackEventsPayload = {
    type: "event_callback",
    event_id: "EvReaction",
    event: {
      type: "reaction_added",
      user: "U123",
      reaction: "thumbsup",
      item: { channel: "C123", ts: "1713900003.000100" },
    },
  };
  assert.equal(
    mapSlackEventToInboundMessage(reaction, { botUserId: "B999" }),
    null
  );

  const threadReply: SlackEventsPayload = {
    type: "event_callback",
    event_id: "EvThreadReply",
    event: {
      type: "message",
      channel_type: "group",
      user: "U123",
      channel: "G123",
      text: "<@B999> follow up here",
      ts: "1713900004.000200",
      thread_ts: "1713900004.000000",
    },
  };
  const reply = mapSlackEventToInboundMessage(threadReply, {
    botUserId: "B999",
  });
  assert.equal(reply?.conversationId, "slack:G123:1713900004.000000");
  assert.deepEqual(reply?.responseTarget, {
    type: "slack_thread",
    channel: "G123",
    threadTs: "1713900004.000000",
    messageTs: "1713900004.000200",
  });

  assert.equal(
    mapSlackEventToInboundMessage(
      {
        ...directMessage,
        event_id: "EvBot",
        event: { ...directMessage.event, bot_id: "B1" },
      },
      { botUserId: "B999" }
    ),
    null
  );
  assert.equal(
    mapSlackEventToInboundMessage(
      {
        ...directMessage,
        event_id: "EvSelf",
        event: { ...directMessage.event, user: "B999" },
      },
      { botUserId: "B999" }
    ),
    null
  );
  assert.equal(
    mapSlackEventToInboundMessage(
      {
        ...channelMention,
        event_id: "EvNoMention",
        event: { ...channelMention.event, text: "no bot here" },
      },
      { botUserId: "B999" }
    ),
    null
  );
});

test("inbound event store records lifecycle states and dedupes provider events", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-inbound-"));
  const config = makeConfig(dataDir, {
    slackSigningSecret: "slack-signing-secret",
  });
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
      responseTarget: {
        type: "slack_thread",
        channel: "C123",
        threadTs: "1713900000.000000",
      },
      rawPayload: { event_id: "Ev123" },
    });
    const duplicate = store.recordReceived({
      channelId: "slack",
      providerEventId: "Ev123",
      conversationId: "slack:C123:1713900000.000000",
      senderId: "U123",
      message: "hello again",
      rawPayload: { event_id: "Ev123" },
    });

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.record.id, first.record.id);

    store.markRunning(first.record.id);
    store.recordProgress(first.record.id, {
      state: "running",
      messageTs: "1713900000.000200",
      statusReaction: "hourglass_flowing_sand",
      summary: "Coordinator started",
    });
    store.markCompleted(first.record.id, {
      sessionId: "session_123",
      runId: "run_123",
      outputText: "done",
    });
    const [record] = store.list({ channelId: "slack" });
    assert.equal(record?.status, "completed");
    assert.equal(record?.runId, "run_123");
    assert.equal(record?.outputText, "done");
    assert.equal(record?.progressState, "running");
    assert.equal(record?.progressMessageTs, "1713900000.000200");
    assert.equal(record?.progress?.[0]?.summary, "Coordinator started");
    assert.equal(
      store.listProgress(first.record.id)[0]?.statusReaction,
      "hourglass_flowing_sand"
    );
    assert.doesNotThrow(() =>
      store.list({ channelId: "slack", limit: Number.NaN })
    );
    assert.equal(store.summary().completed, 1);
  } finally {
    database.close();
  }
});

test("inbound event store preserves email reply response targets", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "codex-phantom-inbound-email-reply-")
  );
  const config = makeConfig(dataDir);
  const database = new AppDatabase(join(dataDir, "email-reply.sqlite"));
  const store = new InboundChannelEventStore(database);

  try {
    const recorded = store.recordReceived({
      channelId: "email",
      providerEventId: "provider-email-1",
      conversationId: "<root@example.com>",
      senderId: "sender@example.com",
      message: "hello from email",
      responseTarget: {
        type: "email_reply",
        to: "sender@example.com",
        subject: "Status Update",
        messageId: "<child@example.com>",
        references: ["<root@example.com>", "<parent@example.com>"],
        fromMessageProviderId: "provider-email-1",
      },
      rawPayload: { providerMessageId: "provider-email-1" },
    });
    const stored = store.get(recorded.record.id);

    assert.deepEqual(stored?.responseTarget, {
      type: "email_reply",
      to: "sender@example.com",
      subject: "Status Update",
      messageId: "<child@example.com>",
      references: ["<root@example.com>", "<parent@example.com>"],
      fromMessageProviderId: "provider-email-1",
    });
  } finally {
    database.close();
  }
});

test("slack channel supports message updates, reactions, and block payloads", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "codex-phantom-slack-transport-")
  );
  const config = makeConfig(dataDir, { slackBotToken: "xoxb-test-token" });
  const database = new AppDatabase(join(dataDir, "transport.sqlite"));
  const channels = new ChannelRegistry(database, config);
  const deliveries = new ChannelDeliveryStore(database);
  const transport = new RecordingSlackTransport();

  try {
    channels.upsert({ id: "slack", enabled: true });
    const slack = new SlackChannel(config, channels, deliveries, transport);
    await slack.sendMessage({
      channel: "C123",
      text: "Queued",
      threadTs: "100.1",
      blocks: [{ type: "actions", block_id: "feedback" }],
    });
    await slack.updateMessage({
      channel: "C123",
      ts: "101.1",
      text: "Running",
    });
    await slack.addReaction({
      channel: "C123",
      timestamp: "100.1",
      name: "hourglass_flowing_sand",
    });
    await slack.removeReaction({
      channel: "C123",
      timestamp: "100.1",
      name: "hourglass_flowing_sand",
    });

    assert.equal(transport.messages[0]?.blocks?.[0]?.type, "actions");
    assert.equal(transport.updates[0]?.text, "Running");
    assert.equal(transport.reactions[0]?.name, "hourglass_flowing_sand");
    assert.equal(transport.removedReactions[0]?.name, "hourglass_flowing_sand");
    assert.equal(
      deliveries
        .list("slack")
        .filter((delivery) => delivery.status === "delivered").length,
      4
    );
  } finally {
    database.close();
  }
});

test("slack feedback helpers map buttons and reactions and dedupe records", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "codex-phantom-slack-feedback-")
  );
  const database = new AppDatabase(join(dataDir, "feedback.sqlite"));
  const inbound = new InboundChannelEventStore(database);
  const feedback = new SlackFeedbackStore(database);

  try {
    const blocks = slackFeedbackBlocks("inbound_123");
    assert.equal(blocks[0]?.type, "actions");
    assert.ok(JSON.stringify(blocks).includes("codex_feedback_positive"));
    assert.ok(JSON.stringify(blocks).includes("codex_feedback_negative"));

    const interaction = mapSlackInteractionFeedback({
      type: "block_actions",
      user: { id: "U123" },
      channel: { id: "C123" },
      container: { message_ts: "1713900000.000200" },
      message: { thread_ts: "1713900000.000100" },
      actions: [
        {
          action_id: "codex_feedback_positive",
          value: "inbound_123",
          action_ts: "1713900001.000000",
        },
      ],
    });
    assert.equal(interaction?.inboundEventId, "inbound_123");
    assert.equal(interaction?.rating, "positive");
    assert.equal(interaction?.messageTs, "1713900000.000200");

    const reactionPayload: SlackEventsPayload = {
      type: "event_callback",
      event_id: "EvFeedback",
      event: {
        type: "reaction_added",
        user: "U456",
        reaction: "thumbsdown",
        item: { channel: "C123", ts: "1713900000.000200" },
      },
    };
    const reaction = mapSlackReactionFeedback(reactionPayload);
    assert.equal(reaction?.providerEventId, "EvFeedback");
    assert.equal(reaction?.rating, "negative");
    assert.equal(
      mapSlackReactionFeedback({
        ...reactionPayload,
        event_id: "EvNonFeedback",
        event: { ...reactionPayload.event, reaction: "eyes" },
      }),
      null
    );

    const inboundRecord = inbound.recordReceived({
      channelId: "slack",
      providerEventId: "EvInbound",
      conversationId: "slack:C123:1713900000.000100",
      senderId: "U123",
      message: "hello",
      rawPayload: { event_id: "EvInbound" },
    });
    const first = feedback.record({
      inboundEvent: inboundRecord.record,
      channelId: "slack",
      providerEventId: interaction?.providerEventId ?? "interaction",
      rating: "positive",
      source: "button",
      userId: interaction?.userId,
      slackChannel: interaction?.slackChannel,
      messageTs: interaction?.messageTs,
      threadTs: interaction?.threadTs,
      rawPayload: { type: "block_actions" },
    });
    const second = feedback.record({
      inboundEvent: inboundRecord.record,
      channelId: "slack",
      providerEventId: interaction?.providerEventId ?? "interaction",
      rating: "positive",
      source: "button",
      rawPayload: { type: "block_actions" },
    });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(feedback.summary().positive, 1);
    assert.equal(feedback.summary().negative, 0);
  } finally {
    database.close();
  }
});

test("inbound async completion side effects do not mark successful runs failed", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "codex-phantom-inbound-router-")
  );
  const config = makeConfig(dataDir, {
    slackSigningSecret: "slack-signing-secret",
  });
  const database = new AppDatabase(join(dataDir, "router.sqlite"));
  const channels = new ChannelRegistry(database, config);
  const store = new InboundChannelEventStore(database);
  const orchestration = {
    async runCoordinator() {
      return {
        sessionId: "session_123",
        runId: "run_123",
        outputText: "done",
      };
    },
  };
  const router = new InboundChannelRouter(
    channels,
    store,
    orchestration as never
  );

  try {
    channels.upsert({ id: "slack", enabled: true });
    const routed = router.routeAsync(
      {
        channelId: "slack",
        providerEventId: "EvCallbackFailure",
        conversationId: "slack:C123:1713900000.000000",
        senderId: "U123",
        message: "hello",
        responseTarget: {
          type: "slack_thread",
          channel: "C123",
          threadTs: "1713900000.000000",
        },
        rawPayload: { event_id: "EvCallbackFailure" },
      },
      {
        async onComplete() {
          throw new Error("Slack delivery failed");
        },
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
