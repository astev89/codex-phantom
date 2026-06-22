import {
  rolePolicyRuntimeSnapshot,
  type RolePolicyOverrides,
  type RolePolicyPatch,
  type RolePolicyRuntimeStore,
} from "../../orchestration/role-policy-runtime.ts";
import type { JsonValue } from "../../shared/types.ts";
import { asJsonObject } from "./common.ts";
import type { AutonomousMutationAdapter } from "./types.ts";

export const ROLE_PERMISSION_POLICY_MUTATION_CLASS = "role.permission_policy";

export function createRolePermissionPolicyAutonomousMutationAdapter(
  rolePolicy: RolePolicyRuntimeStore
): AutonomousMutationAdapter {
  const affectedResources = [{ type: "role_policy", id: "runtime" }];
  return {
    target: "role",
    mutationType: "permission_policy",
    mutationClass: ROLE_PERMISSION_POLICY_MUTATION_CLASS,
    affectedResources,
    rollbackConflictScope: "global",
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const rolePolicyPatch = asJsonObject(
        proposedChange.rolePolicy,
        "proposedChange.rolePolicy"
      );
      const before = rolePolicyRuntimeSnapshot(rolePolicy.get());
      const after = rolePolicyRuntimeSnapshot(
        rolePolicy.update(
          rolePolicyPatch as unknown as RolePolicyPatch,
          input.request.actor ?? "autonomous_mutation"
        )
      );
      return {
        before: before as unknown as JsonValue,
        after: after as unknown as JsonValue,
        rollback: {
          rolePolicy: { overrides: before.overrides },
        } as unknown as JsonValue,
        affectedResources,
        verificationMethod: "role_permission_policy_update",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const rolePolicyRollback = asJsonObject(
        rollback.rolePolicy,
        "rollback.rolePolicy"
      );
      const overrides = asJsonObject(
        rolePolicyRollback.overrides,
        "rollback.rolePolicy.overrides"
      );
      rolePolicy.replaceOverrides(
        overrides as unknown as RolePolicyOverrides,
        input.actor ?? "autonomous_mutation_rollback"
      );
      return { verificationMethod: "role_permission_policy_rollback" };
    },
  };
}
