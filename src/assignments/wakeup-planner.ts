import type { OrchestrationService } from "../orchestration/service.ts";
import {
  AutonomousMutationExecutionError,
  AutonomousMutationExecutor,
  type ApplyAutonomousMutationInput,
} from "./autonomous-mutations.ts";
import type {
  JobRecord,
  SchedulerJobHandlerResult,
  SchedulerService,
} from "../scheduler/service.ts";
import type { JsonValue } from "../shared/types.ts";
import type {
  AssignmentDetail,
  AssignmentAutonomyLevel,
  AssignmentEventRecord,
  AssignmentRecord,
  PromoteChildAssignmentInput,
} from "./types.ts";
import { ASSIGNMENT_AUTONOMY_LEVELS } from "./types.ts";
import {
  AUTONOMOUS_MUTATION_TARGETS,
  type AutonomousMutationTarget,
} from "./mutation-ledger.ts";
import {
  AssignmentValidationError,
  AutonomousAssignmentService,
} from "./service.ts";

export const ASSIGNMENT_WAKEUP_JOB_NAME = "assignment.wakeup";
const DEFAULT_NEXT_WAKEUP_MINUTES = 30;

type AssignmentWakeupScheduler = Pick<
  SchedulerService,
  "list" | "schedule" | "reschedule"
>;
type AssignmentMutationExecutor = Pick<AutonomousMutationExecutor, "apply">;
type PlannerMutationRequest = Pick<
  ApplyAutonomousMutationInput,
  "target" | "mutationType" | "rationale" | "riskClass" | "proposedChange"
>;
type PlannerChildRequest = Pick<
  PromoteChildAssignmentInput,
  | "objective"
  | "title"
  | "autonomyLevel"
  | "rationale"
  | "waitForChild"
  | "dependsOnChildIds"
  | "waitForChildren"
  | "metadata"
  | "context"
>;

export type AssignmentWakeupResult = {
  status:
    | "scheduled"
    | "completed"
    | "blocked"
    | "expired"
    | "failed"
    | "skipped";
  assignment: AssignmentDetail;
  runId?: string;
  nextJob?: JobRecord;
};

export class AssignmentWakeupPlanner {
  private readonly assignments: AutonomousAssignmentService;
  private readonly scheduler: AssignmentWakeupScheduler;
  private readonly orchestration: OrchestrationService;
  private readonly mutations?: AssignmentMutationExecutor;
  private readonly activeWakeups = new Set<string>();

  constructor(input: {
    assignments: AutonomousAssignmentService;
    scheduler: AssignmentWakeupScheduler;
    orchestration: OrchestrationService;
    mutations?: AssignmentMutationExecutor;
  }) {
    this.assignments = input.assignments;
    this.scheduler = input.scheduler;
    this.orchestration = input.orchestration;
    this.mutations = input.mutations;
  }

