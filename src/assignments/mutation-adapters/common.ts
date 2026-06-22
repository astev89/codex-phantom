import type { JsonValue } from "../../shared/types.ts";

export type AutonomousMutationApplyFailureEvidence = {
  before?: JsonValue;
  after?: JsonValue;
  rollback?: JsonValue;
  affectedResources?: JsonValue;
};

export class AutonomousMutationApplyFailure extends Error {
  readonly evidence: AutonomousMutationApplyFailureEvidence;

  constructor(
    message: string,
    evidence: AutonomousMutationApplyFailureEvidence
  ) {
    super(message);
    this.name = "AutonomousMutationApplyFailure";
    this.evidence = evidence;
  }
}

export function asJsonObject(
  value: JsonValue,
  field: string
): { [key: string]: JsonValue } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}

export function requiredString(value: JsonValue, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}
