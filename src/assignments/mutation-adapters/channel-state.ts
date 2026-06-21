import {
  RuntimeChannelCapabilities,
  runtimeChannelDefinition,
  type RuntimeChannelId,
} from "../../channels/capabilities.ts";
import type { ChannelRecord, ChannelRegistry } from "../../channels/registry.ts";
import type { JsonValue } from "../../shared/types.ts";
import {
  asJsonObject,
  AutonomousMutationApplyFailure,
  requiredString,
} from "./common.ts";
import type { AutonomousMutationAdapter } from "./types.ts";

export const CHANNEL_STATE_MUTATION_CLASS = "configuration.channel_state";

export function createChannelStateAutonomousMutationAdapter(
  channels: ChannelRegistry,
  runtimeChannels?: RuntimeChannelCapabilities
): AutonomousMutationAdapter {
  return {
    target: "configuration",
    mutationType: "channel_state",
    mutationClass: CHANNEL_STATE_MUTATION_CLASS,
    affectedResources: [],
    minimumRiskClass: "high",
    requiresAsync: true,
    rollbackConflictScope: "affected_resources",
    async apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      assertOnlyKeys(proposedChange, ["channelState"], "proposedChange");
      const requested = normalizeChannelState(
        asJsonObject(
          proposedChange.channelState,
          "proposedChange.channelState"
        )
      );
      const before = getRequiredRuntimeChannel(channels, requested.channelId);
      if (requested.enabled && !before.secretPresent) {
        throw new Error(
          `${requested.channelId} cannot be enabled because required channel configuration is missing`
        );
      }
      try {
        await updateChannelState(
          channels,
          runtimeChannels,
          requested.channelId,
          requested.enabled,
          before.enabled
        );
      } catch (error) {
        const restored = getRequiredRuntimeChannel(
          channels,
          requested.channelId
        );
        throw new AutonomousMutationApplyFailure(
          error instanceof Error
            ? error.message
            : "Failed to apply autonomous mutation",
          {
            before: {
              channel: channelStateEvidence(before),
            } as JsonValue,
            after: {
              channel: channelStateEvidence(restored),
              attempted: { enabled: requested.enabled },
            } as JsonValue,
            rollback: channelStateRollbackEvidence(before),
            affectedResources: [
              { type: "channel", id: requested.channelId },
            ] as JsonValue,
          }
        );
      }
      const after = getRequiredRuntimeChannel(channels, requested.channelId);
      const affectedResources = [
        { type: "channel", id: requested.channelId },
      ] as JsonValue;
      return {
        before: { channel: channelStateEvidence(before) } as JsonValue,
        after: { channel: channelStateEvidence(after) } as JsonValue,
        rollback: channelStateRollbackEvidence(before),
        affectedResources,
        verificationMethod: "channel_state_update",
      };
    },
    async rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const requested = normalizeChannelState(
        asJsonObject(rollback.channelState, "rollback.channelState")
      );
      const before = getRequiredRuntimeChannel(channels, requested.channelId);
      await updateChannelState(
        channels,
        runtimeChannels,
        requested.channelId,
        requested.enabled,
        before.enabled
      );
      return { verificationMethod: "channel_state_rollback" };
    },
  };
}

async function updateChannelState(
  channels: ChannelRegistry,
  runtimeChannels: RuntimeChannelCapabilities | undefined,
  channelId: RuntimeChannelId,
  enabled: boolean,
  restoreEnabled: boolean
): Promise<void> {
  channels.upsert({ id: channelId, enabled });
  try {
    await applyRuntimeState(runtimeChannels, channelId, enabled);
  } catch (error) {
    channels.upsert({ id: channelId, enabled: restoreEnabled });
    throw error;
  }
}

async function applyRuntimeState(
  runtimeChannels: RuntimeChannelCapabilities | undefined,
  channelId: RuntimeChannelId,
  enabled: boolean
): Promise<void> {
  if (!runtimeChannels) {
    return;
  }
  await runtimeChannels.applyRuntimeState(channelId, enabled);
}

function normalizeChannelState(value: {
  [key: string]: JsonValue;
}): { channelId: RuntimeChannelId; enabled: boolean } {
  assertOnlyKeys(value, ["channelId", "enabled"], "channelState");
  const channelId = requiredString(value.channelId, "channelState.channelId");
  if (!runtimeChannelDefinition(channelId)) {
    throw new Error(`Unknown runtime channel: ${channelId}`);
  }
  return {
    channelId: channelId as RuntimeChannelId,
    enabled: requiredBoolean(value.enabled, "channelState.enabled"),
  };
}

function getRequiredRuntimeChannel(
  channels: ChannelRegistry,
  channelId: RuntimeChannelId
): ChannelRecord {
  const definition = runtimeChannelDefinition(channelId);
  if (!definition) {
    throw new Error(`Unknown runtime channel: ${channelId}`);
  }
  const channel = channels.get(channelId);
  if (!channel) {
    throw new Error(`Unknown channel: ${channelId}`);
  }
  return channel;
}

function channelStateEvidence(channel: ChannelRecord): {
  id: string;
  enabled: boolean;
  secretPresent: boolean;
} {
  return {
    id: channel.id,
    enabled: channel.enabled,
    secretPresent: channel.secretPresent,
  };
}

function channelStateRollbackEvidence(channel: ChannelRecord): JsonValue {
  return {
    channelState: {
      channelId: channel.id,
      enabled: channel.enabled,
    },
  } as JsonValue;
}

function requiredBoolean(value: JsonValue, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function assertOnlyKeys(
  value: { [key: string]: JsonValue },
  allowedKeys: string[],
  field: string
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${field}.${key} is not supported`);
    }
  }
}
