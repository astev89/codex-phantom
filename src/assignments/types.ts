import type { JsonValue } from "../shared/types.ts";

export type AssignmentLifecycleState =
  | "active"
  | "waiting"
  | "needs_approval"
  | "blocked"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export const ASSIGNMENT_LIFECYCLE_STATES = [
  "active",
  "waiting",
  "needs_approval",
  "blocked",
  "completed",
  "cancelled",
  "expired",
  "failed",
] as const satisfies readonly AssignmentLifecycleState[];

export type AssignmentAutonomyLevel =
  | "observe"
  | "draft"
  | "execute"
  | "operate"
  | "evolve";

export const ASSIGNMENT_AUTONOMY_LEVELS = [
  "observe",
  "draft",
  "execute",
  "operate",
  "evolve",
] as const satisfies readonly AssignmentAutonomyLevel[];

export type AssignmentEventImportance = "audit" | "milestone" | "detail";

export type AssignmentControlAction =
  | "pause"
  | "resume"
  | "cancel"
  | "force_wakeup"
  | "add_context"
  | "change_policy"
  | "reopen";

export type AssignmentNotificationCadence = {
  onCreate: boolean;
  onWakeupStart: boolean;
  onMeaningfulProgress: boolean;
  onBlocked: boolean;
  onFailure: boolean;
  onCompletion: boolean;
  activeProgressIntervalMinutes: number;
};

export type AssignmentPolicy = {
  maxWakeups: number;
  maxTotalRuntimeMinutes: number;
  maxConsecutiveFailures: number;
  maxIdleHours: number;
  wakeupDelayMinMinutes: number;
  wakeupDelayMaxMinutes: number;
  notificationCadence: AssignmentNotificationCadence;
};

export type AssignmentPolicyPatch = Partial<
  Omit<AssignmentPolicy, "notificationCadence">
> & {
  notificationCadence?: Partial<AssignmentNotificationCadence>;
};

export type AssignmentSource = {
  channelId?: string;
  conversationId?: string;
  userId?: string;
  inboundEventId?: string;
};

export type AssignmentRecord = {
  id: string;
  parentAssignmentId?: string;
  objective: string;
  title?: string;
  lifecycleState: AssignmentLifecycleState;
  autonomyLevel: AssignmentAutonomyLevel;
  source: AssignmentSource;
  policy: AssignmentPolicy;
  context: JsonValue[];
  metadata: JsonValue;
  wakeupCount: number;
  consecutiveFailureCount: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  terminalReason?: string;
};

export type AssignmentEventRetention = {
  compactable: boolean;
  expiresAt?: string;
};

export type AssignmentEventRecord = {
  id: string;
  assignmentId: string;
  type: string;
  importance: AssignmentEventImportance;
  compactable: boolean;
  retention: AssignmentEventRetention;
  payload: JsonValue;
  createdAt: string;
};

export type AssignmentRunLinkRecord = {
  id: string;
  assignmentId: string;
  runId: string;
  stepId?: string;
  action?: string;
  metadata: JsonValue;
  createdAt: string;
};

export type AssignmentDetail = {
  assignment: AssignmentRecord;
  runLinks: AssignmentRunLinkRecord[];
};

export type AssignmentTimeline = {
  assignmentId: string;
  events: AssignmentEventRecord[];
};

export type CreateAssignmentInput = {
  objective: string;
  title?: string;
  parentAssignmentId?: string;
  autonomyLevel?: AssignmentAutonomyLevel;
  source?: AssignmentSource;
  policy?: AssignmentPolicyPatch;
  metadata?: JsonValue;
  createdBy?: string;
};

export type ListAssignmentsInput = {
  lifecycleState?: AssignmentLifecycleState;
  autonomyLevel?: AssignmentAutonomyLevel;
  parentAssignmentId?: string;
  sourceChannelId?: string;
  limit?: number;
};

export type AssignmentControlInput = {
  action: AssignmentControlAction;
  actor?: string;
  reason?: string;
  context?: JsonValue;
  policy?: AssignmentPolicyPatch;
};

export type LinkAssignmentRunInput = {
  assignmentId: string;
  runId: string;
  stepId?: string;
  action?: string;
  metadata?: JsonValue;
};

export type AssignmentWakeupDecision =
  | "waiting"
  | "completed"
  | "blocked"
  | "expired"
  | "failed";

export type StartAssignmentWakeupInput = {
  assignmentId: string;
  actor?: string;
  reason?: string;
  source?: string;
};

export type CompleteAssignmentWakeupRunInput = {
  assignmentId: string;
  runId: string;
  outputText?: string;
};

export type FailAssignmentWakeupInput = {
  assignmentId: string;
  error: string;
};

export type ApplyAssignmentWakeupDecisionInput = {
  assignmentId: string;
  decision: AssignmentWakeupDecision;
  reason: string;
  nextWakeupAt?: string;
};
