import { emailConfigComplete, type AppConfig } from "../config.ts";
import type { Logger } from "../platform/logger.ts";
import type { ChannelDeliveryStore } from "./delivery-log.ts";
import type { InboundChannelMessage, InboundChannelRouter } from "./inbound.ts";
import type { ChannelRegistry } from "./registry.ts";
import type {
  EmailInboundMessage,
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
        toInboundChannelMessage(message)
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
