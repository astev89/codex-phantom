import { createRequire } from "node:module";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import type { JsonValue } from "../shared/types.ts";
import type {
  EmailAddress,
  EmailInboundMessage,
  EmailPollTransport,
  EmailSendInput,
  EmailSendResult,
  EmailSendTransport,
  EmailAttachmentMetadata,
} from "./email-types.ts";

const require = createRequire(import.meta.url);

type ParsedAddressLike = {
  value?: Array<{
    address?: string;
    name?: string;
  }>;
};

type ParsedAttachmentLike = {
  filename?: string;
  contentType?: string;
  size?: number;
  contentId?: string;
  contentDisposition?: string;
  content?: Buffer;
};

type ParsedMailLike = {
  subject?: string;
  text?: string;
  html?: string | false;
  date?: Date;
  messageId?: string;
  inReplyTo?: string;
  references?: string | string[];
  from?: ParsedAddressLike;
  to?: ParsedAddressLike;
  attachments?: ParsedAttachmentLike[];
};

type MailParserModule = {
  simpleParser(source: Buffer | string): Promise<ParsedMailLike>;
};

type NodemailerModule = {
  createTransport(options: SmtpTransportOptions): SmtpClientLike;
};

type ImapClientLike = {
  connect(): Promise<void>;
  getMailboxLock(path: string): Promise<{
    release(): void;
  }>;
  search(
    query: {
      seen: boolean;
    },
    options?: {
      uid?: boolean;
    }
  ): Promise<number[] | false>;
  fetchOne(
    seq: string,
    query: {
      size?: boolean;
      source?: boolean | { maxLength?: number };
    },
    options?: {
      uid?: boolean;
    }
  ): Promise<
    | {
        uid: number;
        size?: number;
        source?: Buffer;
      }
    | false
  >;
  messageFlagsAdd(
    range: string,
    flags: string[],
    options?: {
      uid?: boolean;
    }
  ): Promise<boolean>;
  logout(): Promise<void>;
};

type ImapTransportOptions = Pick<
  ImapFlowOptions,
  "host" | "port" | "secure" | "auth" | "tls" | "logger"
> & {
  mailbox?: string;
  maxAttachmentBytes?: number;
};

type ImapTransportDependencies = {
  createClient?: (options: ImapTransportOptions) => ImapClientLike;
};

type SmtpTransportOptions = {
  host: string;
  port: number;
  secure: boolean;
  auth?: {
    user: string;
    pass: string;
  };
  tls?: Record<string, unknown>;
};

type SmtpClientLike = {
  sendMail(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  close?(): void;
};

type SmtpTransportDependencies = {
  createTransport?: (options: SmtpTransportOptions) => SmtpClientLike;
};

type ParseEmailMessageInput = {
  providerMessageId?: string;
  uid: string;
  raw: Buffer;
  sizeBytes?: number;
  maxAttachmentBytes?: number;
};

const mailparser = require("mailparser") as MailParserModule;
const nodemailer = require("nodemailer") as NodemailerModule;
const DEFAULT_MAX_ATTACHMENT_BYTES = 200_000;
const SUPPORTED_INDEXED_ATTACHMENT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
]);

export class ImapEmailPollTransport implements EmailPollTransport {
  private readonly mailbox: string;
  private readonly createClient: (
    options: ImapTransportOptions
  ) => ImapClientLike;
  private client?: ImapClientLike;
  private connected = false;
  private readonly providerMessageIdsToUids = new Map<string, string>();
  private readonly options: ImapTransportOptions;
  private readonly maxAttachmentBytes: number;

  constructor(
    options: ImapTransportOptions,
    dependencies: ImapTransportDependencies = {}
  ) {
    this.options = options;
    this.mailbox = options.mailbox ?? "INBOX";
    this.maxAttachmentBytes = normalizeMaxAttachmentBytes(
      options.maxAttachmentBytes
    );
    this.createClient =
      dependencies.createClient ??
      ((clientOptions) =>
        new ImapFlow(clientOptions) as unknown as ImapClientLike);
  }

