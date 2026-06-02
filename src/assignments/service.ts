import { createId } from "../shared/ids.ts";
import type { JsonValue } from "../shared/types.ts";
import {
  decodeJson,
  encodeJson,
  type AppDatabase,
} from "../platform/database.ts";
import type {
  AssignmentAutonomyLevel,
  AssignmentControlInput,
  AssignmentDetail,
  AssignmentEventImportance,
  AssignmentEventRecord,
  AssignmentLifecycleState,
  AssignmentPolicy,
  AssignmentRecord,
  AssignmentRunLinkRecord,
  AssignmentSource,
  AssignmentTimeline,
  CreateAssignmentInput,
  LinkAssignmentRunInput,
  ListAssignmentsInput,
} from "./types.ts";

type AssignmentRow = {
  id: string;
  parent_assignment_id: string | null;
  objective: string;
  title: string | null;
  lifecycle_state: AssignmentLifecycleState;
  autonomy_level: AssignmentAutonomyLevel;
  source_json: string;
  policy_json: string;
  context_json: string;
  metadata_json: string;
  wakeup_count: number;
  consecutive_failure_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  terminal_reason: string | null;
};

type AssignmentEventRow = {
  id: string;
  assignment_id: string;
  type: string;
  importance: AssignmentEventImportance;
  compactable: number;
  expires_at: string | null;
  payload_json: string;
  created_at: string;
};

type AssignmentRunLinkRow = {
  id: string;
  assignment_id: string;
  run_id: string;
  step_id: string | null;
  action: string | null;
  metadata_json: string;
  created_at: string;
};

export class AssignmentNotFoundError extends Error {
  constructor(id: string) {
    super(
      `Unknown assignment ${id}. Use assignment.list to find available assignments.`
    );
  }
}

export class AssignmentValidationError extends Error {}

export class AutonomousAssignmentService {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  create(input: CreateAssignmentInput): AssignmentDetail {
    const objective = input.objective.trim();
    if (!objective) {
      throw new AssignmentValidationError(
        "objective must be a non-empty string"
      );
    }

    const now = new Date().toISOString();
    const assignment: AssignmentRecord = {
      id: createId("asgn"),
      parentAssignmentId: input.parentAssignmentId,
      objective,
      title: normalizeOptionalText(input.title),
      lifecycleState: "active",
      autonomyLevel: input.autonomyLevel ?? "execute",
      source: normalizeSource(input.source),
      policy: buildAssignmentPolicy(input.policy),
      context: [],
      metadata: input.metadata ?? {},
      wakeupCount: 0,
      consecutiveFailureCount: 0,
      createdBy: normalizeOptionalText(input.createdBy),
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };

    this.database.transaction(() => {
      this.insertAssignment(assignment);
      this.recordEvent({
        assignmentId: assignment.id,
        type: "created",
        importance: "audit",
        compactable: false,
        payload: {
          objective: assignment.objective,
          autonomyLevel: assignment.autonomyLevel,
          source: assignment.source,
          createdBy: assignment.createdBy ?? null,
        },
        createdAt: now,
      });
    });

    return this.getRequired(assignment.id);
  }

