import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson } from "../platform/database.ts";
import type { JsonValue } from "../shared/types.ts";

export type ChatArtifactKind = "text" | "json" | "file";

type ChatArtifactRow = {
  id: string;
  session_id: string;
  run_id: string | null;
  title: string;
  kind: ChatArtifactKind;
  content_type: string;
  size_bytes: number;
  storage_path: string;
  sha256: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export type ChatArtifactRecord = {
  id: string;
  sessionId: string;
  runId?: string;
  title: string;
  kind: ChatArtifactKind;
  contentType: string;
  sizeBytes: number;
  storagePath: string;
  sha256: string;
  metadata: JsonValue;
  createdAt: string;
  updatedAt: string;
};

export type ChatArtifactCreateRecord = Omit<ChatArtifactRecord, "createdAt" | "updatedAt">;

export class ChatArtifactStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  async create(input: ChatArtifactCreateRecord): Promise<ChatArtifactRecord> {
    const now = new Date().toISOString();
    const record: ChatArtifactRecord = {
      ...input,
      createdAt: now,
      updatedAt: now
    };
    this.database.run(
      `
        INSERT INTO chat_artifacts (
          id, session_id, run_id, title, kind, content_type, size_bytes,
          storage_path, sha256, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.id,
      record.sessionId,
      record.runId ?? null,
      record.title,
      record.kind,
      record.contentType,
      record.sizeBytes,
      record.storagePath,
      record.sha256,
      encodeJson(record.metadata),
      record.createdAt,
      record.updatedAt
    );
    return record;
  }

  async get(id: string): Promise<ChatArtifactRecord | undefined> {
    const row = this.database.get<ChatArtifactRow>("SELECT * FROM chat_artifacts WHERE id = ?", id);
    return row ? toArtifactRecord(row) : undefined;
  }

  async listForSession(sessionId: string): Promise<ChatArtifactRecord[]> {
    return this.database
      .all<ChatArtifactRow>(
        "SELECT * FROM chat_artifacts WHERE session_id = ? ORDER BY created_at ASC, id ASC",
        sessionId
      )
      .map(toArtifactRecord);
  }

  async list(limit = 250): Promise<ChatArtifactRecord[]> {
    return this.database
      .all<ChatArtifactRow>(
        "SELECT * FROM chat_artifacts ORDER BY created_at DESC LIMIT ?",
        limit
      )
      .map(toArtifactRecord);
  }
}

function toArtifactRecord(row: ChatArtifactRow): ChatArtifactRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    title: row.title,
    kind: row.kind,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    storagePath: row.storage_path,
    sha256: row.sha256,
    metadata: decodeJson(row.metadata_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
