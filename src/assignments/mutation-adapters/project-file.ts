import {
  projectFileDraftSummary,
  type ProjectFileDraftStore,
} from "../../project-files/drafts.ts";
import {
  type ProjectFileApplyBeforeSnapshot,
  type ProjectFilePatchApplyItem,
  type ProjectFileApplyService,
} from "../../project-files/apply.ts";
import {
  projectFilePatchDraftSummary,
  type ProjectFilePatchDraftStore,
} from "../../project-files/patches.ts";
import type { JsonValue } from "../../shared/types.ts";
import {
  asJsonObject,
  AutonomousMutationApplyFailure,
  type AutonomousMutationApplyFailureEvidence,
  requiredString,
} from "./common.ts";
import type { AutonomousMutationAdapter } from "./types.ts";

export const PROJECT_FILE_DRAFT_MUTATION_CLASS = "project_file.draft";
export const PROJECT_FILE_APPLY_DRAFT_MUTATION_CLASS =
  "project_file.apply_draft";
export const PROJECT_FILE_APPLY_BUNDLE_MUTATION_CLASS =
  "project_file.apply_bundle";
export const PROJECT_FILE_PATCH_DRAFT_MUTATION_CLASS =
  "project_file.patch_draft";
export const PROJECT_FILE_APPLY_PATCH_MUTATION_CLASS =
  "project_file.apply_patch";

const MAX_PROJECT_FILE_BUNDLE_DRAFTS = 10;
const PROJECT_FILE_APPLY_ROLLBACK_CONFLICT_MUTATION_TYPES = [
  "apply_draft",
  "apply_patch",
  "apply_bundle",
] as const;

export function createProjectFileDraftAutonomousMutationAdapter(
  projectFileDrafts: ProjectFileDraftStore
): AutonomousMutationAdapter {
  return {
    target: "project_file",
    mutationType: "draft",
    mutationClass: PROJECT_FILE_DRAFT_MUTATION_CLASS,
    affectedResources: [{ type: "project_file_draft" }],
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const projectFileDraft = asJsonObject(
        proposedChange.projectFileDraft,
        "proposedChange.projectFileDraft"
      );
      const draft = projectFileDrafts.create({
        assignmentId: input.assignment.id,
        runId: input.request.runId,
        path: requiredString(projectFileDraft.path, "projectFileDraft.path"),
        content:
          typeof projectFileDraft.content === "string"
            ? projectFileDraft.content
            : requiredString(
                projectFileDraft.content,
                "projectFileDraft.content"
              ),
        contentType:
          typeof projectFileDraft.contentType === "string"
            ? projectFileDraft.contentType
            : undefined,
        metadata:
          projectFileDraft.metadata === undefined
            ? {
                rationale: input.request.rationale,
                actor: input.request.actor ?? null,
              }
            : projectFileDraft.metadata,
      });
      const summary = projectFileDraftSummary(draft);
      const affectedResources = [
        { type: "project_file_draft", id: draft.id, path: draft.path },
      ];
      return {
        before: {
          path: draft.path,
          activeDrafts: projectFileDrafts
            .listActiveSummariesForPath(draft.path)
            .filter((item) => item.id !== draft.id),
        } as unknown as JsonValue,
        after: { draft: summary } as unknown as JsonValue,
        rollback: { projectFileDraft: { id: draft.id } },
        affectedResources,
        verificationMethod: "project_file_draft_create",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const projectFileDraft = asJsonObject(
        rollback.projectFileDraft,
        "rollback.projectFileDraft"
      );
      const id = requiredString(projectFileDraft.id, "projectFileDraft.id");
      projectFileDrafts.markRolledBack(id);
      return { verificationMethod: "project_file_draft_rollback" };
    },
  };
}

