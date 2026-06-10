import type { OrchestrationService } from "../orchestration/service.ts";
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
  private readonly activeWakeups = new Set<string>();

  constructor(input: {
    assignments: AutonomousAssignmentService;
    scheduler: AssignmentWakeupScheduler;
    orchestration: OrchestrationService;
  }) {
    this.assignments = input.assignments;
    this.scheduler = input.scheduler;
    this.orchestration = input.orchestration;
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
  }): Promise<JobRecord> {
    const detail = this.assignments.getRequired(input.assignmentId);
    const existing = findScheduledWakeupJob(
      await this.scheduler.list(),
      input.assignmentId
    );
    if (existing) {
      return existing;
    }
    const delayMinutes =
      input.delayMinutes === 0
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
  ].join("\n");
}

function parsePlannerMarkers(outputText: string): {
  status: "continue" | "completed" | "blocked";
  nextWakeupMinutes?: number;
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
