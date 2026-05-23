import assert from "node:assert/strict";
import test from "node:test";
import type {
  EmailInboundMessage,
  EmailPollTransport,
  EmailSendInput,
  EmailSendResult,
  EmailSendTransport,
} from "../src/channels/email-types.ts";
import { EmailChannelService } from "../src/channels/email.ts";
import {
  ImapEmailPollTransport,
  SmtpEmailSendTransport,
  parseEmailMessage,
} from "../src/channels/email-transports.ts";
import { ChannelRegistry } from "../src/channels/registry.ts";
import { ChannelDeliveryStore } from "../src/channels/delivery-log.ts";
import { AppDatabase } from "../src/platform/database.ts";
import { Logger } from "../src/platform/logger.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfig } from "./helpers.ts";

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

type AssertTrue<T extends true> = T;

type _PollTransportAssignable = AssertTrue<
  FakeEmailPollTransport extends EmailPollTransport ? true : false
>;
type _SendTransportAssignable = AssertTrue<
  FakeEmailSendTransport extends EmailSendTransport ? true : false
>;

class RecordingPollTransport implements FakeEmailPollTransport {
  readonly seen: string[] = [];
  closed = false;
  private readonly messages: EmailInboundMessage[];

  constructor(messages: EmailInboundMessage[]) {
    this.messages = messages;
  }

  async listUnread(input: {
    maxMessages: number;
    maxBytes: number;
  }): Promise<EmailInboundMessage[]> {
    return this.messages.slice(0, Math.min(input.maxMessages, input.maxBytes));
  }

