import type { JsonValue } from "../shared/types.ts";
import {
  applyOperatorSettingsMutation,
  rollbackOperatorSettingsMutation,
  type OperatorSettingsMutationPort,
} from "../self-evolution/mutations.ts";
import type { SelfEvolutionRiskClass } from "../self-evolution/proposals.ts";
import type {
  AutonomousMutationRecord,
  AutonomousMutationTarget,
} from "./mutation-ledger.ts";
import { AutonomousMutationLedger } from "./mutation-ledger.ts";
import type {
  AssignmentRecord,
  AssignmentSelfEvolutionPolicy,
} from "./types.ts";
import { AutonomousAssignmentService } from "./service.ts";

export class AutonomousMutationExecutionError extends Error {
  readonly status: number;
  readonly mutation?: AutonomousMutationRecord;

  constructor(
    status: number,
    message: string,
    mutation?: AutonomousMutationRecord
  ) {
    super(message);
    this.status = status;
    this.mutation = mutation;
  }
}

export type ApplyAutonomousMutationInput = {
  assignmentId: string;
  runId?: string;
  target: AutonomousMutationTarget;
  mutationType: string;
  rationale: string;
  riskClass?: SelfEvolutionRiskClass;
  proposedChange: JsonValue;
  actor?: string;
};

export type RollbackAutonomousMutationInput = {
  assignmentId: string;
  mutationId: string;
  actor?: string;
};

export type AutonomousMutationExecutionResult = {
  assignment: ReturnType<AutonomousAssignmentService["getRequired"]>;
  mutation: AutonomousMutationRecord;
};

export type AutonomousMutationExecutorOptions = {
  assignments: AutonomousAssignmentService;
  ledger: AutonomousMutationLedger;
  settings: OperatorSettingsMutationPort;
};

const MUTATION_CLASS = "configuration.operator_settings";
const RISK_ORDER: SelfEvolutionRiskClass[] = [
  "low",
  "medium",
  "high",
  "critical",
];

export class AutonomousMutationExecutor {
  private readonly assignments: AutonomousAssignmentService;
  private readonly ledger: AutonomousMutationLedger;
  private readonly settings: OperatorSettingsMutationPort;

  constructor(options: AutonomousMutationExecutorOptions) {
    this.assignments = options.assignments;
    this.ledger = options.ledger;
    this.settings = options.settings;
  }

