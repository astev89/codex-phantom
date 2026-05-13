import { accessSync, constants } from "node:fs";
import type { AppConfig } from "../config.ts";
import { defaultSecrets, modelAdapterMode } from "../config.ts";
import type { ChannelRecord } from "../channels/registry.ts";
import type { MemoryStatus } from "../memory/types.ts";

export type ReadinessStatus = "pass" | "warn" | "fail";

export type ReadinessCheck = {
  id: string;
  category:
    | "secrets"
    | "storage"
    | "roles_config"
    | "channels"
    | "model"
    | "memory";
  status: ReadinessStatus;
  label: string;
  message: string;
  action?: string;
};

export type SetupReadiness = {
  ok: boolean;
  status: "ready" | "warning" | "blocked";
  summary: {
    passing: number;
    warnings: number;
    failures: number;
  };
  checks: ReadinessCheck[];
};

export function buildSetupReadiness(input: {
  config: AppConfig;
  memory: MemoryStatus;
  channels: ChannelRecord[];
  databaseReady: boolean;
}): SetupReadiness {
  const checks = [
    ...secretChecks(input.config),
    ...storageChecks(input.config, input.databaseReady),
    ...roleConfigChecks(input.config),
    ...channelChecks(input.channels),
    ...modelChecks(input.config),
    ...memoryChecks(input.config, input.memory),
  ];
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  return {
    ok: failures === 0,
    status: failures > 0 ? "blocked" : warnings > 0 ? "warning" : "ready",
    summary: {
      passing: checks.filter((check) => check.status === "pass").length,
      warnings,
      failures,
    },
    checks,
  };
}

function secretChecks(config: AppConfig): ReadinessCheck[] {
  const defaults = defaultSecrets();
  return [
    secretCheck(
      "operator-token",
      "Operator bearer token",
      "OPERATOR_BEARER_TOKEN",
      config.operatorBearerToken,
      defaults.operatorBearerToken
    ),
    secretCheck(
      "mcp-token",
      "MCP bearer token",
      "MCP_BEARER_TOKEN",
      config.mcpBearerToken,
      defaults.mcpBearerToken
    ),
    secretCheck(
      "external-channel-secret",
      "External channel HMAC secret",
      "EXTERNAL_CHANNEL_SECRET",
      config.externalChannelSecret,
      defaults.externalChannelSecret
    ),
  ];
}

function secretCheck(
  id: string,
  label: string,
  envVar: string,
  value: string,
  defaultValue: string
): ReadinessCheck {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized === "replace-me" ||
    normalized === defaultValue
  ) {
    return {
      id,
      category: "secrets",
      status: "fail",
      label,
      message: `${envVar} is missing or still uses an unsafe default.`,
      action: `Set ${envVar} to a non-default secret before production use.`,
    };
  }
  return {
    id,
    category: "secrets",
    status: "pass",
    label,
    message: `${envVar} is configured with a non-default value.`,
  };
}

function storageChecks(
  config: AppConfig,
  databaseReady: boolean
): ReadinessCheck[] {
  return [
    {
      id: "database-open",
      category: "storage",
      status: databaseReady ? "pass" : "fail",
      label: "SQLite database",
      message: databaseReady
        ? "SQLite is open and responding."
        : "SQLite is not ready.",
      action: databaseReady
        ? undefined
        : "Check CODEX_PHANTOM_DATA_DIR and CODEX_PHANTOM_DATABASE_PATH permissions.",
    },
    pathCheck(
      "data-dir",
      "Data directory path",
      "CODEX_PHANTOM_DATA_DIR",
      config.dataDir
    ),
    pathCheck(
      "database-path",
      "Database path",
      "CODEX_PHANTOM_DATABASE_PATH",
      config.datastorePath
    ),
  ];
}

function roleConfigChecks(config: AppConfig): ReadinessCheck[] {
  return [
    readableFileCheck(
      "role-config",
      "Role policy config",
      "ROLE_CONFIG_PATH",
      config.roleConfigPath
    ),
    readableFileCheck(
      "operator-config",
      "Operator setup config",
      "OPERATOR_CONFIG_PATH",
      config.operatorConfigPath
    ),
  ];
}

