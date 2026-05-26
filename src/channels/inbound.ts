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
  | {
      type: "slack_thread";
      channel: string;
      threadTs: string;
      messageTs?: string;
    }
  | {
      type: "email_reply";
      to: string;
      subject: string;
      messageId?: string;
      references: string[];
      fromMessageProviderId: string;
    };

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

export type InboundChannelEventStatus =
  | "received"
  | "ignored"
  | "running"
  | "completed"
  | "failed";
export type InboundChannelProgressState =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type InboundChannelProgressRecord = {
  id: string;
  inboundEventId: string;
  state: InboundChannelProgressState;
  messageTs?: string;
  statusReaction?: string;
  summary: string;
  createdAt: string;
};

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
  progressState?: string;
  progressMessageTs?: string;
  statusReaction?: string;
  slackResponseMessageTs?: string;
  createdAt: string;
  updatedAt: string;
  progress?: InboundChannelProgressRecord[];
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
  progress_state: string | null;
  progress_message_ts: string | null;
  status_reaction: string | null;
  slack_response_message_ts: string | null;
  created_at: string;
  updated_at: string;
};

type InboundChannelProgressRow = {
  id: string;
  inbound_event_id: string;
  state: InboundChannelProgressState;
  message_ts: string | null;
  status_reaction: string | null;
  summary: string;
  created_at: string;
};

