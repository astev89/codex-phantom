import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  EmailSendInput,
  EmailSendResult,
} from "../src/channels/email-types.ts";
import {
  InboundResponseDispatcher,
  createEmailInboundResponseAdapter,
  createSlackInboundResponseAdapter,
} from "../src/channels/inbound-response-dispatcher.ts";
import { InboundChannelEventStore } from "../src/channels/inbound.ts";
import type { InboundChannelEventRecord } from "../src/channels/inbound.ts";
import { ChannelDeliveryStore } from "../src/channels/delivery-log.ts";
import { ChannelRegistry } from "../src/channels/registry.ts";
import {
  SlackChannel,
  type SlackBlock,
  type SlackTransport,
} from "../src/channels/slack.ts";
import { AppDatabase } from "../src/platform/database.ts";
import { Logger } from "../src/platform/logger.ts";
import { makeConfig } from "./helpers.ts";

class RecordingSlackTransport implements SlackTransport {
  readonly sent: Array<{
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: SlackBlock[];
  }> = [];
  readonly updated: Array<{ channel: string; ts: string; text: string }> = [];
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
  private nextTs = 1;

  async sendMessage(input: {
    token: string;
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: SlackBlock[];
  }) {
    this.sent.push({
      channel: input.channel,
      text: input.text,
      threadTs: input.threadTs,
      blocks: input.blocks,
    });
    return {
      ok: true,
      ts: `1713900000.00010${this.nextTs++}`,
      statusCode: 200,
    };
  }

  async updateMessage(input: {
    token: string;
    channel: string;
    ts: string;
    text: string;
  }) {
    this.updated.push({
      channel: input.channel,
      ts: input.ts,
      text: input.text,
    });
    return { ok: true, ts: input.ts, statusCode: 200 };
  }

  async addReaction(input: {
    token: string;
    channel: string;
    timestamp: string;
    name: string;
  }) {
    this.reactions.push(input);
    return { ok: true, statusCode: 200 };
  }

  async removeReaction(input: {
    token: string;
    channel: string;
    timestamp: string;
    name: string;
  }) {
    this.removedReactions.push(input);
    return { ok: true, statusCode: 200 };
  }
}

class RecordingEmailSendTransport {
  readonly sent: EmailSendInput[] = [];
  readonly failures: unknown[] = [];

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    this.sent.push(input);
    const failure = this.failures.shift();
    if (failure) {
      throw failure;
    }
    return {
      providerMessageId: input.messageId,
      response: { accepted: [input.to] },
    };
  }

  async close(): Promise<void> {}
}

async function withStores(
  name: string,
  run: (input: {
    database: AppDatabase;
    channels: ChannelRegistry;
    deliveries: ChannelDeliveryStore;
    inbound: InboundChannelEventStore;
  }) => Promise<void>
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), `codex-phantom-${name}-`));
  const config = makeConfig(dataDir, {
    slackBotToken: "xoxb-test-token",
    emailFromAddress: "bot@example.com",
    emailFromName: "Codex Phantom",
  });
  const database = new AppDatabase(join(dataDir, `${name}.sqlite`));
  const channels = new ChannelRegistry(database, config);
  const deliveries = new ChannelDeliveryStore(database);
  const inbound = new InboundChannelEventStore(database);

  try {
    await run({ database, channels, deliveries, inbound });
  } finally {
    database.close();
  }
}