function channelChecks(channels: ChannelRecord[]): ReadinessCheck[] {
  const requiredCore = new Set(["web", "scheduler", "webhook"]);
  const checks: ReadinessCheck[] = [];
  for (const channel of channels) {
    if (requiredCore.has(channel.id) && !channel.enabled) {
      checks.push({
        id: `channel-${channel.id}-enabled`,
        category: "channels",
        status: "fail",
        label: `${channel.displayName} channel`,
        message: `${channel.id} is required for first-run readiness but is disabled.`,
        action: `Enable ${channel.id} through /admin/channels.`,
      });
      continue;
    }
    if (channel.enabled && !channel.secretPresent) {
      const requiredSecrets = Array.isArray(
        channel.config.requiredSecretEnvVars
      )
        ? channel.config.requiredSecretEnvVars.join(", ")
        : channel.secretEnvVar;
      checks.push({
        id: `channel-${channel.id}-secrets`,
        category: "channels",
        status: "fail",
        label: `${channel.displayName} channel secrets`,
        message: `${channel.id} is enabled but required secrets are missing.`,
        action: requiredSecrets
          ? `Set required secret env vars: ${requiredSecrets}.`
          : "Set the channel secret before enabling this channel.",
      });
      continue;
    }
    checks.push({
      id: `channel-${channel.id}`,
      category: "channels",
      status: channel.enabled ? "pass" : "warn",
      label: `${channel.displayName} channel`,
      message: channel.enabled
        ? `${channel.id} is enabled and configured.`
        : `${channel.id} is available but disabled.`,
      action: channel.enabled
        ? undefined
        : `Enable ${channel.id} only if this deployment uses it.`,
    });
  }
  return checks;
}

function modelChecks(config: AppConfig): ReadinessCheck[] {
  if (modelAdapterMode(config) === "openai") {
    return [
      {
        id: "openai-api-key",
        category: "model",
        status: "pass",
        label: "OpenAI API key",
        message: "OPENAI_API_KEY is configured.",
      },
    ];
  }
  return [
    {
      id: "openai-api-key",
      category: "model",
      status: config.appEnv === "production" ? "fail" : "warn",
      label: "OpenAI API key",
      message:
        "OPENAI_API_KEY is missing; the runtime will use fallback model behavior.",
      action: "Set OPENAI_API_KEY before production use.",
    },
  ];
}

function memoryChecks(
  config: AppConfig,
  memory: MemoryStatus
): ReadinessCheck[] {
  if (!config.semanticRetrievalEnabled) {
    return [
      {
        id: "semantic-retrieval",
        category: "memory",
        status: "warn",
        label: "Semantic retrieval",
        message: "Semantic retrieval is disabled.",
        action:
          "Set SEMANTIC_RETRIEVAL_ENABLED=true if semantic memory is required.",
      },
    ];
  }
  if (
    config.qdrantEnabled &&
    (!memory.qdrantConfigured || !memory.qdrantReachable)
  ) {
    return [
      {
        id: "qdrant-memory",
        category: "memory",
        status: "fail",
        label: "Qdrant memory backend",
        message: "Qdrant is enabled but not configured or reachable.",
        action: "Check QDRANT_URL, QDRANT_API_KEY, and network access.",
      },
    ];
  }
  return [
    {
      id: "semantic-retrieval",
      category: "memory",
      status: "pass",
      label: "Semantic retrieval",
      message: memory.qdrantReachable
        ? "Semantic retrieval is using Qdrant."
        : "Semantic retrieval is available with SQLite fallback.",
    },
  ];
}

function pathCheck(
  id: string,
  label: string,
  envVar: string,
  value: string
): ReadinessCheck {
  if (!value.trim()) {
    return {
      id,
      category: "storage",
      status: "fail",
      label,
      message: `${envVar} is empty.`,
      action: `Set ${envVar} to a writable path.`,
    };
  }
  return {
    id,
    category: "storage",
    status: "pass",
    label,
    message: `${envVar} is set.`,
  };
}

function readableFileCheck(
  id: string,
  label: string,
  envVar: string,
  path: string
): ReadinessCheck {
  if (!path.trim()) {
    return {
      id,
      category: "roles_config",
      status: "fail",
      label,
      message: `${envVar} is empty.`,
      action: `Set ${envVar} to a readable YAML file.`,
    };
  }
  try {
    accessSync(path, constants.R_OK);
    return {
      id,
      category: "roles_config",
      status: "pass",
      label,
      message: `${envVar} is readable.`,
    };
  } catch {
    return {
      id,
      category: "roles_config",
      status: "fail",
      label,
      message: `${envVar} is not readable at ${path}.`,
      action: `Create the YAML file or set ${envVar} to the correct path.`,
    };
  }
}