  apply(
    input: ApplyAutonomousMutationInput
  ): AutonomousMutationExecutionResult {
    const assignment = this.assignments.getRequired(input.assignmentId);
    const riskClass = input.riskClass ?? "low";
    this.assertAssignmentCanMutate(assignment.assignment, input, riskClass);
    const planned = this.ledger.recordPlanned({
      assignmentId: assignment.assignment.id,
      runId: input.runId,
      target: input.target,
      mutationType: input.mutationType,
      autonomyLevel: assignment.assignment.autonomyLevel,
      authorizingPolicy: authorizingPolicy(
        assignment.assignment.policy.selfEvolution,
        input.actor
      ),
      rationale: input.rationale,
      riskClass,
      affectedResources: [{ type: "settings", id: "operator" }],
      actor: input.actor,
    });

    try {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const result = applyOperatorSettingsMutation(
        this.settings,
        proposedChange.operatorSettings
      );
      const mutation = this.ledger.recordApplied(planned.id, {
        before: result.before,
        after: result.after,
        rollback: result.rollback,
        affectedResources: [{ type: "settings", id: "operator" }],
        verification: {
          attempted: true,
          result: "passed",
          method: "operator_settings_update",
        },
      });
      return {
        assignment: this.assignments.getRequired(assignment.assignment.id),
        mutation,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to apply autonomous mutation";
      const failed = this.ledger.recordFailedOutcome(planned.id, {
        verification: {
          attempted: true,
          result: "failed",
          method: "operator_settings_update",
        },
        errorMessage: message,
      });
      throw new AutonomousMutationExecutionError(400, message, failed);
    }
  }

  rollback(
    input: RollbackAutonomousMutationInput
  ): AutonomousMutationExecutionResult {
    const assignment = this.assignments.getRequired(input.assignmentId);
    if (assignment.assignment.autonomyLevel !== "evolve") {
      throw new AutonomousMutationExecutionError(
        403,
        "Assignment autonomyLevel must be evolve to roll back autonomous mutations"
      );
    }
    const mutation = this.ledger.get(input.mutationId);
    if (!mutation || mutation.assignmentId !== assignment.assignment.id) {
      throw new AutonomousMutationExecutionError(
        404,
        "Autonomous mutation not found for assignment"
      );
    }
    if (
      mutation.target !== "configuration" ||
      mutation.mutationType !== "operator_settings"
    ) {
      throw new AutonomousMutationExecutionError(
        400,
        "Only configuration.operator_settings autonomous mutations can be rolled back in this slice"
      );
    }
    if (mutation.status !== "applied") {
      throw new AutonomousMutationExecutionError(
        409,
        "Only applied autonomous mutations can be rolled back"
      );
    }
    const newerMutation = this.ledger.findNewerApplied({
      assignmentId: mutation.assignmentId,
      target: mutation.target,
      mutationType: mutation.mutationType,
      appliedAt: mutation.appliedAt ?? mutation.updatedAt,
      id: mutation.id,
    });
    if (newerMutation) {
      throw new AutonomousMutationExecutionError(
        409,
        "Cannot roll back this autonomous mutation while a newer applied configuration.operator_settings mutation exists"
      );
    }
    try {
      rollbackOperatorSettingsMutation(this.settings, mutation.rollback);
      return {
        assignment: this.assignments.getRequired(assignment.assignment.id),
        mutation: this.ledger.recordRolledBack(mutation.id, {
          actor: input.actor,
          verification: {
            attempted: true,
            result: "passed",
            method: "operator_settings_rollback",
          },
        }),
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to roll back autonomous mutation";
      throw new AutonomousMutationExecutionError(400, message);
    }
  }

  private assertAssignmentCanMutate(
    assignment: AssignmentRecord,
    input: ApplyAutonomousMutationInput,
    riskClass: SelfEvolutionRiskClass
  ): void {
    if (assignment.autonomyLevel !== "evolve") {
      throw new AutonomousMutationExecutionError(
        403,
        "Assignment autonomyLevel must be evolve to apply autonomous mutations"
      );
    }
    const policy = assignment.policy.selfEvolution;
    if (!policy.enabled) {
      throw new AutonomousMutationExecutionError(
        403,
        "Assignment self-evolution policy is disabled"
      );
    }
    if (
      input.target !== "configuration" ||
      input.mutationType !== "operator_settings"
    ) {
      const failed = this.ledger.recordFailed({
        assignmentId: assignment.id,
        runId: input.runId,
        target: input.target,
        mutationType: input.mutationType,
        autonomyLevel: assignment.autonomyLevel,
        authorizingPolicy: authorizingPolicy(policy, input.actor),
        rationale: input.rationale,
        riskClass,
        actor: input.actor,
        errorMessage:
          "Only configuration.operator_settings autonomous mutations are supported in this slice",
      });
      throw new AutonomousMutationExecutionError(
        400,
        failed.errorMessage ?? "",
        failed
      );
    }
    if (!policy.allowedMutationClasses.includes(MUTATION_CLASS)) {
      throw new AutonomousMutationExecutionError(
        403,
        "Assignment self-evolution policy does not allow configuration.operator_settings"
      );
    }
    if (riskRank(riskClass) > riskRank(policy.maxRiskClass)) {
      const failed = this.ledger.recordFailed({
        assignmentId: assignment.id,
        runId: input.runId,
        target: input.target,
        mutationType: input.mutationType,
        autonomyLevel: assignment.autonomyLevel,
        authorizingPolicy: authorizingPolicy(policy, input.actor),
        rationale: input.rationale,
        riskClass,
        actor: input.actor,
        errorMessage:
          "Autonomous mutation risk exceeds assignment self-evolution policy",
      });
      throw new AutonomousMutationExecutionError(
        403,
        failed.errorMessage ?? "",
        failed
      );
    }
  }
}

function authorizingPolicy(
  policy: AssignmentSelfEvolutionPolicy,
  actor?: string
): JsonValue {
  return {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: policy.maxRiskClass,
    allowedMutationClasses: policy.allowedMutationClasses,
    ...(actor ? { actor } : {}),
  };
}

function riskRank(riskClass: SelfEvolutionRiskClass): number {
  return RISK_ORDER.indexOf(riskClass);
}

function asJsonObject(
  value: JsonValue,
  field: string
): { [key: string]: JsonValue } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}
