import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson } from "../platform/database.ts";
import type { SessionRecord } from "../shared/types.ts";

type SessionRow = {
  session_id: string;
  channel_id: string;
  conversation_id: string;
  provider_session_id: string | null;
  previous_response_id: string | null;
  last_event_cursor: string | null;
  resumability_json: string;
  created_at: string;
  updated_at: string;
  run_ids_json: string;
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
          session_id, channel_id, conversation_id, provider_session_id, previous_response_id,
          last_event_cursor, resumability_json, created_at, updated_at, run_ids_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          conversation_id = excluded.conversation_id,
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
      record.providerSessionId ?? null,
      record.previousResponseId ?? null,
      record.lastEventCursor ?? null,
      encodeJson(record.resumability),
      record.createdAt,
      record.updatedAt,
      encodeJson(record.runIds)
    );
  }
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    channelId: row.channel_id,
    conversationId: row.conversation_id,
    providerSessionId: row.provider_session_id ?? undefined,
    previousResponseId: row.previous_response_id ?? undefined,
    lastEventCursor: row.last_event_cursor ?? undefined,
    resumability: decodeJson(row.resumability_json, { supportsResume: false }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runIds: decodeJson(row.run_ids_json, [])
  };
}