test("dispatcher sends Slack progress, final reply, and response timestamp", async () => {
  await withStores(
    "dispatcher-slack",
    async ({ channels, deliveries, inbound }) => {
      channels.upsert({ id: "slack", enabled: true });
      const config = makeConfig("/tmp", { slackBotToken: "xoxb-test-token" });
      const transport = new RecordingSlackTransport();
      const slack = new SlackChannel(config, channels, deliveries, transport);
      const dispatcher = new InboundResponseDispatcher({
        logger: new Logger("error"),
        adapters: {
          slack_thread: createSlackInboundResponseAdapter({
            slack,
            store: inbound,
            logger: new Logger("error"),
          }),
        },
      });
      const received = inbound.recordReceived({
        channelId: "slack",
        providerEventId: "slack-event-1",
        conversationId: "C123:T123",
        senderId: "U123",
        message: "hello",
        threadId: "T123",
        responseTarget: {
          type: "slack_thread",
          channel: "C123",
          threadTs: "T123",
          messageTs: "M123",
        },
        rawPayload: { source: "test" },
      });
      const running = inbound.markRunning(received.record.id);
      await dispatcher.beforeRun(running);
      await dispatcher.onEvent(running, {
        type: "tool_call_started",
        runId: "run_1",
        toolCallId: "tool_1",
        toolName: "memory.query",
      });
      const completed = inbound.markCompleted(running.id, {
        sessionId: "session_1",
        runId: "run_1",
        outputText: "assistant:hello",
      });
      await dispatcher.onComplete(completed);

      assert.equal(transport.sent[0]?.text, "Queued...");
      assert.equal(transport.sent.at(-1)?.text, "assistant:hello");
      assert.equal(transport.sent.at(-1)?.threadTs, "T123");
      assert.ok(
        transport.sent
          .at(-1)
          ?.blocks?.some((block) =>
            JSON.stringify(block).includes(completed.id)
          )
      );
      assert.deepEqual(
        transport.reactions.map((reaction) => reaction.name),
        ["hourglass", "hourglass_flowing_sand", "white_check_mark"]
      );
      assert.ok(inbound.get(completed.id)?.slackResponseMessageTs);
      assert.equal(deliveries.list("slack").at(0)?.status, "delivered");
    }
  );
});

test("dispatcher skips disabled Slack final delivery without failing completion", async () => {
  await withStores(
    "dispatcher-slack-skip",
    async ({ channels, deliveries, inbound }) => {
      const config = makeConfig("/tmp", { slackBotToken: "xoxb-test-token" });
      const slack = new SlackChannel(
        config,
        channels,
        deliveries,
        new RecordingSlackTransport()
      );
      const dispatcher = new InboundResponseDispatcher({
        logger: new Logger("error"),
        adapters: {
          slack_thread: createSlackInboundResponseAdapter({
            slack,
            store: inbound,
            logger: new Logger("error"),
          }),
        },
      });
      const completed = slackRecord("slack-disabled", "assistant:hello");

      await dispatcher.onComplete(completed);

      assert.equal(deliveries.list("slack").length, 0);
    }
  );
});

test("dispatcher sends threaded Email replies and records delivery audit", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "codex-phantom-dispatcher-email-")
  );
  const config = makeConfig(dataDir, {
    emailFromAddress: "bot@example.com",
    emailFromName: "Codex Phantom",
  });
  const database = new AppDatabase(join(dataDir, "email.sqlite"));
  const deliveries = new ChannelDeliveryStore(database);
  const sendTransport = new RecordingEmailSendTransport();
  const dispatcher = new InboundResponseDispatcher({
    logger: new Logger("error"),
    adapters: {
      email_reply: createEmailInboundResponseAdapter({
        config,
        deliveries,
        sendTransport,
        logger: new Logger("error"),
      }),
    },
  });

  try {
    await dispatcher.onComplete(emailRecord("provider-email-1", "Reply body"));

    assert.equal(sendTransport.sent.length, 1);
    assert.equal(sendTransport.sent[0]?.to, "sender@example.com");
    assert.equal(sendTransport.sent[0]?.subject, "Quarterly <Report>");
    assert.deepEqual(sendTransport.sent[0]?.references, [
      "<root@example.com>",
      "<parent@example.com>",
      "<child@example.com>",
    ]);
    assert.match(sendTransport.sent[0]?.html ?? "", /&lt; 2;/);
    const [delivery] = deliveries.list("email");
    assert.equal(delivery?.status, "delivered");
    assert.equal(delivery?.destination, "sender@example.com");
    assert.equal(delivery?.attemptCount, 1);
    assert.equal(
      "text" in ((delivery?.payload as Record<string, unknown>) ?? {}),
      false
    );
  } finally {
    database.close();
  }
});

