import type { JsonValue } from "../shared/types.ts";
import type { SubagentRequest } from "../orchestration/types.ts";
import type {
  CreateSelfEvolutionProposalInput,
  SelfEvolutionRiskClass,
  SelfEvolutionTarget,
} from "../self-evolution/proposals.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly details?: JsonValue;

  constructor(status: number, message: string, details?: JsonValue) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export type ChatMessageInput = {
  sessionId?: string;
  conversationId?: string;
  message: string;
  attachments?: Array<{
    name: string;
    contentType: string;
    sizeBytes: number;
    description?: string;
  }>;
  attachmentIds?: string[];
  subagents?: SubagentRequest[];
  timeoutMs?: number;
};

export type ChatArtifactInput = {
  sessionId: string;
  runId?: string;
  title: string;
  kind: "text" | "json" | "file";
  contentType: string;
  content: JsonValue;
  metadata?: JsonValue;
};

export type ScheduleJobInput = {
  name: string;
  message: string;
  delayMs?: number;
  scheduledAt?: string;
  subagents?: SubagentRequest[];
  maxAttempts?: number;
};

export type McpRequestInput = {
  method: string;
  params?: { name?: string; input?: JsonValue };
};

export type DynamicToolInput = {
  id: string;
  description: string;
  scopes?: string[];
  inputSchema?: JsonValue;
  responseTemplate: string;
};

export type ChannelUpdateInput = {
  id: string;
  enabled: boolean;
};

export type ToolApprovalInput = {
  toolId: string;
  approvedBy: string;
  notes?: string;
};

export type SlackMessageInput = {
  channel: string;
  text: string;
};

export type OperatorSettingsInput = {
  dashboardRefreshSeconds?: number;
  chatDefaultConversationId?: string;
  memoryTimelineLimit?: number;
};

export type SelfEvolutionReviewInput = {
  reviewedBy: string;
  notes?: string;
};

export type SelfEvolutionApplyInput = {
  appliedBy: string;
  confirmHighRisk?: boolean;
};

export type SelfEvolutionRollbackInput = {
  rolledBackBy: string;
};

