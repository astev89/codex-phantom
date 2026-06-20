import {
  normalizeRuntimeGuidanceText,
  type PromptRuntimeGuidanceStore,
} from "../../prompts/runtime-guidance.ts";
import type { JsonValue } from "../../shared/types.ts";
import { asJsonObject } from "./common.ts";
import type { AutonomousMutationAdapter } from "./types.ts";

export const PROMPT_RUNTIME_GUIDANCE_MUTATION_CLASS =
  "prompt.runtime_guidance";

export function createPromptRuntimeGuidanceAutonomousMutationAdapter(
  promptGuidance: PromptRuntimeGuidanceStore
): AutonomousMutationAdapter {
  const affectedResources = [{ type: "prompt", id: "runtime_guidance" }];
  return {
    target: "prompt",
    mutationType: "runtime_guidance",
    mutationClass: PROMPT_RUNTIME_GUIDANCE_MUTATION_CLASS,
    affectedResources,
    rollbackConflictScope: "global",
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const runtimeGuidance = asJsonObject(
        proposedChange.runtimeGuidance,
        "proposedChange.runtimeGuidance"
      );
      const text = normalizeRuntimeGuidanceText(runtimeGuidance.text);
      const before = promptGuidance.get();
      const after = promptGuidance.update(
        text,
        input.request.actor ?? "autonomous_mutation"
      );
      return {
        before: before as unknown as JsonValue,
        after: after as unknown as JsonValue,
        rollback: { runtimeGuidance: { text: before.text } },
        affectedResources,
        verificationMethod: "prompt_runtime_guidance_update",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const runtimeGuidance = asJsonObject(
        rollback.runtimeGuidance,
        "rollback.runtimeGuidance"
      );
      promptGuidance.update(
        normalizeRuntimeGuidanceText(runtimeGuidance.text, {
          allowEmpty: true,
        }),
        input.actor ?? "autonomous_mutation_rollback"
      );
      return { verificationMethod: "prompt_runtime_guidance_rollback" };
    },
  };
}