export function createProjectFileApplyDraftAutonomousMutationAdapter(
  projectFileDrafts: ProjectFileDraftStore,
  projectFileApply: ProjectFileApplyService
): AutonomousMutationAdapter {
  return {
    target: "project_file",
    mutationType: "apply_draft",
    mutationClass: PROJECT_FILE_APPLY_DRAFT_MUTATION_CLASS,
    minimumRiskClass: "high",
    rollbackConflictScope: "affected_resources",
    rollbackConflictMutationTypes:
      PROJECT_FILE_APPLY_ROLLBACK_CONFLICT_MUTATION_TYPES,
    affectedResources: [{ type: "project_file" }],
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const projectFileApplyInput = asJsonObject(
        proposedChange.projectFileApply,
        "proposedChange.projectFileApply"
      );
      const draftId = requiredString(
        projectFileApplyInput.draftId,
        "projectFileApply.draftId"
      );
      const draft = projectFileDrafts.get(draftId);
      if (!draft) {
        throw new Error("Project file draft not found");
      }
      if (draft.assignmentId !== input.assignment.id) {
        throw new Error("Project file draft does not belong to assignment");
      }
      if (draft.status !== "active") {
        throw new Error("Project file draft is not active");
      }
      const result = projectFileApply.apply({
        path: draft.path,
        content: draft.content,
      });
      let appliedDraft;
      try {
        appliedDraft = projectFileDrafts.markApplied(draft.id, {
          mutationId: input.mutationId,
          sha256: result.after.sha256,
        });
      } catch (error) {
        projectFileApply.rollback(result.before);
        throw error;
      }
      const affectedResources = [
        { type: "project_file", id: draft.path, path: draft.path },
      ];
      return {
        before: result.before as unknown as JsonValue,
        after: {
          draft: projectFileDraftSummary(appliedDraft),
          file: result.after,
        } as unknown as JsonValue,
        rollback: {
          projectFileApply: {
            draftId: draft.id,
            path: draft.path,
            beforeFile: result.before,
          },
        } as unknown as JsonValue,
        affectedResources,
        verificationMethod: "project_file_apply_draft_write",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const projectFileApplyRollback = asJsonObject(
        rollback.projectFileApply,
        "rollback.projectFileApply"
      );
      const draftId = requiredString(
        projectFileApplyRollback.draftId,
        "rollback.projectFileApply.draftId"
      );
      projectFileApply.rollback(
        normalizeProjectFileApplyBeforeSnapshot(
          projectFileApplyRollback.beforeFile
        )
      );
      projectFileDrafts.markActiveAfterApplyRollback(draftId);
      return { verificationMethod: "project_file_apply_draft_rollback" };
    },
  };
}

export function createProjectFilePatchDraftAutonomousMutationAdapter(
  projectFilePatchDrafts: ProjectFilePatchDraftStore
): AutonomousMutationAdapter {
  return {
    target: "project_file",
    mutationType: "patch_draft",
    mutationClass: PROJECT_FILE_PATCH_DRAFT_MUTATION_CLASS,
    minimumRiskClass: "high",
    affectedResources: [{ type: "project_file_patch_draft" }],
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const projectFilePatchDraft = asJsonObject(
        proposedChange.projectFilePatchDraft,
        "proposedChange.projectFilePatchDraft"
      );
      const draft = projectFilePatchDrafts.create({
        assignmentId: input.assignment.id,
        runId: input.request.runId,
        patch:
          typeof projectFilePatchDraft.patch === "string"
            ? projectFilePatchDraft.patch
            : requiredString(
                projectFilePatchDraft.patch,
                "projectFilePatchDraft.patch"
              ),
        metadata:
          projectFilePatchDraft.metadata === undefined
            ? {
                rationale: input.request.rationale,
                actor: input.request.actor ?? null,
              }
            : projectFilePatchDraft.metadata,
      });
      const summary = projectFilePatchDraftSummary(draft);
      const affectedResources = [
        {
          type: "project_file_patch_draft",
          id: draft.id,
          paths: draft.filePaths,
        },
      ];
      return {
        before: { activePatchDrafts: [] } as unknown as JsonValue,
        after: { patchDraft: summary } as unknown as JsonValue,
        rollback: { projectFilePatchDraft: { id: draft.id } },
        affectedResources,
        verificationMethod: "project_file_patch_draft_create",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const projectFilePatchDraft = asJsonObject(
        rollback.projectFilePatchDraft,
        "rollback.projectFilePatchDraft"
      );
      const id = requiredString(
        projectFilePatchDraft.id,
        "projectFilePatchDraft.id"
      );
      projectFilePatchDrafts.markRolledBack(id);
      return { verificationMethod: "project_file_patch_draft_rollback" };
    },
  };
}

