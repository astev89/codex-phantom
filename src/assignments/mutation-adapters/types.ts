import type { JsonValue } from "../../shared/types.ts";
import type {
  AutonomousMutationRecord,
  AutonomousMutationTarget,
} from "../mutation-ledger.ts";
import type { AssignmentRecord } from "../types.ts";
import type { ApplyAutonomousMutationInput } from "../autonomous-mutations.ts";

export type AutonomousMutationApplyResult = {
  before: JsonValue;
  after: JsonValue;
  rollback: JsonValue;
  affectedResources?: JsonValue;
  verificationMethod?: string;
};

export type AutonomousMutationRollbackResult =
  | { verificationMethod?: string }
  | void;

export type AutonomousMutationAdapter = {
  readonly target: AutonomousMutationTarget;
  readonly mutationType: string;
  readonly mutationClass: string;
  readonly affectedResources: JsonValue;
  readonly minimumRiskClass?: "low" | "medium" | "high" | "critical";
  readonly requiresAsync?: boolean;
  readonly rollbackConflictScope?:
    | "assignment"
    | "global"
    | "affected_resources";
  readonly rollbackConflictMutationTypes?: readonly string[];
  apply(input: {
    assignment: AssignmentRecord;
    mutationId: string;
    request: ApplyAutonomousMutationInput;
    proposedChange: JsonValue;
  }): AutonomousMutationApplyResult | Promise<AutonomousMutationApplyResult>;
  rollback(input: {
    assignment: AssignmentRecord;
    mutation: AutonomousMutationRecord;
    rollback: JsonValue;
    actor?: string;
  }): AutonomousMutationRollbackResult | Promise<AutonomousMutationRollbackResult>;
};
