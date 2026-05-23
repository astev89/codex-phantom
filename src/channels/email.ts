import { emailConfigComplete, type AppConfig } from "../config.ts";
import type { Logger } from "../platform/logger.ts";
import { createId } from "../shared/ids.ts";
import type { JsonValue } from "../shared/types.ts";
import type { ChannelDeliveryStore } from "./delivery-log.ts";
import type {
  InboundChannelEventRecord,
  InboundChannelMessage,
  InboundChannelRouter,
} from "./inbound.ts";
import type { ChannelRegistry } from "./registry.ts";
import type {
  EmailInboundMessage,
  EmailSendInput,
  EmailPollTransport,
  EmailSendTransport,
} from "./email-types.ts";

export type EmailPollSummary = {
  polledCount: number;
  acceptedCount: number;
  duplicateCount: number;
  skippedAutoReplyCount: number;
};

export type EmailChannelStatus = {
  enabled: boolean;
  running: boolean;
  configComplete: boolean;
  lastPollAt?: string;
  lastSummary?: EmailPollSummary;
  lastError?: string;
};

const AUTO_REPLY_INDICATORS = [
  "out of office",
  "automatic reply",
  "auto-reply",
  "autoreply",
  "vacation reply",
  "delivery status notification",
  "undeliverable",
  "mailer-daemon",
];

export class EmailChannelService {
  private readonly config: AppConfig;
  private readonly channels: ChannelRegistry;
  private readonly inboundRouter: InboundChannelRouter;
  private readonly deliveries: ChannelDeliveryStore;
  private readonly pollTransport: EmailPollTransport;
  private readonly sendTransport: EmailSendTransport;
  private readonly logger: Logger;
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly statusState: EmailChannelStatus;

