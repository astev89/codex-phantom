import type { RuntimeConfigLimitsStore } from "../../config/runtime-limits.ts";
import type {
  RuntimeChannelCapabilities,
} from "../../channels/capabilities.ts";
import type { ChannelRegistry } from "../../channels/registry.ts";
import type { AppDatabase } from "../../platform/database.ts";
import type { MemoryPolicyStore } from "../../memory/policy.ts";
import type { RolePolicyRuntimeStore } from "../../orchestration/role-policy-runtime.ts";
import type { ProjectFileApplyService } from "../../project-files/apply.ts";
import type { ProjectFileDraftStore } from "../../project-files/drafts.ts";
import type { ProjectFilePatchDraftStore } from "../../project-files/patches.ts";
import type {
  PromptManagedFragmentStore,
  PromptRuntimeGuidanceStore,
} from "../../prompts/runtime-guidance.ts";
import type { OperatorSettingsMutationPort } from "../../self-evolution/mutations.ts";
import type { ToolBundleLifecycleService } from "../../tools/bundle-lifecycle.ts";
import { AutonomousAssignmentService } from "../service.ts";
import {
  createAssignmentPolicyAutonomousMutationAdapter,
  createOperatorSettingsAutonomousMutationAdapter,
  createRuntimeConfigLimitsAutonomousMutationAdapter,
} from "./configuration.ts";
import { createMemoryPolicyRuntimeBoundsAutonomousMutationAdapter } from "./memory-policy.ts";
import {
  createPromptManagedFragmentAutonomousMutationAdapter,
  createPromptRuntimeGuidanceAutonomousMutationAdapter,
} from "./prompt.ts";
import {
  createProjectFileApplyBundleAutonomousMutationAdapter,
  createProjectFileApplyDraftAutonomousMutationAdapter,
  createProjectFileApplyPatchAutonomousMutationAdapter,
  createProjectFileDraftAutonomousMutationAdapter,
  createProjectFilePatchDraftAutonomousMutationAdapter,
} from "./project-file.ts";
import { createRolePermissionPolicyAutonomousMutationAdapter } from "./role.ts";
import { createToolBundleEnableAutonomousMutationAdapter } from "./tool.ts";
import type { AutonomousMutationAdapter } from "./types.ts";
import { createChannelStateAutonomousMutationAdapter } from "./channel-state.ts";
import { createMemoryEntryLifecycleAutonomousMutationAdapter } from "./memory-entry.ts";

export type DefaultAutonomousMutationAdapterOptions = {
  assignments: AutonomousAssignmentService;
  channels?: ChannelRegistry;
  runtimeChannels?: RuntimeChannelCapabilities;
  database?: AppDatabase;
  settings: OperatorSettingsMutationPort;
  memoryPolicy?: MemoryPolicyStore;
  runtimeConfigLimits?: RuntimeConfigLimitsStore;
  promptGuidance?: PromptRuntimeGuidanceStore;
  promptFragments?: PromptManagedFragmentStore;
  rolePolicy?: RolePolicyRuntimeStore;
  projectFileDrafts?: ProjectFileDraftStore;
  projectFilePatchDrafts?: ProjectFilePatchDraftStore;
  projectFileApply?: ProjectFileApplyService;
  toolBundles?: ToolBundleLifecycleService;
};

export function buildDefaultAutonomousMutationAdapters(
  options: DefaultAutonomousMutationAdapterOptions
): AutonomousMutationAdapter[] {
  return [
    createOperatorSettingsAutonomousMutationAdapter(options.settings),
    createAssignmentPolicyAutonomousMutationAdapter(options.assignments),
    ...(options.promptGuidance
      ? [
          createPromptRuntimeGuidanceAutonomousMutationAdapter(
            options.promptGuidance
          ),
        ]
      : []),
    ...(options.promptFragments
      ? [
          createPromptManagedFragmentAutonomousMutationAdapter(
            options.promptFragments
          ),
        ]
      : []),
    ...(options.memoryPolicy
      ? [
          createMemoryPolicyRuntimeBoundsAutonomousMutationAdapter(
            options.memoryPolicy
          ),
        ]
      : []),
    ...(options.database
      ? [createMemoryEntryLifecycleAutonomousMutationAdapter(options.database)]
      : []),
    ...(options.runtimeConfigLimits
      ? [
          createRuntimeConfigLimitsAutonomousMutationAdapter(
            options.runtimeConfigLimits
          ),
        ]
      : []),
    ...(options.channels
      ? [
          createChannelStateAutonomousMutationAdapter(
            options.channels,
            options.runtimeChannels
          ),
        ]
      : []),
    ...(options.rolePolicy
      ? [createRolePermissionPolicyAutonomousMutationAdapter(options.rolePolicy)]
      : []),
    ...(options.projectFileDrafts
      ? [
          createProjectFileDraftAutonomousMutationAdapter(
            options.projectFileDrafts
          ),
        ]
      : []),
    ...(options.projectFileDrafts && options.projectFileApply
      ? [
          createProjectFileApplyDraftAutonomousMutationAdapter(
            options.projectFileDrafts,
            options.projectFileApply
          ),
          createProjectFileApplyBundleAutonomousMutationAdapter(
            options.projectFileDrafts,
            options.projectFileApply
          ),
        ]
      : []),
    ...(options.projectFilePatchDrafts
      ? [
          createProjectFilePatchDraftAutonomousMutationAdapter(
            options.projectFilePatchDrafts
          ),
        ]
      : []),
    ...(options.projectFilePatchDrafts && options.projectFileApply
      ? [
          createProjectFileApplyPatchAutonomousMutationAdapter(
            options.projectFilePatchDrafts,
            options.projectFileApply
          ),
        ]
      : []),
    ...(options.toolBundles
      ? [createToolBundleEnableAutonomousMutationAdapter(options.toolBundles)]
      : []),
  ];
}
