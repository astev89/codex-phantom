import type { JsonValue } from "../shared/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { AutonomousAssignmentService } from "./service.ts";
import type {
  AutonomousMutationLedger,
  AutonomousMutationStatus,
  AutonomousMutationTarget,
} from "./mutation-ledger.ts";
import {
  AUTONOMOUS_MUTATION_STATUSES,
  AUTONOMOUS_MUTATION_TARGETS,
} from "./mutation-ledger.ts";
import type {
  AssignmentAutonomyLevel,
  AssignmentLifecycleState,
  ListAssignmentsInput,
} from "./types.ts";
import {
  ASSIGNMENT_AUTONOMY_LEVELS,
  ASSIGNMENT_LIFECYCLE_STATES,
} from "./types.ts";

export function registerAssignmentTools(
  tools: ToolRegistry,
  assignments: AutonomousAssignmentService,
  mutations?: AutonomousMutationLedger
): void {
  tools.register({
    id: "assignment.list",
    description:
      "List autonomous assignments with optional lifecycle, autonomy, parent, source channel, and limit filters.",
    scopes: ["read"],
    kind: "in_process",
    inputSchema: {
      type: "object",
      properties: {
        lifecycleState: { type: "string" },
        autonomyLevel: { type: "string" },
        parentAssignmentId: { type: "string" },
        sourceChannelId: { type: "string" },
        limit: { type: "integer" },
      },
    },
    handler: (input) => ({
      assignments: assignments.list(parseListInput(input)),
    }),
  });

  tools.register({
    id: "assignment.get",
    description:
      "Get one autonomous assignment by id, including linked coordinator runs.",
    scopes: ["read"],
    kind: "in_process",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
      },
    },
    handler: (input) => {
      const id = requiredString(input, "id");
      const detail = assignments.get(id);
      if (!detail) {
        throw new Error(
          `Unknown assignment ${id}. Use assignment.list to find available assignments.`
        );
      }
      return detail;
    },
  });

  tools.register({
    id: "assignment.timeline",
    description:
      "Read an autonomous assignment timeline with retention-aware audit, milestone, and detail events.",
    scopes: ["read"],
    kind: "in_process",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        limit: { type: "integer" },
      },
    },
    handler: (input) => {
      const value = asObject(input);
      return {
        timeline: assignments.timeline(
          requiredString(value, "id"),
          optionalPositiveInteger(value.limit, "limit")
        ),
      };
    },
  });

  if (mutations) {
    tools.register({
      id: "assignment.mutations",
      description:
        "Read autonomous mutation ledger records for an assignment with optional run, target, status, and limit filters.",
      scopes: ["read"],
      kind: "in_process",
      inputSchema: {
        type: "object",
        required: ["assignmentId"],
        properties: {
          assignmentId: { type: "string" },
          runId: { type: "string" },
          target: { type: "string" },
          status: { type: "string" },
          limit: { type: "integer" },
        },
      },
      handler: (input) => {
        const value = asObject(input);
        const assignmentId = requiredString(value, "assignmentId");
        if (!assignments.get(assignmentId)) {
          throw new Error(
            `Unknown assignment ${assignmentId}. Use assignment.list to find available assignments.`
          );
        }
        return {
          mutations: mutations.list({
            assignmentId,
            runId: optionalString(value.runId, "runId"),
            target: optionalMutationTarget(value.target),
            status: optionalMutationStatus(value.status),
            limit: optionalPositiveInteger(value.limit, "limit"),
          }),
        };
      },
    });
  }
}

function parseListInput(input: JsonValue): ListAssignmentsInput {
  const value = asObject(input);
  return {
    lifecycleState: optionalLifecycleState(value.lifecycleState),
    autonomyLevel: optionalAutonomyLevel(value.autonomyLevel),
    parentAssignmentId: optionalString(
      value.parentAssignmentId,
      "parentAssignmentId"
    ),
    sourceChannelId: optionalString(value.sourceChannelId, "sourceChannelId"),
    limit: optionalPositiveInteger(value.limit, "limit"),
  };
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("assignment tool input must be a JSON object");
  }
  return value as Record<string, JsonValue>;
}

function requiredString(input: JsonValue, field: string): string;
function requiredString(
  input: Record<string, JsonValue>,
  field: string
): string;
function requiredString(
  input: JsonValue | Record<string, JsonValue>,
  field: string
): string {
  const value =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? input[field]
      : undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(
  value: JsonValue | undefined,
  field: string
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string when provided`);
  }
  return value.trim();
}

function optionalPositiveInteger(
  value: JsonValue | undefined,
  field: string
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function optionalLifecycleState(
  value: JsonValue | undefined
): AssignmentLifecycleState | undefined {
  const state = optionalString(value, "lifecycleState");
  if (!state) {
    return undefined;
  }
  if (
    !ASSIGNMENT_LIFECYCLE_STATES.includes(state as AssignmentLifecycleState)
  ) {
    throw new Error("lifecycleState must be a valid assignment state");
  }
  return state as AssignmentLifecycleState;
}

function optionalMutationTarget(
  value: JsonValue | undefined
): AutonomousMutationTarget | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    !AUTONOMOUS_MUTATION_TARGETS.includes(value as AutonomousMutationTarget)
  ) {
    throw new Error(
      "target must be prompt, memory_policy, tool, role, configuration, or project_file"
    );
  }
  return value as AutonomousMutationTarget;
}

function optionalMutationStatus(
  value: JsonValue | undefined
): AutonomousMutationStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    !AUTONOMOUS_MUTATION_STATUSES.includes(value as AutonomousMutationStatus)
  ) {
    throw new Error("status must be planned, applied, failed, or rolled_back");
  }
  return value as AutonomousMutationStatus;
}

function optionalAutonomyLevel(
  value: JsonValue | undefined
): AssignmentAutonomyLevel | undefined {
  const level = optionalString(value, "autonomyLevel");
  if (!level) {
    return undefined;
  }
  if (!ASSIGNMENT_AUTONOMY_LEVELS.includes(level as AssignmentAutonomyLevel)) {
    throw new Error("autonomyLevel must be a valid assignment autonomy level");
  }
  return level as AssignmentAutonomyLevel;
}