  list(input: ListAssignmentsInput = {}): AssignmentRecord[] {
    const limit = boundLimit(input.limit, 100);
    const filters: string[] = [];
    const values: Array<string | number> = [];
    if (input.lifecycleState) {
      filters.push("lifecycle_state = ?");
      values.push(input.lifecycleState);
    }
    if (input.autonomyLevel) {
      filters.push("autonomy_level = ?");
      values.push(input.autonomyLevel);
    }
    if (input.parentAssignmentId) {
      filters.push("parent_assignment_id = ?");
      values.push(input.parentAssignmentId);
    }
    if (input.sourceChannelId) {
      filters.push("json_extract(source_json, '$.channelId') = ?");
      values.push(input.sourceChannelId);
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = this.database.all<AssignmentRow>(
      `SELECT * FROM assignments ${where} ORDER BY updated_at DESC LIMIT ?`,
      ...values,
      limit
    );
    return rows.map(toAssignmentRecord);
  }

  get(assignmentId: string): AssignmentDetail | null {
    const assignment = this.database.get<AssignmentRow>(
      "SELECT * FROM assignments WHERE id = ?",
      assignmentId
    );
    if (!assignment) {
      return null;
    }
    return {
      assignment: toAssignmentRecord(assignment),
      runLinks: this.listRunLinks(assignmentId),
    };
  }

  getRequired(assignmentId: string): AssignmentDetail {
    const detail = this.get(assignmentId);
    if (!detail) {
      throw new AssignmentNotFoundError(assignmentId);
    }
    return detail;
  }

  control(
    assignmentId: string,
    input: AssignmentControlInput
  ): AssignmentDetail {
    const actor = normalizeOptionalText(input.actor) ?? "operator";
    const now = new Date().toISOString();
    const current = this.getRequired(assignmentId).assignment;

    if (input.action === "add_context") {
      if (input.context === undefined) {
        throw new AssignmentValidationError(
          "context is required for add_context"
        );
      }
      const context = input.context;
      const nextContext = [...current.context, input.context];
      this.database.transaction(() => {
        this.updateAssignment(assignmentId, {
          context_json: encodeJson(nextContext),
          updated_at: now,
          last_activity_at: now,
        });
        this.recordEvent({
          assignmentId,
          type: "context_added",
          importance: "detail",
          compactable: true,
          expiresAt: hoursFrom(now, 24 * 30),
          payload: { actor, context },
          createdAt: now,
        });
      });
      return this.getRequired(assignmentId);
    }

    if (input.action === "change_policy") {
      if (!input.policy || Object.keys(input.policy).length === 0) {
        throw new AssignmentValidationError(
          "policy is required for change_policy"
        );
      }
      const policy = buildAssignmentPolicy({
        ...current.policy,
        ...input.policy,
        notificationCadence: {
          ...current.policy.notificationCadence,
          ...input.policy.notificationCadence,
        },
      });
      this.database.transaction(() => {
        this.updateAssignment(assignmentId, {
          policy_json: encodeJson(policy),
          updated_at: now,
          last_activity_at: now,
        });
        this.recordEvent({
          assignmentId,
          type: "policy_changed",
          importance: "audit",
          compactable: false,
          payload: { actor, policy, reason: input.reason ?? null },
          createdAt: now,
        });
      });
      return this.getRequired(assignmentId);
    }

    const transition = transitionForControl(
      current.lifecycleState,
      input.action
    );
    this.database.transaction(() => {
      if (transition.nextState) {
        this.updateAssignment(assignmentId, {
          lifecycle_state: transition.nextState,
          terminal_reason: transition.terminalReason ?? null,
          updated_at: now,
          last_activity_at: now,
        });
      } else {
        this.updateAssignment(assignmentId, {
          updated_at: now,
          last_activity_at: now,
        });
      }
      const payload: Record<string, JsonValue> = {
        actor,
        action: input.action,
        reason: input.reason ?? null,
        previousLifecycleState: current.lifecycleState,
        nextLifecycleState: transition.nextState ?? current.lifecycleState,
      };
      if (input.action === "force_wakeup") {
        payload.plannerStatus = "placeholder_only";
      }
      this.recordEvent({
        assignmentId,
        type: transition.eventType,
        importance: transition.importance,
        compactable: transition.compactable,
        expiresAt: transition.compactable ? hoursFrom(now, 24 * 30) : undefined,
        payload,
        createdAt: now,
      });
    });

    return this.getRequired(assignmentId);
  }

  timeline(assignmentId: string, limit = 100): AssignmentTimeline {
    if (!this.get(assignmentId)) {
      throw new AssignmentNotFoundError(assignmentId);
    }
    const rows = this.database.all<AssignmentEventRow>(
      `SELECT * FROM assignment_events
       WHERE assignment_id = ?
       ORDER BY created_at ASC, rowid ASC
       LIMIT ?`,
      assignmentId,
      boundLimit(limit, 250)
    );
    return {
      assignmentId,
      events: rows.map(toAssignmentEventRecord),
    };
  }

  linkRun(input: LinkAssignmentRunInput): AssignmentRunLinkRecord {
    this.getRequired(input.assignmentId);
    const now = new Date().toISOString();
    const link: AssignmentRunLinkRecord = {
      id: createId("asgnrun"),
      assignmentId: input.assignmentId,
      runId: input.runId,
      stepId: normalizeOptionalText(input.stepId),
      action: normalizeOptionalText(input.action),
      metadata: input.metadata ?? {},
      createdAt: now,
    };

    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO assignment_run_links (
          id, assignment_id, run_id, step_id, action, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        link.id,
        link.assignmentId,
        link.runId,
        link.stepId ?? null,
        link.action ?? null,
        encodeJson(link.metadata),
        link.createdAt
      );
      this.updateAssignment(input.assignmentId, {
        updated_at: now,
        last_activity_at: now,
      });
      this.recordEvent({
        assignmentId: input.assignmentId,
        type: "run_linked",
        importance: "audit",
        compactable: false,
        payload: {
          linkId: link.id,
          runId: link.runId,
          stepId: link.stepId ?? null,
          action: link.action ?? null,
        },
        createdAt: now,
      });
    });

