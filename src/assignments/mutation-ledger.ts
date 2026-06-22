import { createId } from "../shared/ids.ts";
import type { JsonValue } from "../shared/types.ts";
import {
  decodeJson,
  encodeJson,
  toJsonValue,
  type AppDatabase,
} from "../platform/database.ts";
import type {
  AssignmentAutonomyLevel,
  AssignmentMutationMilestone,
} from "./types.ts";
import { ASSIGNMENT_AUTONOMY_LEVELS } from "./types.ts";
import type { AutonomousAssignmentService } from "./service.ts";
import type { SelfEvolutionRiskClass } from "../self-evolution/proposals.ts";

export type AutonomousMutationTarget =
  | "prompt"
  | "memory"
  | "memory_policy"
  | "tool"
  | "role"
  | "configuration"
  | "project_file";

export const AUTONOMOUS_MUTATION_TARGETS = [
  "prompt",
  "memory",
  "memory_policy",
  "tool",
  "role",
  "configuration",
  "project_file",
] as const satisfies readonly AutonomousMutationTarget[];

export type AutonomousMutationStatus =
  | "planned"
  | "applied"
  | "failed"
  | "rolled_back";

export const AUTONOMOUS_MUTATION_STATUSES = [
  "planned",
  "applied",
  "failed",
  "rolled_back",
] as const satisfies readonly AutonomousMutationStatus[];

export type AutonomousMutationRecord = {
  id: string;
  assignmentId: string;
  runId?: string;
  target: AutonomousMutationTarget;
  mutationType: string;
  autonomyLevel: AssignmentAutonomyLevel;
  status: AutonomousMutationStatus;
  riskClass: SelfEvolutionRiskClass;
  authorizingPolicy: JsonValue;
  rationale: string;
  before: JsonValue;
  after: JsonValue;
  rollback: JsonValue;
  affectedResources: JsonValue;
  verification: JsonValue;
  operatorNotification: JsonValue;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  failedAt?: string;
  rolledBackAt?: string;
  notifiedAt?: string;
};

export type RecordAutonomousMutationInput = {
  assignmentId: string;
  runId?: string;
  target: AutonomousMutationTarget;
  mutationType: string;
  autonomyLevel: AssignmentAutonomyLevel;
  authorizingPolicy: JsonValue;
  rationale: string;
  riskClass: SelfEvolutionRiskClass;
  affectedResources?: JsonValue;
  actor?: string;
};

export type RecordAppliedAutonomousMutationInput = {
  before?: JsonValue;
  after: JsonValue;
  rollback?: JsonValue;
  affectedResources?: JsonValue;
  verification?: JsonValue;
  operatorNotification?: JsonValue;
};

export type RecordFailedAutonomousMutationInput =
  RecordAutonomousMutationInput & {
    errorMessage: string;
    before?: JsonValue;
    after?: JsonValue;
    rollback?: JsonValue;
    verification?: JsonValue;
  };

export type RecordFailedAutonomousMutationOutcomeInput = {
  errorMessage: string;
  before?: JsonValue;
  after?: JsonValue;
  rollback?: JsonValue;
  affectedResources?: JsonValue;
  verification?: JsonValue;
};

export type ListAutonomousMutationsInput = {
  assignmentId?: string;
  runId?: string;
  target?: AutonomousMutationTarget;
  status?: AutonomousMutationStatus;
  limit?: number;
};

type AutonomousMutationRow = {
  id: string;
  assignment_id: string;
  run_id: string | null;
  target: AutonomousMutationTarget;
  mutation_type: string;
  autonomy_level: AssignmentAutonomyLevel;
  status: AutonomousMutationStatus;
  risk_class: SelfEvolutionRiskClass;
  authorizing_policy_json: string;
  rationale: string;
  before_json: string;
  after_json: string;
  rollback_json: string;
  affected_resources_json: string;
  verification_json: string;
  operator_notification_json: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
  failed_at: string | null;
  rolled_back_at: string | null;
  notified_at: string | null;
};

