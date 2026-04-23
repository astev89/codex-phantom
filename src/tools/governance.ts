import type { AppDatabase } from "../platform/database.ts";
import { decodeJson } from "../platform/database.ts";

type DynamicToolRow = {
  id: string;
  description: string;
  scopes_json: string;
  input_schema_json: string | null;
  response_template: string;
  created_at: string;
  updated_at: string;
  approval_state: "pending" | "approved" | "rejected";
  approved_by: string | null;
  approved_at: string | null;
  governance_notes: string | null;
};

export type GovernedToolRecord = {
  id: string;
  description: string;
  scopes: string[];
  approvalState: "pending" | "approved" | "rejected";
  approvedBy?: string;
  approvedAt?: string;
  governanceNotes?: string;
  createdAt: string;
  updatedAt: string;
};

export class ToolGovernanceService {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  list(): GovernedToolRecord[] {
    return this.database
      .all<DynamicToolRow>(
        `
          SELECT
            id, description, scopes_json, input_schema_json, response_template, created_at, updated_at,
            approval_state, approved_by, approved_at, governance_notes
          FROM dynamic_tools
          ORDER BY updated_at DESC, id ASC
        `
      )
      .map(toGovernedToolRecord);
  }

  approve(toolId: string, approvedBy: string, notes?: string): GovernedToolRecord {
    const existing = this.database.get<DynamicToolRow>(
      `
        SELECT
          id, description, scopes_json, input_schema_json, response_template, created_at, updated_at,
          approval_state, approved_by, approved_at, governance_notes
        FROM dynamic_tools
        WHERE id = ?
      `,
      toolId
    );
    if (!existing) {
      throw new Error(`Unknown dynamic tool: ${toolId}`);
    }
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run(
        `
          UPDATE dynamic_tools
          SET approval_state = 'approved',
              approved_by = ?,
              approved_at = ?,
              governance_notes = ?,
              updated_at = ?
          WHERE id = ?
        `,
        approvedBy,
        now,
        notes ?? null,
        now,
        toolId
      );
      this.database.run(
        `
          INSERT INTO tool_governance_audit (tool_id, action, actor, notes, created_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        toolId,
        "approved",
        approvedBy,
        notes ?? null,
        now
      );
    });

    const updated = this.database.get<DynamicToolRow>(
      `
        SELECT
          id, description, scopes_json, input_schema_json, response_template, created_at, updated_at,
          approval_state, approved_by, approved_at, governance_notes
        FROM dynamic_tools
        WHERE id = ?
      `,
      toolId
    );
    if (!updated) {
      throw new Error(`Failed to approve tool: ${toolId}`);
    }
    return toGovernedToolRecord(updated);
  }

  summary(): { pendingDynamicTools: number; approvedDynamicTools: number; rejectedDynamicTools: number } {
    const rows = this.database.all<{ approval_state: "pending" | "approved" | "rejected"; count: number }>(
      `
        SELECT approval_state, COUNT(*) AS count
        FROM dynamic_tools
        GROUP BY approval_state
      `
    );
    const counts = new Map(rows.map((row) => [row.approval_state, row.count]));
    return {
      pendingDynamicTools: counts.get("pending") ?? 0,
      approvedDynamicTools: counts.get("approved") ?? 0,
      rejectedDynamicTools: counts.get("rejected") ?? 0
    };
  }
}

function toGovernedToolRecord(row: DynamicToolRow): GovernedToolRecord {
  return {
    id: row.id,
    description: row.description,
    scopes: decodeJson(row.scopes_json, ["read"]),
    approvalState: row.approval_state,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    governanceNotes: row.governance_notes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
