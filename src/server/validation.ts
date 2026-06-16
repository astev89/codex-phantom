import type { JsonValue } from "../shared/types.ts";
import type { SubagentRequest } from "../orchestration/types.ts";
import type {
  AssignmentAutonomyLevel,
  AssignmentControlAction,
  AssignmentPolicy,
  AssignmentPolicyPatch,
  AssignmentSource,
  AssignmentControlInput,
  CreateAssignmentInput,
} from "../assignments/types.ts";
import { ASSIGNMENT_AUTONOMY_LEVELS } from "../assignments/types.ts";
import type { AssignmentIntakeCommand } from "../assignments/intake.ts";
import type {
  CreateSelfEvolutionProposalInput,
  SelfEvolutionRiskClass,
  SelfEvolutionTarget,
} from "../self-evolution/proposals.ts";
import type { AutonomousMutationTarget } from "../assignments/mutation-ledger.ts";
import { AUTONOMOUS_MUTATION_TARGETS } from "../assignments/mutation-ledger.ts";

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
  assignment?: AssignmentIntakeCommand;
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

export type ToolBundlePreviewInput = {
  manifest: JsonValue;
  importedBy?: string;
};

export type ToolBundleLifecycleInput = {
  actor: string;
  notes?: string;
};

export type AssignmentCreateInput = CreateAssignmentInput;
export type AssignmentControlBodyInput = AssignmentControlInput;
export type AutonomousMutationApplyBodyInput = {
  target: AutonomousMutationTarget;
  mutationType: string;
  rationale: string;
  runId?: string;
  actor?: string;
  riskClass?: SelfEvolutionRiskClass;
  proposedChange: JsonValue;
};

export type AutonomousMutationRollbackBodyInput = {
  actor?: string;
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
    assignment: validateAssignmentIntakeCommand(value.assignment),
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

export function validateToolBundlePreviewBody(
  input: unknown
): ToolBundlePreviewInput {
  const value = asRecord(input);
  const manifest = toJsonValue(value.manifest, "manifest");
  return {
    manifest,
    importedBy: optionalString(value.importedBy),
  };
}

export function validateToolBundleLifecycleBody(
  input: unknown
): ToolBundleLifecycleInput {
  const value = asRecord(input);
  return {
    actor: nonEmptyString(value.actor, "actor"),
    notes: optionalString(value.notes),
  };
}

export function validateAssignmentCreateBody(
  input: unknown
): AssignmentCreateInput {
  const value = asRecord(input);
  const autonomyLevel =
    value.autonomyLevel === undefined
      ? undefined
      : requireAssignmentAutonomyLevel(value.autonomyLevel, "autonomyLevel");
  return {
    objective: nonEmptyString(value.objective, "objective"),
    title: optionalString(value.title),
    parentAssignmentId: optionalString(value.parentAssignmentId),
    autonomyLevel,
    source: validateAssignmentSource(value.source),
    policy: validateAssignmentPolicyPatch(value.policy),
    metadata:
      value.metadata === undefined
        ? undefined
        : toJsonValue(value.metadata, "metadata"),
    createdBy: optionalString(value.createdBy),
  };
}

export function validateAssignmentControlBody(
  input: unknown
): AssignmentControlBodyInput {
  const value = asRecord(input);
  const action = requireAssignmentControlAction(value.action, "action");
  return {
    action,
    actor: optionalString(value.actor),
    reason: optionalString(value.reason),
    context:
      value.context === undefined
        ? undefined
        : toJsonValue(value.context, "context"),
    policy: validateAssignmentPolicyPatch(value.policy),
  };
}

export function validateAutonomousMutationApplyBody(
  input: unknown
): AutonomousMutationApplyBodyInput {
  const value = asRecord(input);
  const target = nonEmptyString(value.target, "target");
  if (!isAutonomousMutationTarget(target)) {
    throw new HttpError(
      400,
      "target must be prompt, memory_policy, tool, role, configuration, or project_file"
    );
  }
  const riskClass =
    value.riskClass === undefined
      ? undefined
      : nonEmptyString(value.riskClass, "riskClass");
  if (riskClass !== undefined && !isSelfEvolutionRiskClass(riskClass)) {
    throw new HttpError(
      400,
      "riskClass must be low, medium, high, or critical"
    );
  }
  const proposedChange = toJsonValue(value.proposedChange, "proposedChange");
  if (!isJsonObject(proposedChange)) {
    throw new HttpError(400, "proposedChange must be a JSON object");
  }
  return {
    target,
    mutationType: nonEmptyString(value.mutationType, "mutationType"),
    rationale: nonEmptyString(value.rationale, "rationale"),
    runId: optionalString(value.runId),
    actor: optionalString(value.actor),
    riskClass,
    proposedChange,
  };
}

export function validateAutonomousMutationRollbackBody(
  input: unknown
): AutonomousMutationRollbackBodyInput {
  const value = asRecord(input);
  return {
    actor: optionalString(value.actor),
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

function validateAssignmentSource(
  input: unknown
): AssignmentSource | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  const value = asRecord(input, "source");
  return {
    channelId: optionalString(value.channelId),
    conversationId: optionalString(value.conversationId),
    userId: optionalString(value.userId),
    inboundEventId: optionalString(value.inboundEventId),
  };
}

function validateAssignmentPolicyPatch(
  input: unknown
): AssignmentPolicyPatch | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  const value = asRecord(input, "policy");
  const notificationCadence =
    value.notificationCadence === undefined
      ? undefined
      : validateAssignmentNotificationCadence(value.notificationCadence);
  const selfEvolution =
    value.selfEvolution === undefined
      ? undefined
      : validateAssignmentSelfEvolutionPolicy(value.selfEvolution);
  return {
    maxWakeups: optionalPositiveInteger(value.maxWakeups, "maxWakeups"),
    maxTotalRuntimeMinutes: optionalPositiveInteger(
      value.maxTotalRuntimeMinutes,
      "maxTotalRuntimeMinutes"
    ),
    maxConsecutiveFailures: optionalPositiveInteger(
      value.maxConsecutiveFailures,
      "maxConsecutiveFailures"
    ),
    maxIdleHours: optionalPositiveInteger(value.maxIdleHours, "maxIdleHours"),
    wakeupDelayMinMinutes: optionalPositiveInteger(
      value.wakeupDelayMinMinutes,
      "wakeupDelayMinMinutes"
    ),
    wakeupDelayMaxMinutes: optionalPositiveInteger(
      value.wakeupDelayMaxMinutes,
      "wakeupDelayMaxMinutes"
    ),
    notificationCadence,
    selfEvolution,
  };
}

function validateAssignmentIntakeCommand(
  input: unknown
): AssignmentIntakeCommand | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  const value = asRecord(input, "assignment");
  return {
    create:
      value.create === undefined
        ? undefined
        : requireBoolean(value.create, "assignment.create"),
    title: optionalString(value.title),
    autonomyLevel:
      value.autonomyLevel === undefined
        ? undefined
        : requireAssignmentAutonomyLevel(
            value.autonomyLevel,
            "assignment.autonomyLevel"
          ),
    policy: validateAssignmentPolicyPatch(value.policy),
  };
}

