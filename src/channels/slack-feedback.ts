import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson, toJsonValue } from "../platform/database.ts";
import { createId } from "../shared/ids.ts";
import type { JsonValue } from "../shared/types.ts";
import type { InboundChannelEventRecord } from "./inbound.ts";
import type { SlackEventsPayload } from "./slack-events.ts";
import type { SlackBlock } from "./slack.ts";

export type SlackFeedbackRating = "positive" | "negative";
export type SlackFeedbackSource = "button" | "reaction";

export type SlackFeedbackRecord = {
  id: string;
  inboundEventId?: string;
  channelId: string;
  providerEventId: string;
  rating: SlackFeedbackRating;
  source: SlackFeedbackSource;
  userId?: string;
  slackChannel?: string;
  messageTs?: string;
  threadTs?: string;
  runId?: string;
  rawPayload: JsonValue;
  createdAt: string;
};

type SlackFeedbackRow = {
  id: string;
  inbound_event_id: string | null;
  channel_id: string;
  provider_event_id: string;
  rating: SlackFeedbackRating;
  source: SlackFeedbackSource;
  user_id: string | null;
  slack_channel: string | null;
  message_ts: string | null;
  thread_ts: string | null;
  run_id: string | null;
  raw_payload_json: string;
  created_at: string;
};

export class SlackFeedbackStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  record(input: {
    inboundEvent?: InboundChannelEventRecord;
    channelId: string;
    providerEventId: string;
    rating: SlackFeedbackRating;
    source: SlackFeedbackSource;
    userId?: string;
    slackChannel?: string;
    messageTs?: string;
    threadTs?: string;
    rawPayload: JsonValue;
  }): { record: SlackFeedbackRecord; duplicate: boolean } {
    const id = createId("feedback");
    const now = new Date().toISOString();
    this.database.run(
      `
        INSERT OR IGNORE INTO inbound_channel_feedback (
          id, inbound_event_id, channel_id, provider_event_id, rating, source, user_id,
          slack_channel, message_ts, thread_ts, run_id, raw_payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      id,
      input.inboundEvent?.id ?? null,
      input.channelId,
      input.providerEventId,
      input.rating,
      input.source,
      input.userId ?? null,
      input.slackChannel ?? null,
      input.messageTs ?? null,
      input.threadTs ?? null,
      input.inboundEvent?.runId ?? null,
      encodeJson(toJsonValue(input.rawPayload)),
      now
    );
    const record = this.findByProviderEvent(
      input.channelId,
      input.providerEventId
    );
    if (!record) {
      throw new Error(`Failed to record Slack feedback: ${id}`);
    }
    return { record, duplicate: record.id !== id };
  }

  list(limit = 50): SlackFeedbackRecord[] {
    const normalizedLimit = Math.max(1, Math.min(limit, 200));
    return this.database
      .all<SlackFeedbackRow>(
        "SELECT * FROM inbound_channel_feedback ORDER BY created_at DESC LIMIT ?",
        normalizedLimit
      )
      .map(toRecord);
  }

  summary(): {
    positive: number;
    negative: number;
    recent: SlackFeedbackRecord[];
  } {
    const rows = this.database.all<{
      rating: SlackFeedbackRating;
      count: number;
    }>(
      "SELECT rating, COUNT(*) AS count FROM inbound_channel_feedback GROUP BY rating"
    );
    const counts = new Map(rows.map((row) => [row.rating, row.count]));
    return {
      positive: counts.get("positive") ?? 0,
      negative: counts.get("negative") ?? 0,
      recent: this.list(10),
    };
  }

  private findByProviderEvent(
    channelId: string,
    providerEventId: string
  ): SlackFeedbackRecord | null {
    const row = this.database.get<SlackFeedbackRow>(
      "SELECT * FROM inbound_channel_feedback WHERE channel_id = ? AND provider_event_id = ?",
      channelId,
      providerEventId
    );
    return row ? toRecord(row) : null;
  }
}

export function slackFeedbackBlocks(inboundEventId: string): SlackBlock[] {
  return [
    {
      type: "actions",
      block_id: `codex_feedback_${inboundEventId}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Helpful" },
          action_id: "codex_feedback_positive",
          value: inboundEventId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Needs work" },
          action_id: "codex_feedback_negative",
          value: inboundEventId,
        },
      ],
    },
  ];
}