const TARGETS = new Set<AutonomousMutationTarget>(AUTONOMOUS_MUTATION_TARGETS);
const STATUSES = new Set<AutonomousMutationStatus>(
  AUTONOMOUS_MUTATION_STATUSES
);
const AUTONOMY_LEVELS = new Set<AssignmentAutonomyLevel>(
  ASSIGNMENT_AUTONOMY_LEVELS
);
const RISK_CLASSES = new Set<SelfEvolutionRiskClass>([
  "low",
  "medium",
  "high",
  "critical",
]);

export class AutonomousMutationLedger {
  private readonly database: AppDatabase;
  private readonly assignments: AutonomousAssignmentService;

  constructor(database: AppDatabase, assignments: AutonomousAssignmentService) {
    this.database = database;
    this.assignments = assignments;
  }

  recordPlanned(
    input: RecordAutonomousMutationInput
  ): AutonomousMutationRecord {
    const normalized = normalizeBaseInput(input);
    this.requireAssignment(normalized.assignmentId);
    const now = new Date().toISOString();
    const id = createId("asgnmut");
    this.database.transaction(() => {
      this.database.run(
        `
          INSERT INTO assignment_mutations (
            id, assignment_id, run_id, target, mutation_type, autonomy_level,
            status, risk_class, authorizing_policy_json, rationale,
            before_json, after_json, rollback_json, affected_resources_json,
            verification_json, operator_notification_json, error_message,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        id,
        normalized.assignmentId,
        normalized.runId ?? null,
        normalized.target,
        normalized.mutationType,
        normalized.autonomyLevel,
        "planned",
        normalized.riskClass,
        encodeJson(normalized.authorizingPolicy),
        normalized.rationale,
        encodeJson(null),
        encodeJson(null),
        encodeJson(null),
        encodeJson(normalized.affectedResources ?? []),
        encodeJson(null),
        encodeJson(null),
        null,
        now,
        now
      );
      this.recordAssignmentEvent(id, "planned", normalized);
    });
    return this.getRequired(id);
  }

  recordApplied(
    id: string,
    input: RecordAppliedAutonomousMutationInput
  ): AutonomousMutationRecord {
    if (!hasJsonEvidence(input.before) && !hasJsonEvidence(input.rollback)) {
      throw new Error(
        "Applied autonomous mutations require a rollback payload or before snapshot"
      );
    }
    const current = this.getRequired(id);
    assertTransition(current.status, ["planned"], "applied");
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run(
        `
          UPDATE assignment_mutations
          SET status = 'applied',
              before_json = ?,
              after_json = ?,
              rollback_json = ?,
              affected_resources_json = ?,
              verification_json = ?,
              operator_notification_json = ?,
              notified_at = ?,
              error_message = NULL,
              updated_at = ?,
              applied_at = ?
          WHERE id = ?
        `,
        encodeJson(toJsonOrNull(input.before)),
        encodeJson(toJsonValue(input.after)),
        encodeJson(toJsonOrNull(input.rollback)),
        encodeJson(
          toJsonOrExisting(input.affectedResources, current.affectedResources)
        ),
        encodeJson(toJsonOrNull(input.verification)),
        encodeJson(toJsonOrNull(input.operatorNotification)),
        hasJsonEvidence(input.operatorNotification) ? now : null,
        now,
        now,
        id
      );
      this.recordAssignmentEvent(id, "applied", {
        ...current,
        actor: actorFromAuthorizingPolicy(current.authorizingPolicy),
      });
    });
    return this.getRequired(id);
  }

  recordFailed(
    input: RecordFailedAutonomousMutationInput
  ): AutonomousMutationRecord {
    const normalized = normalizeBaseInput(input);
    const errorMessage = requireText(input.errorMessage, "errorMessage");
    this.requireAssignment(normalized.assignmentId);
    const now = new Date().toISOString();
    const id = createId("asgnmut");
    this.database.transaction(() => {
      this.database.run(
        `
          INSERT INTO assignment_mutations (
            id, assignment_id, run_id, target, mutation_type, autonomy_level,
            status, risk_class, authorizing_policy_json, rationale,
            before_json, after_json, rollback_json, affected_resources_json,
            verification_json, operator_notification_json, error_message,
            created_at, updated_at, failed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        id,
        normalized.assignmentId,
        normalized.runId ?? null,
        normalized.target,
        normalized.mutationType,
        normalized.autonomyLevel,
        "failed",
        normalized.riskClass,
        encodeJson(normalized.authorizingPolicy),
        normalized.rationale,
        encodeJson(toJsonOrNull(input.before)),
        encodeJson(toJsonOrNull(input.after)),
        encodeJson(toJsonOrNull(input.rollback)),
        encodeJson(normalized.affectedResources ?? []),
        encodeJson(toJsonOrNull(input.verification)),
        encodeJson(null),
        errorMessage,
        now,
        now,
        now
      );
      this.recordAssignmentEvent(id, "failed", {
        ...normalized,
        errorMessage,
      });
    });
    return this.getRequired(id);
  }

  recordFailedOutcome(
    id: string,
    input: RecordFailedAutonomousMutationOutcomeInput
  ): AutonomousMutationRecord {
    const current = this.getRequired(id);
    assertTransition(current.status, ["planned"], "failed");
    const errorMessage = requireText(input.errorMessage, "errorMessage");
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run(
        `
          UPDATE assignment_mutations
          SET status = 'failed',
              before_json = ?,
              after_json = ?,
              rollback_json = ?,
              affected_resources_json = ?,
              verification_json = ?,
              error_message = ?,
              updated_at = ?,
              failed_at = ?
          WHERE id = ?
        `,
        encodeJson(toJsonOrNull(input.before)),
        encodeJson(toJsonOrNull(input.after)),
        encodeJson(toJsonOrNull(input.rollback)),
        encodeJson(
          toJsonOrExisting(input.affectedResources, current.affectedResources)
        ),
        encodeJson(toJsonOrNull(input.verification)),
        errorMessage,
        now,
        now,
        id
      );
      this.recordAssignmentEvent(id, "failed", {
        assignmentId: current.assignmentId,
        runId: current.runId,
        target: current.target,
        mutationType: current.mutationType,
        riskClass: current.riskClass,
        rationale: current.rationale,
        actor: actorFromAuthorizingPolicy(current.authorizingPolicy),
        errorMessage,
      });
    });
    return this.getRequired(id);
  }

  recordRolledBack(
    id: string,
    input: { verification?: JsonValue; actor?: string } = {}
  ): AutonomousMutationRecord {
    const current = this.getRequired(id);
    assertTransition(current.status, ["applied"], "rolled_back");
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run(
        `
          UPDATE assignment_mutations
          SET status = 'rolled_back',
              verification_json = ?,
              updated_at = ?,
              rolled_back_at = ?
          WHERE id = ?
        `,
        encodeJson(toJsonOrExisting(input.verification, current.verification)),
        now,
        now,
        id
      );
      this.recordAssignmentEvent(id, "rolled_back", {
        ...current,
        actor: normalizeOptionalText(input.actor),
      });
    });
    return this.getRequired(id);
  }

  recordOperatorNotification(
    id: string,
    operatorNotification: JsonValue
  ): AutonomousMutationRecord {
    this.getRequired(id);
    if (!hasJsonEvidence(operatorNotification)) {
      throw new Error("operatorNotification must be a non-null JSON value");
    }
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE assignment_mutations
        SET operator_notification_json = ?,
            updated_at = ?,
            notified_at = ?
        WHERE id = ?
      `,
      encodeJson(toJsonValue(operatorNotification)),
      now,
      now,
      id
    );
    return this.getRequired(id);
  }

  get(id: string): AutonomousMutationRecord | null {
    const row = this.database.get<AutonomousMutationRow>(
      "SELECT * FROM assignment_mutations WHERE id = ?",
      id
    );
    return row ? toAutonomousMutationRecord(row) : null;
  }

  list(input: ListAutonomousMutationsInput = {}): AutonomousMutationRecord[] {
    const filters: string[] = [];
    const values: string[] = [];
    if (input.assignmentId) {
      filters.push("assignment_id = ?");
      values.push(input.assignmentId);
    }
    if (input.runId) {
      filters.push("run_id = ?");
      values.push(input.runId);
    }
    if (input.target) {
      assertTarget(input.target);
      filters.push("target = ?");
      values.push(input.target);
    }
    if (input.status) {
      assertStatus(input.status);
      filters.push("status = ?");
      values.push(input.status);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = this.database.all<AutonomousMutationRow>(
      `SELECT * FROM assignment_mutations ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      ...values,
      boundLimit(input.limit, 200)
    );
    return rows.map(toAutonomousMutationRecord);
  }

  findNewerApplied(input: {
    assignmentId: string;
    target: AutonomousMutationTarget;
    mutationType: string;
    mutationTypes?: readonly string[];
    appliedAt: string;
    id: string;
    scope?: "assignment" | "global" | "affected_resources";
    affectedResources?: JsonValue;
  }): AutonomousMutationRecord | null {
    assertTarget(input.target);
    const scope = input.scope ?? "assignment";
    const assignmentFilter =
      scope === "assignment" ? "AND candidate.assignment_id = ?" : "";
    const mutationTypes =
      input.mutationTypes && input.mutationTypes.length > 0
        ? input.mutationTypes.map((mutationType) =>
            requireText(mutationType, "mutationTypes")
          )
        : [requireText(input.mutationType, "mutationType")];
    const mutationTypePlaceholders = mutationTypes.map(() => "?").join(", ");
    const resourcePairs =
      scope === "affected_resources"
        ? affectedResourcePairs(input.affectedResources)
        : [];
    const affectedResourceFilter =
      scope === "affected_resources" && resourcePairs.length > 0
        ? `AND EXISTS (
            SELECT 1
            FROM json_each(candidate.affected_resources_json) AS resource
            WHERE ${resourcePairs
              .map(
                () =>
                  "(json_extract(resource.value, '$.type') = ? AND (json_extract(resource.value, '$.id') = ? OR json_extract(resource.value, '$.path') = ?))"
              )
              .join(" OR ")}
          )`
        : "";
    const values = [
      requireText(input.id, "id"),
      ...(scope === "assignment"
        ? [requireText(input.assignmentId, "assignmentId")]
        : []),
      input.target,
      ...mutationTypes,
      ...resourcePairs.flatMap((resource) => [
        resource.type,
        resource.resourceId,
        resource.resourceId,
      ]),
      requireText(input.appliedAt, "appliedAt"),
      requireText(input.appliedAt, "appliedAt"),
    ];
    const rows = this.database.all<AutonomousMutationRow>(
      `
        SELECT candidate.* FROM assignment_mutations AS candidate
        JOIN assignment_mutations AS current ON current.id = ?
        WHERE 1 = 1
          ${assignmentFilter}
          AND candidate.target = ?
          AND candidate.mutation_type IN (${mutationTypePlaceholders})
          AND candidate.status = 'applied'
          ${affectedResourceFilter}
          AND (
            candidate.applied_at > ?
            OR (
              candidate.applied_at = ?
              AND candidate.rowid > current.rowid
            )
          )
        ORDER BY candidate.applied_at DESC, candidate.rowid DESC
        LIMIT ?
      `,
      ...values,
      1
    );
    return rows[0] ? toAutonomousMutationRecord(rows[0]) : null;
  }

  private getRequired(id: string): AutonomousMutationRecord {
    const mutation = this.get(id);
    if (!mutation) {
      throw new Error(`Unknown autonomous mutation ${id}`);
    }
    return mutation;
  }

  private requireAssignment(assignmentId: string): void {
    if (!this.assignments.get(assignmentId)) {
      throw new Error(
        `Unknown assignment ${assignmentId}. Use assignment.list to find available assignments.`
      );
    }
  }

  private recordAssignmentEvent(
    mutationId: string,
    status: AssignmentMutationMilestone,
    input: {
      assignmentId: string;
      runId?: string;
      target: string;
      mutationType: string;
      riskClass: string;
      rationale: string;
      actor?: string;
      errorMessage?: string;
    }
  ): void {
    this.assignments.recordMutationLedgerEvent({
      assignmentId: input.assignmentId,
      mutationId,
      status,
      target: input.target,
      mutationType: input.mutationType,
      runId: input.runId,
      riskClass: input.riskClass,
      rationale: input.rationale,
      actor: input.actor,
      errorMessage: input.errorMessage,
    });
  }
}

