import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson, toJsonValue } from "../platform/database.ts";
import type { JsonValue, ToolCapabilityDescriptor } from "../shared/types.ts";
import { ToolRegistry } from "./registry.ts";

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

export type DynamicToolRecord = ToolCapabilityDescriptor & {
  responseTemplate: string;
  createdAt: string;
  updatedAt: string;
  approvalState: "pending" | "approved" | "rejected";
  approvedBy?: string;
  approvedAt?: string;
  governanceNotes?: string;
};

export type RegisterDynamicToolInput = {
  id: string;
  description: string;
  scopes?: string[];
  inputSchema?: JsonValue;
  responseTemplate: string;
};

export class DynamicToolRegistry {
  private readonly database: AppDatabase;
  private readonly tools: ToolRegistry;

  constructor(database: AppDatabase, tools: ToolRegistry) {
    this.database = database;
    this.tools = tools;
    this.loadPersistedTools();
  }

  list(): DynamicToolRecord[] {
    return this.database
      .all<DynamicToolRow>(
        `
          SELECT id, description, scopes_json, input_schema_json, response_template, created_at, updated_at
                 , approval_state, approved_by, approved_at, governance_notes
          FROM dynamic_tools
          ORDER BY updated_at DESC, id ASC
        `
      )
      .map((row) => toDynamicToolRecord(row));
  }

  get(id: string): DynamicToolRecord | null {
    const row = this.database.get<DynamicToolRow>(
      `
        SELECT id, description, scopes_json, input_schema_json, response_template, created_at, updated_at,
               approval_state, approved_by, approved_at, governance_notes
        FROM dynamic_tools
        WHERE id = ?
      `,
      id
    );
    return row ? toDynamicToolRecord(row) : null;
  }

  has(id: string): boolean {
    return this.tools.has(id) || this.get(id) !== null;
  }

