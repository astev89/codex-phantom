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
  AssignmentPolicy,
  AssignmentPolicyPatch,
  AssignmentRecord,
  AssignmentSelfEvolutionPolicy,
} from "./types.ts";
import { AutonomousAssignmentService } from "./service.ts";
import type { ToolBundleLifecycleService } from "../tools/bundle-lifecycle.ts";

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
  toolBundles?: ToolBundleLifecycleService;
  adapters?: AutonomousMutationAdapter[];
};

export type AutonomousMutationAdapter = {
  readonly target: AutonomousMutationTarget;
  readonly mutationType: string;
  readonly mutationClass: string;
  readonly affectedResources: JsonValue;
  apply(input: {
    assignment: AssignmentRecord;
    request: ApplyAutonomousMutationInput;
    proposedChange: JsonValue;
  }): {
    before: JsonValue;
    after: JsonValue;
    rollback: JsonValue;
    affectedResources?: JsonValue;
    verificationMethod?: string;
  };
  rollback(input: {
    assignment: AssignmentRecord;
    mutation: AutonomousMutationRecord;
    rollback: JsonValue;
    actor?: string;
  }): { verificationMethod?: string } | void;
};

const OPERATOR_SETTINGS_MUTATION_CLASS = "configuration.operator_settings";
const ASSIGNMENT_POLICY_MUTATION_CLASS = "configuration.assignment_policy";
const TOOL_BUNDLE_ENABLE_MUTATION_CLASS = "tool.bundle_enable";
const UNSUPPORTED_MUTATION_ERROR =
  "Only configuration.operator_settings, configuration.assignment_policy, and tool.bundle_enable autonomous mutations are supported in this slice";
const RISK_ORDER: SelfEvolutionRiskClass[] = [
  "low",
  "medium",
  "high",
  "critical",
];

export class AutonomousMutationExecutor {
  private readonly assignments: AutonomousAssignmentService;
  private readonly ledger: AutonomousMutationLedger;
  private readonly adapters: Map<string, AutonomousMutationAdapter>;

  constructor(options: AutonomousMutationExecutorOptions) {
    this.assignments = options.assignments;
    this.ledger = options.ledger;
    this.adapters = buildAdapterMap(
      options.adapters ?? [
        createOperatorSettingsAutonomousMutationAdapter(options.settings),
        createAssignmentPolicyAutonomousMutationAdapter(options.assignments),
        ...(options.toolBundles
          ? [
              createToolBundleEnableAutonomousMutationAdapter(
                options.toolBundles
              ),
            ]
          : []),
      ]
    );
  }

