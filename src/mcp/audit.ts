import type { AppDatabase } from "../platform/database.ts";

export type McpAuditOutcome = "auth_failed" | "success" | "denied" | "failed" | "unsupported";

export type McpAuditInput = {
  requestId?: string;
  method: string;
  toolName?: string;
  outcome: McpAuditOutcome;
  statusCode: number;
  errorMessage?: string;
};

export type McpAuditRecord = McpAuditInput & {
  id: number;
  createdAt: string;
};

type McpAuditRow = {
  id: number;
  request_id: string | null;
  method: string;
  tool_name: string | null;
  outcome: McpAuditOutcome;
  status_code: number;
  error_message: string | null;
  created_at: string;
};

export class McpAuditStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  record(input: McpAuditInput): McpAuditRecord {
    const createdAt = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO mcp_audit_logs (
          request_id, method, tool_name, outcome, status_code, error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      input.requestId ?? null,
      input.method,
      input.toolName ?? null,
      input.outcome,
      input.statusCode,
      input.errorMessage ?? null,
      createdAt
    );

    const row = this.database.get<{ id: number }>("SELECT last_insert_rowid() AS id");
    return {
      id: row?.id ?? 0,
      ...input,
      createdAt
    };
  }

  list(limit = 50): McpAuditRecord[] {
    return this.database
      .all<McpAuditRow>(
        `
          SELECT id, request_id, method, tool_name, outcome, status_code, error_message, created_at
          FROM mcp_audit_logs
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
        Math.max(1, Math.min(limit, 250))
      )
      .map((row) => ({
        id: row.id,
        requestId: row.request_id ?? undefined,
        method: row.method,
        toolName: row.tool_name ?? undefined,
        outcome: row.outcome,
        statusCode: row.status_code,
        errorMessage: row.error_message ?? undefined,
        createdAt: row.created_at
      }));
  }
}