export function parseJsonBody(text: string): unknown {
  if (!text) {
    throw new HttpError(400, "Request body is required");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function validateChatBody(input: unknown): ChatMessageInput {
  const value = asRecord(input);
  const message = nonEmptyString(value.message, "message");
  return {
    sessionId: optionalString(value.sessionId),
    conversationId: optionalString(value.conversationId),
    message,
    attachments: validateAttachments(value.attachments),
    attachmentIds: optionalStringArray(value.attachmentIds, "attachmentIds"),
    subagents: validateSubagents(value.subagents),
    timeoutMs: optionalPositiveInteger(value.timeoutMs, "timeoutMs"),
  };
}

export function validateChatArtifactBody(input: unknown): ChatArtifactInput {
  const value = asRecord(input);
  const kind = nonEmptyString(value.kind, "kind");
  if (kind !== "text" && kind !== "json" && kind !== "file") {
    throw new HttpError(400, "kind must be text, json, or file");
  }
  const content = toJsonValue(value.content, "content");
  if ((kind === "text" || kind === "file") && typeof content !== "string") {
    throw new HttpError(
      400,
      "content must be a string for text and file artifacts"
    );
  }
  return {
    sessionId: nonEmptyString(value.sessionId, "sessionId"),
    runId: optionalString(value.runId),
    title: nonEmptyString(value.title, "title"),
    kind,
    contentType: nonEmptyString(value.contentType, "contentType"),
    content,
    metadata:
      value.metadata === undefined
        ? undefined
        : toJsonValue(value.metadata, "metadata"),
  };
}

export function validateWebhookBody(input: unknown): ChatMessageInput {
  const value = validateChatBody(input);
  if (!value.conversationId) {
    throw new HttpError(400, "conversationId is required");
  }
  return value;
}

export function validateScheduleBody(input: unknown): ScheduleJobInput {
  const value = asRecord(input);
  const delayMs = optionalPositiveInteger(value.delayMs, "delayMs");
  const scheduledAt = optionalIsoDate(value.scheduledAt, "scheduledAt");
  if (delayMs === undefined && !scheduledAt) {
    throw new HttpError(400, "Either delayMs or scheduledAt is required");
  }

  return {
    name: nonEmptyString(value.name, "name"),
    message: nonEmptyString(value.message, "message"),
    delayMs,
    scheduledAt,
    subagents: validateSubagents(value.subagents),
    maxAttempts: optionalBoundedPositiveInteger(
      value.maxAttempts,
      "maxAttempts",
      10
    ),
  };
}

export function validateMcpBody(input: unknown): McpRequestInput {
  const value = asRecord(input);
  return {
    method: nonEmptyString(value.method, "method"),
    params: value.params
      ? (asRecord(value.params) as { name?: string; input?: JsonValue })
      : undefined,
  };
}

export function validateDynamicToolBody(input: unknown): DynamicToolInput {
  const value = asRecord(input);
  return {
    id: nonEmptyString(value.id, "id"),
    description: nonEmptyString(value.description, "description"),
    scopes: optionalStringArray(value.scopes, "scopes"),
    inputSchema:
      value.inputSchema === undefined
        ? undefined
        : toJsonValue(value.inputSchema, "inputSchema"),
    responseTemplate: nonEmptyString(
      value.responseTemplate,
      "responseTemplate"
    ),
  };
}

export function validateChannelUpdateBody(input: unknown): ChannelUpdateInput {
  const value = asRecord(input);
  return {
    id: nonEmptyString(value.id, "id"),
    enabled: requireBoolean(value.enabled, "enabled"),
  };
}

export function validateToolApprovalBody(input: unknown): ToolApprovalInput {
  const value = asRecord(input);
  return {
    toolId: nonEmptyString(value.toolId, "toolId"),
    approvedBy: nonEmptyString(value.approvedBy, "approvedBy"),
    notes: optionalString(value.notes),
  };
}

export function validateSlackMessageBody(input: unknown): SlackMessageInput {
  const value = asRecord(input);
  return {
    channel: nonEmptyString(value.channel, "channel"),
    text: nonEmptyString(value.text, "text"),
  };
}

export function validateOperatorSettingsBody(
  input: unknown
): OperatorSettingsInput {
  const value = asRecord(input);
  return {
    dashboardRefreshSeconds: optionalPositiveInteger(
      value.dashboardRefreshSeconds,
      "dashboardRefreshSeconds"
    ),
    chatDefaultConversationId: optionalString(value.chatDefaultConversationId),
    memoryTimelineLimit: optionalPositiveInteger(
      value.memoryTimelineLimit,
      "memoryTimelineLimit"
    ),
  };
}

export function validateSelfEvolutionProposalBody(
  input: unknown
): CreateSelfEvolutionProposalInput {
  const value = asRecord(input);
  const target = nonEmptyString(value.target, "target");
  if (!isSelfEvolutionTarget(target)) {
    throw new HttpError(
      400,
      "target must be prompt, memory_policy, tool, role, or configuration"
    );
  }
  const riskClass = nonEmptyString(value.riskClass, "riskClass");
  if (!isSelfEvolutionRiskClass(riskClass)) {
    throw new HttpError(
      400,
      "riskClass must be low, medium, high, or critical"
    );
  }
  const proposedChange = toJsonValue(value.proposedChange, "proposedChange");
  if (!isJsonObject(proposedChange)) {
    throw new HttpError(400, "proposedChange must be a JSON object");
  }
  if (
    proposedChange.apply === true ||
    proposedChange.applyNow === true ||
    proposedChange.mutationMode === "direct" ||
    proposedChange.mutationMode === "apply_now"
  ) {
    throw new HttpError(400, "proposedChange cannot request direct mutation");
  }
  return {
    target,
    title: nonEmptyString(value.title, "title"),
    rationale: nonEmptyString(value.rationale, "rationale"),
    riskClass,
    proposedChange,
    metadata:
      value.metadata === undefined
        ? undefined
        : toJsonValue(value.metadata, "metadata"),
    proposedBy: optionalString(value.proposedBy),
  };
}

export function validateSelfEvolutionReviewBody(
  input: unknown
): SelfEvolutionReviewInput {
  const value = asRecord(input);
  return {
    reviewedBy: nonEmptyString(value.reviewedBy, "reviewedBy"),
    notes: optionalString(value.notes),
  };
}

export function validateSelfEvolutionApplyBody(
  input: unknown
): SelfEvolutionApplyInput {
  const value = asRecord(input);
  return {
    appliedBy: nonEmptyString(value.appliedBy, "appliedBy"),
    confirmHighRisk:
      value.confirmHighRisk === undefined
        ? undefined
        : requireBoolean(value.confirmHighRisk, "confirmHighRisk"),
  };
}

export function validateSelfEvolutionRollbackBody(
  input: unknown
): SelfEvolutionRollbackInput {
  const value = asRecord(input);
  return {
    rolledBackBy: nonEmptyString(value.rolledBackBy, "rolledBackBy"),
  };
}

function validateSubagents(input: unknown): SubagentRequest[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    throw new HttpError(400, "subagents must be an array");
  }

  return input.map((item, index) => {
    const value = asRecord(item);
    const role = nonEmptyString(
      value.role,
      `subagents[${index}].role`
    ) as SubagentRequest["role"];
    const objective = nonEmptyString(
      value.objective,
      `subagents[${index}].objective`
    );
    return {
      role,
      objective,
      allowedToolIds: optionalStringArray(
        value.allowedToolIds,
        `subagents[${index}].allowedToolIds`
      ),
      allowedMcpServers: optionalStringArray(
        value.allowedMcpServers,
        `subagents[${index}].allowedMcpServers`
      ),
      fileGlobs: optionalStringArray(
        value.fileGlobs,
        `subagents[${index}].fileGlobs`
      ),
      timeoutMs: optionalPositiveInteger(
        value.timeoutMs,
        `subagents[${index}].timeoutMs`
      ),
      maxBudgetUsd: optionalNumber(
        value.maxBudgetUsd,
        `subagents[${index}].maxBudgetUsd`
      ),
      maxDurationMs: optionalPositiveInteger(
        value.maxDurationMs,
        `subagents[${index}].maxDurationMs`
      ),
    };
  });
}

function validateAttachments(input: unknown): ChatMessageInput["attachments"] {
  if (input === undefined) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    throw new HttpError(400, "attachments must be an array");
  }
  if (input.length > 10) {
    throw new HttpError(400, "attachments must contain 10 or fewer items");
  }
  return input.map((item, index) => {
    const value = asRecord(item);
    return {
      name: nonEmptyString(value.name, `attachments[${index}].name`),
      contentType: nonEmptyString(
        value.contentType,
        `attachments[${index}].contentType`
      ),
      sizeBytes: boundedNonNegativeInteger(
        value.sizeBytes,
        `attachments[${index}].sizeBytes`,
        25_000_000
      ),
      description: optionalString(value.description),
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(
      400,
      "Optional string field must be a non-empty string when provided"
    );
  }
  return value.trim();
}

function optionalStringArray(
  value: unknown,
  field: string
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new HttpError(400, `${field} must be an array of strings`);
  }
  return value.map((item) => item.trim());
}

function optionalPositiveInteger(
  value: unknown,
  field: string
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, `${field} must be a positive integer`);
  }
  return value;
}

function optionalBoundedPositiveInteger(
  value: unknown,
  field: string,
  max: number
): number | undefined {
  const parsed = optionalPositiveInteger(value, field);
  if (parsed !== undefined && parsed > max) {
    throw new HttpError(400, `${field} must be less than or equal to ${max}`);
  }
  return parsed;
}

function boundedNonNegativeInteger(
  value: unknown,
  field: string,
  max: number
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  ) {
    throw new HttpError(
      400,
      `${field} must be an integer between 0 and ${max}`
    );
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new HttpError(400, `${field} must be a number`);
  }
  return value;
}

function optionalIsoDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new HttpError(400, `${field} must be a boolean`);
  }
  return value;
}

function isSelfEvolutionTarget(value: string): value is SelfEvolutionTarget {
  return ["prompt", "memory_policy", "tool", "role", "configuration"].includes(
    value
  );
}

function isSelfEvolutionRiskClass(
  value: string
): value is SelfEvolutionRiskClass {
  return ["low", "medium", "high", "critical"].includes(value);
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toJsonValue(value: unknown, field: string): JsonValue {
  if (value === undefined) {
    throw new HttpError(400, `${field} must be valid JSON`);
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    throw new HttpError(400, `${field} must be valid JSON`);
  }
}