  apply(
    input: ApplyAutonomousMutationInput
  ): AutonomousMutationExecutionResult {
    const assignment = this.assignments.getRequired(input.assignmentId);
    const riskClass = input.riskClass ?? "low";
    const adapter = this.assertAssignmentCanMutate(
      assignment.assignment,
      input,
      riskClass
    );
    const planned = this.ledger.recordPlanned({
      assignmentId: assignment.assignment.id,
      runId: input.runId,
      target: input.target,
      mutationType: input.mutationType,
      autonomyLevel: assignment.assignment.autonomyLevel,
      authorizingPolicy: authorizingPolicy(
        assignment.assignment.policy.selfEvolution,
        input.actor,
        adapter.mutationClass
      ),
      rationale: input.rationale,
      riskClass,
      affectedResources: adapter.affectedResources,
      actor: input.actor,
    });

    try {
      const result = adapter.apply({
        assignment: assignment.assignment,
        request: input,
        proposedChange: input.proposedChange,
      });
      const mutation = this.ledger.recordApplied(planned.id, {
        before: result.before,
        after: result.after,
        rollback: result.rollback,
        affectedResources:
          result.affectedResources ?? adapter.affectedResources,
        verification: {
          attempted: true,
          result: "passed",
          method: result.verificationMethod ?? `${adapter.mutationType}_update`,
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
          method: `${adapter.mutationType}_update`,
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
    const adapter = this.resolveAdapter(mutation.target, mutation.mutationType);
    if (!adapter) {
      throw new AutonomousMutationExecutionError(
        400,
        "No autonomous mutation adapter is available for rollback"
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
        `Cannot roll back this autonomous mutation while a newer applied ${adapter.mutationClass} mutation exists`
      );
    }
    try {
      const rollback = adapter.rollback({
        assignment: assignment.assignment,
        mutation,
        rollback: mutation.rollback,
        actor: input.actor,
      });
      return {
        assignment: this.assignments.getRequired(assignment.assignment.id),
        mutation: this.ledger.recordRolledBack(mutation.id, {
          actor: input.actor,
          verification: {
            attempted: true,
            result: "passed",
            method:
              rollback?.verificationMethod ??
              `${adapter.mutationType}_rollback`,
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
  ): AutonomousMutationAdapter {
    if (assignment.autonomyLevel !== "evolve") {
      throw new AutonomousMutationExecutionError(
        403,
        "Assignment autonomyLevel must be evolve to apply autonomous mutations"
      );
    }
    const policy = assignment.policy.selfEvolution;
    const adapter = this.resolveAdapter(input.target, input.mutationType);
    if (!adapter) {
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
        errorMessage: UNSUPPORTED_MUTATION_ERROR,
      });
      throw new AutonomousMutationExecutionError(
        400,
        failed.errorMessage ?? "",
        failed
      );
    }
    if (!policy.enabled) {
      const failed = this.recordFailedPolicyMutation(
        assignment,
        input,
        riskClass,
        policy,
        "Assignment self-evolution policy is disabled",
        adapter.mutationClass
      );
      throw new AutonomousMutationExecutionError(
        403,
        failed.errorMessage ?? "",
        failed
      );
    }
    if (!policy.allowedMutationClasses.includes(adapter.mutationClass)) {
      const failed = this.recordFailedPolicyMutation(
        assignment,
        input,
        riskClass,
        policy,
        `Assignment self-evolution policy does not allow ${adapter.mutationClass}`,
        adapter.mutationClass
      );
      throw new AutonomousMutationExecutionError(
        403,
        failed.errorMessage ?? "",
        failed
      );
    }
    if (riskRank(riskClass) > riskRank(policy.maxRiskClass)) {
      const failed = this.ledger.recordFailed({
        assignmentId: assignment.id,
        runId: input.runId,
        target: input.target,
        mutationType: input.mutationType,
        autonomyLevel: assignment.autonomyLevel,
        authorizingPolicy: authorizingPolicy(
          policy,
          input.actor,
          adapter.mutationClass
        ),
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
    return adapter;
  }

  private recordFailedPolicyMutation(
    assignment: AssignmentRecord,
    input: ApplyAutonomousMutationInput,
    riskClass: SelfEvolutionRiskClass,
    policy: AssignmentSelfEvolutionPolicy,
    errorMessage: string,
    mutationClass?: string
  ): AutonomousMutationRecord {
    return this.ledger.recordFailed({
      assignmentId: assignment.id,
      runId: input.runId,
      target: input.target,
      mutationType: input.mutationType,
      autonomyLevel: assignment.autonomyLevel,
      authorizingPolicy: authorizingPolicy(policy, input.actor, mutationClass),
      rationale: input.rationale,
      riskClass,
      actor: input.actor,
      errorMessage,
    });
  }

  private resolveAdapter(
    target: AutonomousMutationTarget,
    mutationType: string
  ): AutonomousMutationAdapter | undefined {
    return this.adapters.get(adapterKey(target, mutationType));
  }
}

function createOperatorSettingsAutonomousMutationAdapter(
  settings: OperatorSettingsMutationPort
): AutonomousMutationAdapter {
  const affectedResources = [{ type: "settings", id: "operator" }];
  return {
    target: "configuration",
    mutationType: "operator_settings",
    mutationClass: OPERATOR_SETTINGS_MUTATION_CLASS,
    affectedResources,
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const result = applyOperatorSettingsMutation(
        settings,
        proposedChange.operatorSettings
      );
      return {
        ...result,
        affectedResources,
        verificationMethod: "operator_settings_update",
      };
    },
    rollback(input) {
      rollbackOperatorSettingsMutation(settings, input.rollback);
      return { verificationMethod: "operator_settings_rollback" };
    },
  };
}

function createAssignmentPolicyAutonomousMutationAdapter(
  assignments: AutonomousAssignmentService
): AutonomousMutationAdapter {
  return {
    target: "configuration",
    mutationType: "assignment_policy",
    mutationClass: ASSIGNMENT_POLICY_MUTATION_CLASS,
    affectedResources: [{ type: "assignment_policy" }],
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const assignmentPolicy = asJsonObject(
        proposedChange.assignmentPolicy,
        "proposedChange.assignmentPolicy"
      );
      const policyPatch = toAssignmentPolicyPatch(assignmentPolicy, {
        allowSelfEvolution: false,
      });
      const before = input.assignment.policy;
      const updated = assignments.control(input.assignment.id, {
        action: "change_policy",
        actor: input.request.actor ?? "autonomous_mutation",
        reason: input.request.rationale,
        policy: policyPatch,
      });
      const affectedResources = [
        { type: "assignment_policy", id: input.assignment.id },
      ];
      return {
        before: before as unknown as JsonValue,
        after: updated.assignment.policy as unknown as JsonValue,
        rollback: { assignmentPolicy: before } as unknown as JsonValue,
        affectedResources,
        verificationMethod: "assignment_policy_update",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const assignmentPolicy = asJsonObject(
        rollback.assignmentPolicy,
        "rollback.assignmentPolicy"
      );
      const rollbackPolicy = toAssignmentPolicyPatch(
        withoutSelfEvolution(assignmentPolicy),
        { allowSelfEvolution: false }
      );
      assignments.control(input.assignment.id, {
        action: "change_policy",
        actor: input.actor ?? "autonomous_mutation_rollback",
        reason: `Rollback autonomous mutation ${input.mutation.id}`,
        policy: rollbackPolicy,
      });
      return { verificationMethod: "assignment_policy_rollback" };
    },
  };
}

function createToolBundleEnableAutonomousMutationAdapter(
  toolBundles: ToolBundleLifecycleService
): AutonomousMutationAdapter {
  return {
    target: "tool",
    mutationType: "bundle_enable",
    mutationClass: TOOL_BUNDLE_ENABLE_MUTATION_CLASS,
    affectedResources: [{ type: "tool_bundle_import" }],
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const toolBundle = asJsonObject(
        proposedChange.toolBundle,
        "proposedChange.toolBundle"
      );
      const importId = requiredString(
        toolBundle.importId,
        "toolBundle.importId"
      );
      const before = toolBundles.get(importId);
      if (!before) {
        throw new Error("Tool bundle import not found");
      }
      const after = toolBundles.enable(
        importId,
        input.request.actor ?? "autonomous_mutation",
        input.request.rationale
      );
      const affectedResources = [
        { type: "tool_bundle_import", id: importId },
        ...toolBundles.listToolIds(after).map((id) => ({ type: "tool", id })),
      ];
      return {
        before: before as unknown as JsonValue,
        after: after as unknown as JsonValue,
        rollback: { toolBundle: { importId } },
        affectedResources,
        verificationMethod: "tool_bundle_enable_update",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const toolBundle = asJsonObject(
        rollback.toolBundle,
        "rollback.toolBundle"
      );
      const importId = requiredString(
        toolBundle.importId,
        "toolBundle.importId"
      );
      toolBundles.disable(
        importId,
        input.actor ?? "autonomous_mutation_rollback",
        `Rollback autonomous mutation ${input.mutation.id}`
      );
      return { verificationMethod: "tool_bundle_enable_rollback" };
    },
  };
}

function authorizingPolicy(
  policy: AssignmentSelfEvolutionPolicy,
  actor?: string,
  mutationClass?: string
): JsonValue {
  return {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: policy.maxRiskClass,
    allowedMutationClasses: policy.allowedMutationClasses,
    ...(mutationClass ? { mutationClass } : {}),
    ...(actor ? { actor } : {}),
  };
}

function buildAdapterMap(
  adapters: AutonomousMutationAdapter[]
): Map<string, AutonomousMutationAdapter> {
  const map = new Map<string, AutonomousMutationAdapter>();
  for (const adapter of adapters) {
    const key = adapterKey(adapter.target, adapter.mutationType);
    if (map.has(key)) {
      throw new Error(
        `Duplicate autonomous mutation adapter for ${adapter.mutationClass}`
      );
    }
    map.set(key, adapter);
  }
  return map;
}

function adapterKey(
  target: AutonomousMutationTarget,
  mutationType: string
): string {
  return `${target}:${mutationType}`;
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

function requiredString(value: JsonValue, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function toAssignmentPolicyPatch(
  value: Record<string, JsonValue>,
  options: { allowSelfEvolution: boolean }
): AssignmentPolicyPatch {
  const patch: Record<string, unknown> = {};
  const allowedTopLevel = new Set([
    "maxWakeups",
    "maxTotalRuntimeMinutes",
    "maxConsecutiveFailures",
    "maxIdleHours",
    "wakeupDelayMinMinutes",
    "wakeupDelayMaxMinutes",
    "notificationCadence",
    "childAssignments",
    ...(options.allowSelfEvolution ? ["selfEvolution"] : []),
  ]);

  for (const key of Object.keys(value)) {
    if (key === "selfEvolution" && !options.allowSelfEvolution) {
      throw new Error(
        "assignmentPolicy.selfEvolution cannot be changed by autonomous assignment policy mutations"
      );
    }
    if (!allowedTopLevel.has(key)) {
      throw new Error(`assignmentPolicy.${key} is not supported`);
    }
  }

  for (const key of [
    "maxWakeups",
    "maxTotalRuntimeMinutes",
    "maxConsecutiveFailures",
    "maxIdleHours",
    "wakeupDelayMinMinutes",
    "wakeupDelayMaxMinutes",
  ]) {
    if (value[key] !== undefined) {
      patch[key] = value[key];
    }
  }

  if (value.notificationCadence !== undefined) {
    patch.notificationCadence = toNotificationCadencePatch(
      asJsonObject(
        value.notificationCadence,
        "assignmentPolicy.notificationCadence"
      )
    );
  }

  if (value.childAssignments !== undefined) {
    patch.childAssignments = toChildAssignmentPolicyPatch(
      asJsonObject(value.childAssignments, "assignmentPolicy.childAssignments")
    );
  }

  if (options.allowSelfEvolution && value.selfEvolution !== undefined) {
    patch.selfEvolution = toSelfEvolutionPolicyPatch(
      asJsonObject(value.selfEvolution, "assignmentPolicy.selfEvolution")
    );
  }

  if (Object.keys(patch).length === 0) {
    throw new Error(
      "assignmentPolicy must contain at least one supported field"
    );
  }

  return patch as AssignmentPolicyPatch;
}

function withoutSelfEvolution(
  value: Record<string, JsonValue>
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "selfEvolution")
  ) as Record<string, JsonValue>;
}

function toNotificationCadencePatch(
  value: Record<string, JsonValue>
): AssignmentPolicyPatch["notificationCadence"] {
  const patch: Record<string, unknown> = {};
  const booleanKeys = [
    "onCreate",
    "onWakeupStart",
    "onMeaningfulProgress",
    "onBlocked",
    "onFailure",
    "onCompletion",
  ];
  const allowedKeys = new Set([
    ...booleanKeys,
    "activeProgressIntervalMinutes",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `assignmentPolicy.notificationCadence.${key} is not supported`
      );
    }
  }
  for (const key of booleanKeys) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") {
        throw new Error(
          `assignmentPolicy.notificationCadence.${key} must be boolean`
        );
      }
      patch[key] = value[key];
    }
  }
  if (value.activeProgressIntervalMinutes !== undefined) {
    patch.activeProgressIntervalMinutes = value.activeProgressIntervalMinutes;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error(
      "assignmentPolicy.notificationCadence must contain at least one supported field"
    );
  }
  return patch as AssignmentPolicyPatch["notificationCadence"];
}

function toChildAssignmentPolicyPatch(
  value: Record<string, JsonValue>
): AssignmentPolicyPatch["childAssignments"] {
  const patch: Record<string, unknown> = {};
  const allowedKeys = new Set(["maxDepth", "maxActiveChildren"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `assignmentPolicy.childAssignments.${key} is not supported`
      );
    }
  }
  if (value.maxDepth !== undefined) {
    patch.maxDepth = value.maxDepth;
  }
  if (value.maxActiveChildren !== undefined) {
    patch.maxActiveChildren = value.maxActiveChildren;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error(
      "assignmentPolicy.childAssignments must contain at least one supported field"
    );
  }
  return patch as AssignmentPolicyPatch["childAssignments"];
}

function toSelfEvolutionPolicyPatch(
  value: Record<string, JsonValue>
): AssignmentPolicy["selfEvolution"] {
  const patch: Record<string, unknown> = {};
  const allowedKeys = new Set([
    "enabled",
    "allowedMutationClasses",
    "maxRiskClass",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`assignmentPolicy.selfEvolution.${key} is not supported`);
    }
  }
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      throw new Error("assignmentPolicy.selfEvolution.enabled must be boolean");
    }
    patch.enabled = value.enabled;
  }
  if (value.allowedMutationClasses !== undefined) {
    if (
      !Array.isArray(value.allowedMutationClasses) ||
      value.allowedMutationClasses.some(
        (item) => typeof item !== "string" || item.trim() === ""
      )
    ) {
      throw new Error(
        "assignmentPolicy.selfEvolution.allowedMutationClasses must be non-empty strings"
      );
    }
    patch.allowedMutationClasses = value.allowedMutationClasses;
  }
  if (value.maxRiskClass !== undefined) {
    patch.maxRiskClass = value.maxRiskClass;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error(
      "assignmentPolicy.selfEvolution must contain at least one supported field"
    );
  }
  return patch as AssignmentPolicy["selfEvolution"];
}
