import type { OrchestrationService } from "../orchestration/service.ts";
import type { SubagentRequest } from "../orchestration/types.ts";
import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson } from "../platform/database.ts";
import { createId } from "../shared/ids.ts";
import type { JsonValue } from "../shared/types.ts";
import { HttpError } from "../server/validation.ts";
import type { AgentRunEvent } from "../agent/types.ts";
import type { ChannelRegistry } from "./registry.ts";

export type InboundResponseTarget =
  | { type: "webhook" }
  | { type: "slack_thread"; channel: string; threadTs: string };

export type InboundChannelMessage = {
  sessionId?: string;
  channelId: string;
  providerEventId: string;
  conversationId: string;
  senderId?: string;
  message: string;
  threadId?: string;
  responseTarget?: InboundResponseTarget;
  rawPayload: JsonValue;
  subagents?: SubagentRequest[];
  timeoutMs?: number;
};

export type InboundChannelEventStatus = "received" | "ignored" | "running" | "completed" | "failed";

export type InboundChannelEventRecord = {
  id: string;
  channelId: string;
  providerEventId: string;
  conversationId: string;
  senderId?: string;
  message: string;
  threadId?: string;
  responseTarget?: InboundResponseTarget;
  rawPayload: JsonValue;
  status: InboundChannelEventStatus;
  sessionId?: string;
  runId?: string;
  outputText?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

type InboundChannelEventRow = {
  id: string;
  channel_id: string;
  provider_event_id: string;
  conversation_id: string;
  sender_id: string | null;
  message: string;
  thread_id: string | null;
  response_target_json: string | null;
  raw_payload_json: string;
  status: InboundChannelEventStatus;
  session_id: string | null;
  run_id: string | null;
  output_text: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export class InboundChannelEventStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  recordReceived(input: InboundChannelMessage): { record: InboundChannelEventRecord; duplicate: boolean } {
    const existing = this.findByProviderEvent(input.channelId, input.providerEventId);
    if (existing) {
      return { record: existing, duplicate: true };
    }
    const now = new Date().toISOString();
    const id = createId("inbound");
    this.database.run(
      `
        INSERT INTO inbound_channel_events (
          id, channel_id, provider_event_id, conversation_id, sender_id, message, thread_id,
          response_target_json, raw_payload_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      id,
      input.channelId,
      input.providerEventId,
      input.conversationId,
      input.senderId ?? null,
      input.message,
      input.threadId ?? null,
      input.responseTarget ? encodeJson(input.responseTarget) : null,
      encodeJson(input.rawPayload),
      "received",
      now,
      now
    );
    const record = this.get(id);
    if (!record) {
      throw new Error(`Failed to record inbound channel event: ${id}`);
    }
    return { record, duplicate: false };
  }

  markIgnored(id: string, errorMessage?: string): InboundChannelEventRecord {
    return this.updateStatus(id, "ignored", { errorMessage });
  }

  markRunning(id: string): InboundChannelEventRecord {
    return this.updateStatus(id, "running");
  }

  markCompleted(id: string, result: { sessionId: string; runId: string; outputText: string }): InboundChannelEventRecord {
    return this.updateStatus(id, "completed", result);
  }

  markFailed(id: string, errorMessage: string): InboundChannelEventRecord {
    return this.updateStatus(id, "failed", { errorMessage });
  }

  get(id: string): InboundChannelEventRecord | null {
    const row = this.database.get<InboundChannelEventRow>("SELECT * FROM inbound_channel_events WHERE id = ?", id);
    return row ? toRecord(row) : null;
  }

  list(options: { channelId?: string; limit?: number } = {}): InboundChannelEventRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const rows = options.channelId
      ? this.database.all<InboundChannelEventRow>(
        "SELECT * FROM inbound_channel_events WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?",
        options.channelId,
        limit
      )
      : this.database.all<InboundChannelEventRow>(
        "SELECT * FROM inbound_channel_events ORDER BY created_at DESC LIMIT ?",
        limit
      );
    return rows.map(toRecord);
  }

  summary(): { received: number; ignored: number; running: number; completed: number; failed: number; recentFailed: InboundChannelEventRecord[] } {
    const counts = {
      received: 0,
      ignored: 0,
      running: 0,
      completed: 0,
      failed: 0
    };
    for (const row of this.database.all<{ status: InboundChannelEventStatus; count: number }>(
      "SELECT status, COUNT(*) AS count FROM inbound_channel_events GROUP BY status"
    )) {
      counts[row.status] = row.count;
    }
    return {
      ...counts,
      recentFailed: this.database
        .all<InboundChannelEventRow>(
          "SELECT * FROM inbound_channel_events WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 10"
        )
        .map(toRecord)
    };
  }

  private findByProviderEvent(channelId: string, providerEventId: string): InboundChannelEventRecord | null {
    const row = this.database.get<InboundChannelEventRow>(
      "SELECT * FROM inbound_channel_events WHERE channel_id = ? AND provider_event_id = ?",
      channelId,
      providerEventId
    );
    return row ? toRecord(row) : null;
  }

  private updateStatus(
    id: string,
    status: InboundChannelEventStatus,
    patch: { sessionId?: string; runId?: string; outputText?: string; errorMessage?: string } = {}
  ): InboundChannelEventRecord {
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE inbound_channel_events
        SET status = ?,
            session_id = COALESCE(?, session_id),
            run_id = COALESCE(?, run_id),
            output_text = COALESCE(?, output_text),
            error_message = COALESCE(?, error_message),
            updated_at = ?
        WHERE id = ?
      `,
      status,
      patch.sessionId ?? null,
      patch.runId ?? null,
      patch.outputText ?? null,
      patch.errorMessage ?? null,
      now,
      id
    );
    const record = this.get(id);
    if (!record) {
      throw new Error(`Inbound channel event not found: ${id}`);
    }
    return record;
  }
}

export class InboundChannelRouter {
  private readonly channels: ChannelRegistry;
  private readonly store: InboundChannelEventStore;
  private readonly orchestration: OrchestrationService;

  constructor(channels: ChannelRegistry, store: InboundChannelEventStore, orchestration: OrchestrationService) {
    this.channels = channels;
    this.store = store;
    this.orchestration = orchestration;
  }

  async routeSync(
    message: InboundChannelMessage,
    onEvent: (event: AgentRunEvent) => Promise<void> | void
  ): Promise<{ record: InboundChannelEventRecord; events: AgentRunEvent[]; result: { sessionId: string; runId: string; outputText: string } }> {
    this.requireEnabledChannel(message.channelId);
    const received = this.store.recordReceived(message);
    if (received.duplicate && received.record.sessionId && received.record.runId && received.record.outputText !== undefined) {
      return {
        record: received.record,
        events: [],
        result: {
          sessionId: received.record.sessionId,
          runId: received.record.runId,
          outputText: received.record.outputText
        }
      };
    }
    if (received.duplicate && received.record.status === "running") {
      throw new HttpError(409, "Inbound channel event is already running");
    }
    const record = received.duplicate ? received.record : this.store.markRunning(received.record.id);
    const events: AgentRunEvent[] = [];
    try {
      const result = await this.orchestration.runCoordinator(
        {
          sessionId: message.sessionId,
          channelId: message.channelId,
          conversationId: message.conversationId,
          message: message.message,
          subagents: message.subagents,
          timeoutMs: message.timeoutMs
        },
        async (event) => {
          events.push(event);
          await onEvent(event);
        }
      );
      const completed = this.store.markCompleted(record.id, result);
      return { record: completed, events, result };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Inbound channel run failed";
      this.store.markFailed(record.id, messageText);
      throw error;
    }
  }

  routeAsync(
    message: InboundChannelMessage,
    callbacks: {
      onEvent?: (event: AgentRunEvent) => Promise<void> | void;
      onComplete?: (record: InboundChannelEventRecord) => Promise<void> | void;
      onFailure?: (record: InboundChannelEventRecord) => Promise<void> | void;
    } = {}
  ): { record: InboundChannelEventRecord; duplicate: boolean; completion: Promise<InboundChannelEventRecord> } {
    this.requireEnabledChannel(message.channelId);
    const received = this.store.recordReceived(message);
    if (received.duplicate) {
      return {
        record: received.record,
        duplicate: true,
        completion: Promise.resolve(received.record)
      };
    }
    const running = this.store.markRunning(received.record.id);
    const completion = this.runAsync(message, running.id, callbacks);
    return { record: running, duplicate: false, completion };
  }

  private async runAsync(
    message: InboundChannelMessage,
    recordId: string,
    callbacks: {
      onEvent?: (event: AgentRunEvent) => Promise<void> | void;
      onComplete?: (record: InboundChannelEventRecord) => Promise<void> | void;
      onFailure?: (record: InboundChannelEventRecord) => Promise<void> | void;
    }
  ): Promise<InboundChannelEventRecord> {
    try {
      const result = await this.orchestration.runCoordinator(
        {
          sessionId: message.sessionId,
          channelId: message.channelId,
          conversationId: message.conversationId,
          message: message.message,
          subagents: message.subagents,
          timeoutMs: message.timeoutMs
        },
        async (event) => {
          await callbacks.onEvent?.(event);
        }
      );
      const completed = this.store.markCompleted(recordId, result);
      await callbacks.onComplete?.(completed);
      return completed;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Inbound channel run failed";
      const failed = this.store.markFailed(recordId, messageText);
      await callbacks.onFailure?.(failed);
      return failed;
    }
  }

  private requireEnabledChannel(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel || !channel.enabled) {
      throw new HttpError(409, `${channelId} channel is not enabled`);
    }
  }
}

function toRecord(row: InboundChannelEventRow): InboundChannelEventRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    providerEventId: row.provider_event_id,
    conversationId: row.conversation_id,
    senderId: row.sender_id ?? undefined,
    message: row.message,
    threadId: row.thread_id ?? undefined,
    responseTarget: decodeJson<InboundResponseTarget | undefined>(row.response_target_json, undefined),
    rawPayload: decodeJson<JsonValue>(row.raw_payload_json, null),
    status: row.status,
    sessionId: row.session_id ?? undefined,
    runId: row.run_id ?? undefined,
    outputText: row.output_text ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