export function createProjectFileApplyPatchAutonomousMutationAdapter(
  projectFilePatchDrafts: ProjectFilePatchDraftStore,
  projectFileApply: ProjectFileApplyService
): AutonomousMutationAdapter {
  return {
    target: "project_file",
    mutationType: "apply_patch",
    mutationClass: PROJECT_FILE_APPLY_PATCH_MUTATION_CLASS,
    minimumRiskClass: "high",
    rollbackConflictScope: "affected_resources",
    rollbackConflictMutationTypes:
      PROJECT_FILE_APPLY_ROLLBACK_CONFLICT_MUTATION_TYPES,
    affectedResources: [{ type: "project_file_patch" }],
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const projectFilePatchApply = asJsonObject(
        proposedChange.projectFilePatchApply,
        "proposedChange.projectFilePatchApply"
      );
      const draftId = requiredString(
        projectFilePatchApply.draftId,
        "projectFilePatchApply.draftId"
      );
      const draft = projectFilePatchDrafts.get(draftId);
      if (!draft) {
        throw new Error("Project file patch draft not found");
      }
      if (draft.assignmentId !== input.assignment.id) {
        throw new Error("Project file patch draft does not belong to assignment");
      }
      if (draft.status !== "active") {
        throw new Error("Project file patch draft is not active");
      }

      let result: { files: ProjectFilePatchApplyItem[] };
      try {
        result = projectFileApply.applyPatch({ patch: draft.patch });
      } catch (error) {
        throw error;
      }

      let appliedDraft;
      try {
        appliedDraft = projectFilePatchDrafts.markApplied(draft.id, {
          mutationId: input.mutationId,
          sha256: draft.sha256,
        });
      } catch (error) {
        for (const file of result.files.slice().reverse()) {
          projectFileApply.rollback(file.before);
        }
        throw error;
      }

      const affectedResources = result.files.map((file) => ({
        type: "project_file",
        id: file.path,
        path: file.path,
      }));
      return {
        before: projectFilePatchApplyBeforeEvidence(result.files),
        after: {
          patchDraft: projectFilePatchDraftSummary(appliedDraft),
          files: result.files.map((file) => file.after),
        } as unknown as JsonValue,
        rollback: {
          projectFilePatch: {
            draftId: draft.id,
            items: result.files.map((file) => ({
              path: file.path,
              beforeFile: file.before,
            })),
          },
        } as unknown as JsonValue,
        affectedResources,
        verificationMethod: "project_file_apply_patch_write",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const projectFilePatch = asJsonObject(
        rollback.projectFilePatch,
        "rollback.projectFilePatch"
      );
      const draftId = requiredString(
        projectFilePatch.draftId,
        "rollback.projectFilePatch.draftId"
      );
      if (!Array.isArray(projectFilePatch.items)) {
        throw new Error("rollback.projectFilePatch.items must be an array");
      }
      const items = projectFilePatch.items.map((itemValue) =>
        normalizeProjectFilePatchRollbackItem(itemValue)
      );
      for (const item of items) {
        projectFileApply.assertRollbackSafe(item.beforeFile);
      }
      for (const item of items.slice().reverse()) {
        projectFileApply.rollback(item.beforeFile);
      }
      projectFilePatchDrafts.markActiveAfterApplyRollback(draftId);
      return { verificationMethod: "project_file_apply_patch_rollback" };
    },
  };
}

type ProjectFileBundleApplyItem = {
  draftId: string;
  path: string;
  beforeFile: ProjectFileApplyBeforeSnapshot;
  afterFile: {
    path: string;
    sizeBytes: number;
    sha256: string;
  };
};

type ProjectFilePatchRollbackItem = {
  path: string;
  beforeFile: ProjectFileApplyBeforeSnapshot;
};

