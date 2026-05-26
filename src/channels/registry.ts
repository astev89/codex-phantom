import { hasConfiguredValue, type AppConfig } from "../config.ts";
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
    description:
      "Direct operator chat surface served by the local HTTP console.",
    enabled: true,
    config: { transport: "http" },
  },
  {
    id: "webhook",
    kind: "webhook",
    displayName: "Webhook",
    description: "Inbound signed webhook channel for external integrations.",
    enabled: true,
    secretEnvVar: "EXTERNAL_CHANNEL_SECRET",
    webhookPath: "/channels/webhook",
    config: { transport: "http" },
  },
  {
    id: "scheduler",
    kind: "internal",
    displayName: "Scheduler",
    description: "Internal scheduled jobs that enqueue coordinator runs.",
    enabled: true,
    config: { transport: "internal" },
  },
  {
    id: "slack",
    kind: "external_chat",
    displayName: "Slack",
    description:
      "Slack channel with outbound delivery and signed inbound Events API ingestion.",
    enabled: false,
    secretEnvVar: "SLACK_BOT_TOKEN",
    config: {
      transport: "slack",
      status: "available",
      requiredSecretEnvVars: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
      optionalSecretEnvVars: ["SLACK_BOT_USER_ID"],
    },
  },
  {
    id: "email",
    kind: "external_chat",
    displayName: "Email",
    description: "Email channel with bounded IMAP polling and SMTP replies.",
    enabled: false,
    secretEnvVar: "EMAIL_IMAP_PASSWORD",
    config: {
      transport: "email",
      status: "available",
      requiredSecretEnvVars: [
        "EMAIL_IMAP_HOST",
        "EMAIL_IMAP_USERNAME",
        "EMAIL_IMAP_PASSWORD",
        "EMAIL_SMTP_HOST",
        "EMAIL_SMTP_USERNAME",
        "EMAIL_SMTP_PASSWORD",
        "EMAIL_FROM_ADDRESS",
      ],
      optionalSecretEnvVars: ["EMAIL_FROM_NAME"],
    },
  },
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
      for (const channel of DEFAULT_CHANNELS) {
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
              this.resolveSecretPresence(secretEnvVar)
            )
          : row.secret_env_var
            ? this.resolveSecretPresence(row.secret_env_var)
            : true,
      webhookPath: row.webhook_path ?? undefined,
      config,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private resolveSecretPresence(secretEnvVar: string): boolean {
    switch (secretEnvVar) {
      case "SLACK_BOT_TOKEN":
        return Boolean(this.config.slackBotToken);
      case "SLACK_APP_TOKEN":
        return Boolean(this.config.slackAppToken);
      case "SLACK_SIGNING_SECRET":
        return Boolean(this.config.slackSigningSecret);
      case "SLACK_BOT_USER_ID":
        return Boolean(this.config.slackBotUserId);
      case "EMAIL_IMAP_HOST":
        return hasConfiguredValue(this.config.emailImapHost);
      case "EMAIL_IMAP_USERNAME":
        return hasConfiguredValue(this.config.emailImapUsername);
      case "EMAIL_IMAP_PASSWORD":
        return hasConfiguredValue(this.config.emailImapPassword);
      case "EMAIL_SMTP_HOST":
        return hasConfiguredValue(this.config.emailSmtpHost);
      case "EMAIL_SMTP_USERNAME":
        return hasConfiguredValue(this.config.emailSmtpUsername);
      case "EMAIL_SMTP_PASSWORD":
        return hasConfiguredValue(this.config.emailSmtpPassword);
      case "EMAIL_FROM_ADDRESS":
        return hasConfiguredValue(this.config.emailFromAddress);
      case "EMAIL_FROM_NAME":
        return hasConfiguredValue(this.config.emailFromName);
      case "EXTERNAL_CHANNEL_SECRET":
        return Boolean(this.config.externalChannelSecret);
      default:
        return Boolean(process.env[secretEnvVar]);
    }
  }
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}
