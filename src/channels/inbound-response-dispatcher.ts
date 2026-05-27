import type { AgentRunEvent } from "../agent/types.ts";
import type { AppConfig } from "../config.ts";
import type { Logger } from "../platform/logger.ts";
import { createId } from "../shared/ids.ts";
import type { JsonValue } from "../shared/types.ts";
import { HttpError } from "../server/validation.ts";
import type { ChannelDeliveryStore } from "./delivery-log.ts";
import type { EmailSendInput, EmailSendTransport } from "./email-types.ts";
import type {
  InboundChannelEventRecord,
  InboundChannelEventStore,
  InboundResponseTarget,
} from "./inbound.ts";
import { slackFeedbackBlocks } from "./slack-feedback.ts";
import { SlackProgressReporter } from "./slack-progress.ts";
import type { SlackChannel } from "./slack.ts";

export type InboundResponseAdapter = {
  beforeRun?(record: InboundChannelEventRecord): Promise<void> | void;
  onEvent?(
    record: InboundChannelEventRecord,
    event: AgentRunEvent
  ): Promise<void> | void;
  onComplete?(record: InboundChannelEventRecord): Promise<void> | void;
  onFailure?(record: InboundChannelEventRecord): Promise<void> | void;
};

type InboundResponseTargetType = InboundResponseTarget["type"];

export class InboundResponseDispatcher {
  private readonly adapters = new Map<
    InboundResponseTargetType,
    InboundResponseAdapter
  >();
  private readonly logger: Logger;

  constructor(input: {
    logger: Logger;
    adapters?: Partial<
      Record<InboundResponseTargetType, InboundResponseAdapter>
    >;
  }) {
    this.logger = input.logger.child({ component: "inbound_response" });
    this.adapters.set("webhook", {});
    for (const [targetType, adapter] of Object.entries(
      input.adapters ?? {}
    ) as Array<[InboundResponseTargetType, InboundResponseAdapter]>) {
      this.adapters.set(targetType, adapter);
    }
  }

  callbacks(): {
    beforeRun: (record: InboundChannelEventRecord) => Promise<void>;
    onEvent: (event: AgentRunEvent) => Promise<void>;
    onComplete: (record: InboundChannelEventRecord) => Promise<void>;
    onFailure: (record: InboundChannelEventRecord) => Promise<void>;
  } {
    let currentRecord: InboundChannelEventRecord | undefined;
    return {
      beforeRun: async (record) => {
        currentRecord = record;
        await this.beforeRun(record);
      },
      onEvent: async (event) => {
        if (currentRecord) {
          await this.onEvent(currentRecord, event);
        }
      },
      onComplete: async (record) => {
        currentRecord = record;
        await this.onComplete(record);
      },
      onFailure: async (record) => {
        currentRecord = record;
        await this.onFailure(record);
      },
    };
  }

  async beforeRun(record: InboundChannelEventRecord): Promise<void> {
    await this.runAdapter(record, "beforeRun", (adapter) =>
      adapter.beforeRun?.(record)
    );
  }

  async onEvent(
    record: InboundChannelEventRecord,
    event: AgentRunEvent
  ): Promise<void> {
    await this.runAdapter(record, "onEvent", (adapter) =>
      adapter.onEvent?.(record, event)
    );
  }

  async onComplete(record: InboundChannelEventRecord): Promise<void> {
    if (!record.outputText) {
      return;
    }
    await this.runAdapter(record, "onComplete", (adapter) =>
      adapter.onComplete?.(record)
    );
  }

  async onFailure(record: InboundChannelEventRecord): Promise<void> {
    await this.runAdapter(record, "onFailure", (adapter) =>
      adapter.onFailure?.(record)
    );
  }

