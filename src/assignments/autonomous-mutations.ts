import type { JsonValue } from "../shared/types.ts";
import type { MemoryPolicyStore } from "../memory/policy.ts";
import type { RuntimeConfigLimitsStore } from "../config/runtime-limits.ts";
import type { OperatorSettingsMutationPort } from "../self-evolution/mutations.ts";
import type {
  PromptManagedFragmentStore,
  PromptRuntimeGuidanceStore,
} from "../prompts/runtime-guidance.ts";
import type { RolePolicyRuntimeStore } from "../orchestration/role-policy-runtime.ts";
import type { ProjectFileDraftStore } from "../project-files/drafts.ts";
import type { ProjectFileApplyService } from "../project-files/apply.ts";
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
import type { ToolBundleLifecycleService } from "../tools/bundle-lifecycle.ts";
import { AutonomousMutationApplyFailure } from "./mutation-adapters/common.ts";
import { buildDefaultAutonomousMutationAdapters } from "./mutation-adapters/defaults.ts";
import type { AutonomousMutationAdapter } from "./mutation-adapters/types.ts";

export type { AutonomousMutationAdapter } from "./mutation-adapters/types.ts";

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
  memoryPolicy?: MemoryPolicyStore;
  runtimeConfigLimits?: RuntimeConfigLimitsStore;
  promptGuidance?: PromptRuntimeGuidanceStore;
  promptFragments?: PromptManagedFragmentStore;
  rolePolicy?: RolePolicyRuntimeStore;
  projectFileDrafts?: ProjectFileDraftStore;
  projectFileApply?: ProjectFileApplyService;
  toolBundles?: ToolBundleLifecycleService;
  adapters?: AutonomousMutationAdapter[];
};

const UNSUPPORTED_MUTATION_ERROR =
  "Only configuration.operator_settings, configuration.assignment_policy, configuration.runtime_limits, tool.bundle_enable, prompt.runtime_guidance, prompt.managed_fragment, memory_policy.runtime_bounds, role.permission_policy, project_file.draft, project_file.apply_draft, and project_file.apply_bundle autonomous mutations are supported in this slice";
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
      options.adapters ?? buildDefaultAutonomousMutationAdapters(options)
    );
  }

  apply(
    input: ApplyAutonomousMutationInput
  ): AutonomousMutationExecutionResult {
    const assignment = this.assignments.getRequired(input.assignmentId);
    const requestedRiskClass = input.riskClass ?? "low";
    const { adapter, riskClass } = this.assertAssignmentCanMutate(
      assignment.assignment,
      input,
      requestedRiskClass
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
        mutationId: planned.id,
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
      const evidence =
        error instanceof AutonomousMutationApplyFailure ? error.evidence : {};
      const failed = this.ledger.recordFailedOutcome(planned.id, {
        before: evidence.before,
        after: evidence.after,
        rollback: evidence.rollback,
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
      scope: adapter.rollbackConflictScope ?? "assignment",
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
  ): { adapter: AutonomousMutationAdapter; riskClass: SelfEvolutionRiskClass } {
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
    const effectiveRiskClass = highestRiskClass(
      riskClass,
      adapter.minimumRiskClass ?? "low"
    );
    if (!policy.enabled) {
      const failed = this.recordFailedPolicyMutation(
        assignment,
        input,
        effectiveRiskClass,
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
        effectiveRiskClass,
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
    if (riskRank(effectiveRiskClass) > riskRank(policy.maxRiskClass)) {
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
        riskClass: effectiveRiskClass,
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
    return { adapter, riskClass: effectiveRiskClass };
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

function highestRiskClass(
  left: SelfEvolutionRiskClass,
  right: SelfEvolutionRiskClass
): SelfEvolutionRiskClass {
  return riskRank(left) >= riskRank(right) ? left : right;
}
