import type { JsonValue } from "../shared/types.ts";

export type EmailAddress = { address: string; name?: string };

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
