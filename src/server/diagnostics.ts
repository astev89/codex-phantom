import type { AppConfig } from "../config.ts";
import { modelAdapterMode } from "../config.ts";
import {
  missingRequiredEnvVarsForChannel,
  runtimeChannelConfigComplete,
} from "../channels/capabilities.ts";
import type { ChannelDeliveryRecord } from "../channels/delivery-log.ts";
import type { MemoryStatus } from "../memory/types.ts";
import type { ChannelRecord } from "../channels/registry.ts";
import type {
  EmailChannelStatus,
  EmailPollSummary,
} from "../channels/email.ts";
import type { RolePolicyConfigStatus } from "../orchestration/role-config.ts";
import type { SetupReadiness } from "./readiness.ts";

export type EmailChannelDiagnostics = {
  enabled: boolean;
  running: boolean;
  configComplete: boolean;
  lastPollAt?: string;
  lastSummary?: EmailPollSummary;
  lastError?: string;
  recentDeliveryFailures: ChannelDeliveryRecord[];
};

export type StartupDiagnostics = {
  appEnv: AppConfig["appEnv"];
  modelAdapter: "openai" | "fallback";
  model: {
    name: string;
    reasoningEffort: AppConfig["openAiReasoningEffort"];
    memoryReasoningEffort: AppConfig["openAiMemoryReasoningEffort"];
  };
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
  email?: EmailChannelDiagnostics;
  setupReadiness?: SetupReadiness;
  rolePolicy?: RolePolicyConfigStatus;
};

export function buildStartupDiagnostics(
  config: AppConfig,
  memory: MemoryStatus,
  channels: ChannelRecord[],
  emailStatus?: EmailChannelStatus,
  emailRecentDeliveryFailures: ChannelDeliveryRecord[] = [],
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
  for (const channel of channels) {
    for (const envVar of missingRequiredEnvVarsForChannel(config, channel)) {
      missingRecommendedEnv.add(envVar);
    }
  }

  const emailChannel = channels.find((channel) => channel.id === "email");
  const emailDiagnostics = emailChannel
    ? {
        enabled: emailChannel.enabled,
        running: emailChannel.enabled ? (emailStatus?.running ?? false) : false,
        configComplete:
          emailStatus?.configComplete ??
          runtimeChannelConfigComplete(config, "email"),
        ...(emailStatus?.lastPollAt
          ? { lastPollAt: emailStatus.lastPollAt }
          : {}),
        ...(emailStatus?.lastSummary
          ? { lastSummary: emailStatus.lastSummary }
          : {}),
        ...(emailStatus?.lastError ? { lastError: emailStatus.lastError } : {}),
        recentDeliveryFailures: emailRecentDeliveryFailures,
      }
    : undefined;

  return {
    appEnv: config.appEnv,
    modelAdapter: modelAdapterMode(config),
    model: {
      name: config.model,
      reasoningEffort: config.openAiReasoningEffort,
      memoryReasoningEffort: config.openAiMemoryReasoningEffort,
    },
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
    email: emailDiagnostics,
    setupReadiness,
    rolePolicy,
  };
}
