import type { OperatorSettings } from "../server/settings.ts";
import type { JsonValue } from "../shared/types.ts";
import {
  SelfEvolutionProposalStore,
  type SelfEvolutionMutationRecord,
  type SelfEvolutionProposalRecord,
  type SelfEvolutionTarget,
} from "./proposals.ts";

export type SelfEvolutionMutationErrorCode =
  | "not_found"
  | "invalid_state"
  | "confirmation_required"
  | "apply_failed"
  | "rollback_failed";

export class SelfEvolutionMutationError extends Error {
  readonly code: SelfEvolutionMutationErrorCode;
  readonly mutation?: SelfEvolutionMutationRecord;

  constructor(
    code: SelfEvolutionMutationErrorCode,
    message: string,
    mutation?: SelfEvolutionMutationRecord
  ) {
    super(message);
    this.code = code;
    this.mutation = mutation;
  }
}

export type SelfEvolutionMutationAdapter = {
  readonly target: SelfEvolutionTarget;
  readonly mutationType: string;
  apply(proposal: SelfEvolutionProposalRecord): {
    before: JsonValue;
    after: JsonValue;
    rollback: JsonValue;
  };
  rollback(mutation: SelfEvolutionMutationRecord): void;
};

export type SelfEvolutionMutationServiceOptions = {
  proposals: SelfEvolutionProposalStore;
  adapters: SelfEvolutionMutationAdapter[];
};

export class SelfEvolutionMutationService {
  private readonly proposals: SelfEvolutionProposalStore;
  private readonly adapters: Map<
    SelfEvolutionTarget,
    SelfEvolutionMutationAdapter
  >;

  constructor(options: SelfEvolutionMutationServiceOptions) {
    this.proposals = options.proposals;
    this.adapters = new Map(
      options.adapters.map((adapter) => [adapter.target, adapter])
    );
  }

  applyProposal(
    proposalId: string,
    input: { appliedBy: string; confirmHighRisk?: boolean }
  ): {
    proposal: SelfEvolutionProposalRecord;
    mutation: SelfEvolutionMutationRecord;
  } {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new SelfEvolutionMutationError(
        "not_found",
        "Self-evolution proposal not found"
      );
    }
    if (proposal.status !== "approved") {
      throw new SelfEvolutionMutationError(
        "invalid_state",
        "Self-evolution proposal must be approved first"
      );
    }
    if (
      (proposal.riskClass === "high" || proposal.riskClass === "critical") &&
      input.confirmHighRisk !== true
    ) {
      throw new SelfEvolutionMutationError(
        "confirmation_required",
        "High-risk self-evolution proposal requires explicit confirmation"
      );
    }

    const adapter = this.adapters.get(proposal.target);
    try {
      if (!adapter) {
        throw new Error(
          "Only configuration proposals can be applied in this slice"
        );
      }
      const result = adapter.apply(proposal);
      const mutation = this.proposals.recordApplySuccess({
        proposalId: proposal.id,
        target: proposal.target,
        mutationType: adapter.mutationType,
        before: result.before,
        after: result.after,
        rollback: result.rollback,
        actor: input.appliedBy,
      });
      return {
        proposal: this.proposals.get(proposal.id) ?? proposal,
        mutation,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to apply self-evolution proposal";
      const mutation = this.proposals.recordApplyFailure({
        proposalId: proposal.id,
        target: proposal.target,
        mutationType: adapter?.mutationType ?? "operator_settings",
        actor: input.appliedBy,
        errorMessage: message,
      });
      throw new SelfEvolutionMutationError("apply_failed", message, mutation);
    }
  }

  rollbackProposal(
    proposalId: string,
    rolledBackBy: string
  ): {
    proposal: SelfEvolutionProposalRecord;
    mutation: SelfEvolutionMutationRecord;
  } {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new SelfEvolutionMutationError(
        "not_found",
        "Self-evolution proposal not found"
      );
    }
    if (proposal.status !== "applied") {
      throw new SelfEvolutionMutationError(
        "invalid_state",
        "Only applied proposals can be rolled back"
      );
    }
    const mutation = this.proposals
      .listMutations(proposalId, 1)
      .find((item) => item.status === "applied");
    if (!mutation) {
      throw new SelfEvolutionMutationError(
        "invalid_state",
        "No applied mutation is available to roll back"
      );
    }
    const adapter = this.adapters.get(mutation.target);
    if (!adapter) {
      throw new SelfEvolutionMutationError(
        "rollback_failed",
        "No self-evolution mutation adapter is available for rollback"
      );
    }

