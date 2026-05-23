import assert from "node:assert/strict";
import test from "node:test";
import type {
  EmailInboundMessage,
  EmailPollTransport,
  EmailSendInput,
  EmailSendResult,
  EmailSendTransport,
} from "../src/channels/email-types.ts";
import {
  ImapEmailPollTransport,
  SmtpEmailSendTransport,
  parseEmailMessage,
} from "../src/channels/email-transports.ts";

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

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    this.sent.push(input);
    return {
      providerMessageId: input.messageId,
      response: { accepted: [input.to] },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
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
