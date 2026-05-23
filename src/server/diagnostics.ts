import type { AppConfig } from "../config.ts";
import { emailConfigComplete, modelAdapterMode } from "../config.ts";
import type { MemoryStatus } from "../memory/types.ts";
import type { ChannelRecord } from "../channels/registry.ts";
import type { RolePolicyConfigStatus } from "../orchestration/role-config.ts";
import type { SetupReadiness } from "./readiness.ts";

export type StartupDiagnostics = {
  appEnv: AppConfig["appEnv"];
  modelAdapter: "openai" | "fallback";
  qdrant: {
    enabled: boolean;
    configured: boolean;
    reachable: boolean;
    collectionName: string;
  };
  channels: {
    configuredCount: number;
    enabledCount: number;
  };
  channelReadiness: ChannelRecord[];
  missingRecommendedEnv: string[];
  setupReadiness?: SetupReadiness;
  rolePolicy?: RolePolicyConfigStatus;
};

export function buildStartupDiagnostics(
  config: AppConfig,
  memory: MemoryStatus,
  channels: ChannelRecord[],
  setupReadiness?: SetupReadiness,
  rolePolicy?: RolePolicyConfigStatus
): StartupDiagnostics {
  const missingRecommendedEnv = new Set<string>();
  if (modelAdapterMode(config) === "fallback") {
    missingRecommendedEnv.add("OPENAI_API_KEY");
  }
  if (config.qdrantEnabled && !config.qdrantUrl) {
    missingRecommendedEnv.add("QDRANT_URL");
  }
  if (
    channels.some((channel) => channel.id === "slack" && channel.enabled) &&
    !config.slackBotToken
  ) {
    missingRecommendedEnv.add("SLACK_BOT_TOKEN");
  }
  if (
    channels.some((channel) => channel.id === "webhook" && channel.enabled) &&
    !config.externalChannelSecret
  ) {
    missingRecommendedEnv.add("EXTERNAL_CHANNEL_SECRET");
  }
  if (channels.some((channel) => channel.id === "email" && channel.enabled)) {
    if (!emailConfigComplete(config)) {
      if (!config.emailImapHost) {
        missingRecommendedEnv.add("EMAIL_IMAP_HOST");
      }
      if (!config.emailImapUsername) {
        missingRecommendedEnv.add("EMAIL_IMAP_USERNAME");
      }
      if (!config.emailImapPassword) {
        missingRecommendedEnv.add("EMAIL_IMAP_PASSWORD");
      }
      if (!config.emailSmtpHost) {
        missingRecommendedEnv.add("EMAIL_SMTP_HOST");
      }
      if (!config.emailSmtpUsername) {
        missingRecommendedEnv.add("EMAIL_SMTP_USERNAME");
      }
      if (!config.emailSmtpPassword) {
        missingRecommendedEnv.add("EMAIL_SMTP_PASSWORD");
      }
      if (!config.emailFromAddress) {
        missingRecommendedEnv.add("EMAIL_FROM_ADDRESS");
      }
    }
  }

  return {
    appEnv: config.appEnv,
    modelAdapter: modelAdapterMode(config),
    qdrant: {
      enabled: config.qdrantEnabled,
      configured: memory.qdrantConfigured,
      reachable: memory.qdrantReachable,
      collectionName: config.qdrantCollectionName,
    },
    channels: {
      configuredCount: channels.filter(
        (channel) => channel.secretPresent || !channel.secretEnvVar
      ).length,
      enabledCount: channels.filter((channel) => channel.enabled).length,
    },
    channelReadiness: channels,
    missingRecommendedEnv: [...missingRecommendedEnv].sort(),
    setupReadiness,
    rolePolicy,
  };
}