function normalizeBaseInput(
  input: RecordAutonomousMutationInput
): RecordAutonomousMutationInput {
  assertTarget(input.target);
  assertAutonomyLevel(input.autonomyLevel);
  assertRiskClass(input.riskClass);
  return {
    assignmentId: requireText(input.assignmentId, "assignmentId"),
    runId: normalizeOptionalText(input.runId),
    target: input.target,
    mutationType: requireText(input.mutationType, "mutationType"),
    autonomyLevel: input.autonomyLevel,
    authorizingPolicy: toJsonValue(input.authorizingPolicy),
    rationale: requireText(input.rationale, "rationale"),
    riskClass: input.riskClass,
    affectedResources:
      input.affectedResources === undefined
        ? undefined
        : toJsonValue(input.affectedResources),
    actor: normalizeOptionalText(input.actor),
  };
}

function assertTarget(target: AutonomousMutationTarget): void {
  if (!TARGETS.has(target)) {
    throw new Error(
      "target must be prompt, memory, memory_policy, tool, role, configuration, or project_file"
    );
  }
}

function assertStatus(status: AutonomousMutationStatus): void {
  if (!STATUSES.has(status)) {
    throw new Error("status must be planned, applied, failed, or rolled_back");
  }
}

function assertAutonomyLevel(autonomyLevel: AssignmentAutonomyLevel): void {
  if (!AUTONOMY_LEVELS.has(autonomyLevel)) {
    throw new Error("autonomyLevel must be a valid assignment autonomy level");
  }
}