export function createProjectFileApplyBundleAutonomousMutationAdapter(
  projectFileDrafts: ProjectFileDraftStore,
  projectFileApply: ProjectFileApplyService
): AutonomousMutationAdapter {
  return {
    target: "project_file",
    mutationType: "apply_bundle",
    mutationClass: PROJECT_FILE_APPLY_BUNDLE_MUTATION_CLASS,
    minimumRiskClass: "high",
    rollbackConflictScope: "affected_resources",
    rollbackConflictMutationTypes:
      PROJECT_FILE_APPLY_ROLLBACK_CONFLICT_MUTATION_TYPES,
    affectedResources: [{ type: "project_file_bundle" }],
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const projectFileBundle = asJsonObject(
        proposedChange.projectFileBundle,
        "proposedChange.projectFileBundle"
      );
      const draftIds = requireProjectFileBundleDraftIds(
        projectFileBundle.draftIds
      );
      const drafts = draftIds.map((draftId) => {
        const draft = projectFileDrafts.get(draftId);
        if (!draft) {
          throw new Error(`Project file draft not found: ${draftId}`);
        }
        if (draft.assignmentId !== input.assignment.id) {
          throw new Error("Project file draft does not belong to assignment");
        }
        if (draft.status !== "active") {
          throw new Error("Project file draft is not active");
        }
        return draft;
      });
      const paths = drafts.map((draft) => draft.path);
      if (new Set(paths).size !== paths.length) {
        throw new Error(
          "projectFileBundle.draftIds cannot target duplicate paths"
        );
      }

      const applied: ProjectFileBundleApplyItem[] = [];
      const appliedDraftIds: string[] = [];
      const appliedDraftSummaries = new Map<
        string,
        ReturnType<typeof projectFileDraftSummary>
      >();
      try {
        for (const draft of drafts) {
          const result = projectFileApply.apply({
            path: draft.path,
            content: draft.content,
          });
          applied.push({
            draftId: draft.id,
            path: draft.path,
            beforeFile: result.before,
            afterFile: result.after,
          });
          const appliedDraft = projectFileDrafts.markApplied(draft.id, {
            mutationId: input.mutationId,
            sha256: result.after.sha256,
          });
          appliedDraftIds.push(draft.id);
          appliedDraftSummaries.set(
            draft.id,
            projectFileDraftSummary(appliedDraft)
          );
        }
      } catch (error) {
        for (const item of applied.slice().reverse()) {
          projectFileApply.rollback(item.beforeFile);
        }
        for (const draftId of appliedDraftIds.reverse()) {
          projectFileDrafts.markActiveAfterApplyRollback(draftId);
        }
        if (applied.length > 0) {
          throw new AutonomousMutationApplyFailure(
            error instanceof Error
              ? error.message
              : "Failed to apply autonomous mutation",
            projectFileBundleApplyEvidence(applied, appliedDraftSummaries)
          );
        }
        throw error;
      }

      const affectedResources = applied.map((item) => ({
        type: "project_file",
        id: item.path,
        path: item.path,
      }));
      const evidence = projectFileBundleApplyEvidence(
        applied,
        appliedDraftSummaries
      );
      return {
        before: evidence.before,
        after: evidence.after,
        rollback: evidence.rollback,
        affectedResources,
        verificationMethod: "project_file_apply_bundle_write",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const projectFileBundle = asJsonObject(
        rollback.projectFileBundle,
        "rollback.projectFileBundle"
      );
      if (!Array.isArray(projectFileBundle.items)) {
        throw new Error("rollback.projectFileBundle.items must be an array");
      }
      const items = projectFileBundle.items.map((itemValue) =>
        normalizeProjectFileBundleRollbackItem(itemValue)
      );
      for (const item of items) {
        projectFileApply.assertRollbackSafe(item.beforeFile);
      }
      for (const item of items.slice().reverse()) {
        projectFileApply.rollback(item.beforeFile);
        projectFileDrafts.markActiveAfterApplyRollback(item.draftId);
      }
      return { verificationMethod: "project_file_apply_bundle_rollback" };
    },
  };
}

function requireProjectFileBundleDraftIds(value: JsonValue): string[] {
  if (!Array.isArray(value)) {
    throw new Error("projectFileBundle.draftIds must be an array");
  }
  if (value.length < 1 || value.length > MAX_PROJECT_FILE_BUNDLE_DRAFTS) {
    throw new Error(
      `projectFileBundle.draftIds must contain 1 to ${MAX_PROJECT_FILE_BUNDLE_DRAFTS} draft ids`
    );
  }
  const ids = value.map((item, index) =>
    requiredString(item, `projectFileBundle.draftIds[${index}]`)
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error("projectFileBundle.draftIds must be unique");
  }
  return ids;
}

