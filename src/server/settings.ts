import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson } from "../platform/database.ts";

type SettingsRow = {
  id: string;
  settings_json: string;
  created_at: string;
  updated_at: string;
};

export type OperatorSettings = {
  dashboardRefreshSeconds: number;
  chatDefaultConversationId: string;
  memoryTimelineLimit: number;
};

const SETTINGS_ROW_ID = "operator";

const DEFAULT_SETTINGS: OperatorSettings = {
  dashboardRefreshSeconds: 5,
  chatDefaultConversationId: "operator-console",
  memoryTimelineLimit: 20
};

export class OperatorSettingsStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
    this.seedDefaults();
  }

  get(): OperatorSettings {
    const row = this.database.get<SettingsRow>(
      "SELECT id, settings_json, created_at, updated_at FROM operator_settings WHERE id = ?",
      SETTINGS_ROW_ID
    );
    return row ? normalizeSettings(decodeJson(row.settings_json, DEFAULT_SETTINGS)) : DEFAULT_SETTINGS;
  }

  update(partial: Partial<OperatorSettings>): OperatorSettings {
    const next = normalizeSettings({ ...this.get(), ...partial });
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE operator_settings
        SET settings_json = ?, updated_at = ?
        WHERE id = ?
      `,
      encodeJson(next),
      now,
      SETTINGS_ROW_ID
    );
    return next;
  }

  private seedDefaults(): void {
    const now = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO operator_settings (id, settings_json, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `,
      SETTINGS_ROW_ID,
      encodeJson(DEFAULT_SETTINGS),
      now,
      now
    );
  }
}

function normalizeSettings(value: Partial<OperatorSettings>): OperatorSettings {
  return {
    dashboardRefreshSeconds: clampInteger(value.dashboardRefreshSeconds, DEFAULT_SETTINGS.dashboardRefreshSeconds, 1, 120),
    chatDefaultConversationId:
      typeof value.chatDefaultConversationId === "string" && value.chatDefaultConversationId.trim() !== ""
        ? value.chatDefaultConversationId.trim()
        : DEFAULT_SETTINGS.chatDefaultConversationId,
    memoryTimelineLimit: clampInteger(value.memoryTimelineLimit, DEFAULT_SETTINGS.memoryTimelineLimit, 1, 100)
  };
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, value));
}
