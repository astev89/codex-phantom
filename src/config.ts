import { join } from "node:path";

export type AppEnvironment = "development" | "test" | "production";
export type LogLevel = "debug" | "info" | "warn" | "error";

export type AppConfig = {
  appEnv: AppEnvironment;
  logLevel: LogLevel;
  port: number;
  dataDir: string;
  datastorePath: string;
  model: string;
  agentName: string;
  operatorBearerToken: string;
  mcpBearerToken: string;
  externalChannelSecret: string;
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  openAiConversationMode: "previous_response_id" | "manual";
  openAiEmbeddingModel: string;
  semanticRetrievalEnabled: boolean;
  qdrantEnabled: boolean;
  qdrantUrl?: string;
  qdrantApiKey?: string;
  qdrantCollectionName: string;
  qdrantTimeoutMs: number;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  memoryEmbeddingBatchSize: number;
  memoryTopK: number;
  memoryPerCategoryLimit: number;
  memorySummaryLimit: number;
  memorySummaryTriggerCount: number;
  memorySummaryClusterSize: number;
  defaultRunTimeoutMs: number;
  defaultMaxToolCalls: number;
  rejectDefaultSecrets: boolean;
};

const DEFAULT_MCP_BEARER_TOKEN = "dev-mcp-token";
const DEFAULT_EXTERNAL_CHANNEL_SECRET = "dev-external-secret";
const DEFAULT_OPERATOR_BEARER_TOKEN = "dev-operator-token";

export function loadConfig(): AppConfig {
  const cwd = process.cwd();
  const appEnv = normalizeEnvironment(process.env.APP_ENV ?? process.env.NODE_ENV);
  const dataDir = process.env.CODEX_PHANTOM_DATA_DIR ?? join(cwd, "data");
  const datastorePath = process.env.CODEX_PHANTOM_DATABASE_PATH ?? join(dataDir, "codex-phantom.sqlite");

  const config: AppConfig = {
    appEnv,
    logLevel: normalizeLogLevel(process.env.LOG_LEVEL),
    port: parsePositiveInteger(process.env.PORT, 3210, "PORT"),
    dataDir,
    datastorePath,
    model: process.env.OPENAI_MODEL ?? "gpt-5",
    agentName: process.env.AGENT_NAME ?? "Codex Phantom",
    operatorBearerToken: process.env.OPERATOR_BEARER_TOKEN ?? DEFAULT_OPERATOR_BEARER_TOKEN,
    mcpBearerToken: process.env.MCP_BEARER_TOKEN ?? DEFAULT_MCP_BEARER_TOKEN,
    externalChannelSecret: process.env.EXTERNAL_CHANNEL_SECRET ?? DEFAULT_EXTERNAL_CHANNEL_SECRET,
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiBaseUrl: process.env.OPENAI_BASE_URL,
    openAiConversationMode:
      process.env.OPENAI_CONVERSATION_MODE === "manual" ? "manual" : "previous_response_id",
    openAiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    semanticRetrievalEnabled: process.env.SEMANTIC_RETRIEVAL_ENABLED !== "false",
    qdrantEnabled: process.env.QDRANT_ENABLED === "true",
    qdrantUrl: process.env.QDRANT_URL,
    qdrantApiKey: process.env.QDRANT_API_KEY,
    qdrantCollectionName: process.env.QDRANT_COLLECTION_NAME ?? "codex-phantom-memory",
    qdrantTimeoutMs: parsePositiveInteger(process.env.QDRANT_TIMEOUT_MS, 5_000, "QDRANT_TIMEOUT_MS"),
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    memoryEmbeddingBatchSize: parsePositiveInteger(process.env.MEMORY_EMBEDDING_BATCH_SIZE, 8, "MEMORY_EMBEDDING_BATCH_SIZE"),
    memoryTopK: parsePositiveInteger(process.env.MEMORY_TOP_K, 12, "MEMORY_TOP_K"),
    memoryPerCategoryLimit: parsePositiveInteger(process.env.MEMORY_PER_CATEGORY_LIMIT, 3, "MEMORY_PER_CATEGORY_LIMIT"),
    memorySummaryLimit: parsePositiveInteger(process.env.MEMORY_SUMMARY_LIMIT, 2, "MEMORY_SUMMARY_LIMIT"),
    memorySummaryTriggerCount: parsePositiveInteger(process.env.MEMORY_SUMMARY_TRIGGER_COUNT, 6, "MEMORY_SUMMARY_TRIGGER_COUNT"),
    memorySummaryClusterSize: parsePositiveInteger(process.env.MEMORY_SUMMARY_CLUSTER_SIZE, 4, "MEMORY_SUMMARY_CLUSTER_SIZE"),
    defaultRunTimeoutMs: parsePositiveInteger(process.env.DEFAULT_RUN_TIMEOUT_MS, 30_000, "DEFAULT_RUN_TIMEOUT_MS"),
    defaultMaxToolCalls: parsePositiveInteger(process.env.DEFAULT_MAX_TOOL_CALLS, 6, "DEFAULT_MAX_TOOL_CALLS"),
    rejectDefaultSecrets:
      process.env.REJECT_DEFAULT_SECRETS === "false" ? false : appEnv === "production"
  };

  validateConfig(config);
  return config;
}