  constructor(input: {
    config: AppConfig;
    channels: ChannelRegistry;
    inboundRouter: InboundChannelRouter;
    deliveries: ChannelDeliveryStore;
    pollTransport: EmailPollTransport;
    sendTransport: EmailSendTransport;
    logger: Logger;
  }) {
    this.config = input.config;
    this.channels = input.channels;
    this.inboundRouter = input.inboundRouter;
    this.deliveries = input.deliveries;
    this.pollTransport = input.pollTransport;
    this.sendTransport = input.sendTransport;
    this.logger = input.logger.child({ component: "email_channel" });
    this.statusState = {
      enabled: false,
      running: false,
      configComplete: emailConfigComplete(input.config),
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    const channel = this.channels.get("email");
    this.statusState.enabled = Boolean(channel?.enabled);
    this.statusState.configComplete = emailConfigComplete(this.config);
    this.statusState.lastError = undefined;

    if (!channel?.enabled) {
      this.statusState.running = false;
      return;
    }
    if (!this.statusState.configComplete) {
      this.statusState.running = false;
      this.statusState.lastError =
        "Email channel is enabled but IMAP/SMTP configuration is incomplete";
      this.logger.warn("email_channel_config_incomplete", {
        channelId: "email",
      });
      return;
    }

    this.running = true;
    this.statusState.running = true;
    this.armNext(this.config.emailPollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.statusState.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.pollTransport.close();
    await this.sendTransport.close();
  }

  async pollOnce(): Promise<EmailPollSummary> {
    const messages = await this.pollTransport.listUnread({
      maxMessages: this.config.emailPollBatchSize,
      maxBytes: this.config.emailMaxMessageBytes,
    });
    const limitedMessages = messages.slice(0, this.config.emailPollBatchSize);
    const summary: EmailPollSummary = {
      polledCount: limitedMessages.length,
      acceptedCount: 0,
      duplicateCount: 0,
      skippedAutoReplyCount: 0,
    };

    for (const message of limitedMessages) {
      if (isAutoReply(message)) {
        summary.skippedAutoReplyCount += 1;
        await this.pollTransport.markSeen(message.providerMessageId);
        continue;
      }
      const routed = this.inboundRouter.routeAsync(
        toInboundChannelMessage(message),
        {
          onComplete: async (record) => {
            await this.deliverInboundResponse(record);
          },
        }
      );
      if (routed.duplicate) {
        summary.duplicateCount += 1;
      } else {
        summary.acceptedCount += 1;
      }
      await this.pollTransport.markSeen(message.providerMessageId);
    }

    this.statusState.lastPollAt = new Date().toISOString();
    this.statusState.lastSummary = summary;
    this.statusState.lastError = undefined;
    void this.deliveries;
    return summary;
  }

  status(): EmailChannelStatus {
    return { ...this.statusState };
  }

  private armNext(delayMs: number): void {
    if (!this.running) {
      return;
    }
    const normalizedDelay = Math.max(1_000, Math.trunc(delayMs));
    this.timer = setTimeout(() => {
      void this.runScheduledPoll();
    }, normalizedDelay);
  }

  private async runScheduledPoll(): Promise<void> {
    if (!this.running) {
      return;
    }
    try {
      await this.pollOnce();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Email poll failed";
      this.statusState.lastError = message;
      this.logger.error("email_channel_poll_failed", { error: message });
    } finally {
      this.armNext(this.config.emailPollIntervalMs);
    }
  }

  private async deliverInboundResponse(
    record: InboundChannelEventRecord
  ): Promise<void> {
    if (
      record.status !== "completed" ||
      record.responseTarget?.type !== "email_reply" ||
      !record.outputText
    ) {
      return;
    }

    if (!this.config.emailFromAddress) {
      this.recordFailedDelivery(record, 1, "EMAIL_FROM_ADDRESS is required");
      return;
    }

    const input = buildReplyEmailInput(this.config, record);
    const payload: { [key: string]: JsonValue } = {
      method: "email.reply",
      inboundEventId: record.id,
      providerEventId: record.providerEventId,
      messageId: input.messageId,
      inReplyTo: input.inReplyTo ?? null,
      references: input.references,
      subject: input.subject,
      text: input.text,
      html: input.html,
      fromMessageProviderId: record.responseTarget.fromMessageProviderId,
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await this.sendTransport.send(input);
        this.deliveries.record({
          channelId: "email",
          destination: input.to,
          payload,
          status: "delivered",
          response: {
            providerMessageId: result.providerMessageId ?? null,
            response: result.response,
          },
          attemptCount: attempt,
        });
        return;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Email delivery failed";
        if (attempt === 3 || !isRetryableEmailSendError(error)) {
          this.recordFailedDelivery(
            record,
            attempt,
            errorMessage,
            payload,
            error
          );
          return;
        }
        await sleep(Math.min(attempt * 250, 1_000));
      }
    }
  }

  private recordFailedDelivery(
    record: InboundChannelEventRecord,
    attemptCount: number,
    errorMessage: string,
    payload: { [key: string]: JsonValue } = {
      method: "email.reply",
      inboundEventId: record.id,
      providerEventId: record.providerEventId,
    },
    error?: unknown
  ): void {
    const destination =
      record.responseTarget?.type === "email_reply"
        ? record.responseTarget.to
        : (record.senderId ?? "unknown");
    this.deliveries.record({
      channelId: "email",
      destination,
      payload,
      status: "failed",
      response: error ? serializeEmailSendError(error) : undefined,
      errorMessage,
      attemptCount,
    });
    this.logger.error("email_channel_reply_failed", {
      inboundEventId: record.id,
      destination,
      attemptCount,
      error: errorMessage,
    });
  }
}

function toInboundChannelMessage(
  message: EmailInboundMessage
): InboundChannelMessage {
  return {
    channelId: "email",
    providerEventId: message.providerMessageId,
    conversationId: resolveConversationId(message),
    senderId: message.from.address,
    message: message.text,
    threadId: message.thread.messageId,
    responseTarget: {
      type: "email_reply",
      to: message.from.address,
      subject: message.subject,
      messageId: message.thread.messageId,
      references: message.thread.references,
      fromMessageProviderId: message.providerMessageId,
    },
    rawPayload: message.rawPayload,
  };
}

function resolveConversationId(message: EmailInboundMessage): string {
  return (
    message.thread.references[0] ??
    message.thread.inReplyTo ??
    message.thread.messageId ??
    message.thread.fallbackThreadKey
  );
}

function isAutoReply(message: EmailInboundMessage): boolean {
  const candidates = [
    message.subject,
    message.text,
    message.from.address,
    message.from.name,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());

  return AUTO_REPLY_INDICATORS.some((indicator) =>
    candidates.some((value) => value.includes(indicator))
  );
}

function buildReplyEmailInput(
  config: AppConfig,
  record: InboundChannelEventRecord
): EmailSendInput {
  const target = record.responseTarget;
  if (target?.type !== "email_reply") {
    throw new Error("Inbound record is not configured for email replies");
  }
  if (!config.emailFromAddress) {
    throw new Error("EMAIL_FROM_ADDRESS is required");
  }

  return {
    to: target.to,
    fromAddress: config.emailFromAddress,
    fromName: config.emailFromName,
    subject: target.subject,
    text: record.outputText ?? "",
    html: renderEmailHtml(record.outputText ?? ""),
    messageId: generateReplyMessageId(config.emailFromAddress),
    inReplyTo: target.messageId,
    references: mergeReferences(target.references, target.messageId),
  };
}

function generateReplyMessageId(fromAddress: string): string {
  const domain = fromAddress.split("@")[1]?.trim() || "codex-phantom.local";
  return `<${createId("email")}@${domain}>`;
}

function mergeReferences(references: string[], messageId?: string): string[] {
  const merged = [...references];
  if (messageId) {
    merged.push(messageId);
  }
  return [...new Set(merged.filter((value) => value.trim().length > 0))];
}

function renderEmailHtml(text: string): string {
  const codeBlocks: string[] = [];
  const withoutCodeBlocks = String(text).replace(
    /```([\s\S]*?)```/g,
    (_match, code: string) => {
      const token = `%%CODE_BLOCK_${codeBlocks.length}%%`;
      codeBlocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
      return token;
    }
  );
  const rendered = escapeHtml(withoutCodeBlocks).replace(/\n/g, "<br />");
  return rendered.replace(/%%CODE_BLOCK_(\d+)%%/g, (_match, index: string) => {
    return codeBlocks[Number(index)] ?? "";
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function isRetryableEmailSendError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const errorWithMeta = error as {
    code?: unknown;
    statusCode?: unknown;
    responseCode?: unknown;
    message?: unknown;
  };
  const code =
    typeof errorWithMeta.code === "string"
      ? errorWithMeta.code.toUpperCase()
      : "";
  const statusCode =
    typeof errorWithMeta.statusCode === "number"
      ? errorWithMeta.statusCode
      : typeof errorWithMeta.responseCode === "number"
        ? errorWithMeta.responseCode
        : undefined;
  const message =
    typeof errorWithMeta.message === "string"
      ? errorWithMeta.message.toLowerCase()
      : "";

  return (
    (code.startsWith("E") &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "EPIPE",
        "EHOSTUNREACH",
      ].includes(code)) ||
    statusCode === 429 ||
    (statusCode !== undefined && statusCode >= 500) ||
    /\b(temporary|timeout|timed out|throttl|rate limit|unavailable|try again|connection reset|econnreset|econnrefused|etimedout)\b/.test(
      message
    )
  );
}

function serializeEmailSendError(error: unknown): { [key: string]: JsonValue } {
  if (!error || typeof error !== "object") {
    return { error: String(error) };
  }
  const result: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(error)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
    }
  }
  if (!("message" in result) && error instanceof Error) {
    result.message = error.message;
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
