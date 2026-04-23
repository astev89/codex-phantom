import type { AppDatabase } from "../platform/database.ts";

type RequestAuditRow = {
  request_id: string;
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  created_at: string;
};

export type RequestAuditRecord = {
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  createdAt: string;
};

export class RequestAuditStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  record(input: Omit<RequestAuditRecord, "createdAt">): RequestAuditRecord {
    const createdAt = new Date().toISOString();
    this.database.run(
      `
        INSERT OR REPLACE INTO request_audit_logs (
          request_id, method, path, status_code, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      input.requestId,
      input.method,
      input.path,
      input.statusCode,
      input.durationMs,
      createdAt
    );
    return { ...input, createdAt };
  }

  list(limit = 100): RequestAuditRecord[] {
    return this.database
      .all<RequestAuditRow>(
        `
          SELECT request_id, method, path, status_code, duration_ms, created_at
          FROM request_audit_logs
          ORDER BY created_at DESC
          LIMIT ?
        `,
        Math.max(1, Math.min(limit, 500))
      )
      .map((row) => ({
        requestId: row.request_id,
        method: row.method,
        path: row.path,
        statusCode: row.status_code,
        durationMs: row.duration_ms,
        createdAt: row.created_at
      }));
  }
}
