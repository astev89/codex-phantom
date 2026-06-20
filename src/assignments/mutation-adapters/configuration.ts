import {
  normalizeRuntimeConfigLimitsPatch,
  normalizeRuntimeConfigLimitsSnapshot,
  runtimeConfigLimitValues,
  type RuntimeConfigLimitsStore,
} from "../../config/runtime-limits.ts";
import {
  applyOperatorSettingsMutation,
  rollbackOperatorSettingsMutation,
  type OperatorSettingsMutationPort,
} from "../../self-evolution/mutations.ts";
import type { JsonValue } from "../../shared/types.ts";
import { AutonomousAssignmentService } from "../service.ts";
import type { AssignmentPolicy, AssignmentPolicyPatch } from "../types.ts";
import { asJsonObject } from "./common.ts";
import type { AutonomousMutationAdapter } from "./types.ts";

export const OPERATOR_SETTINGS_MUTATION_CLASS =
  "configuration.operator_settings";
export const ASSIGNMENT_POLICY_MUTATION_CLASS = "configuration.assignment_policy";
export const RUNTIME_CONFIG_LIMITS_MUTATION_CLASS =
  "configuration.runtime_limits";

export function createOperatorSettingsAutonomousMutationAdapter(
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

export function createAssignmentPolicyAutonomousMutationAdapter(
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

export function createRuntimeConfigLimitsAutonomousMutationAdapter(
  runtimeConfigLimits: RuntimeConfigLimitsStore
): AutonomousMutationAdapter {
  const affectedResources = [{ type: "runtime_config", id: "limits" }];
  return {
    target: "configuration",
    mutationType: "runtime_limits",
    mutationClass: RUNTIME_CONFIG_LIMITS_MUTATION_CLASS,
    minimumRiskClass: "medium",
    affectedResources,
    rollbackConflictScope: "global",
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const runtimeLimitsPatch = normalizeRuntimeConfigLimitsPatch(
        asJsonObject(
          proposedChange.runtimeLimits,
          "proposedChange.runtimeLimits"
        )
      );
      const beforeSnapshot = runtimeConfigLimits.snapshot();
      const before = beforeSnapshot.values;
      const after = runtimeConfigLimitValues(
        runtimeConfigLimits.update(
          runtimeLimitsPatch,
          input.request.actor ?? "autonomous_mutation"
        )
      );
      return {
        before: before as unknown as JsonValue,
        after: after as unknown as JsonValue,
        rollback: {
          runtimeLimits: before,
          runtimeLimitsOverlay: beforeSnapshot,
        } as unknown as JsonValue,
        affectedResources,
        verificationMethod: "runtime_config_limits_update",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      if (!("runtimeLimitsOverlay" in rollback)) {
        runtimeConfigLimits.restoreLegacyValues(
          rollback.runtimeLimits,
          input.actor ?? "autonomous_mutation_rollback"
        );
        return { verificationMethod: "runtime_config_limits_rollback" };
      }
      const runtimeLimitsRollback = normalizeRuntimeConfigLimitsSnapshot(
        rollback.runtimeLimitsOverlay
      );
      runtimeConfigLimits.restoreSnapshot(
        runtimeLimitsRollback,
        input.actor ?? "autonomous_mutation_rollback"
      );
      return { verificationMethod: "runtime_config_limits_rollback" };
    },
  };
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
