import {
  memoryPolicyValues,
  normalizeMemoryPolicyPatch,
  type MemoryPolicyStore,
} from "../../memory/policy.ts";
import type { JsonValue } from "../../shared/types.ts";
import { asJsonObject } from "./common.ts";
import type { AutonomousMutationAdapter } from "./types.ts";

export const MEMORY_POLICY_RUNTIME_BOUNDS_MUTATION_CLASS =
  "memory_policy.runtime_bounds";

export function createMemoryPolicyRuntimeBoundsAutonomousMutationAdapter(
  memoryPolicy: MemoryPolicyStore
): AutonomousMutationAdapter {
  const affectedResources = [{ type: "memory_policy", id: "runtime_bounds" }];
  return {
    target: "memory_policy",
    mutationType: "runtime_bounds",
    mutationClass: MEMORY_POLICY_RUNTIME_BOUNDS_MUTATION_CLASS,
    affectedResources,
    rollbackConflictScope: "global",
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const memoryPolicyPatch = normalizeMemoryPolicyPatch(
        asJsonObject(proposedChange.memoryPolicy, "proposedChange.memoryPolicy")
      );
      const before = memoryPolicyValues(memoryPolicy.get());
      const after = memoryPolicyValues(
        memoryPolicy.update(
          memoryPolicyPatch,
          input.request.actor ?? "autonomous_mutation"
        )
      );
      return {
        before: before as unknown as JsonValue,
        after: after as unknown as JsonValue,
        rollback: { memoryPolicy: before } as unknown as JsonValue,
        affectedResources,
        verificationMethod: "memory_policy_runtime_bounds_update",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const memoryPolicyRollback = normalizeMemoryPolicyPatch(
        asJsonObject(rollback.memoryPolicy, "rollback.memoryPolicy")
      );
      memoryPolicy.update(
        memoryPolicyRollback,
        input.actor ?? "autonomous_mutation_rollback"
      );
      return { verificationMethod: "memory_policy_runtime_bounds_rollback" };
    },
  };
}
