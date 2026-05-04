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
  storage_path: string | null;
  sha256: string | null;
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
  storagePath?: string;
  sha256?: string;
  createdAt: string;
};

export type UploadedChatAttachmentInput = ChatAttachmentInput & {
  id: string;
  sessionId: string;
  runId?: string;
  storagePath: string;
  sha256: string;
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
            id, session_id, run_id, name, content_type, size_bytes, description, storage_path, sha256, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        record.id,
        record.sessionId,
        record.runId ?? null,
        record.name,
        record.contentType,
        record.sizeBytes,
        record.description ?? null,
        null,
        null,
        record.createdAt
      );
    }
    return records;
  }

  async recordUploadedAttachment(input: UploadedChatAttachmentInput): Promise<ChatAttachmentRecord> {
    const record: ChatAttachmentRecord = {
      id: input.id,
      sessionId: input.sessionId,
      runId: input.runId,
      name: input.name,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      description: input.description,
      storagePath: input.storagePath,
      sha256: input.sha256,
      createdAt: new Date().toISOString()
    };
    this.database.run(
      `
        INSERT INTO chat_attachments (
          id, session_id, run_id, name, content_type, size_bytes, description, storage_path, sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.id,
      record.sessionId,
      record.runId ?? null,
      record.name,
      record.contentType,
      record.sizeBytes,
      record.description ?? null,
      record.storagePath ?? null,
      record.sha256 ?? null,
      record.createdAt
    );
    return record;
  }

  async getAttachment(id: string): Promise<ChatAttachmentRecord | undefined> {
    const row = this.database.get<ChatAttachmentRow>("SELECT * FROM chat_attachments WHERE id = ?", id);
    return row ? toAttachmentRecord(row) : undefined;
  }

  async linkAttachmentsToRun(sessionId: string, runId: string, attachmentIds: string[]): Promise<ChatAttachmentRecord[]> {
    const records = await Promise.all(attachmentIds.map((id) => this.getAttachment(id)));
    if (records.some((record) => !record || record.sessionId !== sessionId)) {
      throw new Error("Attachment not found for chat session");
    }
    for (const id of attachmentIds) {
      this.database.run(
        "UPDATE chat_attachments SET run_id = ? WHERE id = ? AND session_id = ?",
        runId,
        id,
        sessionId
      );
    }
    return Promise.all(attachmentIds.map(async (id) => {
      const record = await this.getAttachment(id);
      if (!record) {
        throw new Error("Attachment not found for chat session");
      }
      return record;
    }));
  }

  async listAttachments(sessionId: string): Promise<ChatAttachmentRecord[]> {
    return this.database
      .all<ChatAttachmentRow>(
        "SELECT * FROM chat_attachments WHERE session_id = ? ORDER BY created_at ASC, id ASC",
        sessionId
      )
      .map(toAttachmentRecord);
  }

  async listStoredAttachments(limit = 250): Promise<ChatAttachmentRecord[]> {
    return this.database
      .all<ChatAttachmentRow>(
        "SELECT * FROM chat_attachments WHERE storage_path IS NOT NULL ORDER BY created_at DESC LIMIT ?",
        limit
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
    storagePath: row.storage_path ?? undefined,
    sha256: row.sha256 ?? undefined,
    createdAt: row.created_at
  };
}
