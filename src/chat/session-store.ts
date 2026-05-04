import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson } from "../platform/database.ts";
import { createId } from "../shared/ids.ts";
import type { SessionRecord } from "../shared/types.ts";

type SessionRow = {
  session_id: string;
  channel_id: string;
  conversation_id: string;
  title: string | null;
  title_source: "auto" | "manual" | null;
  provider_session_id: string | null;
  previous_response_id: string | null;
  last_event_cursor: string | null;
  resumability_json: string;
  created_at: string;
  updated_at: string;
  run_ids_json: string;
};

type ChatAttachmentRow = {
  id: string;
  session_id: string;
  run_id: string | null;
  name: string;
  content_type: string;
  size_bytes: number;
  description: string | null;
  created_at: string;
};

export type ChatAttachmentInput = {
  name: string;
  contentType: string;
  sizeBytes: number;
  description?: string;
};

export type ChatAttachmentRecord = ChatAttachmentInput & {
  id: string;
  sessionId: string;
  runId?: string;
  createdAt: string;
};

export class SessionStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  async list(): Promise<SessionRecord[]> {
    return this.database
      .all<SessionRow>("SELECT * FROM sessions ORDER BY updated_at DESC")
      .map((row) => toSessionRecord(row));
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    const row = this.database.get<SessionRow>("SELECT * FROM sessions WHERE session_id = ?", sessionId);
    return row ? toSessionRecord(row) : undefined;
  }

  async upsert(record: SessionRecord): Promise<void> {
    this.database.run(
      `
        INSERT INTO sessions (
          session_id, channel_id, conversation_id, title, title_source, provider_session_id, previous_response_id,
          last_event_cursor, resumability_json, created_at, updated_at, run_ids_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          conversation_id = excluded.conversation_id,
          title = COALESCE(excluded.title, sessions.title),
          title_source = COALESCE(excluded.title_source, sessions.title_source),
          provider_session_id = excluded.provider_session_id,
          previous_response_id = excluded.previous_response_id,
          last_event_cursor = excluded.last_event_cursor,
          resumability_json = excluded.resumability_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          run_ids_json = excluded.run_ids_json
      `,
      record.sessionId,
      record.channelId,
      record.conversationId,
      record.title ?? null,
      record.titleSource ?? null,
      record.providerSessionId ?? null,
      record.previousResponseId ?? null,
      record.lastEventCursor ?? null,
      encodeJson(record.resumability),
      record.createdAt,
      record.updatedAt,
      encodeJson(record.runIds)
    );
  }

  async rename(sessionId: string, title: string, source: "auto" | "manual" = "manual"): Promise<void> {
    this.database.run(
      "UPDATE sessions SET title = ?, title_source = ?, updated_at = ? WHERE session_id = ?",
      title,
      source,
      new Date().toISOString(),
      sessionId
    );
  }

  async recordAttachments(sessionId: string, runId: string | undefined, attachments: ChatAttachmentInput[]): Promise<ChatAttachmentRecord[]> {
    const now = new Date().toISOString();
    const records = attachments.map((attachment) => ({
      id: createId("att"),
      sessionId,
      runId,
      name: attachment.name,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      description: attachment.description,
      createdAt: now
    }));
    for (const record of records) {
      this.database.run(
        `
          INSERT INTO chat_attachments (
            id, session_id, run_id, name, content_type, size_bytes, description, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        record.id,
        record.sessionId,
        record.runId ?? null,
        record.name,
        record.contentType,
        record.sizeBytes,
        record.description ?? null,
        record.createdAt
      );
    }
    return records;
  }

  async listAttachments(sessionId: string): Promise<ChatAttachmentRecord[]> {
    return this.database
      .all<ChatAttachmentRow>(
        "SELECT * FROM chat_attachments WHERE session_id = ? ORDER BY created_at ASC, id ASC",
        sessionId
      )
      .map(toAttachmentRecord);
  }
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    channelId: row.channel_id,
    conversationId: row.conversation_id,
    title: row.title ?? undefined,
    titleSource: row.title_source ?? undefined,
    providerSessionId: row.provider_session_id ?? undefined,
    previousResponseId: row.previous_response_id ?? undefined,
    lastEventCursor: row.last_event_cursor ?? undefined,
    resumability: decodeJson(row.resumability_json, { supportsResume: false }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runIds: decodeJson(row.run_ids_json, [])
  };
}

function toAttachmentRecord(row: ChatAttachmentRow): ChatAttachmentRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    name: row.name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    description: row.description ?? undefined,
    createdAt: row.created_at
  };
}