    return link;
  }

  private insertAssignment(assignment: AssignmentRecord): void {
    this.database.run(
      `INSERT INTO assignments (
        id, parent_assignment_id, objective, title, lifecycle_state,
        autonomy_level, source_json, policy_json, context_json, metadata_json,
        wakeup_count, consecutive_failure_count, created_by, created_at,
        updated_at, last_activity_at, terminal_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      assignment.id,
      assignment.parentAssignmentId ?? null,
      assignment.objective,
      assignment.title ?? null,
      assignment.lifecycleState,
      assignment.autonomyLevel,
      encodeJson(assignment.source),
      encodeJson(assignment.policy),
      encodeJson(assignment.context),
      encodeJson(assignment.metadata),
      assignment.wakeupCount,
      assignment.consecutiveFailureCount,
      assignment.createdBy ?? null,
      assignment.createdAt,
      assignment.updatedAt,
      assignment.lastActivityAt,
      assignment.terminalReason ?? null
    );
  }

  private updateAssignment(
    assignmentId: string,
    values: Record<string, string | number | null>
  ): void {
    const keys = Object.keys(values);
    if (keys.length === 0) {
      return;
    }
    this.database.run(
      `UPDATE assignments SET ${keys.map((key) => `${key} = ?`).join(", ")}
       WHERE id = ?`,
      ...keys.map((key) => values[key] ?? null),
      assignmentId
    );
  }

  private recordEvent(input: {
    assignmentId: string;
    type: string;
    importance: AssignmentEventImportance;
    compactable: boolean;
    expiresAt?: string;
    payload: JsonValue;
    createdAt: string;
  }): AssignmentEventRecord {
    const event: AssignmentEventRecord = {
      id: createId("asgnevt"),
      assignmentId: input.assignmentId,
      type: input.type,
      importance: input.importance,
      compactable: input.compactable,
      retention: {
        compactable: input.compactable,
        expiresAt: input.expiresAt,
      },
      payload: input.payload,
      createdAt: input.createdAt,
    };
    this.database.run(
      `INSERT INTO assignment_events (
        id, assignment_id, type, importance, compactable, expires_at,
        payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id,
      event.assignmentId,
      event.type,
      event.importance,
      event.compactable ? 1 : 0,
      event.retention.expiresAt ?? null,
      encodeJson(event.payload),
      event.createdAt
    );
    return event;
  }

  private listRunLinks(assignmentId: string): AssignmentRunLinkRecord[] {
    return this.database
      .all<AssignmentRunLinkRow>(
        `SELECT * FROM assignment_run_links
         WHERE assignment_id = ?
         ORDER BY created_at ASC, rowid ASC`,
        assignmentId
      )
      .map(toAssignmentRunLinkRecord);
  }
}

export function defaultAssignmentPolicy(): AssignmentPolicy {
  return {
    maxWakeups: 5,
    maxTotalRuntimeMinutes: 60,
    maxConsecutiveFailures: 2,
    maxIdleHours: 24,
    wakeupDelayMinMinutes: 5,
    wakeupDelayMaxMinutes: 4 * 60,
    notificationCadence: {
      onCreate: true,
      onWakeupStart: true,
      onMeaningfulProgress: true,
      onBlocked: true,
      onFailure: true,
      onCompletion: true,
      activeProgressIntervalMinutes: 30,
    },
  };
}