export function mapSlackInteractionFeedback(payload: Record<string, unknown>): {
  inboundEventId: string;
  providerEventId: string;
  rating: SlackFeedbackRating;
  userId?: string;
  slackChannel?: string;
  messageTs?: string;
  threadTs?: string;
} | null {
  if (payload.type !== "block_actions") {
    return null;
  }
  const action = arrayValue(payload.actions)?.[0];
  const actionId = stringValue(recordValue(action)?.action_id);
  const rating =
    actionId === "codex_feedback_positive"
      ? "positive"
      : actionId === "codex_feedback_negative"
        ? "negative"
        : undefined;
  const inboundEventId = stringValue(recordValue(action)?.value);
  if (!rating || !inboundEventId) {
    return null;
  }
  const user = recordValue(payload.user);
  const channel = recordValue(payload.channel);
  const message = recordValue(payload.message);
  const container = recordValue(payload.container);
  const actionTs =
    stringValue(recordValue(action)?.action_ts) ??
    stringValue(payload.action_ts) ??
    new Date().toISOString();
  return {
    inboundEventId,
    providerEventId: `interaction:${inboundEventId}:${actionId}:${stringValue(user?.id) ?? "unknown"}:${actionTs}`,
    rating,
    userId: stringValue(user?.id),
    slackChannel: stringValue(channel?.id),
    messageTs: stringValue(container?.message_ts) ?? stringValue(message?.ts),
    threadTs: stringValue(message?.thread_ts),
  };
}

export function mapSlackReactionFeedback(payload: SlackEventsPayload): {
  providerEventId: string;
  rating: SlackFeedbackRating;
  userId?: string;
  slackChannel?: string;
  messageTs?: string;
  threadTs?: string;
  rawPayload: JsonValue;
} | null {
  if (
    payload.type !== "event_callback" ||
    !payload.event_id ||
    !payload.event
  ) {
    return null;
  }
  const event = payload.event;
  if (stringValue(event.type) !== "reaction_added") {
    return null;
  }
  const rating = reactionRating(stringValue(event.reaction));
  const item = recordValue(event.item);
  const messageTs = stringValue(item?.ts);
  if (!rating || !messageTs) {
    return null;
  }
  return {
    providerEventId: payload.event_id,
    rating,
    userId: stringValue(event.user),
    slackChannel: stringValue(item?.channel),
    messageTs,
    threadTs: stringValue(item?.thread_ts),
    rawPayload: payload as JsonValue,
  };
}

function reactionRating(
  reaction: string | undefined
): SlackFeedbackRating | undefined {
  if (
    reaction === "thumbsup" ||
    reaction === "white_check_mark" ||
    reaction === "heavy_plus_sign"
  ) {
    return "positive";
  }
  if (reaction === "thumbsdown" || reaction === "x" || reaction === "warning") {
    return "negative";
  }
  return undefined;
}

function toRecord(row: SlackFeedbackRow): SlackFeedbackRecord {
  return {
    id: row.id,
    inboundEventId: row.inbound_event_id ?? undefined,
    channelId: row.channel_id,
    providerEventId: row.provider_event_id,
    rating: row.rating,
    source: row.source,
    userId: row.user_id ?? undefined,
    slackChannel: row.slack_channel ?? undefined,
    messageTs: row.message_ts ?? undefined,
    threadTs: row.thread_ts ?? undefined,
    runId: row.run_id ?? undefined,
    rawPayload: decodeJson<JsonValue>(row.raw_payload_json, null),
    createdAt: row.created_at,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