  async listUnread(input: {
    maxMessages: number;
    maxBytes: number;
  }): Promise<EmailInboundMessage[]> {
    const maxMessages = normalizePositiveInteger(
      input.maxMessages,
      "maxMessages"
    );
    const maxBytes = normalizePositiveInteger(input.maxBytes, "maxBytes");
    const client = await this.getClient();
    const lock = await client.getMailboxLock(this.mailbox);

    try {
      const unreadUids = await client.search({ seen: false }, { uid: true });
      const selectedUids = (Array.isArray(unreadUids) ? unreadUids : [])
        .slice(-maxMessages)
        .reverse();
      const messages: EmailInboundMessage[] = [];

      for (const uid of selectedUids) {
        const fetched = await client.fetchOne(
          String(uid),
          {
            size: true,
            source: { maxLength: maxBytes },
          },
          { uid: true }
        );
        if (
          !fetched ||
          typeof fetched.size !== "number" ||
          !fetched.source ||
          fetched.size > maxBytes ||
          fetched.source.length > maxBytes
        ) {
          continue;
        }
        const message = await parseEmailMessage({
          uid: String(fetched.uid),
          raw: fetched.source,
          sizeBytes: fetched.size,
          maxAttachmentBytes: this.maxAttachmentBytes,
        });
        this.providerMessageIdsToUids.set(
          message.providerMessageId,
          message.uid
        );
        messages.push(message);
      }

      return messages;
    } finally {
      lock.release();
    }
  }

  async markSeen(providerMessageId: string): Promise<void> {
    const client = await this.getClient();
    const uid = this.providerMessageIdsToUids.get(providerMessageId);
    const resolvedUid = uid ?? parseUid(providerMessageId);
    const lock = await client.getMailboxLock(this.mailbox);

    try {
      const markedSeen = await client.messageFlagsAdd(resolvedUid, ["\\Seen"], {
        uid: true,
      });
      if (markedSeen) {
        this.providerMessageIdsToUids.delete(providerMessageId);
      }
    } finally {
      lock.release();
    }
  }

  async close(): Promise<void> {
    if (!this.client || !this.connected) {
      return;
    }
    await this.client.logout();
    this.connected = false;
    this.client = undefined;
    this.providerMessageIdsToUids.clear();
  }

  private async getClient(): Promise<ImapClientLike> {
    if (!this.client) {
      this.client = this.createClient(this.options);
    }
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
    return this.client;
  }
}

export class SmtpEmailSendTransport implements EmailSendTransport {
  private readonly createTransporter: (
    options: SmtpTransportOptions
  ) => SmtpClientLike;
  private transporter?: SmtpClientLike;
  private readonly options: SmtpTransportOptions;

  constructor(
    options: SmtpTransportOptions,
    dependencies: SmtpTransportDependencies = {}
  ) {
    this.options = options;
    this.createTransporter =
      dependencies.createTransport ??
      ((transportOptions) => nodemailer.createTransport(transportOptions));
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const transporter = this.getTransporter();
    const response = await transporter.sendMail({
      from: formatFromHeader(input.fromName, input.fromAddress),
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      messageId: input.messageId,
      inReplyTo: input.inReplyTo,
      references: input.references,
    });
    const providerMessageId =
      typeof response.messageId === "string" ? response.messageId : undefined;

    return {
      providerMessageId,
      response: sanitizeForJson(response),
    };
  }

  async close(): Promise<void> {
    if (!this.transporter) {
      return;
    }
    this.transporter.close?.();
    this.transporter = undefined;
  }

  private getTransporter(): SmtpClientLike {
    if (!this.transporter) {
      this.transporter = this.createTransporter(this.options);
    }
    return this.transporter;
  }
}

export async function parseEmailMessage(
  input: ParseEmailMessageInput
): Promise<EmailInboundMessage> {
  const parsed = await mailparser.simpleParser(input.raw);
  const from = firstAddress(parsed.from);
  const to = addressList(parsed.to);
  const subject = parsed.subject?.trim() ?? "";
  const normalizedSubject = normalizeSubject(subject);
  const threadMessageId = normalizeHeaderId(parsed.messageId);
  const providerMessageId =
    input.providerMessageId ?? threadMessageId ?? input.uid;
  const references = normalizeReferences(parsed.references);
  const maxAttachmentBytes = normalizeMaxAttachmentBytes(
    input.maxAttachmentBytes
  );
  const attachments = (parsed.attachments ?? []).map((attachment) =>
    extractAttachmentMetadata(attachment, maxAttachmentBytes)
  );

  return {
    providerMessageId,
    uid: input.uid,
    from,
    to,
    subject,
    text: parsed.text ?? "",
    html: typeof parsed.html === "string" ? parsed.html : undefined,
    date: (parsed.date ?? new Date(0)).toISOString(),
    thread: {
      messageId: threadMessageId,
      inReplyTo: normalizeHeaderId(parsed.inReplyTo),
      references,
      normalizedSubject,
      fallbackThreadKey: buildFallbackThreadKey(from, normalizedSubject),
    },
    attachments,
    rawPayload: {
      uid: input.uid,
      providerMessageId,
      sizeBytes: input.sizeBytes ?? input.raw.length,
      fetchedBytes: input.raw.length,
      from,
      to,
      subject,
      date: (parsed.date ?? new Date(0)).toISOString(),
      messageId: threadMessageId ?? null,
      inReplyTo: normalizeHeaderId(parsed.inReplyTo) ?? null,
      references,
      attachmentCount: attachments.length,
      attachments,
    },
  };
}

