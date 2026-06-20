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

type PromptManagedFragmentRow = {
  id: string;
  fragment_text: string;
  active: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type PromptManagedFragmentRecord = {
  id: string;
  text: string;
  active: boolean;
};

const ROW_ID = "runtime";
const MAX_RUNTIME_GUIDANCE_CHARS = 2000;
const MAX_FRAGMENT_ID_CHARS = 80;
const MAX_FRAGMENT_TEXT_CHARS = 2000;

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

export class PromptManagedFragmentStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  get(id: string): PromptManagedFragmentRecord | null {
    const normalizedId = normalizePromptFragmentId(id);
    const row = this.database.get<PromptManagedFragmentRow>(
      "SELECT id, fragment_text, active, updated_by, created_at, updated_at FROM prompt_managed_fragments WHERE id = ?",
      normalizedId
    );
    return row ? toFragmentRecord(row) : null;
  }

  listActive(): PromptManagedFragmentRecord[] {
    return this.database
      .all<PromptManagedFragmentRow>(
        `SELECT id, fragment_text, active, updated_by, created_at, updated_at
         FROM prompt_managed_fragments
         WHERE active = 1
         ORDER BY id ASC`
      )
      .map(toFragmentRecord);
  }

  upsert(
    id: string,
    text: string,
    actor?: string
  ): PromptManagedFragmentRecord {
    const normalizedId = normalizePromptFragmentId(id);
    const normalizedText = normalizePromptFragmentText(text);
    const now = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO prompt_managed_fragments (id, fragment_text, active, updated_by, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          fragment_text = excluded.fragment_text,
          active = 1,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `,
      normalizedId,
      normalizedText,
      actor ?? null,
      now,
      now
    );
    return this.get(normalizedId) ?? {
      id: normalizedId,
      text: normalizedText,
      active: true,
    };
  }

  clear(id: string, actor?: string): PromptManagedFragmentRecord {
    const normalizedId = normalizePromptFragmentId(id);
    const before = this.get(normalizedId);
    const now = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO prompt_managed_fragments (id, fragment_text, active, updated_by, created_at, updated_at)
        VALUES (?, '', 0, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          active = 0,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `,
      normalizedId,
      actor ?? null,
      now,
      now
    );
    return this.get(normalizedId) ?? {
      id: normalizedId,
      text: before?.text ?? "",
      active: false,
    };
  }

  restoreInactive(
    id: string,
    text: string,
    actor?: string
  ): PromptManagedFragmentRecord {
    const normalizedId = normalizePromptFragmentId(id);
    const normalizedText = normalizePromptFragmentText(text, {
      allowEmpty: true,
    });
    const now = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO prompt_managed_fragments (id, fragment_text, active, updated_by, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          fragment_text = excluded.fragment_text,
          active = 0,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `,
      normalizedId,
      normalizedText,
      actor ?? null,
      now,
      now
    );
    return this.get(normalizedId) ?? {
      id: normalizedId,
      text: normalizedText,
      active: false,
    };
  }

  delete(id: string): void {
    this.database.run(
      "DELETE FROM prompt_managed_fragments WHERE id = ?",
      normalizePromptFragmentId(id)
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

export function normalizePromptFragmentId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("promptFragment.id must be a string");
  }
  const id = value.trim();
  if (!id) {
    throw new Error("promptFragment.id must be a non-empty string");
  }
  if (id.length > MAX_FRAGMENT_ID_CHARS) {
    throw new Error("promptFragment.id must be 80 characters or less");
  }
  return id;
}

export function normalizePromptFragmentText(
  value: unknown,
  options: { allowEmpty?: boolean } = {}
): string {
  if (typeof value !== "string") {
    throw new Error("promptFragment.text must be a string");
  }
  const text = value.trim();
  if (!text && options.allowEmpty !== true) {
    throw new Error("promptFragment.text must be a non-empty string");
  }
  if (text.length > MAX_FRAGMENT_TEXT_CHARS) {
    throw new Error("promptFragment.text must be 2000 characters or less");
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

function toFragmentRecord(
  row: PromptManagedFragmentRow
): PromptManagedFragmentRecord {
  return {
    id: row.id,
    text: row.fragment_text,
    active: row.active === 1,
  };
}
