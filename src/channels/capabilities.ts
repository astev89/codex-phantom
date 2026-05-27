import {
  emailConfigComplete,
  hasConfiguredValue,
  type AppConfig,
} from "../config.ts";
import type { ChannelRecord } from "./registry.ts";
import type { EmailChannelStatus } from "./email.ts";

export type RuntimeChannelId =
  | "web"
  | "webhook"
  | "scheduler"
  | "slack"
  | "email";

export type RuntimeChannelDefinition = {
  id: RuntimeChannelId;
  kind: string;
  displayName: string;
  description: string;
  enabled: boolean;
  secretEnvVar?: string;
  webhookPath?: string;
  config: Record<string, unknown>;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  configComplete(config: AppConfig): boolean;
};

export type RuntimeChannelLifecycle = {
  start(): Promise<void>;
  stop(): Promise<void>;
  status?(): EmailChannelStatus;
};

const EMAIL_REQUIRED_ENV_VARS = [
  "EMAIL_IMAP_HOST",
  "EMAIL_IMAP_USERNAME",
  "EMAIL_IMAP_PASSWORD",
  "EMAIL_SMTP_HOST",
  "EMAIL_SMTP_USERNAME",
  "EMAIL_SMTP_PASSWORD",
  "EMAIL_FROM_ADDRESS",
];

export const RUNTIME_CHANNEL_DEFINITIONS: RuntimeChannelDefinition[] = [
  {
    id: "web",
    kind: "operator_ui",
    displayName: "Web Console",
    description:
      "Direct operator chat surface served by the local HTTP console.",
    enabled: true,
    config: { transport: "http" },
    requiredEnvVars: [],
    optionalEnvVars: [],
    configComplete: () => true,
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
    requiredEnvVars: ["EXTERNAL_CHANNEL_SECRET"],
    optionalEnvVars: [],
    configComplete: (config) =>
      hasConfiguredValue(config.externalChannelSecret),
  },
  {
    id: "scheduler",
    kind: "internal",
    displayName: "Scheduler",
    description: "Internal scheduled jobs that enqueue coordinator runs.",
    enabled: true,
    config: { transport: "internal" },
    requiredEnvVars: [],
    optionalEnvVars: [],
    configComplete: () => true,
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
    requiredEnvVars: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
    optionalEnvVars: ["SLACK_BOT_USER_ID"],
    configComplete: (config) =>
      hasConfiguredValue(config.slackBotToken) &&
      hasConfiguredValue(config.slackSigningSecret),
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
      requiredSecretEnvVars: EMAIL_REQUIRED_ENV_VARS,
      optionalSecretEnvVars: ["EMAIL_FROM_NAME"],
    },
    requiredEnvVars: EMAIL_REQUIRED_ENV_VARS,
    optionalEnvVars: ["EMAIL_FROM_NAME"],
    configComplete: emailConfigComplete,
  },
];

export class RuntimeChannelCapabilities {
  private readonly lifecycles = new Map<string, RuntimeChannelLifecycle>();

  registerLifecycle(
    channelId: RuntimeChannelId,
    lifecycle: RuntimeChannelLifecycle
  ): void {
    this.lifecycles.set(channelId, lifecycle);
  }

  async applyRuntimeState(channelId: string, enabled: boolean): Promise<void> {
    const lifecycle = this.lifecycles.get(channelId);
    if (!lifecycle) {
      return;
    }
    if (enabled) {
      await lifecycle.start();
      return;
    }
    await lifecycle.stop();
  }

  emailStatus(): EmailChannelStatus | undefined {
    return this.lifecycles.get("email")?.status?.();
  }
}

export function runtimeChannelDefinitions(): RuntimeChannelDefinition[] {
  return RUNTIME_CHANNEL_DEFINITIONS;
}

export function runtimeChannelDefinition(
  channelId: string
): RuntimeChannelDefinition | undefined {
  return RUNTIME_CHANNEL_DEFINITIONS.find(
    (definition) => definition.id === channelId
  );
}

export function requiredEnvVarsForChannel(channel: ChannelRecord): string[] {
  return runtimeChannelDefinition(channel.id)?.requiredEnvVars ?? [];
}

export function missingRequiredEnvVarsForChannel(
  config: AppConfig,
  channel: ChannelRecord
): string[] {
  const definition = runtimeChannelDefinition(channel.id);
  if (!definition || !channel.enabled || definition.configComplete(config)) {
    return [];
  }
  return definition.requiredEnvVars.filter(
    (envVar) => !runtimeChannelEnvPresent(config, envVar)
  );
}

export function runtimeChannelConfigComplete(
  config: AppConfig,
  channelId: string
): boolean {
  return runtimeChannelDefinition(channelId)?.configComplete(config) ?? true;
}

export function runtimeChannelEnvPresent(
  config: AppConfig,
  envVar: string
): boolean {
  switch (envVar) {
    case "SLACK_BOT_TOKEN":
      return hasConfiguredValue(config.slackBotToken);
    case "SLACK_APP_TOKEN":
      return hasConfiguredValue(config.slackAppToken);
    case "SLACK_SIGNING_SECRET":
      return hasConfiguredValue(config.slackSigningSecret);
    case "SLACK_BOT_USER_ID":
      return hasConfiguredValue(config.slackBotUserId);
    case "EMAIL_IMAP_HOST":
      return hasConfiguredValue(config.emailImapHost);
    case "EMAIL_IMAP_USERNAME":
      return hasConfiguredValue(config.emailImapUsername);
    case "EMAIL_IMAP_PASSWORD":
      return hasConfiguredValue(config.emailImapPassword);
    case "EMAIL_SMTP_HOST":
      return hasConfiguredValue(config.emailSmtpHost);
    case "EMAIL_SMTP_USERNAME":
      return hasConfiguredValue(config.emailSmtpUsername);
    case "EMAIL_SMTP_PASSWORD":
      return hasConfiguredValue(config.emailSmtpPassword);
    case "EMAIL_FROM_ADDRESS":
      return hasConfiguredValue(config.emailFromAddress);
    case "EMAIL_FROM_NAME":
      return hasConfiguredValue(config.emailFromName);
    case "EXTERNAL_CHANNEL_SECRET":
      return hasConfiguredValue(config.externalChannelSecret);
    default:
      return hasConfiguredValue(process.env[envVar]);
  }
}