function extractAttachmentMetadata(
  attachment: ParsedAttachmentLike,
  maxAttachmentBytes: number
): EmailAttachmentMetadata {
  const contentType =
    attachment.contentType?.trim() || "application/octet-stream";
  const sizeBytes = normalizeAttachmentSize(attachment);
  const metadata: EmailAttachmentMetadata = {
    contentType,
    sizeBytes,
  };

  if (attachment.filename) {
    metadata.filename = attachment.filename;
  }
  if (attachment.contentId) {
    metadata.contentId = normalizeHeaderId(attachment.contentId);
  }
  if (attachment.contentDisposition) {
    metadata.disposition = attachment.contentDisposition;
  }
  if (sizeBytes > maxAttachmentBytes) {
    metadata.skippedReason = "too_large";
    return metadata;
  }
  if (!SUPPORTED_INDEXED_ATTACHMENT_TYPES.has(contentType)) {
    metadata.skippedReason = "unsupported_content_type";
    return metadata;
  }

  const indexedText = extractIndexedText(attachment.content);
  if (indexedText === undefined) {
    metadata.skippedReason = "unsupported_content_type";
    return metadata;
  }

  metadata.indexedText = indexedText;
  metadata.indexedBytes = Buffer.byteLength(indexedText, "utf8");

  return metadata;
}

function normalizeAttachmentSize(attachment: ParsedAttachmentLike): number {
  if (typeof attachment.size === "number" && Number.isFinite(attachment.size)) {
    return Math.max(0, Math.trunc(attachment.size));
  }
  if (attachment.content) {
    return attachment.content.length;
  }
  return 0;
}

function extractIndexedText(content?: Buffer): string | undefined {
  if (!content || content.length === 0) {
    return "";
  }
  const decoded = content.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(content)) {
    return undefined;
  }
  return decoded;
}

function firstAddress(addresses?: ParsedAddressLike): EmailAddress {
  return addressList(addresses)[0] ?? { address: "unknown@invalid" };
}

function addressList(addresses?: ParsedAddressLike): EmailAddress[] {
  return (addresses?.value ?? [])
    .map((entry) => {
      const address = entry.address?.trim();
      if (!address) {
        return undefined;
      }
      return entry.name?.trim()
        ? { address, name: entry.name.trim() }
        : { address };
    })
    .filter((entry): entry is EmailAddress => entry !== undefined);
}

function normalizeSubject(subject: string): string {
  const withoutPrefixes = subject.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "");
  return withoutPrefixes.trim().replace(/\s+/g, " ").toLowerCase();
}

function buildFallbackThreadKey(
  from: EmailAddress,
  normalizedSubject: string
): string {
  const subject = normalizedSubject || "(no subject)";
  return `${from.address.toLowerCase()}::${subject}`;
}

function normalizeReferences(references?: string | string[]): string[] {
  if (Array.isArray(references)) {
    return references
      .map(normalizeHeaderId)
      .filter((value): value is string => Boolean(value));
  }
  if (typeof references === "string") {
    return references
      .split(/\s+/)
      .map(normalizeHeaderId)
      .filter((value): value is string => Boolean(value));
  }
  return [];
}

function normalizeHeaderId(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatFromHeader(name: string, address: string): string {
  const escapedName = name.replace(/"/g, '\\"');
  return `"${escapedName}" <${address}>`;
}

function normalizePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return Math.trunc(value);
}

function normalizeMaxAttachmentBytes(value?: number): number {
  if (value === undefined) {
    return DEFAULT_MAX_ATTACHMENT_BYTES;
  }
  return normalizePositiveInteger(value, "maxAttachmentBytes");
}

function parseUid(providerMessageId: string): string {
  if (!/^\d+$/.test(providerMessageId)) {
    throw new Error(
      `Unable to resolve IMAP UID for providerMessageId ${providerMessageId}`
    );
  }
  return providerMessageId;
}

function sanitizeForJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return {
      type: "Buffer",
      length: value.length,
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForJson(entry));
  }
  if (typeof value === "object") {
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || typeof entry === "function") {
        continue;
      }
      output[key] = sanitizeForJson(entry);
    }
    return output;
  }
  return String(value);
}
