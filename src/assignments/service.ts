import { createId } from "../shared/ids.ts";
import type { JsonValue } from "../shared/types.ts";
import {
  decodeJson,
  encodeJson,
  type AppDatabase,
} from "../platform/database.ts";
import { ASSIGNMENT_AUTONOMY_LEVELS } from "./types.ts";
import type {
  AssignmentAutonomyLevel,
  AssignmentChildDependencyWaitMode,
  AssignmentChildPolicy,
  AssignmentControlInput,
  AssignmentDetail,
  AssignmentEventImportance,
  AssignmentEventRecord,
  AssignmentLifecycleState,
  AssignmentNotificationCadence,
  AssignmentPolicy,
  AssignmentPolicyPatch,
  AssignmentRecord,
  AssignmentRunLinkRecord,
  AssignmentSelfEvolutionPolicy,
  AssignmentSelfEvolutionRiskClass,
  AssignmentSource,
  AssignmentTimeline,
  CompactAssignmentEventsInput,
  CompactAssignmentEventsResult,
  ApplyAssignmentWakeupDecisionInput,
  CompleteAssignmentWakeupRunInput,
  CreateAssignmentInput,
  FailAssignmentWakeupInput,
  LinkAssignmentRunInput,
  ListAssignmentsInput,
  PromoteChildAssignmentInput,
  PromoteChildAssignmentResult,
  RecordAssignmentMutationEventInput,
  StartAssignmentWakeupInput,
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

type CountRow = {
  count: number;
};

type ParentAssignmentRow = {
  parent_assignment_id: string | null;
};

export type AssignmentDependencyResolutionResult = {
  parentAssignmentId: string;
  activatedChildIds: string[];
  blockedChildIds: string[];
  activeWaitedChildIds: string[];
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
    if (input.parentAssignmentId) {
      return this.promoteChild({
        parentAssignmentId: input.parentAssignmentId,
        objective: input.objective,
        title: input.title,
        autonomyLevel: input.autonomyLevel,
        source: input.source,
        policy: input.policy,
        metadata: input.metadata,
        actor: input.createdBy,
        rationale: "Created as child assignment",
        waitForChild: false,
      }).child;
    }

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

  promoteChild(
    input: PromoteChildAssignmentInput
  ): PromoteChildAssignmentResult {
    const parent = this.getRequired(input.parentAssignmentId).assignment;
    if (isTerminalLifecycleState(parent.lifecycleState)) {
      throw new AssignmentValidationError(
        "Terminal assignments cannot promote child assignments"
      );
    }
    const objective = input.objective.trim();
    if (!objective) {
      throw new AssignmentValidationError(
        "objective must be a non-empty string"
      );
    }
    const rationale = input.rationale.trim();
    if (!rationale) {
      throw new AssignmentValidationError(
        "rationale must be a non-empty string"
      );
    }
    const childDepth = this.assignmentDepth(parent.id) + 1;
    if (childDepth > parent.policy.childAssignments.maxDepth) {
      throw new AssignmentValidationError(
        "Parent assignment child assignment depth limit has been reached"
      );
    }
    const activeChildren = this.countActiveChildren(parent.id);
    if (activeChildren >= parent.policy.childAssignments.maxActiveChildren) {
      throw new AssignmentValidationError(
        "Parent assignment active child assignment limit has been reached"
      );
    }
    const remainingWakeups =
      parent.policy.maxWakeups -
      parent.wakeupCount -
      this.reservedActiveChildWakeupBudget(parent.id);
    if (remainingWakeups <= 0) {
      throw new AssignmentValidationError(
        "Parent assignment remaining wakeup budget has been exhausted"
      );
    }
    const requestedPolicy = buildAssignmentPolicyPatch(
      parent.policy,
      input.policy
    );
    const childPolicy = capChildPolicyToParent(
      requestedPolicy,
      parent.policy,
      remainingWakeups
    );

    const dependencies = this.normalizeChildDependencies(parent.id, input);
    const dependencyState = this.evaluateChildDependencyState(dependencies);
    const now = new Date().toISOString();
    const waitForChild = input.waitForChild === true;
    const actor = normalizeOptionalText(input.actor) ?? "planner";
    const child: AssignmentRecord = {
      id: createId("asgn"),
      parentAssignmentId: parent.id,
      objective,
      title: normalizeOptionalText(input.title),
      lifecycleState:
        dependencyState === "waiting"
          ? "waiting"
          : dependencyState === "blocked"
            ? "blocked"
            : "active",
      autonomyLevel: capAutonomyLevel(
        input.autonomyLevel ?? parent.autonomyLevel,
        parent.autonomyLevel
      ),
      source: normalizeSource(input.source ?? parent.source),
      policy: childPolicy,
      context: input.context ?? [],
      metadata: mergeChildMetadata(input.metadata, {
        parentAssignmentId: parent.id,
        parentWaitsForChild: waitForChild,
        ...(dependencies
          ? {
              childDependencyConfigValidated: true,
              dependsOnChildIds: dependencies.dependsOnChildIds,
              waitForChildren: dependencies.waitForChildren,
            }
          : {}),
      }),
      wakeupCount: 0,
      consecutiveFailureCount: 0,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };

    this.database.transaction(() => {
      this.insertAssignment(child);
      this.recordEvent({
        assignmentId: child.id,
        type: "created",
        importance: "audit",
        compactable: false,
        payload: {
          objective: child.objective,
          autonomyLevel: child.autonomyLevel,
          source: child.source,
          parentAssignmentId: parent.id,
          createdBy: child.createdBy ?? null,
        },
        createdAt: now,
      });
      this.updateAssignment(parent.id, {
        updated_at: now,
        last_activity_at: now,
      });
      this.recordEvent({
        assignmentId: parent.id,
        type: "child_assignment_created",
        importance: "milestone",
        compactable: false,
        payload: {
          actor,
          childAssignmentId: child.id,
          objective: child.objective,
          rationale,
          waitForChild,
          ...(dependencies
            ? {
                dependsOnChildIds: dependencies.dependsOnChildIds,
                waitForChildren: dependencies.waitForChildren,
              }
            : {}),
        },
        createdAt: now,
      });
      if (dependencyState === "blocked") {
        this.recordEvent({
          assignmentId: child.id,
          type: "blocked",
          importance: "audit",
          compactable: false,
          payload: {
            decision: "blocked",
            reason: "Required child assignment dependency failed",
            blockingDependencies: this.childDependencyEvidence(child),
            nextWakeupAt: null,
          },
          createdAt: now,
        });
      } else if (dependencyState === "waiting") {
        this.recordEvent({
          assignmentId: child.id,
          type: "waiting",
          importance: "milestone",
          compactable: false,
          payload: {
            decision: "waiting",
            reason: "Waiting for child assignment dependencies",
            blockingDependencies: this.childDependencyEvidence(child),
            nextWakeupAt: null,
          },
          createdAt: now,
        });
      }
    });

    return {
      parent: this.getRequired(parent.id),
      child: this.getRequired(child.id),
    };
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

  findByIntakeProviderEvent(input: {
    channelId: string;
    providerEventId: string;
  }): AssignmentDetail | null {
    const assignment = this.database.get<AssignmentRow>(
      `SELECT * FROM assignments
        WHERE json_extract(source_json, '$.channelId') = ?
          AND json_extract(metadata_json, '$.intake.providerEventId') = ?
        ORDER BY updated_at DESC
        LIMIT 1`,
      input.channelId,
      input.providerEventId
    );
    return assignment ? this.get(assignment.id) : null;
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

    if (
      input.action === "resume" &&
      current.parentAssignmentId &&
      !this.parentHasCapacityToReactivateChild(current)
    ) {
      throw new AssignmentValidationError(
        "Assignment parent has no child capacity to resume this assignment"
      );
    }

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
      if (!hasPolicyPatch(input.policy)) {
        throw new AssignmentValidationError(
          "policy is required for change_policy"
        );
      }
      const policy = buildAssignmentPolicyPatch(current.policy, input.policy);
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

    const detail = this.getRequired(assignmentId);
    if (
      detail.assignment.parentAssignmentId &&
      input.resolveDependencies !== false
    ) {
      this.resolveChildDependencies(detail.assignment.parentAssignmentId);
      return this.getRequired(assignmentId);
    }
    return detail;
  }

  recordChildPromotionFailure(input: {
    assignmentId: string;
    actor?: string;
    objective: string;
    rationale: string;
    errorMessage: string;
  }): AssignmentEventRecord {
    this.getRequired(input.assignmentId);
    const now = new Date().toISOString();
    this.updateAssignment(input.assignmentId, {
      updated_at: now,
      last_activity_at: now,
    });
    return this.recordEvent({
      assignmentId: input.assignmentId,
      type: "child_assignment_failed",
      importance: "milestone",
      compactable: false,
      payload: {
        actor: normalizeOptionalText(input.actor) ?? "planner",
        objective: input.objective,
        rationale: input.rationale,
        errorMessage: input.errorMessage,
      },
      createdAt: now,
    });
  }

  resolveChildDependencies(
    parentAssignmentId: string
  ): AssignmentDependencyResolutionResult {
    this.getRequired(parentAssignmentId);
    const activatedChildIds: string[] = [];
    const blockedChildIds: string[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      const children = this.listChildren(parentAssignmentId);
      for (const child of children) {
        if (isTerminalLifecycleState(child.lifecycleState)) {
          continue;
        }
        const dependencies = dependencyConfigFromMetadata(child.metadata);
        if (!dependencies) {
          continue;
        }
        const state = evaluateChildDependencies(children, dependencies);
        if (state === "blocked" && child.lifecycleState !== "blocked") {
          this.applyWakeupDecision({
            assignmentId: child.id,
            decision: "blocked",
            reason: "Required child assignment dependency failed",
            resolveDependencies: false,
          });
          blockedChildIds.push(child.id);
          changed = true;
        } else if (
          state === "satisfied" &&
          ((child.lifecycleState === "waiting" &&
            this.isDependencyWaiting(child.id)) ||
            (child.lifecycleState === "blocked" &&
              this.isDependencyBlocked(child.id) &&
              !this.shouldRestoreWaitingAfterDependencyBlock(child.id)))
        ) {
          if (!this.parentHasCapacityToReactivateChild(child)) {
            if (child.lifecycleState === "blocked") {
              this.applyWakeupDecision({
                assignmentId: child.id,
                decision: "waiting",
                reason: "Waiting for child assignment dependencies",
                resolveDependencies: false,
              });
              changed = true;
            }
            continue;
          }
          this.control(child.id, {
            action: "resume",
            actor: "system",
            reason: "Child assignment dependencies satisfied",
            resolveDependencies: false,
          });
          activatedChildIds.push(child.id);
          changed = true;
        } else if (
          state === "satisfied" &&
          child.lifecycleState === "blocked" &&
          this.isDependencyBlocked(child.id) &&
          this.shouldRestoreWaitingAfterDependencyBlock(child.id)
        ) {
          this.applyWakeupDecision({
            assignmentId: child.id,
            decision: "waiting",
            reason: "Restoring previous child assignment wait",
            resolveDependencies: false,
          });
          changed = true;
        } else if (
          state === "waiting" &&
          (child.lifecycleState === "active" ||
            (child.lifecycleState === "blocked" &&
              this.isDependencyBlocked(child.id)))
        ) {
          const restorePreviousWait =
            child.lifecycleState === "blocked" &&
            this.shouldRestoreWaitingAfterDependencyBlock(child.id);
          this.applyWakeupDecision({
            assignmentId: child.id,
            decision: "waiting",
            reason: restorePreviousWait
              ? "Restoring previous child assignment wait"
              : "Waiting for child assignment dependencies",
            resolveDependencies: false,
          });
          changed = true;
        }
      }
    }

    return {
      parentAssignmentId,
      activatedChildIds,
      blockedChildIds,
      activeWaitedChildIds: this.activeWaitedChildIds(parentAssignmentId),
    };
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

  latestTimeline(assignmentId: string, limit = 100): AssignmentTimeline {
    if (!this.get(assignmentId)) {
      throw new AssignmentNotFoundError(assignmentId);
    }
    const rows = this.database.all<AssignmentEventRow>(
      `SELECT * FROM (
         SELECT assignment_events.*, rowid AS event_rowid FROM assignment_events
         WHERE assignment_id = ?
         ORDER BY created_at DESC, event_rowid DESC
         LIMIT ?
       )
       ORDER BY created_at ASC, event_rowid ASC`,
      assignmentId,
      boundLimit(limit, 250)
    );
    return {
      assignmentId,
      events: rows.map(toAssignmentEventRecord),
    };
  }

  latestTimelineByTypes(
    assignmentId: string,
    eventTypes: string[],
    limit = 100
  ): AssignmentTimeline {
    if (!this.get(assignmentId)) {
      throw new AssignmentNotFoundError(assignmentId);
    }
    if (eventTypes.length === 0) {
      return { assignmentId, events: [] };
    }
    const placeholders = eventTypes.map(() => "?").join(", ");
    const rows = this.database.all<AssignmentEventRow>(
      `SELECT * FROM (
         SELECT assignment_events.*, rowid AS event_rowid FROM assignment_events
         WHERE assignment_id = ?
           AND type IN (${placeholders})
         ORDER BY created_at DESC, event_rowid DESC
         LIMIT ?
       )
       ORDER BY created_at ASC, event_rowid ASC`,
      assignmentId,
      ...eventTypes,
      boundLimit(limit, 250)
    );
    return {
      assignmentId,
      events: rows.map(toAssignmentEventRecord),
    };
  }

  compactEvents(
    input: CompactAssignmentEventsInput
  ): CompactAssignmentEventsResult {
    this.getRequired(input.assignmentId);
    const compactBefore = normalizeCompactionCutoff(input.compactBefore);
    const limit = boundLimit(input.limit ?? 100, 500);
    const rows = this.database.all<AssignmentEventRow>(
      `SELECT * FROM assignment_events
       WHERE assignment_id = ?
         AND compactable = 1
         AND expires_at IS NOT NULL
         AND expires_at <= ?
       ORDER BY created_at ASC, rowid ASC
       LIMIT ?`,
      input.assignmentId,
      compactBefore,
      limit
    );
    if (rows.length === 0) {
      return {
        assignmentId: input.assignmentId,
        compactedCount: 0,
        deletedEventIds: [],
      };
    }

    const events = rows.map(toAssignmentEventRecord);
    let summaryEvent: AssignmentEventRecord | undefined;
    this.database.transaction(() => {
      summaryEvent = this.recordEvent({
        assignmentId: input.assignmentId,
        type: "events_compacted",
        importance: "milestone",
        compactable: false,
        payload: buildCompactionPayload({
          events,
          actor: input.actor,
          reason: input.reason,
        }),
        createdAt: new Date().toISOString(),
      });
      const placeholders = events.map(() => "?").join(", ");
      this.database.run(
        `DELETE FROM assignment_events
         WHERE assignment_id = ?
           AND compactable = 1
           AND id IN (${placeholders})`,
        input.assignmentId,
        ...events.map((event) => event.id)
      );
    });

    return {
      assignmentId: input.assignmentId,
      compactedCount: events.length,
      deletedEventIds: events.map((event) => event.id),
      summaryEvent,
    };
  }

  startWakeup(input: StartAssignmentWakeupInput): AssignmentDetail {
    const now = new Date().toISOString();
    const current = this.getRequired(input.assignmentId).assignment;
    assertWakeable(current.lifecycleState);
    const dependencyWaitReason = this.childDependencyWaitReason(current);
    if (dependencyWaitReason) {
      throw new AssignmentValidationError(dependencyWaitReason);
    }
    if (this.hasActiveWaitedChild(current.id)) {
      throw new AssignmentValidationError(
        "Assignment is waiting for active child assignment"
      );
    }
    if (
      current.wakeupCount + this.reservedActiveChildWakeupBudget(current.id) >=
      current.policy.maxWakeups
    ) {
      throw new AssignmentValidationError(
        "Assignment wakeup budget is reserved for active child assignments"
      );
    }
    this.database.transaction(() => {
      this.updateAssignment(input.assignmentId, {
        lifecycle_state: "active",
        wakeup_count: current.wakeupCount + 1,
        updated_at: now,
        last_activity_at: now,
        terminal_reason: null,
      });
      this.recordEvent({
        assignmentId: input.assignmentId,
        type: "wakeup_started",
        importance: "milestone",
        compactable: false,
        payload: {
          actor: normalizeOptionalText(input.actor) ?? "system",
          reason: normalizeOptionalText(input.reason) ?? null,
          source: normalizeOptionalText(input.source) ?? "scheduled",
          wakeupCount: current.wakeupCount + 1,
        },
        createdAt: now,
      });
    });
    return this.getRequired(input.assignmentId);
  }

  completeWakeupRun(input: CompleteAssignmentWakeupRunInput): AssignmentDetail {
    const now = new Date().toISOString();
    const link = buildAssignmentRunLink(
      {
        assignmentId: input.assignmentId,
        runId: input.runId,
        action: "assignment_wakeup",
        metadata: { outputText: input.outputText ?? null },
      },
      now
    );
    this.getRequired(input.assignmentId);
    this.database.transaction(() => {
      this.insertRunLink(link, now);
      this.updateAssignment(input.assignmentId, {
        consecutive_failure_count: 0,
        updated_at: now,
        last_activity_at: now,
      });
      this.recordEvent({
        assignmentId: input.assignmentId,
        type: "wakeup_run_completed",
        importance: "detail",
        compactable: true,
        expiresAt: hoursFrom(now, 24 * 30),
        payload: {
          runId: input.runId,
          outputText: input.outputText ?? null,
        },
        createdAt: now,
      });
    });
    return this.getRequired(input.assignmentId);
  }

  failWakeup(input: FailAssignmentWakeupInput): AssignmentDetail {
    const now = new Date().toISOString();
    const current = this.getRequired(input.assignmentId).assignment;
    this.database.transaction(() => {
      this.updateAssignment(input.assignmentId, {
        consecutive_failure_count: current.consecutiveFailureCount + 1,
        updated_at: now,
        last_activity_at: now,
      });
      this.recordEvent({
        assignmentId: input.assignmentId,
        type: "wakeup_failed",
        importance: "milestone",
        compactable: false,
        payload: {
          error: input.error,
          consecutiveFailureCount: current.consecutiveFailureCount + 1,
        },
        createdAt: now,
      });
    });
    return this.getRequired(input.assignmentId);
  }

  applyWakeupDecision(
    input: ApplyAssignmentWakeupDecisionInput
  ): AssignmentDetail {
    const now = new Date().toISOString();
    const transition = wakeupDecisionTransition(input);
    this.database.transaction(() => {
      this.updateAssignment(input.assignmentId, {
        lifecycle_state: transition.lifecycleState,
        terminal_reason: transition.terminalReason,
        updated_at: now,
        last_activity_at: now,
      });
      this.recordEvent({
        assignmentId: input.assignmentId,
        type: transition.eventType,
        importance: transition.importance,
        compactable: false,
        payload: {
          decision: input.decision,
          reason: input.reason,
          ...(input.decision === "blocked"
            ? {
                blockingDependencies: this.childDependencyEvidence(
                  this.getRequired(input.assignmentId).assignment
                ),
              }
            : {}),
          nextWakeupAt: input.nextWakeupAt ?? null,
        },
        createdAt: now,
      });
    });
    const detail = this.getRequired(input.assignmentId);
    if (
      input.resolveDependencies !== false &&
      detail.assignment.parentAssignmentId
    ) {
      this.resolveChildDependencies(detail.assignment.parentAssignmentId);
      return this.getRequired(input.assignmentId);
    }
    return detail;
  }

  linkRun(input: LinkAssignmentRunInput): AssignmentRunLinkRecord {
    this.getRequired(input.assignmentId);
    const now = new Date().toISOString();
    const link = buildAssignmentRunLink(input, now);

    this.database.transaction(() => {
      this.insertRunLink(link, now);
    });

    return link;
  }

  recordMutationLedgerEvent(
    input: RecordAssignmentMutationEventInput
  ): AssignmentEventRecord {
    this.getRequired(input.assignmentId);
    const now = new Date().toISOString();
    this.updateAssignment(input.assignmentId, {
      updated_at: now,
      last_activity_at: now,
    });
    return this.recordEvent({
      assignmentId: input.assignmentId,
      type: `mutation_${input.status}`,
      importance: "milestone",
      compactable: false,
      payload: {
        mutationId: input.mutationId,
        status: input.status,
        target: input.target,
        mutationType: input.mutationType,
        runId: input.runId ?? null,
        riskClass: input.riskClass,
        rationale: input.rationale,
        actor: input.actor ?? null,
        errorMessage: input.errorMessage ?? null,
      },
      createdAt: now,
    });
  }

  private insertRunLink(link: AssignmentRunLinkRecord, now: string): void {
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
    this.updateAssignment(link.assignmentId, {
      updated_at: now,
      last_activity_at: now,
    });
    this.recordEvent({
      assignmentId: link.assignmentId,
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

  private assignmentDepth(assignmentId: string): number {
    let depth = 0;
    let currentId: string | undefined = assignmentId;
    const seen = new Set<string>();
    while (currentId) {
      if (seen.has(currentId)) {
        throw new AssignmentValidationError(
          "Assignment parent hierarchy contains a cycle"
        );
      }
      seen.add(currentId);
      const row: ParentAssignmentRow | null =
        this.database.get<ParentAssignmentRow>(
          "SELECT parent_assignment_id FROM assignments WHERE id = ?",
          currentId
        );
      currentId = row?.parent_assignment_id ?? undefined;
      if (currentId) {
        depth += 1;
      }
    }
    return depth;
  }

  private countActiveChildren(parentAssignmentId: string): number {
    return (
      this.database.get<CountRow>(
        `SELECT COUNT(*) AS count FROM assignments
         WHERE parent_assignment_id = ?
           AND lifecycle_state NOT IN ('completed', 'cancelled', 'blocked', 'expired', 'failed')`,
        parentAssignmentId
      )?.count ?? 0
    );
  }

  private listChildren(parentAssignmentId: string): AssignmentRecord[] {
    return this.database
      .all<AssignmentRow>(
        `SELECT * FROM assignments
         WHERE parent_assignment_id = ?
         ORDER BY updated_at DESC, rowid DESC`,
        parentAssignmentId
      )
      .map(toAssignmentRecord);
  }

  private reservedActiveChildWakeupBudget(parentAssignmentId: string): number {
    return this.database
      .all<AssignmentRow>(
        `SELECT * FROM assignments
         WHERE parent_assignment_id = ?
           AND lifecycle_state NOT IN ('completed', 'cancelled', 'blocked', 'expired', 'failed')`,
        parentAssignmentId
      )
      .map(toAssignmentRecord)
      .reduce((total, child) => total + child.policy.maxWakeups, 0);
  }

  private hasActiveWaitedChild(parentAssignmentId: string): boolean {
    return this.activeWaitedChildIds(parentAssignmentId).length > 0;
  }

  private activeWaitedChildIds(parentAssignmentId: string): string[] {
    return this.database
      .all<AssignmentRow>(
        `SELECT * FROM assignments
         WHERE parent_assignment_id = ?
           AND lifecycle_state NOT IN ('completed', 'cancelled', 'blocked', 'expired', 'failed')`,
        parentAssignmentId
      )
      .map(toAssignmentRecord)
      .filter((child) => {
        const metadata = child.metadata;
        return (
          metadata !== null &&
          typeof metadata === "object" &&
          !Array.isArray(metadata) &&
          (metadata as Record<string, JsonValue>).parentWaitsForChild === true
        );
      })
      .map((child) => child.id);
  }

  private parentHasCapacityToReactivateChild(child: AssignmentRecord): boolean {
    if (!child.parentAssignmentId) {
      return true;
    }
    const parent = this.getRequired(child.parentAssignmentId).assignment;
    const childAlreadyReservesCapacity =
      child.lifecycleState !== "blocked" &&
      !isTerminalLifecycleState(child.lifecycleState);
    const activeChildren =
      this.countActiveChildren(parent.id) -
      (childAlreadyReservesCapacity ? 1 : 0);
    if (
      activeChildren >= parent.policy.childAssignments.maxActiveChildren
    ) {
      return false;
    }
    const childReservedWakeups = childAlreadyReservesCapacity
      ? child.policy.maxWakeups
      : 0;
    const remainingWakeups =
      parent.policy.maxWakeups -
      parent.wakeupCount -
      (this.reservedActiveChildWakeupBudget(parent.id) -
        childReservedWakeups);
    return remainingWakeups >= child.policy.maxWakeups;
  }

  private normalizeChildDependencies(
    parentAssignmentId: string,
    input: PromoteChildAssignmentInput
  ): ChildDependencyConfig | null {
    if (!input.dependsOnChildIds || input.dependsOnChildIds.length === 0) {
      return null;
    }
    const dependsOnChildIds = normalizeDependencyIds(input.dependsOnChildIds);
    const waitForChildren = input.waitForChildren ?? "all";
    if (waitForChildren !== "all" && waitForChildren !== "any") {
      throw new AssignmentValidationError(
        "waitForChildren must be all or any"
      );
    }
    const dependencies = dependsOnChildIds.map((id) => {
      const dependency = this.get(id);
      if (!dependency) {
        throw new AssignmentValidationError(`Assignment not found: ${id}`);
      }
      return dependency.assignment;
    });
    for (const dependency of dependencies) {
      if (dependency.parentAssignmentId !== parentAssignmentId) {
        throw new AssignmentValidationError(
          "Child assignment dependencies must belong to the same parent assignment"
        );
      }
    }
    return { dependsOnChildIds, waitForChildren };
  }

  private evaluateChildDependencyState(
    dependencies: ChildDependencyConfig | null
  ): "satisfied" | "waiting" | "blocked" {
    if (!dependencies) {
      return "satisfied";
    }
    const parentAssignmentId = this.getRequired(
      dependencies.dependsOnChildIds[0] ?? ""
    ).assignment.parentAssignmentId;
    const siblings = parentAssignmentId ? this.listChildren(parentAssignmentId) : [];
    return evaluateChildDependencies(siblings, dependencies);
  }

  private childDependencyWaitReason(assignment: AssignmentRecord): string | null {
    const dependencies = dependencyConfigFromMetadata(assignment.metadata);
    if (!dependencies) {
      return null;
    }
    const siblings = assignment.parentAssignmentId
      ? this.listChildren(assignment.parentAssignmentId)
      : [];
    const state = evaluateChildDependencies(siblings, dependencies);
    if (state === "satisfied") {
      return null;
    }
    if (state === "blocked") {
      throw new AssignmentValidationError(
        "Required child assignment dependency failed"
      );
    }
    return "Assignment is waiting for child assignment dependencies";
  }

  private childDependencyEvidence(assignment: AssignmentRecord): JsonValue {
    const dependencies = dependencyConfigFromMetadata(assignment.metadata);
    if (!dependencies || !assignment.parentAssignmentId) {
      return [];
    }
    const siblings = this.listChildren(assignment.parentAssignmentId);
    return dependencySnapshots(siblings, dependencies);
  }

  private isDependencyBlocked(assignmentId: string): boolean {
    return this.latestLifecycleReason(assignmentId, "blocked") ===
      "Required child assignment dependency failed";
  }

  private isDependencyWaiting(assignmentId: string): boolean {
    const wait = this.latestWaitLikeEvent(assignmentId);
    return (
      wait?.type !== "paused" &&
      wait?.reason === "Waiting for child assignment dependencies"
    );
  }

  private shouldRestoreWaitingAfterDependencyBlock(
    assignmentId: string
  ): boolean {
    const wait = this.latestWaitLikeEvent(assignmentId);
    if (!wait || wait.type === "resumed") {
      return false;
    }
    return wait.reason !== "Waiting for child assignment dependencies";
  }

  private latestWaitLikeEvent(
    assignmentId: string
  ): { type: string; reason?: string } | null {
    const row = this.database.get<AssignmentEventRow>(
      `SELECT * FROM assignment_events
       WHERE assignment_id = ?
         AND type IN ('paused', 'waiting', 'wakeup_scheduled', 'resumed')
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      assignmentId
    );
    if (!row) {
      return null;
    }
    const payload = decodeJson<JsonValue>(row.payload_json, {});
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return { type: row.type };
    }
    const reason = (payload as Record<string, JsonValue>).reason;
    return { type: row.type, reason: typeof reason === "string" ? reason : undefined };
  }

  private latestLifecycleReason(
    assignmentId: string,
    type: "blocked" | "waiting"
  ): string | undefined {
    const row = this.database.get<AssignmentEventRow>(
      `SELECT * FROM assignment_events
       WHERE assignment_id = ?
         AND type = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      assignmentId,
      type
    );
    if (!row) {
      return undefined;
    }
    const payload = decodeJson<JsonValue>(row.payload_json, {});
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }
    const reason = (payload as Record<string, JsonValue>).reason;
    return typeof reason === "string" ? reason : undefined;
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
    selfEvolution: {
      enabled: true,
      allowedMutationClasses: ["configuration.operator_settings"],
      maxRiskClass: "medium",
    },
    childAssignments: {
      maxDepth: 2,
      maxActiveChildren: 3,
    },
  };
}

function buildAssignmentPolicy(
  input?: AssignmentPolicyPatch
): AssignmentPolicy {
  const defaults = defaultAssignmentPolicy();
  return buildAssignmentPolicyPatch(defaults, input);
}

function buildAssignmentPolicyPatch(
  current: AssignmentPolicy,
  input?: AssignmentPolicyPatch
): AssignmentPolicy {
  const patch = stripUndefined(input ?? {});
  const notificationCadence = stripUndefined(input?.notificationCadence ?? {});
  const selfEvolution = stripUndefined(input?.selfEvolution ?? {});
  const childAssignments = stripUndefined(input?.childAssignments ?? {});
  const policy = {
    ...current,
    ...patch,
    notificationCadence: {
      ...current.notificationCadence,
      ...notificationCadence,
    },
    selfEvolution: {
      ...current.selfEvolution,
      ...selfEvolution,
    },
    childAssignments: {
      ...current.childAssignments,
      ...childAssignments,
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
  validateNonNegativeInteger(policy.childAssignments.maxDepth, "maxDepth");
  validateNonNegativeInteger(
    policy.childAssignments.maxActiveChildren,
    "maxActiveChildren"
  );
  if (policy.wakeupDelayMinMinutes > policy.wakeupDelayMaxMinutes) {
    throw new AssignmentValidationError(
      "wakeupDelayMinMinutes must be less than or equal to wakeupDelayMaxMinutes"
    );
  }
  if (typeof policy.selfEvolution.enabled !== "boolean") {
    throw new AssignmentValidationError(
      "selfEvolution.enabled must be boolean"
    );
  }
  if (
    !Array.isArray(policy.selfEvolution.allowedMutationClasses) ||
    policy.selfEvolution.allowedMutationClasses.some(
      (item) => typeof item !== "string" || item.trim() === ""
    )
  ) {
    throw new AssignmentValidationError(
      "selfEvolution.allowedMutationClasses must be non-empty strings"
    );
  }
  if (
    !["low", "medium", "high", "critical"].includes(
      policy.selfEvolution.maxRiskClass
    )
  ) {
    throw new AssignmentValidationError(
      "selfEvolution.maxRiskClass must be low, medium, high, or critical"
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

function hasPolicyPatch(input: AssignmentPolicyPatch | undefined): boolean {
  if (!input) {
    return false;
  }
  return Object.entries(input).some(([key, value]) => {
    if (value === undefined) {
      return false;
    }
    if (key === "notificationCadence") {
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value).some((item) => item !== undefined)
      );
    }
    if (key === "selfEvolution") {
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value).some((item) => item !== undefined)
      );
    }
    if (key === "childAssignments") {
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value).some((item) => item !== undefined)
      );
    }
    return true;
  });
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
      if (isTerminalLifecycleState(current)) {
        throw new AssignmentValidationError(
          "Terminal assignments must be reopened before they can be paused"
        );
      }
      if (current !== "active") {
        throw new AssignmentValidationError(
          "Only active assignments can be paused"
        );
      }
      return {
        nextState: "waiting",
        eventType: "paused",
        importance: "milestone",
        compactable: false,
      };
    case "resume":
      if (isTerminalLifecycleState(current)) {
        throw new AssignmentValidationError(
          "Terminal assignments must be reopened before they can be resumed"
        );
      }
      if (current !== "waiting" && current !== "blocked") {
        throw new AssignmentValidationError(
          "Only waiting or blocked assignments can be resumed"
        );
      }
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
      if (!isTerminalLifecycleState(current)) {
        throw new AssignmentValidationError(
          "Only terminal assignments can be reopened"
        );
      }
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

function buildAssignmentRunLink(
  input: LinkAssignmentRunInput,
  now: string
): AssignmentRunLinkRecord {
  return {
    id: createId("asgnrun"),
    assignmentId: input.assignmentId,
    runId: input.runId,
    stepId: normalizeOptionalText(input.stepId),
    action: normalizeOptionalText(input.action),
    metadata: input.metadata ?? {},
    createdAt: now,
  };
}

function wakeupDecisionTransition(input: ApplyAssignmentWakeupDecisionInput): {
  lifecycleState: AssignmentLifecycleState;
  terminalReason: string | null;
  eventType: string;
  importance: AssignmentEventImportance;
} {
  switch (input.decision) {
    case "waiting":
      return {
        lifecycleState: "waiting",
        terminalReason: null,
        eventType: "wakeup_scheduled",
        importance: "milestone",
      };
    case "completed":
      return {
        lifecycleState: "completed",
        terminalReason: "assignment_completed",
        eventType: "completed",
        importance: "audit",
      };
    case "blocked":
      return {
        lifecycleState: "blocked",
        terminalReason: null,
        eventType: "blocked",
        importance: "audit",
      };
    case "expired":
      return {
        lifecycleState: "expired",
        terminalReason: "assignment_expired",
        eventType: "expired",
        importance: "audit",
      };
    case "failed":
      return {
        lifecycleState: "failed",
        terminalReason: "assignment_failed",
        eventType: "failed",
        importance: "audit",
      };
  }
}

function isTerminalLifecycleState(state: AssignmentLifecycleState): boolean {
  return ["completed", "cancelled", "expired", "failed"].includes(state);
}

type ChildDependencyConfig = {
  dependsOnChildIds: string[];
  waitForChildren: AssignmentChildDependencyWaitMode;
};

function normalizeDependencyIds(ids: string[]): string[] {
  const normalized = ids.map((id, index) => {
    if (typeof id !== "string" || id.trim() === "") {
      throw new AssignmentValidationError(
        `dependsOnChildIds[${index}] must be a non-empty string`
      );
    }
    return id.trim();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new AssignmentValidationError("dependsOnChildIds must be unique");
  }
  return normalized;
}

function dependencyConfigFromMetadata(
  metadata: JsonValue
): ChildDependencyConfig | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = metadata as Record<string, JsonValue>;
  if (value.childDependencyConfigValidated !== true) {
    return null;
  }
  if (!Array.isArray(value.dependsOnChildIds)) {
    return null;
  }
  const waitForChildren =
    value.waitForChildren === "any" || value.waitForChildren === "all"
      ? value.waitForChildren
      : "all";
  return {
    dependsOnChildIds: normalizeDependencyIds(
      value.dependsOnChildIds as string[]
    ),
    waitForChildren,
  };
}

function evaluateChildDependencies(
  siblings: AssignmentRecord[],
  dependencies: ChildDependencyConfig
): "satisfied" | "waiting" | "blocked" {
  const byId = new Map(siblings.map((child) => [child.id, child]));
  const dependencyStates = dependencies.dependsOnChildIds.map((id) => {
    const dependency = byId.get(id);
    if (!dependency) {
      return "blocked";
    }
    return dependency.lifecycleState;
  });
  if (dependencies.waitForChildren === "any") {
    if (dependencyStates.some((state) => state === "completed")) {
      return "satisfied";
    }
    if (dependencyStates.every(isTerminalOrBlockedDependencyState)) {
      return "blocked";
    }
    return "waiting";
  }
  if (
    dependencyStates.some(
      (state) =>
        state === "failed" ||
        state === "cancelled" ||
        state === "expired" ||
        state === "blocked"
    )
  ) {
    return "blocked";
  }
  return dependencyStates.every((state) => state === "completed")
    ? "satisfied"
    : "waiting";
}

function dependencySnapshots(
  siblings: AssignmentRecord[],
  dependencies: ChildDependencyConfig
): JsonValue {
  const byId = new Map(siblings.map((child) => [child.id, child]));
  return dependencies.dependsOnChildIds.map((id) => {
    const dependency = byId.get(id);
    return {
      childAssignmentId: id,
      lifecycleState: dependency?.lifecycleState ?? "missing",
    };
  });
}

function isTerminalOrBlockedDependencyState(
  state: AssignmentLifecycleState | "blocked"
): boolean {
  return (
    state === "blocked" ||
    state === "completed" ||
    state === "cancelled" ||
    state === "expired" ||
    state === "failed"
  );
}

function assertWakeable(state: AssignmentLifecycleState): void {
  if (isTerminalLifecycleState(state)) {
    throw new AssignmentValidationError(
      "Terminal assignments must be reopened before they can wake"
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
    policy: normalizeStoredAssignmentPolicy(
      decodeJson<Partial<AssignmentPolicy>>(
        row.policy_json,
        failClosedAssignmentPolicyFallback()
      )
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

function normalizeStoredAssignmentPolicy(
  policy: Partial<AssignmentPolicy>
): AssignmentPolicy {
  const defaults = defaultAssignmentPolicy();
  return {
    ...defaults,
    ...policy,
    notificationCadence: {
      ...defaults.notificationCadence,
      ...(policy.notificationCadence ?? {}),
    },
    selfEvolution: normalizeStoredSelfEvolutionPolicy(policy.selfEvolution),
    childAssignments: normalizeStoredChildPolicy(policy.childAssignments),
  };
}

function normalizeStoredSelfEvolutionPolicy(
  policy: Partial<AssignmentSelfEvolutionPolicy> | undefined
): AssignmentSelfEvolutionPolicy {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return failClosedSelfEvolutionPolicy();
  }
  return {
    enabled: typeof policy.enabled === "boolean" ? policy.enabled : false,
    allowedMutationClasses:
      Array.isArray(policy.allowedMutationClasses) &&
      policy.allowedMutationClasses.every(
        (item) => typeof item === "string" && item.trim() !== ""
      )
        ? policy.allowedMutationClasses
        : [],
    maxRiskClass: ["low", "medium", "high", "critical"].includes(
      policy.maxRiskClass ?? ""
    )
      ? (policy.maxRiskClass ?? "low")
      : "low",
  };
}

function failClosedSelfEvolutionPolicy(): AssignmentSelfEvolutionPolicy {
  return {
    enabled: false,
    allowedMutationClasses: [],
    maxRiskClass: "low",
  };
}

function normalizeStoredChildPolicy(
  policy: Partial<AssignmentChildPolicy> | undefined
): AssignmentChildPolicy {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return failClosedChildPolicy();
  }
  const maxDepth = policy.maxDepth;
  const maxActiveChildren = policy.maxActiveChildren;
  return {
    maxDepth:
      Number.isInteger(maxDepth) && maxDepth !== undefined && maxDepth >= 0
        ? maxDepth
        : 0,
    maxActiveChildren:
      Number.isInteger(maxActiveChildren) &&
      maxActiveChildren !== undefined &&
      maxActiveChildren >= 0
        ? maxActiveChildren
        : 0,
  };
}

function failClosedChildPolicy(): AssignmentChildPolicy {
  return {
    maxDepth: 0,
    maxActiveChildren: 0,
  };
}

function failClosedAssignmentPolicyFallback(): AssignmentPolicy {
  return {
    ...defaultAssignmentPolicy(),
    selfEvolution: failClosedSelfEvolutionPolicy(),
    childAssignments: failClosedChildPolicy(),
  };
}

function normalizeCompactionCutoff(value: string | undefined): string {
  if (value === undefined) {
    return new Date().toISOString();
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new AssignmentValidationError(
      "compactBefore must be a valid ISO date"
    );
  }
  return new Date(timestamp).toISOString();
}

function buildCompactionPayload(input: {
  events: AssignmentEventRecord[];
  actor?: string;
  reason?: string;
}): JsonValue {
  const eventTypes: Record<string, JsonValue> = {};
  for (const event of input.events) {
    const current = eventTypes[event.type];
    eventTypes[event.type] = typeof current === "number" ? current + 1 : 1;
  }
  return {
    actor: normalizeOptionalText(input.actor) ?? "system",
    reason:
      normalizeOptionalText(input.reason) ??
      "Expired assignment detail retention window",
    compactedCount: input.events.length,
    eventTypes,
    firstEventAt: input.events[0]?.createdAt,
    lastEventAt: input.events[input.events.length - 1]?.createdAt,
    deletedEventIds: input.events.map((event) => event.id),
  };
}

function capChildPolicyToParent(
  requested: AssignmentPolicy,
  parent: AssignmentPolicy,
  remainingWakeups: number
): AssignmentPolicy {
  return {
    ...requested,
    maxWakeups: Math.min(requested.maxWakeups, remainingWakeups),
    maxTotalRuntimeMinutes: Math.min(
      requested.maxTotalRuntimeMinutes,
      parent.maxTotalRuntimeMinutes
    ),
    maxConsecutiveFailures: Math.min(
      requested.maxConsecutiveFailures,
      parent.maxConsecutiveFailures
    ),
    maxIdleHours: Math.min(requested.maxIdleHours, parent.maxIdleHours),
    wakeupDelayMinMinutes: capWakeupDelayMin(
      requested.wakeupDelayMinMinutes,
      parent
    ),
    wakeupDelayMaxMinutes: capWakeupDelayMax(
      requested.wakeupDelayMaxMinutes,
      parent
    ),
    notificationCadence: capNotificationCadenceToParent(
      requested.notificationCadence,
      parent.notificationCadence
    ),
    selfEvolution: capSelfEvolutionPolicyToParent(
      requested.selfEvolution,
      parent.selfEvolution
    ),
    childAssignments: {
      maxDepth: Math.min(
        requested.childAssignments.maxDepth,
        parent.childAssignments.maxDepth
      ),
      maxActiveChildren: Math.min(
        requested.childAssignments.maxActiveChildren,
        parent.childAssignments.maxActiveChildren
      ),
    },
  };
}

function capWakeupDelayMin(
  requested: number,
  parent: AssignmentPolicy
): number {
  return Math.min(
    Math.max(requested, parent.wakeupDelayMinMinutes),
    parent.wakeupDelayMaxMinutes
  );
}

function capWakeupDelayMax(
  requested: number,
  parent: AssignmentPolicy
): number {
  return Math.max(
    Math.min(requested, parent.wakeupDelayMaxMinutes),
    parent.wakeupDelayMinMinutes
  );
}

function capNotificationCadenceToParent(
  requested: AssignmentNotificationCadence,
  parent: AssignmentNotificationCadence
): AssignmentNotificationCadence {
  return {
    onCreate: requested.onCreate || parent.onCreate,
    onWakeupStart: requested.onWakeupStart || parent.onWakeupStart,
    onMeaningfulProgress:
      requested.onMeaningfulProgress || parent.onMeaningfulProgress,
    onBlocked: requested.onBlocked || parent.onBlocked,
    onFailure: requested.onFailure || parent.onFailure,
    onCompletion: requested.onCompletion || parent.onCompletion,
    activeProgressIntervalMinutes: Math.min(
      requested.activeProgressIntervalMinutes,
      parent.activeProgressIntervalMinutes
    ),
  };
}

function capSelfEvolutionPolicyToParent(
  requested: AssignmentSelfEvolutionPolicy,
  parent: AssignmentSelfEvolutionPolicy
): AssignmentSelfEvolutionPolicy {
  const allowedByParent = new Set(parent.allowedMutationClasses);
  return {
    enabled: requested.enabled && parent.enabled,
    allowedMutationClasses: requested.allowedMutationClasses.filter((item) =>
      allowedByParent.has(item)
    ),
    maxRiskClass: capRiskClass(requested.maxRiskClass, parent.maxRiskClass),
  };
}

const SELF_EVOLUTION_RISK_ORDER = [
  "low",
  "medium",
  "high",
  "critical",
] as const satisfies readonly AssignmentSelfEvolutionRiskClass[];

function capRiskClass(
  requested: AssignmentSelfEvolutionRiskClass,
  parent: AssignmentSelfEvolutionRiskClass
): AssignmentSelfEvolutionRiskClass {
  return riskRank(requested) > riskRank(parent) ? parent : requested;
}

function riskRank(riskClass: AssignmentSelfEvolutionRiskClass): number {
  return SELF_EVOLUTION_RISK_ORDER.indexOf(riskClass);
}

function capAutonomyLevel(
  requested: AssignmentAutonomyLevel,
  parent: AssignmentAutonomyLevel
): AssignmentAutonomyLevel {
  return autonomyRank(requested) > autonomyRank(parent) ? parent : requested;
}

function autonomyRank(level: AssignmentAutonomyLevel): number {
  return ASSIGNMENT_AUTONOMY_LEVELS.indexOf(level);
}

function mergeChildMetadata(
  metadata: JsonValue | undefined,
  childMetadata: Record<string, JsonValue>
): JsonValue {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return {
      ...(metadata as Record<string, JsonValue>),
      ...childMetadata,
    };
  }
  if (metadata !== undefined) {
    return {
      value: metadata,
      ...childMetadata,
    };
  }
  return childMetadata;
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

function validateNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new AssignmentValidationError(
      `${field} must be a non-negative integer`
    );
  }
}

function boundLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
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
