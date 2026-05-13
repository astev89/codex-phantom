import type { AppDatabase } from "../platform/database.ts";
import type { ChatAttachmentRecord } from "./session-store.ts";

export const MAX_ATTACHMENT_TEXT_INDEX_BYTES = 200_000;

type AttachmentTextIndexRow = {
  attachment_id: string;
  session_id: string;
  run_id: string | null;
  content_type: string;
  indexed_text: string | null;
  indexed_bytes: number;
  skipped_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type AttachmentTextIndexRecord = {
  attachmentId: string;
  sessionId: string;
  runId?: string;
  contentType: string;
  indexedText?: string;
  indexedBytes: number;
  skippedReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type AttachmentTextSearchResult = AttachmentTextIndexRecord & {
  name: string;
  sizeBytes: number;
  sha256?: string;
  downloadUrl?: string;
  excerpt: string;
};

type AttachmentTextSearchRow = AttachmentTextIndexRow & {
  name: string;
  size_bytes: number;
  sha256: string | null;
  storage_path: string | null;
};

export class AttachmentTextIndexStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  indexAttachment(
    attachment: ChatAttachmentRecord,
    content: Buffer
  ): AttachmentTextIndexRecord {
    const now = new Date().toISOString();
    const extracted = extractSearchableText(attachment.contentType, content);
    const record: AttachmentTextIndexRecord = {
      attachmentId: attachment.id,
      sessionId: attachment.sessionId,
      runId: attachment.runId,
      contentType: attachment.contentType,
      indexedText: extracted.text,
      indexedBytes: extracted.bytes,
      skippedReason: extracted.skippedReason,
      createdAt: now,
      updatedAt: now,
    };
    this.database.run(
      `
        INSERT INTO chat_attachment_text_index (
          attachment_id, session_id, run_id, content_type, indexed_text,
          indexed_bytes, skipped_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(attachment_id) DO UPDATE SET
          session_id = excluded.session_id,
          run_id = excluded.run_id,
          content_type = excluded.content_type,
          indexed_text = excluded.indexed_text,
          indexed_bytes = excluded.indexed_bytes,
          skipped_reason = excluded.skipped_reason,
          updated_at = excluded.updated_at
      `,
      record.attachmentId,
      record.sessionId,
      record.runId ?? null,
      record.contentType,
      record.indexedText ?? null,
      record.indexedBytes,
      record.skippedReason ?? null,
      record.createdAt,
      record.updatedAt
    );
    return record;
  }

  updateRunForAttachments(
    sessionId: string,
    runId: string,
    attachmentIds: string[]
  ): void {
    for (const attachmentId of attachmentIds) {
      this.database.run(
        "UPDATE chat_attachment_text_index SET run_id = ?, updated_at = ? WHERE attachment_id = ? AND session_id = ?",
        runId,
        new Date().toISOString(),
        attachmentId,
        sessionId
      );
    }
  }

  listForSession(sessionId: string): AttachmentTextIndexRecord[] {
    return this.database
      .all<AttachmentTextIndexRow>(
        "SELECT * FROM chat_attachment_text_index WHERE session_id = ? ORDER BY created_at ASC, attachment_id ASC",
        sessionId
      )
      .map(toIndexRecord);
  }

  list(limit = 250): AttachmentTextIndexRecord[] {
    return this.database
      .all<AttachmentTextIndexRow>(
        "SELECT * FROM chat_attachment_text_index ORDER BY created_at DESC LIMIT ?",
        limit
      )
      .map(toIndexRecord);
  }

  search(query: string, limit = 25): AttachmentTextSearchResult[] {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }
    const like = `%${escapeLike(normalized)}%`;
    return this.database
      .all<AttachmentTextSearchRow>(
        `
          SELECT
            idx.*,
            att.name,
            att.size_bytes,
            att.sha256,
            att.storage_path
          FROM chat_attachment_text_index idx
          JOIN chat_attachments att ON att.id = idx.attachment_id
          WHERE idx.indexed_text IS NOT NULL
            AND idx.indexed_text LIKE ? ESCAPE '\\'
          ORDER BY idx.updated_at DESC, idx.attachment_id ASC
          LIMIT ?
        `,
        like,
        Math.max(1, Math.min(limit, 100))
      )
      .map((row) => toSearchResult(row, normalized));
  }
}

function extractSearchableText(
  contentType: string,
  content: Buffer
): { text?: string; bytes: number; skippedReason?: string } {
  if (!isSafeTextContentType(contentType)) {
    return { bytes: 0, skippedReason: "unsafe_content_type" };
  }
  const bounded = content.subarray(0, MAX_ATTACHMENT_TEXT_INDEX_BYTES);
  const text = bounded.toString("utf8").replace(/\u0000/g, "");
  if (!text.trim()) {
    return { bytes: 0, skippedReason: "empty_text" };
  }
  return { text, bytes: bounded.byteLength };
}

function isSafeTextContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized.endsWith("+json") ||
    normalized === "application/markdown" ||
    normalized === "application/x-ndjson" ||
    normalized === "application/yaml" ||
    normalized === "application/x-yaml"
  );
}

function toIndexRecord(row: AttachmentTextIndexRow): AttachmentTextIndexRecord {
  return {
    attachmentId: row.attachment_id,
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    contentType: row.content_type,
    indexedText: row.indexed_text ?? undefined,
    indexedBytes: row.indexed_bytes,
    skippedReason: row.skipped_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSearchResult(
  row: AttachmentTextSearchRow,
  query: string
): AttachmentTextSearchResult {
  const record = toIndexRecord(row);
  return {
    ...record,
    name: row.name,
    sizeBytes: row.size_bytes,
    sha256: row.sha256 ?? undefined,
    downloadUrl: row.storage_path
      ? `/chat/attachments/${record.attachmentId}`
      : undefined,
    excerpt: excerpt(record.indexedText ?? "", query),
  };
}

function excerpt(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, index - 80);
  const end = Math.min(
    text.length,
    (index < 0 ? 0 : index) + query.length + 80
  );
  return text.slice(start, end);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