  async wakeNow(input: {
    assignmentId: string;
    actor?: string;
    reason?: string;
    source?: string;
  }): Promise<AssignmentWakeupResult> {
    if (this.activeWakeups.has(input.assignmentId)) {
      return {
        status: "skipped",
        assignment: this.assignments.getRequired(input.assignmentId),
      };
    }
    const initial = this.assignments.getRequired(input.assignmentId);
    if (isTerminalAssignment(initial.assignment)) {
      return { status: "skipped", assignment: initial };
    }
    if (isIdleExpired(initial.assignment)) {
      const assignment = this.assignments.applyWakeupDecision({
        assignmentId: input.assignmentId,
        decision: "expired",
        reason: "Assignment exceeded idle policy before wakeup",
        resolveDependencies: false,
      });
      await this.scheduleDependencyContinuations(assignment.assignment);
      return {
        status: "expired",
        assignment,
      };
    }

    this.activeWakeups.add(input.assignmentId);
    try {
      let started: AssignmentDetail;
      try {
        started = this.assignments.startWakeup({
          assignmentId: input.assignmentId,
          actor: input.actor,
          reason: input.reason,
          source: input.source,
        });
      } catch (error) {
        if (
          error instanceof AssignmentValidationError &&
          error.message === "Required child assignment dependency failed"
        ) {
          const assignment = this.assignments.applyWakeupDecision({
            assignmentId: input.assignmentId,
            decision: "blocked",
            reason: "Required child assignment dependency failed",
            resolveDependencies: false,
          });
          await this.scheduleDependencyContinuations(assignment.assignment);
          return {
            status: "blocked",
            assignment,
          };
        }
        if (isActiveChildReservationError(error)) {
          const reason =
            error instanceof Error &&
            error.message ===
              "Assignment is waiting for child assignment dependencies"
              ? "Waiting for child assignment dependencies"
              : "Waiting for active child assignment";
          if (
            input.source === "scheduled" &&
            reason === "Waiting for child assignment dependencies"
          ) {
            return {
              status: "skipped",
              assignment: this.assignments.applyWakeupDecision({
                assignmentId: input.assignmentId,
                decision: "waiting",
                reason,
              }),
            };
          }
          const nextJob = await this.scheduleNext({
            assignmentId: input.assignmentId,
            reason,
          });
          return {
            status: "scheduled",
            nextJob,
            assignment: this.assignments.applyWakeupDecision({
              assignmentId: input.assignmentId,
              decision: "waiting",
              reason,
              nextWakeupAt: nextJob.scheduledAt,
            }),
          };
        }
        throw error;
      }

      try {
        const result = await this.orchestration.runCoordinator(
          {
            channelId: "scheduler",
            conversationId: input.assignmentId,
            message: buildWakeupPrompt(
              started,
              this.assignments.timeline(input.assignmentId, 10).events
            ),
          },
          async () => undefined
        );
        const completed = this.assignments.completeWakeupRun({
          assignmentId: input.assignmentId,
          runId: result.runId,
          outputText: result.outputText,
        });
        const marker = parsePlannerMarkers(result.outputText, {
          allowMutations: shouldAllowPlannerMutationMarkers(completed),
          allowChildren: shouldAllowPlannerChildMarkers(completed),
        });
        const afterMutation = this.applyPlannerMutation({
          assignmentId: input.assignmentId,
          runId: result.runId,
          mutation: marker.mutation,
        });
        const afterChild = await this.applyPlannerChild({
          assignmentId: input.assignmentId,
          child: marker.child,
        });
        const afterPlannerActions = afterChild.assignment ?? afterMutation;
        if (afterChild.waitForChild) {
          const nextJob = await this.scheduleNext({
            assignmentId: input.assignmentId,
            reason: "Waiting for child assignment",
            delayMinutes: marker.nextWakeupMinutes,
          });
          return {
            status: "scheduled",
            runId: result.runId,
            nextJob,
            assignment: this.assignments.applyWakeupDecision({
              assignmentId: input.assignmentId,
              decision: "waiting",
              reason: "Planner promoted child assignment",
              nextWakeupAt: nextJob.scheduledAt,
            }),
          };
        }
        if (marker.status === "completed") {
          const assignment = this.assignments.applyWakeupDecision({
            assignmentId: input.assignmentId,
            decision: "completed",
            reason: "Coordinator reported assignment completion",
            resolveDependencies: false,
          });
          await this.scheduleDependencyContinuations(assignment.assignment);
          return {
            status: "completed",
            runId: result.runId,
            assignment,
          };
        }
        if (marker.status === "blocked") {
          const assignment = this.assignments.applyWakeupDecision({
            assignmentId: input.assignmentId,
            decision: "blocked",
            reason: "Coordinator reported assignment is blocked",
            resolveDependencies: false,
          });
          await this.scheduleDependencyContinuations(assignment.assignment);
          return {
            status: "blocked",
            runId: result.runId,
            assignment,
          };
        }
        if (
          afterPlannerActions.assignment.wakeupCount >=
          afterPlannerActions.assignment.policy.maxWakeups
        ) {
          const assignment = this.assignments.applyWakeupDecision({
            assignmentId: input.assignmentId,
            decision: "expired",
            reason: "Assignment exhausted wakeup budget",
            resolveDependencies: false,
          });
          await this.scheduleDependencyContinuations(assignment.assignment);
          return {
            status: "expired",
            runId: result.runId,
            assignment,
          };
        }
        const nextJob = await this.scheduleNext({
          assignmentId: input.assignmentId,
          reason: "Planner requested continuation",
          delayMinutes: marker.nextWakeupMinutes,
        });
        return {
          status: "scheduled",
          runId: result.runId,
          nextJob,
          assignment: this.assignments.applyWakeupDecision({
            assignmentId: input.assignmentId,
            decision: "waiting",
            reason: "Planner requested continuation",
            nextWakeupAt: nextJob.scheduledAt,
          }),
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Assignment wakeup failed";
        const failed = this.assignments.failWakeup({
          assignmentId: input.assignmentId,
          error: message,
        });
        if (
          failed.assignment.consecutiveFailureCount >=
          failed.assignment.policy.maxConsecutiveFailures
        ) {
          const assignment = this.assignments.applyWakeupDecision({
            assignmentId: input.assignmentId,
            decision: "failed",
            reason: "Assignment exhausted consecutive failure budget",
            resolveDependencies: false,
          });
          await this.scheduleDependencyContinuations(assignment.assignment);
          return {
            status: "failed",
            assignment,
          };
        }
        const nextJob = await this.scheduleNext({
          assignmentId: input.assignmentId,
          reason: "Retry after wakeup failure",
        });
        return {
          status: "scheduled",
          nextJob,
          assignment: this.assignments.applyWakeupDecision({
            assignmentId: input.assignmentId,
            decision: "waiting",
            reason: "Retry after wakeup failure",
            nextWakeupAt: nextJob.scheduledAt,
          }),
        };
      }
    } finally {
      this.activeWakeups.delete(input.assignmentId);
    }
  }

  async scheduleNext(input: {
    assignmentId: string;
    reason: string;
    delayMinutes?: number;
    force?: boolean;
  }): Promise<JobRecord> {
    const detail = this.assignments.getRequired(input.assignmentId);
    const message = JSON.stringify({
      assignmentId: input.assignmentId,
      reason: input.reason,
    });
    const existing = findScheduledWakeupJob(
      await this.scheduler.list(),
      input.assignmentId
    );
    if (existing) {
      if (input.force === true) {
        return this.scheduler.reschedule(existing.id, {
          message,
          delayMs: 0,
        });
      }
      return existing;
    }
    const delayMinutes =
      input.force === true && input.delayMinutes === 0
        ? 0
        : clampDelayMinutes(
            input.delayMinutes ?? DEFAULT_NEXT_WAKEUP_MINUTES,
            detail.assignment
          );
    return this.scheduler.schedule(
      ASSIGNMENT_WAKEUP_JOB_NAME,
      message,
      {
        delayMs: delayMinutes * 60_000,
        maxAttempts: 1,
      }
    );
  }

  async scheduleDependencyContinuationsForAssignment(
    assignmentId: string
  ): Promise<void> {
    await this.scheduleDependencyContinuations(
      this.assignments.getRequired(assignmentId).assignment
    );
  }

  async handleScheduledWakeup(
    job: JobRecord
  ): Promise<SchedulerJobHandlerResult> {
    const payload = parseWakeupJobPayload(job.message);
    const result = await this.wakeNow({
      assignmentId: payload.assignmentId,
      reason: payload.reason,
      actor: "scheduler",
      source: "scheduled",
    });
    return result.runId ? { runId: result.runId } : {};
  }

  private applyPlannerMutation(input: {
    assignmentId: string;
    runId: string;
    mutation?: PlannerMutationRequest;
  }): AssignmentDetail {
    if (!this.mutations || !input.mutation) {
      return this.assignments.getRequired(input.assignmentId);
    }
    try {
      this.mutations.apply({
        assignmentId: input.assignmentId,
        runId: input.runId,
        target: input.mutation.target,
        mutationType: input.mutation.mutationType,
        rationale: input.mutation.rationale,
        riskClass: input.mutation.riskClass,
        proposedChange: input.mutation.proposedChange,
        actor: "planner",
      });
    } catch (error) {
      if (error instanceof AutonomousMutationExecutionError) {
        return this.assignments.getRequired(input.assignmentId);
      }
      throw error;
    }
    return this.assignments.getRequired(input.assignmentId);
  }

  private async applyPlannerChild(input: {
    assignmentId: string;
    child?: PlannerChildRequest;
  }): Promise<{
    assignment?: AssignmentDetail;
    childJob?: JobRecord;
    waitForChild: boolean;
  }> {
    if (!input.child) {
      return {
        assignment: this.assignments.getRequired(input.assignmentId),
        waitForChild: false,
      };
    }
    try {
      const promoted = this.assignments.promoteChild({
        parentAssignmentId: input.assignmentId,
        objective: input.child.objective,
        title: input.child.title,
        autonomyLevel: input.child.autonomyLevel,
        rationale: input.child.rationale,
        waitForChild: input.child.waitForChild,
        dependsOnChildIds: input.child.dependsOnChildIds,
        waitForChildren: input.child.waitForChildren,
        metadata: input.child.metadata,
        context: input.child.context,
        actor: "planner",
      });
      let childJob: JobRecord | undefined;
      if (promoted.child.assignment.lifecycleState === "active") {
        childJob = await this.scheduleNext({
          assignmentId: promoted.child.assignment.id,
          reason: "Planner promoted child assignment",
          delayMinutes: 0,
          force: true,
        });
      } else if (promoted.child.assignment.lifecycleState === "blocked") {
        await this.scheduleDependencyContinuations(promoted.child.assignment);
      }
      return {
        assignment: promoted.parent,
        childJob,
        waitForChild:
          input.child.waitForChild === true &&
          promoted.child.assignment.lifecycleState !== "blocked",
      };
    } catch (error) {
      if (error instanceof AssignmentValidationError) {
        this.assignments.recordChildPromotionFailure({
          assignmentId: input.assignmentId,
          actor: "planner",
          objective: input.child.objective,
          rationale: input.child.rationale,
          errorMessage: error.message,
        });
        return {
          assignment: this.assignments.getRequired(input.assignmentId),
          waitForChild: false,
        };
      }
      throw error;
    }
  }

  private async scheduleDependencyContinuations(
    assignment: AssignmentRecord
  ): Promise<void> {
    const parentAssignmentId = assignment.parentAssignmentId;
    if (!parentAssignmentId) {
      return;
    }
    const resolution =
      this.assignments.resolveChildDependencies(parentAssignmentId);
    for (const childAssignmentId of resolution.activatedChildIds) {
      await this.scheduleNext({
        assignmentId: childAssignmentId,
        reason: "Child assignment dependencies satisfied",
        delayMinutes: 0,
        force: true,
      });
    }
    const resolvedWaitedChildIds = [
      ...resolution.activatedChildIds,
      ...resolution.blockedChildIds,
    ].filter((childAssignmentId) =>
      isWaitedChild(this.assignments.getRequired(childAssignmentId).assignment)
    );
    if (
      resolution.activeWaitedChildIds.length === 0 &&
      (isWaitedChild(assignment) || resolvedWaitedChildIds.length > 0) &&
      shouldScheduleParentContinuation(this.assignments, parentAssignmentId)
    ) {
      await this.scheduleNext({
        assignmentId: parentAssignmentId,
        reason: "Waited child assignments satisfied",
        delayMinutes: 0,
        force: true,
      });
    }
  }
}

function findScheduledWakeupJob(
  jobs: JobRecord[],
  assignmentId: string
): JobRecord | null {
  for (const job of jobs) {
    if (job.name !== ASSIGNMENT_WAKEUP_JOB_NAME || job.status !== "scheduled") {
      continue;
    }
    try {
      const payload = parseWakeupJobPayload(job.message);
      if (payload.assignmentId === assignmentId) {
        return job;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function buildWakeupPrompt(
  detail: AssignmentDetail,
  events: AssignmentEventRecord[]
): string {
  const assignment = detail.assignment;
  const lines = [
    "Continue the autonomous assignment.",
    `Assignment id: ${assignment.id}`,
    `Objective: ${assignment.objective}`,
    `Lifecycle state: ${assignment.lifecycleState}`,
    `Wakeups: ${assignment.wakeupCount}/${assignment.policy.maxWakeups}`,
    `Consecutive failures: ${assignment.consecutiveFailureCount}/${assignment.policy.maxConsecutiveFailures}`,
    `Wake delay policy minutes: ${assignment.policy.wakeupDelayMinMinutes}-${assignment.policy.wakeupDelayMaxMinutes}`,
    `Context: ${JSON.stringify(assignment.context)}`,
    `Recent events: ${JSON.stringify(
      events.map((event) => ({
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
      }))
    )}`,
    `Linked runs: ${JSON.stringify(
      detail.runLinks.map((link) => ({
        runId: link.runId,
        action: link.action,
        createdAt: link.createdAt,
      }))
    )}`,
    "Return useful progress. Include one marker: ASSIGNMENT_STATUS: continue, ASSIGNMENT_STATUS: complete, or ASSIGNMENT_STATUS: blocked.",
    "Optionally include NEXT_WAKEUP_MINUTES: <integer> when more work should continue later.",
  ];
  if (shouldAllowPlannerMutationMarkers(detail)) {
    lines.push(
      'Optionally include one autonomous mutation marker on a single line, for example ASSIGNMENT_MUTATION: {"target":"configuration","mutationType":"operator_settings","rationale":"...","proposedChange":{"operatorSettings":{...}}}, ASSIGNMENT_MUTATION: {"target":"configuration","mutationType":"runtime_limits","riskClass":"medium","rationale":"...","proposedChange":{"runtimeLimits":{"defaultRunTimeoutMs":45000}}}, ASSIGNMENT_MUTATION: {"target":"prompt","mutationType":"managed_fragment","riskClass":"high","rationale":"...","proposedChange":{"promptFragment":{"id":"tone","mode":"upsert","text":"..."}}}, ASSIGNMENT_MUTATION: {"target":"memory","mutationType":"entry_lifecycle","riskClass":"high","rationale":"...","proposedChange":{"memoryEntry":{"action":"create","category":"semantic","content":"..."}}}, ASSIGNMENT_MUTATION: {"target":"memory_policy","mutationType":"runtime_bounds","rationale":"...","proposedChange":{"memoryPolicy":{...}}}, ASSIGNMENT_MUTATION: {"target":"role","mutationType":"permission_policy","rationale":"...","proposedChange":{"rolePolicy":{"roles":{"explorer":{"allowedMcpServers":["docs"]}}}}}, ASSIGNMENT_MUTATION: {"target":"project_file","mutationType":"draft","rationale":"...","proposedChange":{"projectFileDraft":{"path":"docs/example.md","content":"...","contentType":"text/markdown"}}}, ASSIGNMENT_MUTATION: {"target":"project_file","mutationType":"apply_draft","riskClass":"high","rationale":"...","proposedChange":{"projectFileApply":{"draftId":"pfd_..."}}}, or ASSIGNMENT_MUTATION: {"target":"project_file","mutationType":"apply_bundle","riskClass":"high","rationale":"...","proposedChange":{"projectFileBundle":{"draftIds":["pfd_...","pfd_..."]}}}. Mutations only apply when the assignment is evolve-authorized and assignment policy allows the class.'
    );
  }
  if (shouldAllowPlannerChildMarkers(detail)) {
    lines.push(
      'Optionally include one child-assignment marker on a single line: ASSIGNMENT_CHILD: {"objective":"...","title":"...","rationale":"...","waitForChild":true,"dependsOnChildIds":["asgn_..."],"waitForChildren":"all"}. Child assignments inherit parent policy and cannot exceed parent autonomy, depth, or active-child limits. Dependency ids must be sibling child assignments under the same parent.'
    );
  }
  return lines.join("\n");
}

function parsePlannerMarkers(
  outputText: string,
  options: { allowMutations?: boolean; allowChildren?: boolean } = {}
): {
  status: "continue" | "completed" | "blocked";
  nextWakeupMinutes?: number;
  mutation?: PlannerMutationRequest;
  child?: PlannerChildRequest;
} {
  const statusMatch = outputText.match(
    /ASSIGNMENT_STATUS:\s*(continue|complete|completed|blocked)/i
  );
  const nextMatch = outputText.match(/NEXT_WAKEUP_MINUTES:\s*(-?\d+)/i);
  const rawStatus = statusMatch?.[1]?.toLowerCase();
  const status =
    rawStatus === "complete" || rawStatus === "completed"
      ? "completed"
      : rawStatus === "blocked"
        ? "blocked"
        : "continue";
  return {
    status,
    nextWakeupMinutes: nextMatch ? Number(nextMatch[1]) : undefined,
    mutation:
      options.allowMutations === true
        ? parsePlannerMutationMarker(outputText)
        : undefined,
    child:
      options.allowChildren === true
        ? parsePlannerChildMarker(outputText)
        : undefined,
  };
}

function shouldAllowPlannerMutationMarkers(detail: AssignmentDetail): boolean {
  const policy = detail.assignment.policy.selfEvolution;
  return (
    detail.assignment.autonomyLevel === "evolve" &&
    policy.enabled &&
    policy.allowedMutationClasses.length > 0
  );
}

function shouldAllowPlannerChildMarkers(detail: AssignmentDetail): boolean {
  return (
    autonomyRank(detail.assignment.autonomyLevel) >= autonomyRank("execute") &&
    detail.assignment.policy.childAssignments.maxDepth > 0 &&
    detail.assignment.policy.childAssignments.maxActiveChildren > 0
  );
}

function parsePlannerChildMarker(
  outputText: string
): PlannerChildRequest | undefined {
  const childMatch = outputText.match(/^ASSIGNMENT_CHILD:\s*(\{.*\})\s*$/im);
  if (!childMatch?.[1]) {
    return undefined;
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(childMatch[1]) as JsonValue;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const value = parsed as Record<string, JsonValue>;
  if (
    typeof value.objective !== "string" ||
    value.objective.trim() === "" ||
    typeof value.rationale !== "string" ||
    value.rationale.trim() === ""
  ) {
    return undefined;
  }
  const autonomyLevel = parseAssignmentAutonomyLevel(value.autonomyLevel);
  const dependsOnChildIds = parseDependsOnChildIds(value.dependsOnChildIds);
  const waitForChildren =
    value.waitForChildren === "any" || value.waitForChildren === "all"
      ? value.waitForChildren
      : value.waitForChildren === undefined
        ? undefined
        : "invalid";
  return {
    objective: value.objective.trim(),
    title:
      typeof value.title === "string" && value.title.trim() !== ""
        ? value.title.trim()
        : undefined,
    rationale: value.rationale.trim(),
    autonomyLevel,
    waitForChild: value.waitForChild === true,
    dependsOnChildIds:
      waitForChildren === "invalid" ? [""] : dependsOnChildIds,
    waitForChildren: waitForChildren === "invalid" ? undefined : waitForChildren,
    metadata: value.metadata,
    context: Array.isArray(value.context) ? value.context : undefined,
  };
}

function parseDependsOnChildIds(
  value: JsonValue | undefined
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return [""];
  }
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      return [""];
    }
    ids.push(item.trim());
  }
  return ids;
}

function parsePlannerMutationMarker(
  outputText: string
): PlannerMutationRequest | undefined {
  const mutationMatch = outputText.match(
    /^ASSIGNMENT_MUTATION:\s*(\{.*\})\s*$/im
  );
  if (!mutationMatch?.[1]) {
    return undefined;
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(mutationMatch[1]) as JsonValue;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const value = parsed as Record<string, JsonValue>;
  if (
    typeof value.target !== "string" ||
    typeof value.mutationType !== "string" ||
    typeof value.rationale !== "string" ||
    value.rationale.trim() === "" ||
    value.proposedChange === undefined
  ) {
    return undefined;
  }
  const target = value.target as AutonomousMutationTarget;
  if (!AUTONOMOUS_MUTATION_TARGETS.includes(target)) {
    return undefined;
  }
  const riskClass =
    value.riskClass === "low" ||
    value.riskClass === "medium" ||
    value.riskClass === "high" ||
    value.riskClass === "critical"
      ? value.riskClass
      : undefined;
  return {
    target,
    mutationType: value.mutationType,
    rationale: value.rationale.trim(),
    riskClass,
    proposedChange: value.proposedChange,
  };
}

function parseAssignmentAutonomyLevel(
  value: JsonValue | undefined
): AssignmentAutonomyLevel | undefined {
  return typeof value === "string" &&
    ASSIGNMENT_AUTONOMY_LEVELS.includes(value as AssignmentAutonomyLevel)
    ? (value as AssignmentAutonomyLevel)
    : undefined;
}

function autonomyRank(level: AssignmentAutonomyLevel): number {
  return ASSIGNMENT_AUTONOMY_LEVELS.indexOf(level);
}

function parseWakeupJobPayload(message: string): {
  assignmentId: string;
  reason?: string;
} {
  const parsed = JSON.parse(message) as JsonValue;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("assignment wakeup job payload must be a JSON object");
  }
  const value = parsed as Record<string, JsonValue>;
  if (
    typeof value.assignmentId !== "string" ||
    value.assignmentId.trim() === ""
  ) {
    throw new Error("assignment wakeup job payload requires assignmentId");
  }
  return {
    assignmentId: value.assignmentId.trim(),
    reason: typeof value.reason === "string" ? value.reason : undefined,
  };
}

function clampDelayMinutes(
  requestedMinutes: number,
  assignment: AssignmentRecord
): number {
  if (!Number.isFinite(requestedMinutes)) {
    return DEFAULT_NEXT_WAKEUP_MINUTES;
  }
  const integerMinutes = Math.trunc(requestedMinutes);
  return Math.min(
    assignment.policy.wakeupDelayMaxMinutes,
    Math.max(assignment.policy.wakeupDelayMinMinutes, integerMinutes)
  );
}

function isTerminalAssignment(assignment: AssignmentRecord): boolean {
  return ["completed", "cancelled", "expired", "failed"].includes(
    assignment.lifecycleState
  );
}

function isIdleExpired(assignment: AssignmentRecord): boolean {
  return (
    Date.now() - Date.parse(assignment.lastActivityAt) >
    assignment.policy.maxIdleHours * 60 * 60 * 1000
  );
}

function isWaitedChild(assignment: AssignmentRecord): boolean {
  const metadata = assignment.metadata;
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, JsonValue>).parentWaitsForChild === true
  );
}

function shouldScheduleParentContinuation(
  assignments: AutonomousAssignmentService,
  parentAssignmentId: string
): boolean {
  const parent = assignments.getRequired(parentAssignmentId).assignment;
  if (isTerminalAssignment(parent)) {
    return false;
  }
  if (parent.lifecycleState === "active") {
    return true;
  }
  if (parent.lifecycleState !== "waiting") {
    return false;
  }
  const latestWait = latestParentWaitEvent(assignments, parentAssignmentId);
  if (!latestWait || latestWait.type === "paused") {
    return false;
  }
  return (
    latestWait.reason === "Planner promoted child assignment" ||
    latestWait.reason === "Waiting for active child assignment" ||
    latestWait.reason === "Waited child assignments satisfied"
  );
}

function latestParentWaitEvent(
  assignments: AutonomousAssignmentService,
  parentAssignmentId: string
): { type: string; reason?: string } | null {
  const events = assignments.latestTimelineByTypes(
    parentAssignmentId,
    ["paused", "waiting", "wakeup_scheduled", "resumed"],
    50
  ).events;
  for (const event of [...events].reverse()) {
    if (
      event.type !== "paused" &&
      event.type !== "waiting" &&
      event.type !== "wakeup_scheduled" &&
      event.type !== "resumed"
    ) {
      continue;
    }
    if (event.payload === null || typeof event.payload !== "object") {
      return { type: event.type };
    }
    if (Array.isArray(event.payload)) {
      return { type: event.type };
    }
    const reason = (event.payload as Record<string, JsonValue>).reason;
    return {
      type: event.type,
      reason: typeof reason === "string" ? reason : undefined,
    };
  }
  return null;
}

function isActiveChildReservationError(error: unknown): boolean {
  return (
    error instanceof AssignmentValidationError &&
    (error.message ===
	      "Assignment wakeup budget is reserved for active child assignments" ||
	      error.message === "Assignment is waiting for active child assignment" ||
	      error.message ===
	        "Assignment is waiting for child assignment dependencies")
	  );
	}
