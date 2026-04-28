import type { JsonValue } from "../shared/types.ts";

export type OperatorExportFormat = "json" | "ndjson";
export type OperatorExportScope = "requests" | "runs" | "channels" | "governance" | "mcp" | (string & {});
export type OperatorExportRecord = { [key: string]: JsonValue };
export type OperatorExportMetadata = Record<string, JsonValue>;

type OperatorExportOptions<T extends OperatorExportRecord> = {
  scope: OperatorExportScope;
  items: readonly T[];
  exportedAt?: string;
  meta?: OperatorExportMetadata;
};

type OperatorExportBase = {
  scope: OperatorExportScope;
  exportedAt: string;
  count: number;
  meta?: OperatorExportMetadata;
};

export type JsonExportPayload<T extends OperatorExportRecord> = OperatorExportBase & {
  format: "json";
  items: T[];
};

export type NdjsonExportPayload = OperatorExportBase & {
  format: "ndjson";
  body: string;
};

export type OperatorExportPayload<T extends OperatorExportRecord> = JsonExportPayload<T> | NdjsonExportPayload;

export function buildJsonExport<T extends OperatorExportRecord>(
  options: OperatorExportOptions<T>
): JsonExportPayload<T> {
  const items = [...options.items];

  return {
    scope: options.scope,
    format: "json",
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    count: items.length,
    meta: options.meta,
    items
  };
}

export function buildNdjsonExport<T extends OperatorExportRecord>(
  options: OperatorExportOptions<T>
): NdjsonExportPayload {
  const items = [...options.items];

  return {
    scope: options.scope,
    format: "ndjson",
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    count: items.length,
    meta: options.meta,
    body: items.map((item) => JSON.stringify(item)).join("\n")
  };
}

export function buildOperatorExport<T extends OperatorExportRecord>(
  format: OperatorExportFormat,
  options: OperatorExportOptions<T>
): OperatorExportPayload<T> {
  return format === "json" ? buildJsonExport(options) : buildNdjsonExport(options);
}
