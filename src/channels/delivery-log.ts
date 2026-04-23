import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson, toJsonValue } from "../platform/database.ts";
import { createId } from "../shared/ids.ts";
import type { JsonValue } from "../shared/types.ts";

type DeliveryLogRow = {
  id: string;
  channel_id: string;
  destination: string;
  payload_json: string;
  status: "delivered" | "failed";
  response_json: string | null;
  error_message: string | null;
  delivered_at: string;
};

export type ChannelDeliveryRecord = {
  id: string;
  channelId: string;
  destination: string;
  payload: JsonValue;
  status: "delivered" | "failed";
  response?: JsonValue;
  errorMessage?: string;
  deliveredAt: string;
};

export class ChannelDeliveryStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  record(input: {
    channelId: string;
    destination: string;
    payload: JsonValue;
    status: "delivered" | "failed";
    response?: JsonValue;
    errorMessage?: string;
  }): ChannelDeliveryRecord {
    const id = createId("delivery");
    const deliveredAt = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO channel_delivery_logs (
          id, channel_id, destination, payload_json, status, response_json, error_message, delivered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      id,
      input.channelId,
      input.destination,
      encodeJson(toJsonValue(input.payload)),
      input.status,
      input.response === undefined ? null : encodeJson(toJsonValue(input.response)),
      input.errorMessage ?? null,
      deliveredAt
    );
    return {
      id,
      channelId: input.channelId,
      destination: input.destination,
      payload: toJsonValue(input.payload),
      status: input.status,
      response: input.response === undefined ? undefined : toJsonValue(input.response),
      errorMessage: input.errorMessage,
      deliveredAt
    };
  }

  list(channelId?: string, limit = 50): ChannelDeliveryRecord[] {
    const normalizedLimit = Math.max(1, Math.min(limit, 200));
    const rows = channelId
      ? this.database.all<DeliveryLogRow>(
          `
            SELECT
              id, channel_id, destination, payload_json, status, response_json, error_message, delivered_at
            FROM channel_delivery_logs
            WHERE channel_id = ?
            ORDER BY delivered_at DESC
            LIMIT ?
          `,
          channelId,
          normalizedLimit
        )
      : this.database.all<DeliveryLogRow>(
          `
            SELECT
              id, channel_id, destination, payload_json, status, response_json, error_message, delivered_at
            FROM channel_delivery_logs
            ORDER BY delivered_at DESC
            LIMIT ?
          `,
          normalizedLimit
        );

    return rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      destination: row.destination,
      payload: decodeJson<JsonValue>(row.payload_json, null),
      status: row.status,
      response: row.response_json ? decodeJson<JsonValue>(row.response_json, null) : undefined,
      errorMessage: row.error_message ?? undefined,
      deliveredAt: row.delivered_at
    }));
  }

  summary(): { delivered: number; failed: number } {
    const rows = this.database.all<{ status: "delivered" | "failed"; count: number }>(
      `
        SELECT status, COUNT(*) AS count
        FROM channel_delivery_logs
        GROUP BY status
      `
    );
    const counts = new Map(rows.map((row) => [row.status, row.count]));
    return {
      delivered: counts.get("delivered") ?? 0,
      failed: counts.get("failed") ?? 0
    };
  }
}