  register(input: RegisterDynamicToolInput): DynamicToolRecord {
    const record = normalizeInput(input);
    const now = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO dynamic_tools (
          id, description, scopes_json, input_schema_json, response_template, created_at, updated_at,
          approval_state, approved_by, approved_at, governance_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          description = excluded.description,
          scopes_json = excluded.scopes_json,
          input_schema_json = excluded.input_schema_json,
          response_template = excluded.response_template,
          approval_state = 'pending',
          approved_by = NULL,
          approved_at = NULL,
          governance_notes = NULL,
          updated_at = excluded.updated_at
      `,
      record.id,
      record.description,
      encodeJson(record.scopes),
      record.inputSchema ? encodeJson(record.inputSchema) : null,
      record.responseTemplate,
      now,
      now,
      "pending",
      null,
      null,
      null
    );
    const stored = this.database.get<DynamicToolRow>(
      `
        SELECT id, description, scopes_json, input_schema_json, response_template, created_at, updated_at,
               approval_state, approved_by, approved_at, governance_notes
        FROM dynamic_tools
        WHERE id = ?
      `,
      record.id
    );
    if (!stored) {
      throw new Error(`Failed to persist dynamic tool ${record.id}`);
    }

    this.database.run(
      `
        INSERT INTO tool_governance_audit (tool_id, action, actor, notes, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      record.id,
      "submitted",
      "operator",
      "awaiting approval",
      now
    );

    if (stored.approval_state === "approved") {
      this.registerWithToolRegistry(stored);
    } else {
      this.tools.unregisterDynamic(stored.id);
    }
    return toDynamicToolRecord(stored);
  }

  registerApproved(
    input: RegisterDynamicToolInput,
    approval: { approvedBy: string; notes?: string }
  ): DynamicToolRecord {
    const record = normalizeInput(input);
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run(
        `
          INSERT INTO dynamic_tools (
            id, description, scopes_json, input_schema_json, response_template, created_at, updated_at,
            approval_state, approved_by, approved_at, governance_notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            description = excluded.description,
            scopes_json = excluded.scopes_json,
            input_schema_json = excluded.input_schema_json,
            response_template = excluded.response_template,
            approval_state = 'approved',
            approved_by = excluded.approved_by,
            approved_at = excluded.approved_at,
            governance_notes = excluded.governance_notes,
            updated_at = excluded.updated_at
        `,
        record.id,
        record.description,
        encodeJson(record.scopes),
        record.inputSchema ? encodeJson(record.inputSchema) : null,
        record.responseTemplate,
        now,
        now,
        "approved",
        approval.approvedBy,
        now,
        approval.notes ?? "approved internal tool bundle"
      );
      this.database.run(
        `
          INSERT INTO tool_governance_audit (tool_id, action, actor, notes, created_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        record.id,
        "approved",
        approval.approvedBy,
        approval.notes ?? "approved internal tool bundle",
        now
      );
    });
    const stored = this.database.get<DynamicToolRow>(
      `
        SELECT id, description, scopes_json, input_schema_json, response_template, created_at, updated_at,
               approval_state, approved_by, approved_at, governance_notes
        FROM dynamic_tools
        WHERE id = ?
      `,
      record.id
    );
    if (!stored) {
      throw new Error(`Failed to persist dynamic tool ${record.id}`);
    }
    this.registerWithToolRegistry(stored);
    return toDynamicToolRecord(stored);
  }

  unregister(id: string): boolean {
    if (!this.tools.unregisterDynamic(id)) {
      const existing = this.database.get<{ id: string }>(
        "SELECT id FROM dynamic_tools WHERE id = ?",
        id
      );
      if (!existing) {
        return false;
      }
    }

    this.database.run("DELETE FROM dynamic_tools WHERE id = ?", id);
    return true;
  }

  deactivate(id: string): boolean {
    return this.tools.unregisterDynamic(id);
  }

  activateApprovedTool(id: string): DynamicToolRecord {
    const stored = this.database.get<DynamicToolRow>(
      `
        SELECT id, description, scopes_json, input_schema_json, response_template, created_at, updated_at,
               approval_state, approved_by, approved_at, governance_notes
        FROM dynamic_tools
        WHERE id = ?
      `,
      id
    );
    if (!stored) {
      throw new Error(`Unknown dynamic tool: ${id}`);
    }
    if (stored.approval_state !== "approved") {
      throw new Error(`Dynamic tool ${id} is not approved`);
    }
    this.registerWithToolRegistry(stored);
    return toDynamicToolRecord(stored);
  }

  private loadPersistedTools(): void {
    for (const row of this.database.all<DynamicToolRow>(
      `
        SELECT id, description, scopes_json, input_schema_json, response_template, created_at, updated_at,
               approval_state, approved_by, approved_at, governance_notes
        FROM dynamic_tools
        ORDER BY updated_at DESC, id ASC
      `
    )) {
      if (row.approval_state === "approved") {
        this.registerWithToolRegistry(row);
      }
    }
  }

  private registerWithToolRegistry(row: DynamicToolRow): void {
    const record = toDynamicToolRecord(row);
    this.tools.registerDynamic({
      id: record.id,
      description: record.description,
      scopes: record.scopes,
      kind: "in_process",
      inputSchema: record.inputSchema,
      handler: async (input) => ({
        toolId: record.id,
        content: renderTemplate(record.responseTemplate, input),
        input: toJsonValue(input),
      }),
    });
  }
}

function toDynamicToolRecord(row: DynamicToolRow): DynamicToolRecord {
  return {
    id: row.id,
    description: row.description,
    scopes: decodeJson(row.scopes_json, ["read"]),
    kind: "in_process",
    inputSchema: row.input_schema_json
      ? decodeJson<JsonValue>(row.input_schema_json, {})
      : undefined,
    responseTemplate: row.response_template,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvalState: row.approval_state,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    governanceNotes: row.governance_notes ?? undefined,
  };
}

function normalizeInput(
  input: RegisterDynamicToolInput
): RegisterDynamicToolInput {
  const id = input.id.trim();
  if (!/^[a-z][a-z0-9._-]{1,99}$/.test(id)) {
    throw new Error(
      "id must start with a letter and contain only lowercase letters, numbers, dots, underscores, or dashes"
    );
  }

  const description = input.description.trim();
  if (!description) {
    throw new Error("description must be a non-empty string");
  }

  const responseTemplate = input.responseTemplate.trim();
  if (!responseTemplate) {
    throw new Error("responseTemplate must be a non-empty string");
  }

  const scopes =
    input.scopes && input.scopes.length > 0
      ? [...new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean))]
      : ["read"];
  if (scopes.length === 0 || scopes.some((scope) => scope === "write")) {
    throw new Error("dynamic tools currently support read-only scopes");
  }

  return {
    id,
    description,
    scopes,
    inputSchema: input.inputSchema,
    responseTemplate,
  };
}

function renderTemplate(template: string, input: JsonValue): string {
  const dictionary = toTemplateDictionary(input);
  return template.replaceAll(
    /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
    (_match, key: string) => {
      if (key === "json") {
        return JSON.stringify(input);
      }
      return dictionary[key] ?? "";
    }
  );
}

function toTemplateDictionary(input: JsonValue): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      stringifyTemplateValue(value),
    ])
  );
}

function stringifyTemplateValue(value: JsonValue): string {
  if (value === null) {
    return "";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}