export class InboundChannelEventStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  recordReceived(input: InboundChannelMessage): {
    record: InboundChannelEventRecord;
    duplicate: boolean;
  } {
    const now = new Date().toISOString();
    const id = createId("inbound");
    this.database.run(
      `
        INSERT OR IGNORE INTO inbound_channel_events (
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
    const record = this.findByProviderEvent(
      input.channelId,
      input.providerEventId
    );
    if (!record) {
      throw new Error(`Failed to record inbound channel event: ${id}`);
    }
    return { record, duplicate: record.id !== id };
  }

  markIgnored(id: string, errorMessage?: string): InboundChannelEventRecord {
    return this.updateStatus(id, "ignored", { errorMessage });
  }

  markRunning(id: string): InboundChannelEventRecord {
    return this.updateStatus(id, "running");
  }

  markCompleted(
    id: string,
    result: { sessionId: string; runId: string; outputText: string }
  ): InboundChannelEventRecord {
    return this.updateStatus(id, "completed", result);
  }

  markFailed(id: string, errorMessage: string): InboundChannelEventRecord {
    return this.updateStatus(id, "failed", { errorMessage });
  }

  recordSlackResponseMessage(
    id: string,
    messageTs: string
  ): InboundChannelEventRecord {
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE inbound_channel_events
        SET slack_response_message_ts = ?,
            updated_at = ?
        WHERE id = ?
      `,
      messageTs,
      now,
      id
    );
    const record = this.get(id);
    if (!record) {
      throw new Error(`Inbound channel event not found: ${id}`);
    }
    return record;
  }

  findBySlackMessageTs(messageTs: string): InboundChannelEventRecord | null {
    const direct = this.database.get<InboundChannelEventRow>(
      "SELECT * FROM inbound_channel_events WHERE slack_response_message_ts = ? OR progress_message_ts = ? ORDER BY updated_at DESC LIMIT 1",
      messageTs,
      messageTs
    );
    if (direct) {
      return this.withProgress(toRecord(direct));
    }
    const progress = this.database.get<{ inbound_event_id: string }>(
      "SELECT inbound_event_id FROM inbound_channel_progress WHERE message_ts = ? ORDER BY created_at DESC LIMIT 1",
      messageTs
    );
    return progress ? this.get(progress.inbound_event_id) : null;
  }

  recordProgress(
    id: string,
    input: {
      state: InboundChannelProgressState;
      messageTs?: string;
      statusReaction?: string;
      summary: string;
    }
  ): InboundChannelProgressRecord {
    const progressId = createId("progress");
    const now = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO inbound_channel_progress (
          id, inbound_event_id, state, message_ts, status_reaction, summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      progressId,
      id,
      input.state,
      input.messageTs ?? null,
      input.statusReaction ?? null,
      input.summary,
      now
    );
    this.database.run(
      `
        UPDATE inbound_channel_events
        SET progress_state = ?,
            progress_message_ts = COALESCE(?, progress_message_ts),
            status_reaction = COALESCE(?, status_reaction),
            updated_at = ?
        WHERE id = ?
      `,
      input.state,
      input.messageTs ?? null,
      input.statusReaction ?? null,
      now,
      id
    );
    const row = this.database.get<InboundChannelProgressRow>(
      "SELECT * FROM inbound_channel_progress WHERE id = ?",
      progressId
    );
    if (!row) {
      throw new Error(
        `Failed to record inbound channel progress: ${progressId}`
      );
    }
    return toProgressRecord(row);
  }

  listProgress(id: string, limit = 50): InboundChannelProgressRecord[] {
    const normalizedLimit = Math.max(1, Math.min(limit, 200));
    return this.database
      .all<InboundChannelProgressRow>(
        "SELECT * FROM inbound_channel_progress WHERE inbound_event_id = ? ORDER BY created_at DESC LIMIT ?",
        id,
        normalizedLimit
      )
      .map(toProgressRecord);
  }

  get(id: string): InboundChannelEventRecord | null {
    const row = this.database.get<InboundChannelEventRow>(
      "SELECT * FROM inbound_channel_events WHERE id = ?",
      id
    );
    return row ? this.withProgress(toRecord(row)) : null;
  }

  list(
    options: { channelId?: string; limit?: number } = {}
  ): InboundChannelEventRecord[] {
    const requestedLimit =
      typeof options.limit === "number" &&
      Number.isFinite(options.limit) &&
      Number.isInteger(options.limit)
        ? options.limit
        : 100;
    const limit = Math.max(1, Math.min(requestedLimit, 500));
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
    return rows.map((row) => this.withProgress(toRecord(row)));
  }

  summary(): {
    received: number;
    ignored: number;
    running: number;
    completed: number;
    failed: number;
    recentFailed: InboundChannelEventRecord[];
  } {
    const counts = {
      received: 0,
      ignored: 0,
      running: 0,
      completed: 0,
      failed: 0,
    };
    for (const row of this.database.all<{
      status: InboundChannelEventStatus;
      count: number;
    }>(
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
        .map((row) => this.withProgress(toRecord(row))),
    };
  }

  private findByProviderEvent(
    channelId: string,
    providerEventId: string
  ): InboundChannelEventRecord | null {
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
    patch: {
      sessionId?: string;
      runId?: string;
      outputText?: string;
      errorMessage?: string;
    } = {}
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

  private withProgress(
    record: InboundChannelEventRecord
  ): InboundChannelEventRecord {
    return {
      ...record,
      progress: this.listProgress(record.id),
    };
  }
}

export class InboundChannelRouter {
  private readonly channels: ChannelRegistry;
  private readonly store: InboundChannelEventStore;
  private readonly orchestration: OrchestrationService;

  constructor(
    channels: ChannelRegistry,
    store: InboundChannelEventStore,
    orchestration: OrchestrationService
  ) {
    this.channels = channels;
    this.store = store;
    this.orchestration = orchestration;
  }

  async routeSync(
    message: InboundChannelMessage,
    onEvent: (event: AgentRunEvent) => Promise<void> | void
  ): Promise<{
    record: InboundChannelEventRecord;
    events: AgentRunEvent[];
    result: { sessionId: string; runId: string; outputText: string };
  }> {
    this.requireEnabledChannel(message.channelId);
    const received = this.store.recordReceived(message);
    if (
      received.duplicate &&
      received.record.sessionId &&
      received.record.runId &&
      received.record.outputText !== undefined
    ) {
      return {
        record: received.record,
        events: [],
        result: {
          sessionId: received.record.sessionId,
          runId: received.record.runId,
          outputText: received.record.outputText,
        },
      };
    }
    if (received.duplicate && received.record.status === "running") {
      throw new HttpError(409, "Inbound channel event is already running");
    }
    const record = received.duplicate
      ? received.record
      : this.store.markRunning(received.record.id);
    const events: AgentRunEvent[] = [];
    try {
      const result = await this.orchestration.runCoordinator(
        {
          sessionId: message.sessionId,
          channelId: message.channelId,
          conversationId: message.conversationId,
          message: message.message,
          subagents: message.subagents,
          timeoutMs: message.timeoutMs,
        },
        async (event) => {
          events.push(event);
          await onEvent(event);
        }
      );
      const completed = this.store.markCompleted(record.id, result);
      return { record: completed, events, result };
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : "Inbound channel run failed";
      this.store.markFailed(record.id, messageText);
      throw error;
    }
  }

  routeAsync(
    message: InboundChannelMessage,
    callbacks: {
      beforeRun?: (record: InboundChannelEventRecord) => Promise<void> | void;
      onEvent?: (event: AgentRunEvent) => Promise<void> | void;
      onComplete?: (record: InboundChannelEventRecord) => Promise<void> | void;
      onFailure?: (record: InboundChannelEventRecord) => Promise<void> | void;
    } = {}
  ): {
    record: InboundChannelEventRecord;
    duplicate: boolean;
    completion: Promise<InboundChannelEventRecord>;
  } {
    this.requireEnabledChannel(message.channelId);
    const received = this.store.recordReceived(message);
    if (received.duplicate) {
      return {
        record: received.record,
        duplicate: true,
        completion: Promise.resolve(received.record),
      };
    }
    const running = this.store.markRunning(received.record.id);
    const completion = Promise.resolve().then(() =>
      this.runAsync(message, running.id, callbacks)
    );
    return { record: running, duplicate: false, completion };
  }

  private async runAsync(
    message: InboundChannelMessage,
    recordId: string,
    callbacks: {
      beforeRun?: (record: InboundChannelEventRecord) => Promise<void> | void;
      onEvent?: (event: AgentRunEvent) => Promise<void> | void;
      onComplete?: (record: InboundChannelEventRecord) => Promise<void> | void;
      onFailure?: (record: InboundChannelEventRecord) => Promise<void> | void;
    }
  ): Promise<InboundChannelEventRecord> {
    try {
      const current = this.store.get(recordId);
      if (current) {
        await runSideEffectCallback(() => callbacks.beforeRun?.(current));
      }
      const result = await this.orchestration.runCoordinator(
        {
          sessionId: message.sessionId,
          channelId: message.channelId,
          conversationId: message.conversationId,
          message: message.message,
          subagents: message.subagents,
          timeoutMs: message.timeoutMs,
        },
        async (event) => {
          await runSideEffectCallback(() => callbacks.onEvent?.(event));
        }
      );
      const completed = this.store.markCompleted(recordId, result);
      await runSideEffectCallback(() => callbacks.onComplete?.(completed));
      return completed;
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : "Inbound channel run failed";
      const failed = this.store.markFailed(recordId, messageText);
      await runSideEffectCallback(() => callbacks.onFailure?.(failed));
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

async function runSideEffectCallback(
  callback: () => Promise<void> | void | undefined
): Promise<void> {
  try {
    await callback();
  } catch {
    return;
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
    responseTarget: decodeJson<InboundResponseTarget | undefined>(
      row.response_target_json,
      undefined
    ),
    rawPayload: decodeJson<JsonValue>(row.raw_payload_json, null),
    status: row.status,
    sessionId: row.session_id ?? undefined,
    runId: row.run_id ?? undefined,
    outputText: row.output_text ?? undefined,
    errorMessage: row.error_message ?? undefined,
    progressState: row.progress_state ?? undefined,
    progressMessageTs: row.progress_message_ts ?? undefined,
    statusReaction: row.status_reaction ?? undefined,
    slackResponseMessageTs: row.slack_response_message_ts ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProgressRecord(
  row: InboundChannelProgressRow
): InboundChannelProgressRecord {
  return {
    id: row.id,
    inboundEventId: row.inbound_event_id,
    state: row.state,
    messageTs: row.message_ts ?? undefined,
    statusReaction: row.status_reaction ?? undefined,
    summary: row.summary,
    createdAt: row.created_at,
  };
}
