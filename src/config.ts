import { join } from "node:path";

export type AppEnvironment = "development" | "test" | "production";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type OpenAiReasoningEffort = "low" | "medium" | "high";

export type AppConfig = {
  appEnv: AppEnvironment;
  logLevel: LogLevel;
  port: number;
  dataDir: string;
  datastorePath: string;
  model: string;
  openAiReasoningEffort: OpenAiReasoningEffort;
  openAiMemoryReasoningEffort: OpenAiReasoningEffort;
  agentName: string;
  roleConfigPath: string;
  operatorConfigPath: string;
  operatorBearerToken: string;
  mcpBearerToken: string;
  externalChannelSecret: string;
  openAiApiKey?: string;
  openAiBaseUrl?: string;
  openAiConversationMode: "previous_response_id" | "manual";
  openAiRequestTimeoutMs: number;
  openAiEmbeddingModel: string;
  openAiEmbeddingTimeoutMs: number;
  semanticRetrievalEnabled: boolean;
  qdrantEnabled: boolean;
  qdrantUrl?: string;
  qdrantApiKey?: string;
  qdrantCollectionName: string;
  qdrantTimeoutMs: number;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  slackBotUserId?: string;
  emailImapHost?: string;
  emailImapPort: number;
  emailImapUsername?: string;
  emailImapPassword?: string;
  emailImapTls: boolean;
  emailSmtpHost?: string;
  emailSmtpPort: number;
  emailSmtpUsername?: string;
  emailSmtpPassword?: string;
  emailSmtpTls: boolean;
  emailFromAddress?: string;
  emailFromName: string;
  emailPollIntervalMs: number;
  emailPollBatchSize: number;
  emailMaxMessageBytes: number;
  emailMaxAttachmentBytes: number;
  emailSendTimeoutMs: number;
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
const COMPOSE_DEV_MCP_BEARER_TOKEN = "local-dev-mcp-token";
const COMPOSE_DEV_EXTERNAL_CHANNEL_SECRET = "local-dev-channel-secret";
const COMPOSE_DEV_OPERATOR_BEARER_TOKEN = "local-dev-operator-token";

export function loadConfig(): AppConfig {
  const cwd = process.cwd();
  const appEnv = normalizeEnvironment(
    process.env.APP_ENV ?? process.env.NODE_ENV
  );
  const dataDir = process.env.CODEX_PHANTOM_DATA_DIR ?? join(cwd, "data");
  const datastorePath =
    process.env.CODEX_PHANTOM_DATABASE_PATH ??
    join(dataDir, "codex-phantom.sqlite");

  const config: AppConfig = {
    appEnv,
    logLevel: normalizeLogLevel(process.env.LOG_LEVEL),
    port: parsePositiveInteger(process.env.PORT, 3210, "PORT"),
    dataDir,
    datastorePath,
    model: process.env.OPENAI_MODEL ?? "gpt-5",
    openAiReasoningEffort: parseReasoningEffort(
      process.env.OPENAI_REASONING_EFFORT,
      "medium",
      "OPENAI_REASONING_EFFORT"
    ),
    openAiMemoryReasoningEffort: parseReasoningEffort(
      process.env.OPENAI_MEMORY_REASONING_EFFORT,
      "low",
      "OPENAI_MEMORY_REASONING_EFFORT"
    ),
    agentName: process.env.AGENT_NAME ?? "Codex Phantom",
    roleConfigPath:
      process.env.ROLE_CONFIG_PATH ?? join(cwd, "config", "roles.yaml"),
    operatorConfigPath:
      process.env.OPERATOR_CONFIG_PATH ?? join(cwd, "config", "operator.yaml"),
    operatorBearerToken:
      process.env.OPERATOR_BEARER_TOKEN ?? DEFAULT_OPERATOR_BEARER_TOKEN,
    mcpBearerToken: process.env.MCP_BEARER_TOKEN ?? DEFAULT_MCP_BEARER_TOKEN,
    externalChannelSecret:
      process.env.EXTERNAL_CHANNEL_SECRET ?? DEFAULT_EXTERNAL_CHANNEL_SECRET,
    openAiApiKey: process.env.OPENAI_API_KEY,
    openAiBaseUrl: process.env.OPENAI_BASE_URL,
    openAiConversationMode:
      process.env.OPENAI_CONVERSATION_MODE === "manual"
        ? "manual"
        : "previous_response_id",
    openAiRequestTimeoutMs: parsePositiveInteger(
      process.env.OPENAI_REQUEST_TIMEOUT_MS,
      60_000,
      "OPENAI_REQUEST_TIMEOUT_MS"
    ),
    openAiEmbeddingModel:
      process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    openAiEmbeddingTimeoutMs: parsePositiveInteger(
      process.env.OPENAI_EMBEDDING_TIMEOUT_MS,
      10_000,
      "OPENAI_EMBEDDING_TIMEOUT_MS"
    ),
    semanticRetrievalEnabled:
      process.env.SEMANTIC_RETRIEVAL_ENABLED !== "false",
    qdrantEnabled: process.env.QDRANT_ENABLED === "true",
    qdrantUrl: process.env.QDRANT_URL,
    qdrantApiKey: process.env.QDRANT_API_KEY,
    qdrantCollectionName:
      process.env.QDRANT_COLLECTION_NAME ?? "codex-phantom-memory",
    qdrantTimeoutMs: parsePositiveInteger(
      process.env.QDRANT_TIMEOUT_MS,
      5_000,
      "QDRANT_TIMEOUT_MS"
    ),
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    slackBotUserId: process.env.SLACK_BOT_USER_ID,
    emailImapHost: process.env.EMAIL_IMAP_HOST,
    emailImapPort: parsePositiveInteger(
      process.env.EMAIL_IMAP_PORT,
      993,
      "EMAIL_IMAP_PORT"
    ),
    emailImapUsername: process.env.EMAIL_IMAP_USERNAME,
    emailImapPassword: process.env.EMAIL_IMAP_PASSWORD,
    emailImapTls: parseBoolean(
      process.env.EMAIL_IMAP_TLS,
      true,
      "EMAIL_IMAP_TLS"
    ),
    emailSmtpHost: process.env.EMAIL_SMTP_HOST,
    emailSmtpPort: parsePositiveInteger(
      process.env.EMAIL_SMTP_PORT,
      587,
      "EMAIL_SMTP_PORT"
    ),
    emailSmtpUsername: process.env.EMAIL_SMTP_USERNAME,
    emailSmtpPassword: process.env.EMAIL_SMTP_PASSWORD,
    emailSmtpTls: parseBoolean(
      process.env.EMAIL_SMTP_TLS,
      true,
      "EMAIL_SMTP_TLS"
    ),
    emailFromAddress: process.env.EMAIL_FROM_ADDRESS,
    emailFromName:
      process.env.EMAIL_FROM_NAME ?? process.env.AGENT_NAME ?? "Codex Phantom",
    emailPollIntervalMs: parsePositiveInteger(
      process.env.EMAIL_POLL_INTERVAL_MS,
      30_000,
      "EMAIL_POLL_INTERVAL_MS"
    ),
    emailPollBatchSize: parsePositiveInteger(
      process.env.EMAIL_POLL_BATCH_SIZE,
      10,
      "EMAIL_POLL_BATCH_SIZE"
    ),
    emailMaxMessageBytes: parsePositiveInteger(
      process.env.EMAIL_MAX_MESSAGE_BYTES,
      1_048_576,
      "EMAIL_MAX_MESSAGE_BYTES"
    ),
    emailMaxAttachmentBytes: parsePositiveInteger(
      process.env.EMAIL_MAX_ATTACHMENT_BYTES,
      200_000,
      "EMAIL_MAX_ATTACHMENT_BYTES"
    ),
    emailSendTimeoutMs: parsePositiveInteger(
      process.env.EMAIL_SEND_TIMEOUT_MS,
      10_000,
      "EMAIL_SEND_TIMEOUT_MS"
    ),
    memoryEmbeddingBatchSize: parsePositiveInteger(
      process.env.MEMORY_EMBEDDING_BATCH_SIZE,
      8,
      "MEMORY_EMBEDDING_BATCH_SIZE"
    ),
    memoryTopK: parsePositiveInteger(
      process.env.MEMORY_TOP_K,
      12,
      "MEMORY_TOP_K"
    ),
    memoryPerCategoryLimit: parsePositiveInteger(
      process.env.MEMORY_PER_CATEGORY_LIMIT,
      3,
      "MEMORY_PER_CATEGORY_LIMIT"
    ),
    memorySummaryLimit: parsePositiveInteger(
      process.env.MEMORY_SUMMARY_LIMIT,
      2,
      "MEMORY_SUMMARY_LIMIT"
    ),
    memorySummaryTriggerCount: parsePositiveInteger(
      process.env.MEMORY_SUMMARY_TRIGGER_COUNT,
      6,
      "MEMORY_SUMMARY_TRIGGER_COUNT"
    ),
    memorySummaryClusterSize: parsePositiveInteger(
      process.env.MEMORY_SUMMARY_CLUSTER_SIZE,
      4,
      "MEMORY_SUMMARY_CLUSTER_SIZE"
    ),
    defaultRunTimeoutMs: parsePositiveInteger(
      process.env.DEFAULT_RUN_TIMEOUT_MS,
      30_000,
      "DEFAULT_RUN_TIMEOUT_MS"
    ),
    defaultMaxToolCalls: parsePositiveInteger(
      process.env.DEFAULT_MAX_TOOL_CALLS,
      6,
      "DEFAULT_MAX_TOOL_CALLS"
    ),
    rejectDefaultSecrets:
      process.env.REJECT_DEFAULT_SECRETS === "false"
        ? false
        : appEnv === "production",
  };

  validateConfig(config);
  return config;
}

export function modelAdapterMode(config: AppConfig): "openai" | "fallback" {
  return config.openAiApiKey ? "openai" : "fallback";
}

export function defaultSecrets(): {
  operatorBearerToken: string;
  operatorBearerTokens: string[];
  mcpBearerToken: string;
  mcpBearerTokens: string[];
  externalChannelSecret: string;
  externalChannelSecrets: string[];
} {
  return {
    operatorBearerToken: DEFAULT_OPERATOR_BEARER_TOKEN,
    operatorBearerTokens: [
      DEFAULT_OPERATOR_BEARER_TOKEN,
      COMPOSE_DEV_OPERATOR_BEARER_TOKEN,
    ],
    mcpBearerToken: DEFAULT_MCP_BEARER_TOKEN,
    mcpBearerTokens: [DEFAULT_MCP_BEARER_TOKEN, COMPOSE_DEV_MCP_BEARER_TOKEN],
    externalChannelSecret: DEFAULT_EXTERNAL_CHANNEL_SECRET,
    externalChannelSecrets: [
      DEFAULT_EXTERNAL_CHANNEL_SECRET,
      COMPOSE_DEV_EXTERNAL_CHANNEL_SECRET,
    ],
  };
}

export function hasConfiguredValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function emailConfigComplete(config: AppConfig): boolean {
  return Boolean(
    hasConfiguredValue(config.emailImapHost) &&
    hasConfiguredValue(config.emailImapUsername) &&
    hasConfiguredValue(config.emailImapPassword) &&
    hasConfiguredValue(config.emailSmtpHost) &&
    hasConfiguredValue(config.emailSmtpUsername) &&
    hasConfiguredValue(config.emailSmtpPassword) &&
    hasConfiguredValue(config.emailFromAddress)
  );
}

function normalizeEnvironment(value: string | undefined): AppEnvironment {
  if (value === "production" || value === "test") {
    return value;
  }
  return "development";
}

function normalizeLogLevel(value: string | undefined): LogLevel {
  if (
    value === "debug" ||
    value === "warn" ||
    value === "error" ||
    value === "info"
  ) {
    return value;
  }
  return "info";
}

function parseBoolean(
  raw: string | undefined,
  fallback: boolean,
  field: string
): boolean {
  if (raw === undefined) {
    return fallback;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`${field} must be set to true or false`);
}

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
  field: string
): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function parseReasoningEffort(
  raw: string | undefined,
  fallback: OpenAiReasoningEffort,
  field: string
): OpenAiReasoningEffort {
  if (!raw) {
    return fallback;
  }
  if (raw === "low" || raw === "medium" || raw === "high") {
    return raw;
  }
  throw new Error(`${field} must be low, medium, or high`);
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
  if (!config.roleConfigPath.trim()) {
    throw new Error("ROLE_CONFIG_PATH must not be empty");
  }
  if (!config.operatorConfigPath.trim()) {
    throw new Error("OPERATOR_CONFIG_PATH must not be empty");
  }
  if (!config.openAiEmbeddingModel.trim()) {
    throw new Error("OPENAI_EMBEDDING_MODEL must not be empty");
  }
  if (!config.qdrantCollectionName.trim()) {
    throw new Error("QDRANT_COLLECTION_NAME must not be empty");
  }
  if (
    config.qdrantEnabled &&
    (!config.qdrantUrl || config.qdrantUrl.trim() === "")
  ) {
    throw new Error("QDRANT_URL is required when QDRANT_ENABLED=true");
  }
  validateSecret("OPERATOR_BEARER_TOKEN", config.operatorBearerToken, false);
  validateSecret("MCP_BEARER_TOKEN", config.mcpBearerToken, false);
  validateSecret(
    "EXTERNAL_CHANNEL_SECRET",
    config.externalChannelSecret,
    false
  );
  if (config.rejectDefaultSecrets || config.appEnv === "production") {
    validateSecret("OPERATOR_BEARER_TOKEN", config.operatorBearerToken, true, [
      DEFAULT_OPERATOR_BEARER_TOKEN,
      COMPOSE_DEV_OPERATOR_BEARER_TOKEN,
    ]);
    validateSecret("MCP_BEARER_TOKEN", config.mcpBearerToken, true, [
      DEFAULT_MCP_BEARER_TOKEN,
      COMPOSE_DEV_MCP_BEARER_TOKEN,
    ]);
    validateSecret(
      "EXTERNAL_CHANNEL_SECRET",
      config.externalChannelSecret,
      true,
      [DEFAULT_EXTERNAL_CHANNEL_SECRET, COMPOSE_DEV_EXTERNAL_CHANNEL_SECRET]
    );
  }
  if (config.appEnv === "production" && !config.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required in production");
  }
}

function validateSecret(
  field: string,
  value: string,
  rejectPlaceholder: boolean,
  defaultValues: string[] = []
): void {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must not be empty`);
  }
  if (
    rejectPlaceholder &&
    (defaultValues.includes(normalized) || normalized === "replace-me")
  ) {
    throw new Error(`${field} must be set to a non-default secret`);
  }
}