function projectFilePatchApplyBeforeEvidence(
  files: ProjectFilePatchApplyItem[]
): JsonValue {
  return {
    files: files.map((file) => ({
      path: file.path,
      beforeFile: file.before,
    })),
  } as unknown as JsonValue;
}

function normalizeProjectFilePatchRollbackItem(
  value: JsonValue
): ProjectFilePatchRollbackItem {
  const item = asJsonObject(value, "rollback.projectFilePatch.items[]");
  const path = requiredString(
    item.path,
    "rollback.projectFilePatch.item.path"
  );
  return {
    path,
    beforeFile: normalizeProjectFileApplyBeforeSnapshot(item.beforeFile),
  };
}

function projectFileBundleApplyEvidence(
  applied: ProjectFileBundleApplyItem[],
  appliedDraftSummaries: Map<string, ReturnType<typeof projectFileDraftSummary>>
): Required<AutonomousMutationApplyFailureEvidence> {
  return {
    before: {
      files: applied.map((item) => ({
        draftId: item.draftId,
        path: item.path,
        beforeFile: item.beforeFile,
      })),
    } as unknown as JsonValue,
    after: {
      files: applied.map((item) => ({
        draft: appliedDraftSummaries.get(item.draftId),
        file: item.afterFile,
      })),
    } as unknown as JsonValue,
    rollback: {
      projectFileBundle: {
        items: applied,
      },
    } as unknown as JsonValue,
    affectedResources: applied.map((item) => ({
      type: "project_file",
      id: item.path,
      path: item.path,
    })) as JsonValue,
  };
}

function normalizeProjectFileBundleRollbackItem(
  value: JsonValue
): ProjectFileBundleApplyItem {
  const item = asJsonObject(value, "rollback.projectFileBundle.items[]");
  const draftId = requiredString(
    item.draftId,
    "rollback.projectFileBundle.item.draftId"
  );
  const path = requiredString(
    item.path,
    "rollback.projectFileBundle.item.path"
  );
  const afterFile = asJsonObject(
    item.afterFile,
    "rollback.projectFileBundle.item.afterFile"
  );
  if (typeof afterFile.sizeBytes !== "number") {
    throw new Error(
      "rollback.projectFileBundle.item.afterFile.sizeBytes must be a number"
    );
  }
  return {
    draftId,
    path,
    beforeFile: normalizeProjectFileApplyBeforeSnapshot(item.beforeFile),
    afterFile: {
      path: requiredString(
        afterFile.path,
        "rollback.projectFileBundle.item.afterFile.path"
      ),
      sizeBytes: afterFile.sizeBytes,
      sha256: requiredString(
        afterFile.sha256,
        "rollback.projectFileBundle.item.afterFile.sha256"
      ),
    },
  };
}

function normalizeProjectFileApplyBeforeSnapshot(
  value: JsonValue
): ProjectFileApplyBeforeSnapshot {
  const label = "rollback.projectFile.beforeFile";
  const snapshot = asJsonObject(value, label);
  const path = requiredString(
    snapshot.path,
    `${label}.path`
  );
  if (typeof snapshot.existed !== "boolean") {
    throw new Error(
      `${label}.existed must be a boolean`
    );
  }
  if (!snapshot.existed) {
    return { path, existed: false };
  }
  if (
    typeof snapshot.contentBase64 !== "string" &&
    typeof snapshot.content !== "string"
  ) {
    throw new Error(
      `${label}.contentBase64 or content must be a string`
    );
  }
  const before: ProjectFileApplyBeforeSnapshot = {
    path,
    existed: true,
  };
  if (typeof snapshot.contentBase64 === "string") {
    before.contentBase64 = snapshot.contentBase64;
  } else if (typeof snapshot.content === "string") {
    before.content = snapshot.content;
  }
  if (typeof snapshot.sizeBytes === "number") {
    before.sizeBytes = snapshot.sizeBytes;
  }
  if (typeof snapshot.sha256 === "string") {
    before.sha256 = snapshot.sha256;
  }
  return before;
}