function buildAssignmentPolicy(
  input?: Partial<AssignmentPolicy>
): AssignmentPolicy {
  const defaults = defaultAssignmentPolicy();
  const patch = stripUndefined(input ?? {});
  const notificationCadence = stripUndefined(input?.notificationCadence ?? {});
  const policy = {
    ...defaults,
    ...patch,
    notificationCadence: {
      ...defaults.notificationCadence,
      ...notificationCadence,
    },
  };
  validatePositiveInteger(policy.maxWakeups, "maxWakeups");
  validatePositiveInteger(
    policy.maxTotalRuntimeMinutes,
    "maxTotalRuntimeMinutes"
  );
  validatePositiveInteger(
    policy.maxConsecutiveFailures,
    "maxConsecutiveFailures"
  );
  validatePositiveInteger(policy.maxIdleHours, "maxIdleHours");
  validatePositiveInteger(
    policy.wakeupDelayMinMinutes,
    "wakeupDelayMinMinutes"
  );
  validatePositiveInteger(
    policy.wakeupDelayMaxMinutes,
    "wakeupDelayMaxMinutes"
  );
  validatePositiveInteger(
    policy.notificationCadence.activeProgressIntervalMinutes,
    "activeProgressIntervalMinutes"
  );
  if (policy.wakeupDelayMinMinutes > policy.wakeupDelayMaxMinutes) {
    throw new AssignmentValidationError(
      "wakeupDelayMinMinutes must be less than or equal to wakeupDelayMaxMinutes"
    );
  }
  return policy;
}

function stripUndefined<T extends Record<string, unknown>>(
  input: T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([_key, value]) => value !== undefined)
  ) as Partial<T>;
}

function transitionForControl(
  current: AssignmentLifecycleState,
  action: AssignmentControlInput["action"]
): {
  nextState?: AssignmentLifecycleState;
  terminalReason?: string;
  eventType: string;
  importance: AssignmentEventImportance;
  compactable: boolean;
} {
  switch (action) {
    case "pause":
      return {
        nextState: "waiting",
        eventType: "paused",
        importance: "milestone",
        compactable: false,
      };
    case "resume":
      return {
        nextState: "active",
        eventType: "resumed",
        importance: "milestone",
        compactable: false,
      };
    case "cancel":
      return {
        nextState: "cancelled",
        terminalReason: "operator_cancelled",
        eventType: "cancelled",
        importance: "audit",
        compactable: false,
      };
    case "force_wakeup":
      return {
        eventType: "planner_wakeup_requested",
        importance: "milestone",
        compactable: false,
      };
    case "reopen":
      return {
        nextState: "active",
        eventType: "reopened",
        importance: "audit",
        compactable: false,
      };
    default:
      throw new AssignmentValidationError(
        `Unsupported control action for lifecycle transition: ${action}`
      );
  }
}

function toAssignmentRecord(row: AssignmentRow): AssignmentRecord {
  return {
    id: row.id,
    parentAssignmentId: row.parent_assignment_id ?? undefined,
    objective: row.objective,
    title: row.title ?? undefined,
    lifecycleState: row.lifecycle_state,
    autonomyLevel: row.autonomy_level,
    source: decodeJson<AssignmentSource>(row.source_json, {}),
    policy: decodeJson<AssignmentPolicy>(
      row.policy_json,
      defaultAssignmentPolicy()
    ),
    context: decodeJson<JsonValue[]>(row.context_json, []),
    metadata: decodeJson<JsonValue>(row.metadata_json, {}),
    wakeupCount: row.wakeup_count,
    consecutiveFailureCount: row.consecutive_failure_count,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    terminalReason: row.terminal_reason ?? undefined,
  };
}

function toAssignmentEventRecord(
  row: AssignmentEventRow
): AssignmentEventRecord {
  const compactable = row.compactable === 1;
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    type: row.type,
    importance: row.importance,
    compactable,
    retention: {
      compactable,
      expiresAt: row.expires_at ?? undefined,
    },
    payload: decodeJson<JsonValue>(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

function toAssignmentRunLinkRecord(
  row: AssignmentRunLinkRow
): AssignmentRunLinkRecord {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    runId: row.run_id,
    stepId: row.step_id ?? undefined,
    action: row.action ?? undefined,
    metadata: decodeJson<JsonValue>(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function normalizeSource(input?: AssignmentSource): AssignmentSource {
  return {
    channelId: normalizeOptionalText(input?.channelId),
    conversationId: normalizeOptionalText(input?.conversationId),
    userId: normalizeOptionalText(input?.userId),
    inboundEventId: normalizeOptionalText(input?.inboundEventId),
  };
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function validatePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AssignmentValidationError(`${field} must be a positive integer`);
  }
}

function boundLimit(value: number | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new AssignmentValidationError("limit must be a positive integer");
  }
  return Math.min(value, 500);
}

function hoursFrom(iso: string, hours: number): string {
  return new Date(
    new Date(iso).getTime() + hours * 60 * 60 * 1000
  ).toISOString();
}