function validateAssignmentNotificationCadence(
  input: unknown
): Partial<AssignmentPolicy["notificationCadence"]> {
  const value = asRecord(input, "notificationCadence");
  return {
    onCreate:
      value.onCreate === undefined
        ? undefined
        : requireBoolean(value.onCreate, "notificationCadence.onCreate"),
    onWakeupStart:
      value.onWakeupStart === undefined
        ? undefined
        : requireBoolean(
            value.onWakeupStart,
            "notificationCadence.onWakeupStart"
          ),
    onMeaningfulProgress:
      value.onMeaningfulProgress === undefined
        ? undefined
        : requireBoolean(
            value.onMeaningfulProgress,
            "notificationCadence.onMeaningfulProgress"
          ),
    onBlocked:
      value.onBlocked === undefined
        ? undefined
        : requireBoolean(value.onBlocked, "notificationCadence.onBlocked"),
    onFailure:
      value.onFailure === undefined
        ? undefined
        : requireBoolean(value.onFailure, "notificationCadence.onFailure"),
    onCompletion:
      value.onCompletion === undefined
        ? undefined
        : requireBoolean(
            value.onCompletion,
            "notificationCadence.onCompletion"
          ),
    activeProgressIntervalMinutes: optionalPositiveInteger(
      value.activeProgressIntervalMinutes,
      "notificationCadence.activeProgressIntervalMinutes"
    ),
  };
}

function validateAssignmentSelfEvolutionPolicy(
  input: unknown
): Partial<AssignmentPolicy["selfEvolution"]> {
  const value = asRecord(input, "selfEvolution");
  const maxRiskClass =
    value.maxRiskClass === undefined
      ? undefined
      : nonEmptyString(value.maxRiskClass, "selfEvolution.maxRiskClass");
  if (maxRiskClass !== undefined && !isSelfEvolutionRiskClass(maxRiskClass)) {
    throw new HttpError(
      400,
      "selfEvolution.maxRiskClass must be low, medium, high, or critical"
    );
  }
  return {
    enabled:
      value.enabled === undefined
        ? undefined
        : requireBoolean(value.enabled, "selfEvolution.enabled"),
    allowedMutationClasses: optionalStringArray(
      value.allowedMutationClasses,
      "selfEvolution.allowedMutationClasses"
    ),
    maxRiskClass,
  };
}

function requireAssignmentAutonomyLevel(
  value: unknown,
  field: string
): AssignmentAutonomyLevel {
  if (
    typeof value !== "string" ||
    !ASSIGNMENT_AUTONOMY_LEVELS.includes(value as AssignmentAutonomyLevel)
  ) {
    throw new HttpError(
      400,
      `${field} must be observe, draft, execute, operate, or evolve`
    );
  }
  return value as AssignmentAutonomyLevel;
}

function requireAssignmentControlAction(
  value: unknown,
  field: string
): AssignmentControlAction {
  if (
    typeof value !== "string" ||
    ![
      "pause",
      "resume",
      "cancel",
      "force_wakeup",
      "add_context",
      "change_policy",
      "reopen",
    ].includes(value)
  ) {
    throw new HttpError(
      400,
      `${field} must be a valid assignment control action`
    );
  }
  return value as AssignmentControlAction;
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

function asRecord(value: unknown, field = "Body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${field} must be a JSON object`);
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

function isAutonomousMutationTarget(
  value: string
): value is AutonomousMutationTarget {
  return AUTONOMOUS_MUTATION_TARGETS.includes(
    value as AutonomousMutationTarget
  );
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