  private async runAdapter(
    record: InboundChannelEventRecord,
    phase: keyof InboundResponseAdapter,
    work: (adapter: InboundResponseAdapter) => Promise<void> | void | undefined
  ): Promise<void> {
    const targetType = record.responseTarget?.type;
    if (!targetType) {
      return;
    }
    const adapter = this.adapters.get(targetType);
    if (!adapter) {
      return;
    }
    try {
      await work(adapter);
    } catch (error) {
      this.logger.error("inbound_response_dispatch_failed", {
        inboundEventId: record.id,
        channelId: record.channelId,
        targetType,
        phase,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }
}

export function createSlackInboundResponseAdapter(input: {
  slack: SlackChannel;
  store: InboundChannelEventStore;
  logger: Logger;
}): InboundResponseAdapter {
  const progressReporters = new Map<string, SlackProgressReporter>();
  const logger = input.logger.child({ component: "slack_inbound_response" });

  function targetFor(
    record: InboundChannelEventRecord
  ): Extract<InboundResponseTarget, { type: "slack_thread" }> | undefined {
    return record.responseTarget?.type === "slack_thread"
      ? record.responseTarget
      : undefined;
  }

  return {
    async beforeRun(record) {
      const target = targetFor(record);
      if (!target) {
        return;
      }
      const progressReporter = new SlackProgressReporter({
        slack: input.slack,
        store: input.store,
        recordId: record.id,
        target,
      });
      progressReporters.set(record.id, progressReporter);
      await progressReporter.queued();
    },
    async onEvent(record, event) {
      await progressReporters.get(record.id)?.onEvent(event);
    },
    async onComplete(record) {
      const target = targetFor(record);
      if (!target || !record.outputText) {
        return;
      }
      await progressReporters.get(record.id)?.completed(record.outputText);
      try {
        const delivered = await input.slack.sendMessage({
          channel: target.channel,
          text: record.outputText,
          threadTs: target.threadTs,
          blocks: slackFeedbackBlocks(record.id),
        });
        input.store.recordSlackResponseMessage(record.id, delivered.result.ts);
      } catch (error) {
        if (shouldIgnoreSlackDeliveryError(error)) {
          logger.warn("inbound_response_delivery_skipped", {
            channelId: "slack",
            reason:
              error instanceof Error
                ? error.message
                : "Slack delivery unavailable",
          });
          return;
        }
        throw error;
      } finally {
        progressReporters.delete(record.id);
      }
    },
    async onFailure(record) {
      const target = targetFor(record);
      if (!target) {
        return;
      }
      await progressReporters
        .get(record.id)
        ?.failed(record.errorMessage ?? "Inbound channel run failed");
      logger.error("inbound_channel_failed", {
        inboundEventId: record.id,
        channelId: record.channelId,
        error: record.errorMessage ?? "Inbound channel run failed",
      });
      progressReporters.delete(record.id);
    },
  };
}

export function createEmailInboundResponseAdapter(input: {
  config: AppConfig;
  deliveries: ChannelDeliveryStore;
  sendTransport: EmailSendTransport;
  logger: Logger;
}): InboundResponseAdapter {
  const logger = input.logger.child({ component: "email_channel" });

  return {
    async onComplete(record) {
      if (
        record.status !== "completed" ||
        record.responseTarget?.type !== "email_reply" ||
        !record.outputText
      ) {
        return;
      }

      if (!input.config.emailFromAddress) {
        recordFailedEmailDelivery(
          input.deliveries,
          logger,
          record,
          1,
          "EMAIL_FROM_ADDRESS is required"
        );
        return;
      }

      const email = buildReplyEmailInput(input.config, record);
      const payload = emailDeliveryPayload(record, email);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const result = await input.sendTransport.send(email);
          input.deliveries.record({
            channelId: "email",
            destination: email.to,
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
            recordFailedEmailDelivery(
              input.deliveries,
              logger,
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
    },
  };
}

function shouldIgnoreSlackDeliveryError(error: unknown): boolean {
  if (
    error instanceof HttpError &&
    (error.status === 409 || error.status === 412)
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("slack_bot_token") ||
    message.includes("slack channel is not enabled") ||
    message.includes("slack signing")
  );
}

function emailDeliveryPayload(
  record: InboundChannelEventRecord,
  email: EmailSendInput
): { [key: string]: JsonValue } {
  const target = record.responseTarget;
  if (target?.type !== "email_reply") {
    throw new Error("Inbound record is not configured for email replies");
  }
  return {
    method: "email.reply",
    inboundEventId: record.id,
    providerEventId: record.providerEventId,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo ?? null,
    references: email.references,
    subject: email.subject,
    fromMessageProviderId: target.fromMessageProviderId,
    textCharCount: email.text.length,
    textByteCount: Buffer.byteLength(email.text, "utf8"),
    htmlCharCount: email.html.length,
    htmlByteCount: Buffer.byteLength(email.html, "utf8"),
  };
}

function recordFailedEmailDelivery(
  deliveries: ChannelDeliveryStore,
  logger: Logger,
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
  deliveries.record({
    channelId: "email",
    destination,
    payload,
    status: "failed",
    response: error ? serializeEmailSendError(error) : undefined,
    errorMessage,
    attemptCount,
  });
  logger.error("email_channel_reply_failed", {
    inboundEventId: record.id,
    destination,
    attemptCount,
    error: errorMessage,
  });
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
      : undefined;
  const responseCode =
    typeof errorWithMeta.responseCode === "number"
      ? errorWithMeta.responseCode
      : undefined;
  const message =
    typeof errorWithMeta.message === "string"
      ? errorWithMeta.message.toLowerCase()
      : "";

  if (responseCode !== undefined) {
    if (responseCode >= 400 && responseCode < 500) {
      return true;
    }
    if (responseCode >= 500 && responseCode < 600) {
      return false;
    }
  }

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

function serializeEmailSendError(error: unknown): JsonValue {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }
  const errorWithMeta = error as {
    message?: unknown;
    code?: unknown;
    statusCode?: unknown;
    responseCode?: unknown;
    response?: unknown;
  };
  return {
    message:
      typeof errorWithMeta.message === "string"
        ? errorWithMeta.message
        : "Email delivery failed",
    code: typeof errorWithMeta.code === "string" ? errorWithMeta.code : null,
    statusCode:
      typeof errorWithMeta.statusCode === "number"
        ? errorWithMeta.statusCode
        : null,
    responseCode:
      typeof errorWithMeta.responseCode === "number"
        ? errorWithMeta.responseCode
        : null,
    response:
      typeof errorWithMeta.response === "string"
        ? errorWithMeta.response
        : null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
