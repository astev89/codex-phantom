import { createHmac, timingSafeEqual } from "node:crypto";
import type { JsonValue } from "../shared/types.ts";
import type { InboundChannelMessage } from "./inbound.ts";

const MAX_SLACK_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type SlackEventsPayload = {
  type: string;
  challenge?: string;
  event_id?: string;
  event?: Record<string, unknown>;
};

export function validateSlackRequest(
  headers: Headers,
  signingSecret: string,
  rawBody: string,
  now = Date.now()
): boolean {
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  if (!timestamp || !signature?.startsWith("v0=")) {
    return false;
  }
  const timestampMs = Number(timestamp) * 1000;
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs(now - timestampMs) > MAX_SLACK_CLOCK_SKEW_MS
  ) {
    return false;
  }
  const expectedSignature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const expectedBuffer = Buffer.from(expectedSignature);
  const actualBuffer = Buffer.from(signature);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

export function mapSlackEventToInboundMessage(
  payload: SlackEventsPayload,
  options: { botUserId?: string } = {}
): InboundChannelMessage | null {
  if (
    payload.type !== "event_callback" ||
    !payload.event_id ||
    !payload.event
  ) {
    return null;
  }
  const event = payload.event;
  if (typeof event.bot_id === "string" || event.subtype !== undefined) {
    return null;
  }
  const eventType = stringValue(event.type);
  if (eventType === "reaction_added") {
    return mapReaction(payload.event_id, event);
  }
  if (eventType !== "app_mention" && eventType !== "message") {
    return null;
  }
  const user = stringValue(event.user);
  if (options.botUserId && user === options.botUserId) {
    return null;
  }
  const channel = stringValue(event.channel);
  const text = stringValue(event.text);
  const ts = stringValue(event.ts);
  if (!channel || !text || !ts) {
    return null;
  }
  const channelType = stringValue(event.channel_type);
  const threadTs = stringValue(event.thread_ts) ?? ts;
  const isDirectMessage = channelType === "im" || channel.startsWith("D");
  const cleanedText = stripBotMention(text, options.botUserId);
  if (eventType === "message" && !isDirectMessage && cleanedText === text) {
    return null;
  }
  return {
    channelId: "slack",
    providerEventId: payload.event_id,
    conversationId: `slack:${channel}:${threadTs}`,
    senderId: user,
    message: cleanedText.trim(),
    threadId: threadTs,
    responseTarget: { type: "slack_thread", channel, threadTs, messageTs: ts },
    rawPayload: payload as JsonValue,
  };
}

function mapReaction(
  providerEventId: string,
  event: Record<string, unknown>
): InboundChannelMessage | null {
  const user = stringValue(event.user);
  const reaction = stringValue(event.reaction);
  const item = recordValue(event.item);
  const channel = stringValue(item?.channel);
  const ts = stringValue(item?.ts);
  if (!reaction || !channel || !ts) {
    return null;
  }
  return {
    channelId: "slack",
    providerEventId,
    conversationId: `slack:${channel}:${ts}`,
    senderId: user,
    message: `Slack reaction :${reaction}: from ${user ?? "unknown"}`,
    threadId: ts,
    responseTarget: {
      type: "slack_thread",
      channel,
      threadTs: ts,
      messageTs: ts,
    },
    rawPayload: { type: "reaction_added", event } as JsonValue,
  };
}

function stripBotMention(text: string, botUserId?: string): string {
  if (!botUserId) {
    return text;
  }
  return text
    .replace(new RegExp(`<@${escapeRegExp(botUserId)}>`, "g"), "")
    .replace(/\s+/g, " ")
    .trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
