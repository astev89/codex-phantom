import type { JobRecord } from "../scheduler/service.ts";
import type { JsonValue } from "../shared/types.ts";
import { AutonomousAssignmentService } from "./service.ts";
import type { AssignmentWakeupPlanner } from "./wakeup-planner.ts";
import type {
  AssignmentAutonomyLevel,
  AssignmentDetail,
  AssignmentPolicyPatch,
} from "./types.ts";

export type AssignmentIntakeCommand = {
  create?: boolean;
  title?: string;
  autonomyLevel?: AssignmentAutonomyLevel;
  policy?: AssignmentPolicyPatch;
};

export type AssignmentIntentDecision =
  | { kind: "one_shot" }
  | {
      kind: "create_assignment";
      objective: string;
      title?: string;
      autonomyLevel?: AssignmentAutonomyLevel;
      policy?: AssignmentPolicyPatch;
      reason: string;
    };

export type AssignmentIntakeInput = {
  channelId: string;
  providerEventId?: string;
  conversationId: string;
  senderId?: string;
  message: string;
  rawPayload: JsonValue;
  assignment?: AssignmentIntakeCommand;
};

export type AssignmentIntakeResult =
  | { kind: "one_shot" }
  | {
      kind: "assignment_created";
      assignment: AssignmentDetail;
      duplicate: boolean;
      nextJob?: JobRecord;
      acknowledgementText: string;
    };

const PERSISTENCE_PATTERNS = [
  /\bkeep working\b/i,
  /\bcontinue until\b/i,
  /\bmonitor\b/i,
  /\bcheck back\b/i,
  /\bfollow up\b/i,
  /\bwake yourself\b/i,
  /\bkeep going\b/i,
  /\bin the background\b/i,
];

export function classifyAssignmentIntent(input: {
  message: string;
  assignment?: AssignmentIntakeCommand;
}): AssignmentIntentDecision {
  const message = input.message.trim();
  if (input.assignment?.create === false) {
    return { kind: "one_shot" };
  }
  if (input.assignment?.create === true) {
    return {
      kind: "create_assignment",
      objective: message,
      title: normalizeText(input.assignment.title),
      autonomyLevel: input.assignment.autonomyLevel,
      policy: input.assignment.policy,
      reason: "structured_request",
    };
  }
  const matched = PERSISTENCE_PATTERNS.find((pattern) => pattern.test(message));
  if (!matched) {
    return { kind: "one_shot" };
  }
  return {
    kind: "create_assignment",
    objective: message,
    reason: "persistence_intent",
  };
}

export class AssignmentIntakeService {
  private readonly assignments: AutonomousAssignmentService;
  private readonly wakeups?: Pick<AssignmentWakeupPlanner, "scheduleNext">;

  constructor(
    assignments: AutonomousAssignmentService,
    wakeups?: Pick<AssignmentWakeupPlanner, "scheduleNext">
  ) {
    this.assignments = assignments;
    this.wakeups = wakeups;
  }

  async handle(input: AssignmentIntakeInput): Promise<AssignmentIntakeResult> {
    const decision = classifyAssignmentIntent({
      message: input.message,
      assignment: input.assignment,
    });
    if (decision.kind === "one_shot") {
      return { kind: "one_shot" };
    }

    const duplicate = this.findDuplicate(input);
    if (duplicate) {
      return {
        kind: "assignment_created",
        assignment: duplicate,
        duplicate: true,
        acknowledgementText: `Assignment already exists ${duplicate.assignment.id}: ${duplicate.assignment.objective}`,
      };
    }

    const created = this.assignments.create({
      objective: decision.objective,
      title: decision.title,
      autonomyLevel: decision.autonomyLevel,
      policy: decision.policy,
      source: {
        channelId: input.channelId,
        conversationId: input.conversationId,
        userId: input.senderId,
      },
      metadata: {
        intake: {
          providerEventId: input.providerEventId ?? null,
          reason: decision.reason,
          rawPayload: input.rawPayload,
        },
      },
      createdBy: input.senderId ?? input.channelId,
    });
    const nextJob = this.wakeups
      ? await this.wakeups.scheduleNext({
          assignmentId: created.assignment.id,
          reason: "Assignment created from channel intake",
          delayMinutes: 0,
          force: true,
        })
      : undefined;
    return {
      kind: "assignment_created",
      assignment: created,
      duplicate: false,
      nextJob,
      acknowledgementText: `Created assignment ${created.assignment.id}: ${created.assignment.objective}`,
    };
  }

  private findDuplicate(input: AssignmentIntakeInput): AssignmentDetail | null {
    if (!input.providerEventId) {
      return null;
    }
    const matchingAssignment = this.assignments
      .list({ sourceChannelId: input.channelId, limit: 100 })
      .find((assignment) => {
        const metadata = recordValue(assignment.metadata);
        const intake = recordValue(metadata?.intake);
        return intake?.providerEventId === input.providerEventId;
      });
    return matchingAssignment
      ? this.assignments.get(matchingAssignment.id)
      : null;
  }
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
