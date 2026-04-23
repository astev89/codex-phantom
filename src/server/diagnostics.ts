import type { AppConfig } from "../config.ts";
import { modelAdapterMode } from "../config.ts";
import type { MemoryStatus } from "../memory/types.ts";
import type { ChannelRecord } from "../channels/registry.ts";

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
};

export function buildStartupDiagnostics(
  config: AppConfig,
  memory: MemoryStatus,
  channels: ChannelRecord[]
): StartupDiagnostics {
  const missingRecommendedEnv = new Set<string>();
  if (modelAdapterMode(config) === "fallback") {
    missingRecommendedEnv.add("OPENAI_API_KEY");
  }
  if (config.qdrantEnabled && !config.qdrantUrl) {
    missingRecommendedEnv.add("QDRANT_URL");
  }
  if (channels.some((channel) => channel.id === "slack" && channel.enabled) && !config.slackBotToken) {
    missingRecommendedEnv.add("SLACK_BOT_TOKEN");
  }
  if (channels.some((channel) => channel.id === "webhook" && channel.enabled) && !config.externalChannelSecret) {
    missingRecommendedEnv.add("EXTERNAL_CHANNEL_SECRET");
  }

  return {
    appEnv: config.appEnv,
    modelAdapter: modelAdapterMode(config),
    qdrant: {
      enabled: config.qdrantEnabled,
      configured: memory.qdrantConfigured,
      reachable: memory.qdrantReachable,
      collectionName: config.qdrantCollectionName
    },
    channels: {
      configuredCount: channels.filter((channel) => channel.secretPresent || !channel.secretEnvVar).length,
      enabledCount: channels.filter((channel) => channel.enabled).length
    },
    channelReadiness: channels,
    missingRecommendedEnv: [...missingRecommendedEnv].sort()
  };
}
