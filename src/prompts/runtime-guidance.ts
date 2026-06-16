import type { AppDatabase } from "../platform/database.ts";

type PromptRuntimeGuidanceRow = {
  id: string;
  guidance_text: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type PromptRuntimeGuidanceRecord = {
  id: "runtime";
  text: string;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

const ROW_ID = "runtime";
const MAX_RUNTIME_GUIDANCE_CHARS = 2000;

export class PromptRuntimeGuidanceStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
    this.seedDefault();
  }

  get(): PromptRuntimeGuidanceRecord {
    const row = this.database.get<PromptRuntimeGuidanceRow>(
      "SELECT id, guidance_text, updated_by, created_at, updated_at FROM prompt_runtime_guidance WHERE id = ?",
      ROW_ID
    );
    if (!row) {
      this.seedDefault();
      return this.get();
    }
    return toRecord(row);
  }

  update(text: string, actor?: string): PromptRuntimeGuidanceRecord {
    const normalized = normalizeRuntimeGuidanceText(text, { allowEmpty: true });
    const now = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO prompt_runtime_guidance (id, guidance_text, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          guidance_text = excluded.guidance_text,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `,
      ROW_ID,
      normalized,
      actor ?? null,
      now,
      now
    );
    return this.get();
  }

  private seedDefault(): void {
    const now = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO prompt_runtime_guidance (id, guidance_text, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `,
      ROW_ID,
      "",
      null,
      now,
      now
    );
  }
}

export function normalizeRuntimeGuidanceText(
  value: unknown,
  options: { allowEmpty?: boolean } = {}
): string {
  if (typeof value !== "string") {
    throw new Error("runtimeGuidance.text must be a string");
  }
  const text = value.trim();
  if (!text && options.allowEmpty !== true) {
    throw new Error("runtimeGuidance.text must be a non-empty string");
  }
  if (text.length > MAX_RUNTIME_GUIDANCE_CHARS) {
    throw new Error("runtimeGuidance.text must be 2000 characters or less");
  }
  return text;
}

function toRecord(row: PromptRuntimeGuidanceRow): PromptRuntimeGuidanceRecord {
  return {
    id: "runtime",
    text: row.guidance_text,
    updatedBy: row.updated_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
