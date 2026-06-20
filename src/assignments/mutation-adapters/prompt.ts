import {
  normalizePromptFragmentId,
  normalizePromptFragmentText,
  type PromptManagedFragmentRecord,
  type PromptManagedFragmentStore,
  normalizeRuntimeGuidanceText,
  type PromptRuntimeGuidanceStore,
} from "../../prompts/runtime-guidance.ts";
import type { JsonValue } from "../../shared/types.ts";
import { asJsonObject } from "./common.ts";
import type { AutonomousMutationAdapter } from "./types.ts";

export const PROMPT_RUNTIME_GUIDANCE_MUTATION_CLASS =
  "prompt.runtime_guidance";
export const PROMPT_MANAGED_FRAGMENT_MUTATION_CLASS =
  "prompt.managed_fragment";

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

export function createPromptManagedFragmentAutonomousMutationAdapter(
  promptFragments: PromptManagedFragmentStore
): AutonomousMutationAdapter {
  return {
    target: "prompt",
    mutationType: "managed_fragment",
    mutationClass: PROMPT_MANAGED_FRAGMENT_MUTATION_CLASS,
    affectedResources: [],
    minimumRiskClass: "high",
    rollbackConflictScope: "global",
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const promptFragment = asJsonObject(
        proposedChange.promptFragment,
        "proposedChange.promptFragment"
      );
      const id = normalizePromptFragmentId(promptFragment.id);
      const mode = normalizePromptFragmentApplyMode(promptFragment.mode);
      const before = promptFragments.get(id);
      let after: PromptManagedFragmentRecord;
      let rollback: JsonValue;
      if (mode === "upsert") {
        const text = normalizePromptFragmentText(promptFragment.text);
        after = promptFragments.upsert(
          id,
          text,
          input.request.actor ?? "autonomous_mutation"
        );
        rollback = rollbackForFragmentBaseline(id, before);
      } else {
        if (promptFragment.text !== undefined) {
          throw new Error("promptFragment.text is not supported for clear mode");
        }
        after = promptFragments.clear(
          id,
          input.request.actor ?? "autonomous_mutation"
        );
        rollback = rollbackForFragmentBaseline(id, before);
      }
      const affectedResources = [{ type: "prompt", id: `fragment:${id}` }];
      return {
        before: fragmentEvidence(id, before),
        after: fragmentEvidence(id, after),
        rollback,
        affectedResources,
        verificationMethod: "prompt_managed_fragment_update",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const promptFragment = asJsonObject(
        rollback.promptFragment,
        "rollback.promptFragment"
      );
      const id = normalizePromptFragmentId(promptFragment.id);
      const mode = normalizePromptFragmentRollbackMode(promptFragment.mode);
      if (mode === "upsert") {
        promptFragments.upsert(
          id,
          normalizePromptFragmentText(promptFragment.text),
          input.actor ?? "autonomous_mutation_rollback"
        );
      } else if (mode === "restore_inactive") {
        promptFragments.restoreInactive(
          id,
          normalizePromptFragmentText(promptFragment.text, {
            allowEmpty: true,
          }),
          input.actor ?? "autonomous_mutation_rollback"
        );
      } else if (mode === "delete") {
        if (promptFragment.text !== undefined) {
          throw new Error("promptFragment.text is not supported for delete mode");
        }
        promptFragments.delete(id);
      } else {
        if (promptFragment.text !== undefined) {
          throw new Error("promptFragment.text is not supported for clear mode");
        }
        promptFragments.clear(id, input.actor ?? "autonomous_mutation_rollback");
      }
      return { verificationMethod: "prompt_managed_fragment_rollback" };
    },
  };
}

function normalizePromptFragmentApplyMode(value: JsonValue): "upsert" | "clear" {
  if (value !== "upsert" && value !== "clear") {
    throw new Error("promptFragment.mode must be upsert or clear");
  }
  return value;
}

function normalizePromptFragmentRollbackMode(
  value: JsonValue
): "upsert" | "clear" | "restore_inactive" | "delete" {
  if (
    value !== "upsert" &&
    value !== "clear" &&
    value !== "restore_inactive" &&
    value !== "delete"
  ) {
    throw new Error("promptFragment.mode must be upsert or clear");
  }
  return value;
}

function rollbackForFragmentBaseline(
  id: string,
  before: PromptManagedFragmentRecord | null
): JsonValue {
  if (!before) {
    return { promptFragment: { id, mode: "delete" } };
  }
  return {
    promptFragment: {
      id,
      mode: before.active ? "upsert" : "restore_inactive",
      text: before.text,
    },
  };
}

function fragmentEvidence(
  id: string,
  fragment: PromptManagedFragmentRecord | null
): JsonValue {
  return fragment
    ? {
        id: fragment.id,
        text: fragment.text,
        active: fragment.active,
        exists: true,
      }
    : { id, text: "", active: false, exists: false };
}
