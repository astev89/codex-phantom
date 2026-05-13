import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson, toJsonValue } from "../platform/database.ts";
import { createId } from "../shared/ids.ts";
import type { JsonValue } from "../shared/types.ts";

export type ToolBundleManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  tools: Array<{
    id: string;
    description: string;
    scopes?: string[];
    inputSchema?: JsonValue;
    responseTemplate: string;
    installation?: JsonValue;
  }>;
};

export type ToolBundleDiagnostic = {
  level: "error" | "warning" | "info";
  field: string;
  message: string;
};

export type ToolBundleImportRecord = {
  id: string;
  bundleId: string;
  name: string;
  version: string;
  manifest: JsonValue;
  status: "valid" | "invalid";
  diagnostics: ToolBundleDiagnostic[];
  importedBy: string;
  createdAt: string;
};

type ToolBundleImportRow = {
  id: string;
  bundle_id: string;
  name: string;
  version: string;
  manifest_json: string;
  status: "valid" | "invalid";
  diagnostics_json: string;
  imported_by: string;
  created_at: string;
};

export class ToolBundleImportStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  preview(input: {
    manifest: JsonValue;
    importedBy: string;
  }): ToolBundleImportRecord {
    const diagnostics = validateManifest(input.manifest);
    const manifest = normalizeManifestShape(input.manifest);
    const now = new Date().toISOString();
    const id = createId("tbi");
    const status = diagnostics.some((item) => item.level === "error")
      ? "invalid"
      : "valid";
    this.database.run(
      `
        INSERT INTO tool_bundle_imports (
          id, bundle_id, name, version, manifest_json, status,
          diagnostics_json, imported_by, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      id,
      manifest.id,
      manifest.name,
      manifest.version,
      encodeJson(input.manifest),
      status,
      encodeJson(diagnostics),
      requireText(input.importedBy, "importedBy"),
      now
    );
    return this.getRequired(id);
  }

  list(limit = 50): ToolBundleImportRecord[] {
    return this.database
      .all<ToolBundleImportRow>(
        `
          SELECT id, bundle_id, name, version, manifest_json, status,
                 diagnostics_json, imported_by, created_at
          FROM tool_bundle_imports
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
        Math.max(1, Math.min(limit, 200))
      )
      .map(toImportRecord);
  }

  summary(): {
    valid: number;
    invalid: number;
    recent: ToolBundleImportRecord[];
  } {
    const rows = this.database.all<{
      status: "valid" | "invalid";
      count: number;
    }>(
      `
        SELECT status, COUNT(*) AS count
        FROM tool_bundle_imports
        GROUP BY status
      `
    );
    const counts = new Map(rows.map((row) => [row.status, row.count]));
    return {
      valid: counts.get("valid") ?? 0,
      invalid: counts.get("invalid") ?? 0,
      recent: this.list(5),
    };
  }

  private getRequired(id: string): ToolBundleImportRecord {
    const row = this.database.get<ToolBundleImportRow>(
      `
        SELECT id, bundle_id, name, version, manifest_json, status,
               diagnostics_json, imported_by, created_at
        FROM tool_bundle_imports
        WHERE id = ?
      `,
      id
    );
    if (!row) {
      throw new Error(`Failed to record tool bundle import: ${id}`);
    }
    return toImportRecord(row);
  }
}

function validateManifest(input: JsonValue): ToolBundleDiagnostic[] {
  const diagnostics: ToolBundleDiagnostic[] = [];
  if (!isJsonObject(input)) {
    return [
      {
        level: "error",
        field: "manifest",
        message: "manifest must be a JSON object",
      },
    ];
  }
  const manifest = input;
  validateId(manifest.id, "id", diagnostics);
  requireManifestText(manifest.name, "name", diagnostics);
  requireManifestText(manifest.version, "version", diagnostics);
  if (!Array.isArray(manifest.tools)) {
    diagnostics.push({
      level: "error",
      field: "tools",
      message: "tools must be an array",
    });
    return diagnostics;
  }
  if (manifest.tools.length === 0 || manifest.tools.length > 20) {
    diagnostics.push({
      level: "error",
      field: "tools",
      message: "tools must contain between 1 and 20 items",
    });
  }
  const seen = new Set<string>();
  manifest.tools.forEach((item, index) => {
    const field = `tools[${index}]`;
    if (!isJsonObject(item)) {
      diagnostics.push({
        level: "error",
        field,
        message: "tool must be a JSON object",
      });
      return;
    }
    validateId(item.id, `${field}.id`, diagnostics);
    if (typeof item.id === "string") {
      if (seen.has(item.id)) {
        diagnostics.push({
          level: "error",
          field: `${field}.id`,
          message: "tool ids must be unique",
        });
      }
      seen.add(item.id);
    }
    requireManifestText(item.description, `${field}.description`, diagnostics);
    requireManifestText(
      item.responseTemplate,
      `${field}.responseTemplate`,
      diagnostics
    );
    const scopes = item.scopes === undefined ? ["read"] : item.scopes;
    if (
      !Array.isArray(scopes) ||
      scopes.some((scope) => typeof scope !== "string")
    ) {
      diagnostics.push({
        level: "error",
        field: `${field}.scopes`,
        message: "scopes must be strings",
      });
    } else if (
      (scopes as string[]).some((scope) =>
        ["write", "admin", "full_access"].includes(scope)
      )
    ) {
      diagnostics.push({
        level: "error",
        field: `${field}.scopes`,
        message: "bundle preview only accepts read-only tool scopes",
      });
    }
    if (item.installation !== undefined) {
      diagnostics.push({
        level: "warning",
        field: `${field}.installation`,
        message: "installation requirements are recorded but not executed",
      });
    }
  });
  if (!diagnostics.some((item) => item.level === "error")) {
    diagnostics.push({
      level: "info",
      field: "manifest",
      message: "bundle preview is valid and awaits governance approval",
    });
  }
  return diagnostics;
}

function normalizeManifestShape(input: JsonValue): {
  id: string;
  name: string;
  version: string;
} {
  if (!isJsonObject(input)) {
    return { id: "invalid", name: "Invalid bundle", version: "invalid" };
  }
  return {
    id:
      typeof input.id === "string" && input.id.trim()
        ? input.id.trim()
        : "invalid",
    name:
      typeof input.name === "string" && input.name.trim()
        ? input.name.trim()
        : "Invalid bundle",
    version:
      typeof input.version === "string" && input.version.trim()
        ? input.version.trim()
        : "invalid",
  };
}

function validateId(
  value: JsonValue | undefined,
  field: string,
  diagnostics: ToolBundleDiagnostic[]
): void {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{1,99}$/.test(value)) {
    diagnostics.push({
      level: "error",
      field,
      message:
        "id must start with a letter and contain lowercase letters, numbers, dots, underscores, or dashes",
    });
  }
}

function requireManifestText(
  value: JsonValue | undefined,
  field: string,
  diagnostics: ToolBundleDiagnostic[]
): void {
  if (typeof value !== "string" || value.trim() === "") {
    diagnostics.push({
      level: "error",
      field,
      message: "must be a non-empty string",
    });
  }
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function isJsonObject(value: JsonValue | undefined): value is {
  [key: string]: JsonValue;
} {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function toImportRecord(row: ToolBundleImportRow): ToolBundleImportRecord {
  return {
    id: row.id,
    bundleId: row.bundle_id,
    name: row.name,
    version: row.version,
    manifest: decodeJson(row.manifest_json, {}),
    status: row.status,
    diagnostics: decodeJson(row.diagnostics_json, []),
    importedBy: row.imported_by,
    createdAt: row.created_at,
  };
}