export function modelAdapterMode(config: AppConfig): "openai" | "fallback" {
  return config.openAiApiKey ? "openai" : "fallback";
}

export function defaultSecrets(): { operatorBearerToken: string; mcpBearerToken: string; externalChannelSecret: string } {
  return {
    operatorBearerToken: DEFAULT_OPERATOR_BEARER_TOKEN,
    mcpBearerToken: DEFAULT_MCP_BEARER_TOKEN,
    externalChannelSecret: DEFAULT_EXTERNAL_CHANNEL_SECRET
  };
}

function normalizeEnvironment(value: string | undefined): AppEnvironment {
  if (value === "production" || value === "test") {
    return value;
  }
  return "development";
}

function normalizeLogLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "warn" || value === "error" || value === "info") {
    return value;
  }
  return "info";
}

function parsePositiveInteger(raw: string | undefined, fallback: number, field: string): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function validateConfig(config: AppConfig): void {
  if (!config.dataDir.trim()) {
    throw new Error("CODEX_PHANTOM_DATA_DIR must not be empty");
  }
  if (!config.datastorePath.trim()) {
    throw new Error("CODEX_PHANTOM_DATABASE_PATH must not be empty");
  }
  if (!config.model.trim()) {
    throw new Error("OPENAI_MODEL must not be empty");
  }
  if (!config.openAiEmbeddingModel.trim()) {
    throw new Error("OPENAI_EMBEDDING_MODEL must not be empty");
  }
  if (!config.qdrantCollectionName.trim()) {
    throw new Error("QDRANT_COLLECTION_NAME must not be empty");
  }
  if (config.qdrantEnabled && (!config.qdrantUrl || config.qdrantUrl.trim() === "")) {
    throw new Error("QDRANT_URL is required when QDRANT_ENABLED=true");
  }
  validateSecret("OPERATOR_BEARER_TOKEN", config.operatorBearerToken, false);
  validateSecret("MCP_BEARER_TOKEN", config.mcpBearerToken, false);
  validateSecret("EXTERNAL_CHANNEL_SECRET", config.externalChannelSecret, false);
  if (config.rejectDefaultSecrets) {
    validateSecret("OPERATOR_BEARER_TOKEN", config.operatorBearerToken, true, DEFAULT_OPERATOR_BEARER_TOKEN);
    validateSecret("MCP_BEARER_TOKEN", config.mcpBearerToken, true, DEFAULT_MCP_BEARER_TOKEN);
    validateSecret("EXTERNAL_CHANNEL_SECRET", config.externalChannelSecret, true, DEFAULT_EXTERNAL_CHANNEL_SECRET);
  }
  if (config.appEnv === "production" && !config.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required in production");
  }
}

function validateSecret(field: string, value: string, rejectPlaceholder: boolean, defaultValue?: string): void {
  if (!value.trim()) {
    throw new Error(`${field} must not be empty`);
  }
  if (rejectPlaceholder && (value === defaultValue || value === "replace-me")) {
    throw new Error(`${field} must be set to a non-default secret`);
  }
}
