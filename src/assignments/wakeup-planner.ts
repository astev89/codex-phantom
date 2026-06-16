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
  AssignmentEventRecord,
  AssignmentRecord,
} from "./types.ts";
import { AutonomousAssignmentService } from "./service.ts";

export const ASSIGNMENT_WAKEUP_JOB_NAME = "assignment.wakeup";
const DEFAULT_NEXT_WAKEUP_MINUTES = 30;

type AssignmentWakeupScheduler = Pick<SchedulerService, "list" | "schedule">;
type AssignmentMutationExecutor = Pick<AutonomousMutationExecutor, "apply">;
type PlannerMutationRequest = Pick<
  ApplyAutonomousMutationInput,
  "target" | "mutationType" | "rationale" | "riskClass" | "proposedChange"
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
      return {
        status: "expired",
        assignment: this.assignments.applyWakeupDecision({
          assignmentId: input.assignmentId,
          decision: "expired",
          reason: "Assignment exceeded idle policy before wakeup",
        }),
      };
    }

    this.activeWakeups.add(input.assignmentId);
    try {
      const started = this.assignments.startWakeup({
        assignmentId: input.assignmentId,
        actor: input.actor,
        reason: input.reason,
        source: input.source,
      });

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
        const marker = parsePlannerMarkers(result.outputText);
        this.applyPlannerMutation({
          assignmentId: input.assignmentId,
          runId: result.runId,
          mutation: marker.mutation,
        });
        if (marker.status === "completed") {
          return {
            status: "completed",
            runId: result.runId,
            assignment: this.assignments.applyWakeupDecision({
              assignmentId: input.assignmentId,
              decision: "completed",
              reason: "Coordinator reported assignment completion",
            }),
          };
        }
        if (marker.status === "blocked") {
          return {
            status: "blocked",
            runId: result.runId,
            assignment: this.assignments.applyWakeupDecision({
              assignmentId: input.assignmentId,
              decision: "blocked",
              reason: "Coordinator reported assignment is blocked",
            }),
          };
        }
        if (
          completed.assignment.wakeupCount >=
          completed.assignment.policy.maxWakeups
        ) {
          return {
            status: "expired",
            runId: result.runId,
            assignment: this.assignments.applyWakeupDecision({
              assignmentId: input.assignmentId,
              decision: "expired",
              reason: "Assignment exhausted wakeup budget",
            }),
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
          return {
            status: "failed",
            assignment: this.assignments.applyWakeupDecision({
              assignmentId: input.assignmentId,
              decision: "failed",
              reason: "Assignment exhausted consecutive failure budget",
            }),
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
    const existing = findScheduledWakeupJob(
      await this.scheduler.list(),
      input.assignmentId,
      { force: input.force === true }
    );
    if (existing) {
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
      JSON.stringify({
        assignmentId: input.assignmentId,
        reason: input.reason,
      }),
      {
        delayMs: delayMinutes * 60_000,
        maxAttempts: 1,
      }
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
  }): void {
    if (!this.mutations || !input.mutation) {
      return;
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
        return;
      }
      throw error;
    }
  }
}

function findScheduledWakeupJob(
  jobs: JobRecord[],
  assignmentId: string,
  options: { force?: boolean } = {}
): JobRecord | null {
  const now = Date.now();
  for (const job of jobs) {
    if (job.name !== ASSIGNMENT_WAKEUP_JOB_NAME || job.status !== "scheduled") {
      continue;
    }
    if (options.force && Date.parse(job.scheduledAt) > now) {
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
  return [
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
    'Optionally include one autonomous mutation marker on a single line: ASSIGNMENT_MUTATION: {"target":"configuration","mutationType":"operator_settings","rationale":"...","proposedChange":{"operatorSettings":{...}}}. Mutations only apply when the assignment is evolve-authorized and assignment policy allows the class.',
  ].join("\n");
}

function parsePlannerMarkers(outputText: string): {
  status: "continue" | "completed" | "blocked";
  nextWakeupMinutes?: number;
  mutation?: PlannerMutationRequest;
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
    mutation: parsePlannerMutationMarker(outputText),
  };
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
  const riskClass =
    value.riskClass === "low" ||
    value.riskClass === "medium" ||
    value.riskClass === "high" ||
    value.riskClass === "critical"
      ? value.riskClass
      : undefined;
  return {
    target: value.target as PlannerMutationRequest["target"],
    mutationType: value.mutationType,
    rationale: value.rationale.trim(),
    riskClass,
    proposedChange: value.proposedChange,
  };
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
