import type { JsonValue } from "../../shared/types.ts";
import type { ToolBundleLifecycleService } from "../../tools/bundle-lifecycle.ts";
import { asJsonObject, requiredString } from "./common.ts";
import type { AutonomousMutationAdapter } from "./types.ts";

export const TOOL_BUNDLE_ENABLE_MUTATION_CLASS = "tool.bundle_enable";

export function createToolBundleEnableAutonomousMutationAdapter(
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
