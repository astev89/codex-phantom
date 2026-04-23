import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson } from "../platform/database.ts";

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

const DEFAULT_CHANNELS = [
  {
    id: "web",
    kind: "operator_ui",
    displayName: "Web Console",
    description: "Direct operator chat surface served by the local HTTP console.",
    enabled: true,
    config: { transport: "http" }
  },
  {
    id: "webhook",
    kind: "webhook",
    displayName: "Webhook",
    description: "Inbound signed webhook channel for external integrations.",
    enabled: true,
    secretEnvVar: "EXTERNAL_CHANNEL_SECRET",
    webhookPath: "/channels/webhook",
    config: { transport: "http" }
  },
  {
    id: "scheduler",
    kind: "internal",
    displayName: "Scheduler",
    description: "Internal scheduled jobs that enqueue coordinator runs.",
    enabled: true,
    config: { transport: "internal" }
  },
  {
    id: "slack",
    kind: "external_chat",
    displayName: "Slack",
    description: "Planned external channel with operator-controlled enablement and secret checks.",
    enabled: false,
    secretEnvVar: "SLACK_BOT_TOKEN",
    config: { transport: "slack", status: "planned" }
  }
] as Array<{
  id: string;
  kind: string;
  displayName: string;
  description: string;
  enabled: boolean;
  secretEnvVar?: string;
  webhookPath?: string;
  config: Record<string, unknown>;
}>;

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
      .map((row) => toChannelRecord(row));
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
    this.database.run("UPDATE channels SET enabled = ?, updated_at = ? WHERE id = ?", input.enabled ? 1 : 0, now, input.id);
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
    return toChannelRecord(updated);
  }

  summary(): { configured: number; enabled: number; channels: ChannelRecord[] } {
    const channels = this.list();
    return {
      configured: channels.filter((channel) => channel.secretPresent || !channel.secretEnvVar).length,
      enabled: channels.filter((channel) => channel.enabled).length,
      channels
    };
  }

  private seedDefaults(): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      for (const channel of DEFAULT_CHANNELS) {
        this.database.run(
          `
            INSERT INTO channels (
              id, kind, display_name, description, enabled, secret_env_var, webhook_path, config_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
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
}

function toChannelRecord(row: ChannelRow): ChannelRecord {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    description: row.description,
    enabled: row.enabled === 1,
    secretEnvVar: row.secret_env_var ?? undefined,
    secretPresent: row.secret_env_var ? Boolean(process.env[row.secret_env_var]) : true,
    webhookPath: row.webhook_path ?? undefined,
    config: decodeJson<Record<string, unknown>>(row.config_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