  async markSeen(providerMessageId: string): Promise<void> {
    this.seen.push(providerMessageId);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class RecordingSendTransport implements FakeEmailSendTransport {
  readonly sent: EmailSendInput[] = [];
  closed = false;
  failures: Array<unknown> = [];

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    this.sent.push(input);
    const failure = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    return {
      providerMessageId: input.messageId,
      response: { accepted: [input.to] },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class SpyPollTransport implements FakeEmailPollTransport {
  readonly seen: string[] = [];
  readonly listUnreadCalls: Array<{ maxMessages: number; maxBytes: number }> =
    [];
  closed = false;
  private readonly messages: EmailInboundMessage[];
  private readonly hideSeenMessages: boolean;

  constructor(
    messages: EmailInboundMessage[],
    options?: { hideSeenMessages?: boolean }
  ) {
    this.messages = messages;
    this.hideSeenMessages = options?.hideSeenMessages ?? false;
  }

  async listUnread(input: {
    maxMessages: number;
    maxBytes: number;
  }): Promise<EmailInboundMessage[]> {
    this.listUnreadCalls.push(input);
    if (!this.hideSeenMessages) {
      return this.messages;
    }
    return this.messages.filter(
      (message) => !this.seen.includes(message.providerMessageId)
    );
  }

  async markSeen(providerMessageId: string): Promise<void> {
    this.seen.push(providerMessageId);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class StubInboundRouter {
  readonly routed: Array<{
    channelId: string;
    providerEventId: string;
    conversationId: string;
    senderId?: string;
    message: string;
    responseTarget?: unknown;
    rawPayload: unknown;
  }> = [];
  readonly completions: Array<Promise<unknown>> = [];
  private readonly behavior: "accept" | "duplicate" | "throw";
  private readonly invokeCompletionCallbacks: boolean;

  constructor(
    behavior: "accept" | "duplicate" | "throw" = "accept",
    options?: { invokeCompletionCallbacks?: boolean }
  ) {
    this.behavior = behavior;
    this.invokeCompletionCallbacks =
      options?.invokeCompletionCallbacks ?? false;
  }

  routeAsync(
    message: {
      channelId: string;
      providerEventId: string;
      conversationId: string;
      senderId?: string;
      message: string;
      responseTarget?: unknown;
      rawPayload: unknown;
    },
    callbacks: {
      onComplete?: (record: {
        id: string;
        channelId: string;
        providerEventId: string;
        conversationId: string;
        message: string;
        rawPayload: unknown;
        status: string;
        outputText?: string;
        responseTarget?: unknown;
        createdAt: string;
        updatedAt: string;
      }) => Promise<void> | void;
    } = {}
  ) {
    this.routed.push(message);
    if (this.behavior === "throw") {
      throw new Error("route failed");
    }
    const completionRecord = {
      id: "inbound_123",
      channelId: message.channelId,
      providerEventId: message.providerEventId,
      conversationId: message.conversationId,
      message: message.message,
      rawPayload: message.rawPayload,
      responseTarget: message.responseTarget,
      status: "completed",
      outputText: "Reply body\n\n```ts\nconst value = 1 < 2;\n```",
      createdAt: "2026-05-22T12:00:00.000Z",
      updatedAt: "2026-05-22T12:00:00.000Z",
    };
    const completion = Promise.resolve().then(async () => {
      if (this.invokeCompletionCallbacks) {
        await callbacks.onComplete?.(completionRecord);
      }
      return completionRecord;
    });
    this.completions.push(completion);

    return {
      record: {
        id: "inbound_123",
        channelId: message.channelId,
        providerEventId: message.providerEventId,
        conversationId: message.conversationId,
        message: message.message,
        rawPayload: message.rawPayload,
        status: this.behavior === "duplicate" ? "completed" : "running",
        createdAt: "2026-05-22T12:00:00.000Z",
        updatedAt: "2026-05-22T12:00:00.000Z",
      },
      duplicate: this.behavior === "duplicate",
      completion,
    };
  }
}

function makeInboundMessage(
  overrides: Partial<EmailInboundMessage> = {}
): EmailInboundMessage {
  return {
    providerMessageId: "provider-1",
    uid: "101",
    from: { address: "sender@example.com", name: "Sender" },
    to: [{ address: "bot@example.com", name: "Bot" }],
    subject: "Status Update",
    text: "hello",
    date: "2026-05-22T12:00:00.000Z",
    thread: {
      messageId: "<provider-1@example.com>",
      inReplyTo: "<parent@example.com>",
      references: ["<parent@example.com>"],
      normalizedSubject: "status update",
      fallbackThreadKey: "sender@example.com::status update",
    },
    attachments: [],
    rawPayload: { source: "fixture" },
    ...overrides,
  };
}

async function withEmailChannelService(
  options: {
    configOverrides?: Parameters<typeof makeConfig>[1];
    channelEnabled?: boolean;
    messages?: EmailInboundMessage[];
    routerBehavior?: "accept" | "duplicate" | "throw";
    hideSeenMessages?: boolean;
    invokeCompletionCallbacks?: boolean;
  },
  run: (input: {
    service: EmailChannelService;
    pollTransport: SpyPollTransport;
    sendTransport: RecordingSendTransport;
    inboundRouter: StubInboundRouter;
    channels: ChannelRegistry;
    database: AppDatabase;
  }) => Promise<void>
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-email-service-"));
  const config = makeConfig(dataDir, options.configOverrides);
  const database = new AppDatabase(join(dataDir, "email.sqlite"));
  const channels = new ChannelRegistry(database, config);
  const deliveries = new ChannelDeliveryStore(database);
  const pollTransport = new SpyPollTransport(options.messages ?? [], {
    hideSeenMessages: options.hideSeenMessages,
  });
  const sendTransport = new RecordingSendTransport();
  const inboundRouter = new StubInboundRouter(options.routerBehavior, {
    invokeCompletionCallbacks: options.invokeCompletionCallbacks,
  });
  const service = new EmailChannelService({
    config,
    channels,
    inboundRouter: inboundRouter as never,
    deliveries,
    pollTransport,
    sendTransport,
    logger: new Logger("error"),
  });

  try {
    if (options.channelEnabled) {
      channels.upsert({ id: "email", enabled: true });
    }
    await run({
      service,
      pollTransport,
      sendTransport,
      inboundRouter,
      channels,
      database,
    });
  } finally {
    await service.stop();
    database.close();
  }
}

test("email channel pollOnce processes at most emailPollBatchSize", async () => {
  await withEmailChannelService(
    {
      configOverrides: { emailPollBatchSize: 2, emailMaxMessageBytes: 321 },
      channelEnabled: true,
      messages: [
        makeInboundMessage({ providerMessageId: "provider-1" }),
        makeInboundMessage({ providerMessageId: "provider-2", uid: "102" }),
        makeInboundMessage({ providerMessageId: "provider-3", uid: "103" }),
      ],
    },
    async ({ service, pollTransport, inboundRouter }) => {
      const summary = await service.pollOnce();

      assert.equal(pollTransport.listUnreadCalls.length, 1);
      assert.deepEqual(pollTransport.listUnreadCalls[0], {
        maxMessages: 2,
        maxBytes: 321,
      });
      assert.equal(summary.polledCount, 2);
      assert.equal(summary.acceptedCount, 2);
      assert.deepEqual(
        inboundRouter.routed.map((message) => message.providerEventId),
        ["provider-1", "provider-2"]
      );
    }
  );
});

test("email channel pollOnce marks auto replies seen and does not reroute them", async () => {
  await withEmailChannelService(
    {
      configOverrides: { emailPollBatchSize: 5 },
      channelEnabled: true,
      hideSeenMessages: true,
      messages: [
        makeInboundMessage({
          providerMessageId: "provider-auto",
          subject: "Automatic reply: away today",
          text: "Out of office auto-reply",
        }),
        makeInboundMessage({
          providerMessageId: "provider-real",
          uid: "102",
          subject: "Need help",
          text: "Please help",
        }),
      ],
    },
    async ({ service, inboundRouter, pollTransport }) => {
      const firstSummary = await service.pollOnce();
      const secondSummary = await service.pollOnce();

      assert.equal(firstSummary.skippedAutoReplyCount, 1);
      assert.equal(firstSummary.acceptedCount, 1);
      assert.equal(secondSummary.polledCount, 0);
      assert.equal(secondSummary.skippedAutoReplyCount, 0);
      assert.deepEqual(
        inboundRouter.routed.map((message) => message.providerEventId),
        ["provider-real"]
      );
      assert.deepEqual(pollTransport.seen, ["provider-auto", "provider-real"]);
    }
  );
});

test("email channel pollOnce routes inbound messages with deterministic reply metadata", async () => {
  await withEmailChannelService(
    {
      channelEnabled: true,
      messages: [
        makeInboundMessage({
          providerMessageId: "provider-thread",
          thread: {
            messageId: "<child@example.com>",
            inReplyTo: "<parent@example.com>",
            references: ["<root@example.com>", "<parent@example.com>"],
            normalizedSubject: "status update",
            fallbackThreadKey: "sender@example.com::status update",
          },
        }),
      ],
    },
    async ({ service, inboundRouter }) => {
      await service.pollOnce();

      assert.equal(inboundRouter.routed.length, 1);
      assert.equal(
        inboundRouter.routed[0]?.conversationId,
        "<root@example.com>"
      );
      assert.deepEqual(inboundRouter.routed[0]?.responseTarget, {
        type: "email_reply",
        to: "sender@example.com",
        subject: "Status Update",
        messageId: "<child@example.com>",
        references: ["<root@example.com>", "<parent@example.com>"],
        fromMessageProviderId: "provider-thread",
      });
    }
  );
});

test("email channel sends threaded SMTP replies and audits final delivery under email", async () => {
  await withEmailChannelService(
    {
      configOverrides: {
        emailFromAddress: "bot@example.com",
        emailFromName: "Codex Phantom",
      },
      channelEnabled: true,
      invokeCompletionCallbacks: true,
      messages: [
        makeInboundMessage({
          providerMessageId: "provider-thread",
          subject: "Quarterly <Report>",
          thread: {
            messageId: "<child@example.com>",
            inReplyTo: "<parent@example.com>",
            references: ["<root@example.com>", "<parent@example.com>"],
            normalizedSubject: "quarterly report",
            fallbackThreadKey: "sender@example.com::quarterly report",
          },
        }),
      ],
    },
    async ({ service, sendTransport, inboundRouter, database }) => {
      const summary = await service.pollOnce();
      assert.equal(summary.acceptedCount, 1);

      const [completedRecord] = await Promise.all(inboundRouter.completions);

      assert.equal(sendTransport.sent.length, 1);
      assert.equal(sendTransport.sent[0]?.to, "sender@example.com");
      assert.equal(sendTransport.sent[0]?.subject, "Quarterly <Report>");
      assert.equal(sendTransport.sent[0]?.inReplyTo, "<child@example.com>");
      assert.deepEqual(sendTransport.sent[0]?.references, [
        "<root@example.com>",
        "<parent@example.com>",
        "<child@example.com>",
      ]);
      assert.match(sendTransport.sent[0]?.messageId ?? "", /^<email_[^>]+>$/);
      assert.match(sendTransport.sent[0]?.html ?? "", /<pre><code>/);
      assert.match(sendTransport.sent[0]?.html ?? "", /&lt; 2;/);

      const deliveries = new ChannelDeliveryStore(database).list("email");
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.channelId, "email");
      assert.equal(deliveries[0]?.status, "delivered");
      assert.equal(deliveries[0]?.destination, "sender@example.com");
      assert.equal(deliveries[0]?.attemptCount, 1);
      assert.deepEqual(deliveries[0]?.payload, {
        method: "email.reply",
        inboundEventId: "inbound_123",
        providerEventId: "provider-thread",
        messageId: sendTransport.sent[0]?.messageId ?? null,
        inReplyTo: "<child@example.com>",
        references: [
          "<root@example.com>",
          "<parent@example.com>",
          "<child@example.com>",
        ],
        subject: "Quarterly <Report>",
        fromMessageProviderId: "provider-thread",
        textCharCount: sendTransport.sent[0]?.text.length ?? 0,
        textByteCount: Buffer.byteLength(
          sendTransport.sent[0]?.text ?? "",
          "utf8"
        ),
        htmlCharCount: sendTransport.sent[0]?.html.length ?? 0,
        htmlByteCount: Buffer.byteLength(
          sendTransport.sent[0]?.html ?? "",
          "utf8"
        ),
      });
      assert.equal(
        "text" in ((deliveries[0]?.payload as Record<string, unknown>) ?? {}),
        false
      );
      assert.equal(
        "html" in ((deliveries[0]?.payload as Record<string, unknown>) ?? {}),
        false
      );
      assert.match(sendTransport.sent[0]?.text ?? "", /Reply body/);
      assert.match(sendTransport.sent[0]?.html ?? "", /Reply body/);
    }
  );
});

test("email channel retries transient SMTP failures up to three attempts", async () => {
  await withEmailChannelService(
    {
      configOverrides: {
        emailFromAddress: "bot@example.com",
        emailFromName: "Codex Phantom",
      },
      channelEnabled: true,
      invokeCompletionCallbacks: true,
      messages: [makeInboundMessage({ providerMessageId: "provider-retry" })],
    },
    async ({ service, sendTransport, inboundRouter, database }) => {
      sendTransport.failures.push(
        new Error("ECONNRESET while sending"),
        Object.assign(new Error("temporary rate limit"), {
          code: "ETIMEDOUT",
          statusCode: 429,
        })
      );

      await service.pollOnce();
      const [completedRecord] = await Promise.all(inboundRouter.completions);

      assert.equal(sendTransport.sent.length, 3);
      const deliveries = new ChannelDeliveryStore(database).list("email");
      assert.equal(deliveries[0]?.status, "delivered");
      assert.equal(deliveries[0]?.attemptCount, 3);
    }
  );
});

test("email channel retries transient SMTP 4xx response codes and eventually delivers", async () => {
  await withEmailChannelService(
    {
      configOverrides: {
        emailFromAddress: "bot@example.com",
        emailFromName: "Codex Phantom",
      },
      channelEnabled: true,
      invokeCompletionCallbacks: true,
      messages: [
        makeInboundMessage({ providerMessageId: "provider-smtp-4xx" }),
      ],
    },
    async ({ service, sendTransport, inboundRouter, database }) => {
      sendTransport.failures.push(
        Object.assign(new Error("Mailbox temporarily unavailable"), {
          responseCode: 450,
        })
      );

      await service.pollOnce();
      await Promise.all(inboundRouter.completions);

      assert.equal(sendTransport.sent.length, 2);
      const deliveries = new ChannelDeliveryStore(database).list("email");
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.status, "delivered");
      assert.equal(deliveries[0]?.attemptCount, 2);
    }
  );
});

test("email channel does not retry permanent SMTP 5xx response codes", async () => {
  await withEmailChannelService(
    {
      configOverrides: {
        emailFromAddress: "bot@example.com",
        emailFromName: "Codex Phantom",
      },
      channelEnabled: true,
      invokeCompletionCallbacks: true,
      messages: [
        makeInboundMessage({ providerMessageId: "provider-smtp-5xx" }),
      ],
    },
    async ({ service, sendTransport, inboundRouter, database }) => {
      sendTransport.failures.push(
        Object.assign(new Error("Mailbox unavailable"), {
          responseCode: 550,
          code: "ETIMEDOUT",
        })
      );

      await service.pollOnce();
      await Promise.all(inboundRouter.completions);

      assert.equal(sendTransport.sent.length, 1);
      const deliveries = new ChannelDeliveryStore(database).list("email");
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.status, "failed");
      assert.equal(deliveries[0]?.attemptCount, 1);
    }
  );
});

test("email channel records failed SMTP delivery without failing the inbound completion", async () => {
  await withEmailChannelService(
    {
      configOverrides: {
        emailFromAddress: "bot@example.com",
        emailFromName: "Codex Phantom",
      },
      channelEnabled: true,
      invokeCompletionCallbacks: true,
      messages: [makeInboundMessage({ providerMessageId: "provider-failed" })],
    },
    async ({ service, sendTransport, inboundRouter, database }) => {
      sendTransport.failures.push(
        new Error("451 temporary unavailable"),
        new Error("451 temporary unavailable"),
        new Error("451 temporary unavailable")
      );

      await service.pollOnce();
      const [completedRecord] = await Promise.all(inboundRouter.completions);

      assert.equal(sendTransport.sent.length, 3);
      const deliveries = new ChannelDeliveryStore(database).list("email");
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.status, "failed");
      assert.equal(deliveries[0]?.attemptCount, 3);
      assert.match(deliveries[0]?.errorMessage ?? "", /temporary unavailable/);

      assert.equal(
        (completedRecord as { status?: string } | undefined)?.status,
        "completed"
      );
    }
  );
});

test("email channel pollOnce marks messages seen only after accept or dedupe", async () => {
  await withEmailChannelService(
    {
      channelEnabled: true,
      routerBehavior: "duplicate",
      messages: [makeInboundMessage({ providerMessageId: "provider-dup" })],
    },
    async ({ service, pollTransport }) => {
      const summary = await service.pollOnce();

      assert.equal(summary.duplicateCount, 1);
      assert.deepEqual(pollTransport.seen, ["provider-dup"]);
    }
  );
});

test("email channel pollOnce leaves messages unseen when route accept fails", async () => {
  await withEmailChannelService(
    {
      channelEnabled: true,
      routerBehavior: "throw",
      messages: [makeInboundMessage({ providerMessageId: "provider-fail" })],
    },
    async ({ service, pollTransport }) => {
      await assert.rejects(() => service.pollOnce(), /route failed/);
      assert.deepEqual(pollTransport.seen, []);
    }
  );
});

test("fake email poll transport matches the channel polling contract", async () => {
  const transport = new RecordingPollTransport([
    makeInboundMessage(),
    makeInboundMessage({
      providerMessageId: "provider-2",
      uid: "102",
      subject: "Second",
    }),
  ]);

  const unread = await transport.listUnread({ maxMessages: 1, maxBytes: 10 });
  assert.equal(unread.length, 1);
  assert.equal(unread[0]?.providerMessageId, "provider-1");

  await transport.markSeen("provider-1");
  await transport.close();

  assert.deepEqual(transport.seen, ["provider-1"]);
  assert.equal(transport.closed, true);
});

test("fake email send transport matches the channel send contract", async () => {
  const transport = new RecordingSendTransport();
  const sendInput: EmailSendInput = {
    to: "user@example.com",
    fromAddress: "bot@example.com",
    fromName: "Bot",
    subject: "Reply",
    text: "Plain text",
    html: "<p>Plain text</p>",
    messageId: "<message-1@example.com>",
    inReplyTo: "<thread-root@example.com>",
    references: ["<thread-root@example.com>"],
  };

  const result = await transport.send(sendInput);
  await transport.close();

  assert.equal(result.providerMessageId, "<message-1@example.com>");
  assert.deepEqual(result.response, { accepted: ["user@example.com"] });
  assert.deepEqual(transport.sent, [sendInput]);
  assert.equal(transport.closed, true);
});

test("parseEmailMessage extracts message and attachment metadata", async () => {
  const rawMessage = [
    "From: Sender <sender@example.com>",
    "To: Bot <bot@example.com>",
    "Subject: Re: Quarterly Report",
    "Message-ID: <child@example.com>",
    "In-Reply-To: <root@example.com>",
    "References: <root@example.com>",
    "Date: Thu, 22 May 2026 12:34:56 +0000",
    'Content-Type: multipart/mixed; boundary="demo"',
    "",
    "--demo",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello from email.",
    "--demo",
    'Content-Type: text/plain; charset=utf-8; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    "",
    "attachment body",
    "--demo--",
    "",
  ].join("\r\n");

  const parsed = await parseEmailMessage({
    providerMessageId: "provider-message-1",
    uid: "200",
    raw: Buffer.from(rawMessage, "utf8"),
  });

  assert.equal(parsed.providerMessageId, "provider-message-1");
  assert.equal(parsed.uid, "200");
  assert.equal(parsed.subject, "Re: Quarterly Report");
  assert.equal(parsed.text.trim(), "Hello from email.");
  assert.equal(parsed.thread.messageId, "<child@example.com>");
  assert.equal(parsed.thread.inReplyTo, "<root@example.com>");
  assert.deepEqual(parsed.thread.references, ["<root@example.com>"]);
  assert.equal(parsed.thread.normalizedSubject, "quarterly report");
  assert.equal(parsed.attachments.length, 1);
  assert.deepEqual(parsed.attachments[0], {
    filename: "notes.txt",
    contentType: "text/plain",
    sizeBytes: 15,
    disposition: "attachment",
  });
  assert.equal(
    JSON.stringify(parsed.rawPayload).includes("attachment body"),
    false
  );
});

test("imap poll transport bounds unread fetches and marks messages seen", async () => {
  const rawMessages = new Map<number, Buffer>([
    [
      101,
      Buffer.from(
        [
          "From: Sender <sender@example.com>",
          "To: Bot <bot@example.com>",
          "Subject: First",
          "Message-ID: <first@example.com>",
          "Date: Thu, 22 May 2026 12:34:56 +0000",
          "",
          "First body",
          "",
        ].join("\r\n"),
        "utf8"
      ),
    ],
    [
      102,
      Buffer.from(
        [
          "From: Sender <sender@example.com>",
          "To: Bot <bot@example.com>",
          "Subject: Second",
          "Message-ID: <second@example.com>",
          "Date: Thu, 22 May 2026 12:35:56 +0000",
          "",
          "Second body",
          "",
        ].join("\r\n"),
        "utf8"
      ),
    ],
  ]);
  const seenFlags: Array<{ uid: string; flags: string[]; uidMode?: boolean }> =
    [];
  let logoutCount = 0;
  let connectCount = 0;

  const transport = new ImapEmailPollTransport(
    {
      host: "imap.example.com",
      port: 993,
      secure: true,
      auth: { user: "bot@example.com", pass: "secret" },
      mailbox: "INBOX",
    },
    {
      createClient() {
        return {
          async connect() {
            connectCount += 1;
          },
          async getMailboxLock() {
            return { release() {} };
          },
          async search() {
            return [101, 102];
          },
          async fetchOne(
            uid: string,
            query: { source?: { maxLength?: number } }
          ) {
            const numericUid = Number(uid);
            const raw = rawMessages.get(numericUid);
            assert.ok(raw);
            return {
              uid: numericUid,
              size: raw.length,
              source: raw.subarray(0, query.source?.maxLength ?? raw.length),
            };
          },
          async messageFlagsAdd(
            uid: string,
            flags: string[],
            options?: { uid?: boolean }
          ) {
            seenFlags.push({ uid, flags, uidMode: options?.uid });
            return true;
          },
          async logout() {
            logoutCount += 1;
          },
        };
      },
    }
  );

  const unread = await transport.listUnread({ maxMessages: 1, maxBytes: 1024 });
  assert.equal(unread.length, 1);
  assert.equal(unread[0]?.providerMessageId, "<second@example.com>");
  assert.equal(connectCount, 1);

  await transport.markSeen("<second@example.com>");
  await transport.close();

  assert.deepEqual(seenFlags, [
    { uid: "102", flags: ["\\Seen"], uidMode: true },
  ]);
  assert.equal(logoutCount, 1);
});

test("imap markSeen retains providerMessageId mappings across poll cycles", async () => {
  const rawMessages = new Map<number, Buffer>([
    [
      101,
      Buffer.from(
        [
          "From: Sender <sender@example.com>",
          "To: Bot <bot@example.com>",
          "Subject: First",
          "Message-ID: <first@example.com>",
          "Date: Thu, 22 May 2026 12:34:56 +0000",
          "",
          "First body",
          "",
        ].join("\r\n"),
        "utf8"
      ),
    ],
    [
      102,
      Buffer.from(
        [
          "From: Sender <sender@example.com>",
          "To: Bot <bot@example.com>",
          "Subject: Second",
          "Message-ID: <second@example.com>",
          "Date: Thu, 22 May 2026 12:35:56 +0000",
          "",
          "Second body",
          "",
        ].join("\r\n"),
        "utf8"
      ),
    ],
  ]);
  const seenFlags: Array<{ uid: string; flags: string[]; uidMode?: boolean }> =
    [];
  let searchCallCount = 0;

  const transport = new ImapEmailPollTransport(
    {
      host: "imap.example.com",
      port: 993,
      secure: true,
      auth: { user: "bot@example.com", pass: "secret" },
      mailbox: "INBOX",
    },
    {
      createClient() {
        return {
          async connect() {
            return;
          },
          async getMailboxLock() {
            return { release() {} };
          },
          async search() {
            searchCallCount += 1;
            return searchCallCount === 1 ? [101] : [102];
          },
          async fetchOne(
            uid: string,
            query: { source?: { maxLength?: number } }
          ) {
            const numericUid = Number(uid);
            const raw = rawMessages.get(numericUid);
            assert.ok(raw);
            return {
              uid: numericUid,
              size: raw.length,
              source: raw.subarray(0, query.source?.maxLength ?? raw.length),
            };
          },
          async messageFlagsAdd(
            uid: string,
            flags: string[],
            options?: { uid?: boolean }
          ) {
            seenFlags.push({ uid, flags, uidMode: options?.uid });
            return true;
          },
          async logout() {
            return;
          },
        };
      },
    }
  );

  const firstUnread = await transport.listUnread({
    maxMessages: 1,
    maxBytes: 1024,
  });
  const secondUnread = await transport.listUnread({
    maxMessages: 1,
    maxBytes: 1024,
  });

  assert.equal(firstUnread[0]?.providerMessageId, "<first@example.com>");
  assert.equal(secondUnread[0]?.providerMessageId, "<second@example.com>");

  await transport.markSeen("<first@example.com>");
  await transport.close();

  assert.deepEqual(seenFlags, [
    { uid: "101", flags: ["\\Seen"], uidMode: true },
  ]);
});

test("imap markSeen keeps providerMessageId mapping when store op returns false", async () => {
  const rawMessages = new Map<number, Buffer>([
    [
      101,
      Buffer.from(
        [
          "From: Sender <sender@example.com>",
          "To: Bot <bot@example.com>",
          "Subject: Retry",
          "Message-ID: <retry@example.com>",
          "Date: Thu, 22 May 2026 12:34:56 +0000",
          "",
          "Retry body",
          "",
        ].join("\r\n"),
        "utf8"
      ),
    ],
  ]);
  const seenFlags: Array<{
    uid: string;
    flags: string[];
    uidMode?: boolean;
  }> = [];
  let markSeenCallCount = 0;

  const transport = new ImapEmailPollTransport(
    {
      host: "imap.example.com",
      port: 993,
      secure: true,
      auth: { user: "bot@example.com", pass: "secret" },
      mailbox: "INBOX",
    },
    {
      createClient() {
        return {
          async connect() {
            return;
          },
          async getMailboxLock() {
            return { release() {} };
          },
          async search() {
            return [101];
          },
          async fetchOne(
            uid: string,
            query: { source?: { maxLength?: number } }
          ) {
            const numericUid = Number(uid);
            const raw = rawMessages.get(numericUid);
            assert.ok(raw);
            return {
              uid: numericUid,
              size: raw.length,
              source: raw.subarray(0, query.source?.maxLength ?? raw.length),
            };
          },
          async messageFlagsAdd(
            uid: string,
            flags: string[],
            options?: { uid?: boolean }
          ) {
            markSeenCallCount += 1;
            seenFlags.push({ uid, flags, uidMode: options?.uid });
            return markSeenCallCount > 1;
          },
          async logout() {
            return;
          },
        };
      },
    }
  );

  const unread = await transport.listUnread({
    maxMessages: 1,
    maxBytes: 1024,
  });
  assert.equal(unread[0]?.providerMessageId, "<retry@example.com>");

  await transport.markSeen("<retry@example.com>");
  await transport.markSeen("<retry@example.com>");
  await transport.close();

  assert.deepEqual(seenFlags, [
    { uid: "101", flags: ["\\Seen"], uidMode: true },
    { uid: "101", flags: ["\\Seen"], uidMode: true },
  ]);
});

test("smtp send transport maps send input onto the provider transport", async () => {
  const sentMessages: Array<Record<string, unknown>> = [];
  let closeCount = 0;
  const transport = new SmtpEmailSendTransport(
    {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: { user: "bot@example.com", pass: "secret" },
    },
    {
      createTransport() {
        return {
          async sendMail(message: Record<string, unknown>) {
            sentMessages.push(message);
            return {
              messageId: "<smtp-provider@example.com>",
              accepted: ["user@example.com"],
              rejected: [],
              response: "250 queued",
            };
          },
          close() {
            closeCount += 1;
          },
        };
      },
    }
  );

  const result = await transport.send({
    to: "user@example.com",
    fromAddress: "bot@example.com",
    fromName: "Codex Phantom",
    subject: "Reply",
    text: "Plain text",
    html: "<p>Plain text</p>",
    messageId: "<message@example.com>",
    inReplyTo: "<root@example.com>",
    references: ["<root@example.com>"],
  });
  await transport.close();

  assert.deepEqual(sentMessages, [
    {
      from: '"Codex Phantom" <bot@example.com>',
      to: "user@example.com",
      subject: "Reply",
      text: "Plain text",
      html: "<p>Plain text</p>",
      messageId: "<message@example.com>",
      inReplyTo: "<root@example.com>",
      references: ["<root@example.com>"],
    },
  ]);
  assert.equal(result.providerMessageId, "<smtp-provider@example.com>");
  assert.deepEqual(result.response, {
    accepted: ["user@example.com"],
    rejected: [],
    response: "250 queued",
    messageId: "<smtp-provider@example.com>",
  });
  assert.equal(closeCount, 1);
});
