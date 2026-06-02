import type { JsonValue } from "../shared/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { AutonomousAssignmentService } from "./service.ts";
import type {
  AssignmentAutonomyLevel,
  AssignmentLifecycleState,
  ListAssignmentsInput,
} from "./types.ts";

export function registerAssignmentTools(
  tools: ToolRegistry,
  assignments: AutonomousAssignmentService
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
        limit: { type: "number" },
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
        limit: { type: "number" },
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
  if (!ASSIGNMENT_LIFECYCLE_STATES.includes(state)) {
    throw new Error("lifecycleState must be a valid assignment state");
  }
  return state as AssignmentLifecycleState;
}

function optionalAutonomyLevel(
  value: JsonValue | undefined
): AssignmentAutonomyLevel | undefined {
  const level = optionalString(value, "autonomyLevel");
  if (!level) {
    return undefined;
  }
  if (!ASSIGNMENT_AUTONOMY_LEVELS.includes(level)) {
    throw new Error("autonomyLevel must be a valid assignment autonomy level");
  }
  return level as AssignmentAutonomyLevel;
}

const ASSIGNMENT_LIFECYCLE_STATES = [
  "active",
  "waiting",
  "needs_approval",
  "blocked",
  "completed",
  "cancelled",
  "expired",
  "failed",
];

const ASSIGNMENT_AUTONOMY_LEVELS = [
  "observe",
  "draft",
  "execute",
  "operate",
  "evolve",
];