test("dispatcher records Email retry and permanent failure outcomes without throwing", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "codex-phantom-dispatcher-email-fail-")
  );
  const config = makeConfig(dataDir, { emailFromAddress: "bot@example.com" });
  const database = new AppDatabase(join(dataDir, "email-fail.sqlite"));
  const deliveries = new ChannelDeliveryStore(database);
  const sendTransport = new RecordingEmailSendTransport();
  const dispatcher = new InboundResponseDispatcher({
    logger: new Logger("error"),
    adapters: {
      email_reply: createEmailInboundResponseAdapter({
        config,
        deliveries,
        sendTransport,
        logger: new Logger("error"),
      }),
    },
  });

  try {
    sendTransport.failures.push(
      Object.assign(new Error("temporary rate limit"), { responseCode: 450 })
    );
    await dispatcher.onComplete(emailRecord("provider-retry", "Retry body"));
    assert.equal(sendTransport.sent.length, 2);
    assert.equal(deliveries.list("email")[0]?.status, "delivered");
    assert.equal(deliveries.list("email")[0]?.attemptCount, 2);

    sendTransport.failures.push(
      Object.assign(new Error("Mailbox unavailable"), { responseCode: 550 })
    );
    await dispatcher.onComplete(emailRecord("provider-fail", "Fail body"));
    const failed = deliveries
      .list("email")
      .find((delivery) => delivery.status === "failed");
    assert.equal(failed?.attemptCount, 1);
    assert.match(failed?.errorMessage ?? "", /Mailbox unavailable/);
  } finally {
    database.close();
  }
});

test("dispatcher no-ops for webhook, missing target, and missing output", async () => {
  const dispatcher = new InboundResponseDispatcher({
    logger: new Logger("error"),
    adapters: {},
  });

  await dispatcher.onComplete({
    ...slackRecord("missing-target", "hello"),
    responseTarget: undefined,
  });
  await dispatcher.onComplete({
    ...slackRecord("missing-output", ""),
    outputText: undefined,
  });
  await dispatcher.onComplete({
    ...slackRecord("webhook-target", "hello"),
    responseTarget: { type: "webhook" },
  });
});

function slackRecord(
  id: string,
  outputText: string
): InboundChannelEventRecord {
  return {
    id,
    channelId: "slack",
    providerEventId: id,
    conversationId: "C123:T123",
    senderId: "U123",
    message: "hello",
    threadId: "T123",
    responseTarget: {
      type: "slack_thread",
      channel: "C123",
      threadTs: "T123",
      messageTs: "M123",
    },
    rawPayload: { source: "test" },
    status: "completed",
    sessionId: "session_1",
    runId: "run_1",
    outputText,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
  };
}

function emailRecord(
  providerEventId: string,
  outputText: string
): InboundChannelEventRecord {
  return {
    id: `inbound_${providerEventId}`,
    channelId: "email",
    providerEventId,
    conversationId: "<root@example.com>",
    senderId: "sender@example.com",
    message: "hello",
    threadId: "<child@example.com>",
    responseTarget: {
      type: "email_reply",
      to: "sender@example.com",
      subject: "Quarterly <Report>",
      messageId: "<child@example.com>",
      references: ["<root@example.com>", "<parent@example.com>"],
      fromMessageProviderId: providerEventId,
    },
    rawPayload: { source: "test" },
    status: "completed",
    sessionId: "session_1",
    runId: "run_1",
    outputText: `${outputText}\n\n\`\`\`ts\nconst value = 1 < 2;\n\`\`\``,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
  };
}