    try {
      adapter.rollback(mutation);
      const updatedProposal = this.proposals.recordRollback({
        proposalId,
        mutationId: mutation.id,
        actor: rolledBackBy,
      });
      const updatedMutation =
        this.proposals
          .listMutations(proposalId, 10)
          .find((item) => item.id === mutation.id) ?? mutation;
      return { proposal: updatedProposal, mutation: updatedMutation };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to roll back self-evolution proposal";
      throw new SelfEvolutionMutationError("rollback_failed", message);
    }
  }
}

export type OperatorSettingsMutationPort = {
  get(): OperatorSettings;
  update(partial: Partial<OperatorSettings>): OperatorSettings;
};

export function createOperatorSettingsMutationAdapter(
  settings: OperatorSettingsMutationPort
): SelfEvolutionMutationAdapter {
  return {
    target: "configuration",
    mutationType: "operator_settings",
    apply(proposal) {
      const patch = extractOperatorSettingsPatch(proposal);
      const before = settings.get();
      const after = settings.update(patch);
      return {
        before: before as unknown as JsonValue,
        after: after as unknown as JsonValue,
        rollback: { operatorSettings: before },
      };
    },
    rollback(mutation) {
      const rollback = asJsonObject(mutation.rollback, "rollback");
      const operatorSettings = asJsonObject(
        rollback.operatorSettings,
        "rollback.operatorSettings"
      );
      settings.update(toOperatorSettingsPatch(operatorSettings));
    },
  };
}

function extractOperatorSettingsPatch(
  proposal: SelfEvolutionProposalRecord
): Partial<OperatorSettings> {
  if (proposal.target !== "configuration") {
    throw new Error(
      "Only configuration proposals can be applied in this slice"
    );
  }
  const proposedChange = asJsonObject(
    proposal.proposedChange,
    "proposedChange"
  );
  const operatorSettings = asJsonObject(
    proposedChange.operatorSettings,
    "proposedChange.operatorSettings"
  );
  return toOperatorSettingsPatch(operatorSettings);
}

function toOperatorSettingsPatch(
  value: Record<string, JsonValue>
): Partial<OperatorSettings> {
  const patch: Partial<OperatorSettings> = {};
  if (value.dashboardRefreshSeconds !== undefined) {
    if (
      typeof value.dashboardRefreshSeconds !== "number" ||
      !Number.isInteger(value.dashboardRefreshSeconds) ||
      value.dashboardRefreshSeconds <= 0
    ) {
      throw new Error(
        "operatorSettings.dashboardRefreshSeconds must be a positive integer"
      );
    }
    patch.dashboardRefreshSeconds = value.dashboardRefreshSeconds;
  }
  if (value.chatDefaultConversationId !== undefined) {
    if (
      typeof value.chatDefaultConversationId !== "string" ||
      value.chatDefaultConversationId.trim() === ""
    ) {
      throw new Error(
        "operatorSettings.chatDefaultConversationId must be a non-empty string"
      );
    }
    patch.chatDefaultConversationId = value.chatDefaultConversationId.trim();
  }
  if (value.memoryTimelineLimit !== undefined) {
    if (
      typeof value.memoryTimelineLimit !== "number" ||
      !Number.isInteger(value.memoryTimelineLimit) ||
      value.memoryTimelineLimit <= 0
    ) {
      throw new Error(
        "operatorSettings.memoryTimelineLimit must be a positive integer"
      );
    }
    patch.memoryTimelineLimit = value.memoryTimelineLimit;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error(
      "operatorSettings must contain at least one supported field"
    );
  }
  return patch;
}

function asJsonObject(
  value: JsonValue | undefined,
  field: string
): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}
