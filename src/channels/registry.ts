import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson } from "../platform/database.ts";
import {
  runtimeChannelDefinitions,
  runtimeChannelEnvPresent,
} from "./capabilities.ts";

type ChannelRow = {
  id: string;
  kind: string;
  display_name: string;
  description: string;
  enabled: number;
  secret_env_var: string | null;
  webhook_path: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
};

export type ChannelRecord = {
  id: string;
  kind: string;
  displayName: string;
  description: string;
  enabled: boolean;
  secretEnvVar?: string;
  secretPresent: boolean;
  webhookPath?: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export class ChannelRegistry {
  private readonly database: AppDatabase;
  private readonly config: AppConfig;

  constructor(database: AppDatabase, config: AppConfig) {
    this.database = database;
    this.config = config;
    this.seedDefaults();
  }

  list(): ChannelRecord[] {
    return this.database
      .all<ChannelRow>(
        `
          SELECT
            id, kind, display_name, description, enabled, secret_env_var, webhook_path,
            config_json, created_at, updated_at
          FROM channels
          ORDER BY id ASC
        `
      )
      .map((row) => this.toChannelRecord(row));
  }

  get(id: string): ChannelRecord | null {
    const row = this.database.get<ChannelRow>(
      `
        SELECT
          id, kind, display_name, description, enabled, secret_env_var, webhook_path,
          config_json, created_at, updated_at
        FROM channels
        WHERE id = ?
      `,
      id
    );
    return row ? this.toChannelRecord(row) : null;
  }

  upsert(input: { id: string; enabled: boolean }): ChannelRecord {
    const existing = this.database.get<ChannelRow>(
      `
        SELECT
          id, kind, display_name, description, enabled, secret_env_var, webhook_path,
          config_json, created_at, updated_at
        FROM channels
        WHERE id = ?
      `,
      input.id
    );
    if (!existing) {
      throw new Error(`Unknown channel: ${input.id}`);
    }
    const now = new Date().toISOString();
    this.database.run(
      "UPDATE channels SET enabled = ?, updated_at = ? WHERE id = ?",
      input.enabled ? 1 : 0,
      now,
      input.id
    );
    const updated = this.database.get<ChannelRow>(
      `
        SELECT
          id, kind, display_name, description, enabled, secret_env_var, webhook_path,
          config_json, created_at, updated_at
        FROM channels
        WHERE id = ?
      `,
      input.id
    );
    if (!updated) {
      throw new Error(`Failed to update channel: ${input.id}`);
    }
    return this.toChannelRecord(updated);
  }

  summary(): {
    configured: number;
    enabled: number;
    channels: ChannelRecord[];
  } {
    const channels = this.list();
    return {
      configured: channels.filter(
        (channel) => channel.secretPresent || !channel.secretEnvVar
      ).length,
      enabled: channels.filter((channel) => channel.enabled).length,
      channels,
    };
  }

  private seedDefaults(): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      for (const channel of runtimeChannelDefinitions()) {
        this.database.run(
          `
            INSERT INTO channels (
              id, kind, display_name, description, enabled, secret_env_var, webhook_path, config_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              kind = excluded.kind,
              display_name = excluded.display_name,
              description = excluded.description,
              secret_env_var = excluded.secret_env_var,
              webhook_path = excluded.webhook_path,
              config_json = excluded.config_json,
              updated_at = excluded.updated_at
          `,
          channel.id,
          channel.kind,
          channel.displayName,
          channel.description,
          channel.enabled ? 1 : 0,
          channel.secretEnvVar ?? null,
          channel.webhookPath ?? null,
          encodeJson(channel.config),
          now,
          now
        );
      }
    });
  }

  private toChannelRecord(row: ChannelRow): ChannelRecord {
    const config = decodeJson<Record<string, unknown>>(row.config_json, {});
    const requiredSecrets = stringArrayValue(config.requiredSecretEnvVars);
    return {
      id: row.id,
      kind: row.kind,
      displayName: row.display_name,
      description: row.description,
      enabled: row.enabled === 1,
      secretEnvVar: row.secret_env_var ?? undefined,
      secretPresent:
        requiredSecrets.length > 0
          ? requiredSecrets.every((secretEnvVar) =>
              runtimeChannelEnvPresent(this.config, secretEnvVar)
            )
          : row.secret_env_var
            ? runtimeChannelEnvPresent(this.config, row.secret_env_var)
            : true,
      webhookPath: row.webhook_path ?? undefined,
      config,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}