function assertRiskClass(riskClass: SelfEvolutionRiskClass): void {
  if (!RISK_CLASSES.has(riskClass)) {
    throw new Error("riskClass must be low, medium, high, or critical");
  }
}

function assertTransition(
  current: AutonomousMutationStatus,
  allowed: AutonomousMutationStatus[],
  next: AutonomousMutationStatus
): void {
  if (!allowed.includes(current)) {
    throw new Error(`Cannot mark ${current} autonomous mutation as ${next}`);
  }
}

function requireText(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function toJsonOrNull(value: JsonValue | undefined): JsonValue {
  return value === undefined ? null : toJsonValue(value);
}

function toJsonOrExisting(
  value: JsonValue | undefined,
  existing: JsonValue
): JsonValue {
  return value === undefined ? existing : toJsonValue(value);
}

function hasJsonEvidence(value: JsonValue | undefined): boolean {
  return value !== undefined && value !== null;
}

function actorFromAuthorizingPolicy(value: JsonValue): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const actor = value.actor;
  return typeof actor === "string" && actor.trim() !== ""
    ? actor.trim()
    : undefined;
}

function boundLimit(limit: number | undefined, max: number): number {
  if (limit === undefined) {
    return 50;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(limit, max);
}

function toAutonomousMutationRecord(
  row: AutonomousMutationRow
): AutonomousMutationRecord {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    runId: row.run_id ?? undefined,
    target: row.target,
    mutationType: row.mutation_type,
    autonomyLevel: row.autonomy_level,
    status: row.status,
    riskClass: row.risk_class,
    authorizingPolicy: decodeJson(row.authorizing_policy_json, null),
    rationale: row.rationale,
    before: decodeJson(row.before_json, null),
    after: decodeJson(row.after_json, null),
    rollback: decodeJson(row.rollback_json, null),
    affectedResources: decodeJson(row.affected_resources_json, []),
    verification: decodeJson(row.verification_json, null),
    operatorNotification: decodeJson(row.operator_notification_json, null),
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at ?? undefined,
    failedAt: row.failed_at ?? undefined,
    rolledBackAt: row.rolled_back_at ?? undefined,
    notifiedAt: row.notified_at ?? undefined,
  };
}

function affectedResourcePairs(
  value: JsonValue | undefined
): { type: string; resourceId: string }[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const pairs: { type: string; resourceId: string }[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof item.type === "string"
    ) {
      const resourceId =
        typeof item.id === "string"
          ? item.id
          : typeof item.path === "string"
            ? item.path
            : undefined;
      if (resourceId) {
        const key = `${item.type}:${resourceId}`;
        if (!seen.has(key)) {
          pairs.push({ type: item.type, resourceId });
          seen.add(key);
        }
      }
    }
  }
  return pairs;
}
