import { createHash } from "node:crypto";
import { createId } from "../shared/ids.ts";
import type { JsonValue } from "../shared/types.ts";
import {
  decodeJson,
  encodeJson,
  type AppDatabase,
} from "../platform/database.ts";
import { normalizeProjectFilePath } from "./drafts.ts";

export const MAX_PROJECT_FILE_PATCH_DRAFT_BYTES = 200_000;
export const MAX_PROJECT_FILE_PATCH_FILES = 10;

export type ProjectFilePatchDraftStatus =
  | "active"
  | "applied"
  | "rolled_back";

export type ProjectFilePatchDraftRecord = {
  id: string;
  assignmentId: string;
  runId?: string;
  patch: string;
  sizeBytes: number;
  sha256: string;
  filePaths: string[];
  metadata: JsonValue;
  status: ProjectFilePatchDraftStatus;
  appliedMutationId?: string;
  appliedAt?: string;
  appliedSha256?: string;
  createdAt: string;
  updatedAt: string;
  rolledBackAt?: string;
};

export type ProjectFilePatchDraftCreateInput = {
  assignmentId: string;
  runId?: string;
  patch: string;
  metadata?: JsonValue;
};

export type ProjectFilePatchDraftSummary = Omit<
  ProjectFilePatchDraftRecord,
  "patch" | "metadata" | "createdAt" | "updatedAt" | "rolledBackAt"
>;

export type ProjectFilePatchLine = {
  kind: "context" | "add" | "remove";
  text: string;
};

export type ProjectFilePatchHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ProjectFilePatchLine[];
};

export type ProjectFileParsedFilePatch = {
  path: string;
  oldPath?: string;
  newPath: string;
  newEndsWithNewline: boolean;
  hunks: ProjectFilePatchHunk[];
};

export type ProjectFileParsedPatch = {
  files: ProjectFileParsedFilePatch[];
};

type ProjectFilePatchDraftRow = {
  id: string;
  assignment_id: string;
  run_id: string | null;
  patch: string;
  size_bytes: number;
  sha256: string;
  file_paths_json: string;
  metadata_json: string;
  status: ProjectFilePatchDraftStatus;
  applied_mutation_id: string | null;
  applied_at: string | null;
  applied_sha256: string | null;
  created_at: string;
  updated_at: string;
  rolled_back_at: string | null;
};

export class ProjectFilePatchDraftStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  create(
    input: ProjectFilePatchDraftCreateInput
  ): ProjectFilePatchDraftRecord {
    const normalized = normalizeProjectFilePatchDraft(input);
    const now = new Date().toISOString();
    const record: ProjectFilePatchDraftRecord = {
      id: createId("pfpatch"),
      assignmentId: input.assignmentId,
      runId: input.runId,
      patch: normalized.patch,
      sizeBytes: normalized.sizeBytes,
      sha256: normalized.sha256,
      filePaths: normalized.filePaths,
      metadata: input.metadata ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.database.run(
      `
        INSERT INTO project_file_patch_drafts (
          id, assignment_id, run_id, patch, size_bytes, sha256,
          file_paths_json, metadata_json, status, created_at, updated_at,
          rolled_back_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.id,
      record.assignmentId,
      record.runId ?? null,
      record.patch,
      record.sizeBytes,
      record.sha256,
      encodeJson(record.filePaths),
      encodeJson(record.metadata),
      record.status,
      record.createdAt,
      record.updatedAt,
      null
    );
    return record;
  }

  get(id: string): ProjectFilePatchDraftRecord | undefined {
    const row = this.database.get<ProjectFilePatchDraftRow>(
      "SELECT * FROM project_file_patch_drafts WHERE id = ?",
      id
    );
    return row ? toProjectFilePatchDraftRecord(row) : undefined;
  }

  list(
    input: {
      assignmentId?: string;
      status?: ProjectFilePatchDraftStatus;
      limit?: number;
    } = {}
  ): ProjectFilePatchDraftRecord[] {
    const filters: string[] = [];
    const values: Array<string | number> = [];
    if (input.assignmentId) {
      filters.push("assignment_id = ?");
      values.push(input.assignmentId);
    }
    if (input.status) {
      filters.push("status = ?");
      values.push(input.status);
    }
    const limit = Math.min(Math.max(input.limit ?? 250, 1), 500);
    values.push(limit);
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return this.database
      .all<ProjectFilePatchDraftRow>(
        `SELECT * FROM project_file_patch_drafts ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
        ...values
      )
      .map(toProjectFilePatchDraftRecord);
  }

  markRolledBack(id: string): ProjectFilePatchDraftRecord {
    const current = this.get(id);
    if (!current) {
      throw new Error("Project file patch draft not found");
    }
    if (current.status === "rolled_back") {
      return current;
    }
    if (current.status === "applied") {
      throw new Error(
        "Applied project file patch draft cannot be rolled back before its apply mutation is rolled back"
      );
    }
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE project_file_patch_drafts
        SET status = ?, updated_at = ?, rolled_back_at = ?
        WHERE id = ?
      `,
      "rolled_back",
      now,
      now,
      id
    );
    return this.get(id) ?? current;
  }

  markApplied(
    id: string,
    input: { mutationId: string; sha256: string }
  ): ProjectFilePatchDraftRecord {
    const current = this.get(id);
    if (!current) {
      throw new Error("Project file patch draft not found");
    }
    if (current.status !== "active") {
      throw new Error("Project file patch draft is not active");
    }
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE project_file_patch_drafts
        SET status = ?,
            applied_mutation_id = ?,
            applied_at = ?,
            applied_sha256 = ?,
            updated_at = ?
        WHERE id = ?
      `,
      "applied",
      input.mutationId,
      now,
      input.sha256,
      now,
      id
    );
    return this.get(id) ?? current;
  }

  markActiveAfterApplyRollback(id: string): ProjectFilePatchDraftRecord {
    const current = this.get(id);
    if (!current) {
      throw new Error("Project file patch draft not found");
    }
    if (current.status === "active") {
      return current;
    }
    if (current.status === "rolled_back") {
      throw new Error(
        "Rolled back project file patch draft cannot be reactivated"
      );
    }
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE project_file_patch_drafts
        SET status = ?,
            applied_mutation_id = NULL,
            applied_at = NULL,
            applied_sha256 = NULL,
            updated_at = ?
        WHERE id = ?
      `,
      "active",
      now,
      id
    );
    return this.get(id) ?? current;
  }
}

export function projectFilePatchDraftSummary(
  draft: ProjectFilePatchDraftRecord
): ProjectFilePatchDraftSummary {
  return {
    id: draft.id,
    assignmentId: draft.assignmentId,
    runId: draft.runId,
    sizeBytes: draft.sizeBytes,
    sha256: draft.sha256,
    filePaths: draft.filePaths,
    status: draft.status,
    ...(draft.appliedMutationId
      ? { appliedMutationId: draft.appliedMutationId }
      : {}),
    ...(draft.appliedAt ? { appliedAt: draft.appliedAt } : {}),
    ...(draft.appliedSha256 ? { appliedSha256: draft.appliedSha256 } : {}),
  };
}

export function normalizeProjectFilePatchDraft(
  input: ProjectFilePatchDraftCreateInput
): {
  patch: string;
  sizeBytes: number;
  sha256: string;
  filePaths: string[];
} {
  if (typeof input.patch !== "string" || input.patch.trim() === "") {
    throw new Error("projectFilePatchDraft.patch must be a non-empty string");
  }
  const patch = input.patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (patch.includes("\u0000")) {
    throw new Error("projectFilePatchDraft.patch must be text");
  }
  const sizeBytes = Buffer.byteLength(patch, "utf8");
  if (sizeBytes > MAX_PROJECT_FILE_PATCH_DRAFT_BYTES) {
    throw new Error(
      `projectFilePatchDraft.patch exceeds ${MAX_PROJECT_FILE_PATCH_DRAFT_BYTES} bytes`
    );
  }
  const parsed = parseUnifiedProjectFilePatch(patch);
  return {
    patch,
    sizeBytes,
    sha256: createHash("sha256").update(patch).digest("hex"),
    filePaths: parsed.files.map((file) => file.path),
  };
}

export function parseUnifiedProjectFilePatch(
  patch: string
): ProjectFileParsedPatch {
  const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (
    lines.some(
      (line) => line === "GIT binary patch" || line.startsWith("Binary files ")
    )
  ) {
    throw new Error("projectFilePatchDraft.patch cannot contain binary patches");
  }

  const files: ProjectFileParsedFilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line === "") {
      index += 1;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      index += 1;
      continue;
    }
    if (isSkippableGitDiffMetadata(line)) {
      index += 1;
      continue;
    }
    if (!line.startsWith("--- ")) {
      throw new Error("projectFilePatchDraft.patch must be a unified diff");
    }
    const oldPath = normalizePatchHeaderPath(line.slice(4), "old");
    index += 1;
    const newHeader = lines[index] ?? "";
    if (!newHeader.startsWith("+++ ")) {
      throw new Error("projectFilePatchDraft.patch must include +++ headers");
    }
    const newPath = normalizePatchHeaderPath(newHeader.slice(4), "new");
    if (!newPath) {
      throw new Error("projectFilePatchDraft.patch cannot delete files");
    }
    if (oldPath && oldPath !== newPath) {
      throw new Error("projectFilePatchDraft.patch cannot rename files");
    }
    index += 1;

    const hunks: ProjectFilePatchHunk[] = [];
    let newEndsWithNewline = true;
    let lastHunkLineAffectsNewFile = false;
    while (index < lines.length) {
      const hunkHeader = lines[index] ?? "";
      if (
        hunkHeader.startsWith("diff --git ") ||
        isSkippableGitDiffMetadata(hunkHeader) ||
        hunkHeader.startsWith("--- ")
      ) {
        break;
      }
      if (hunkHeader === "") {
        index += 1;
        continue;
      }
      const hunk = parseHunkHeader(hunkHeader);
      index += 1;
      let oldLineCount = 0;
      let newLineCount = 0;
      const hunkLines: ProjectFilePatchLine[] = [];
      while (index < lines.length) {
        const hunkLine = lines[index] ?? "";
        if (hunkLine === "" && index === lines.length - 1) {
          index += 1;
          break;
        }
        if (
          hunkLine.startsWith("@@ ") ||
          hunkLine.startsWith("diff --git ") ||
          isSkippableGitDiffMetadata(hunkLine) ||
          (hunkLine.startsWith("--- ") &&
            oldLineCount === hunk.oldCount &&
            newLineCount === hunk.newCount)
        ) {
          break;
        }
        if (hunkLine.startsWith("\\ No newline at end of file")) {
          if (lastHunkLineAffectsNewFile) {
            newEndsWithNewline = false;
          }
          index += 1;
          continue;
        }
        const prefix = hunkLine[0];
        if (prefix !== " " && prefix !== "+" && prefix !== "-") {
          throw new Error(
            "projectFilePatchDraft.patch contains malformed hunk lines"
          );
        }
        const text = hunkLine.slice(1);
        if (prefix === " ") {
          oldLineCount += 1;
          newLineCount += 1;
          hunkLines.push({ kind: "context", text });
          lastHunkLineAffectsNewFile = true;
          newEndsWithNewline = true;
        } else if (prefix === "+") {
          newLineCount += 1;
          hunkLines.push({ kind: "add", text });
          lastHunkLineAffectsNewFile = true;
          newEndsWithNewline = true;
        } else {
          oldLineCount += 1;
          hunkLines.push({ kind: "remove", text });
          lastHunkLineAffectsNewFile = false;
        }
        index += 1;
      }
      if (oldLineCount !== hunk.oldCount || newLineCount !== hunk.newCount) {
        throw new Error("projectFilePatchDraft.patch hunk counts do not match");
      }
      hunks.push({ ...hunk, lines: hunkLines });
    }
    if (hunks.length === 0) {
      throw new Error("projectFilePatchDraft.patch must include hunks");
    }
    files.push({
      path: newPath,
      oldPath: oldPath ?? undefined,
      newPath,
      newEndsWithNewline,
      hunks,
    });
  }

  if (files.length < 1) {
    throw new Error("projectFilePatchDraft.patch must include at least one file");
  }
  if (files.length > MAX_PROJECT_FILE_PATCH_FILES) {
    throw new Error(
      `projectFilePatchDraft.patch cannot touch more than ${MAX_PROJECT_FILE_PATCH_FILES} files`
    );
  }
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("projectFilePatchDraft.patch cannot target duplicate paths");
  }
  return { files };
}

function isSkippableGitDiffMetadata(line: string): boolean {
  return (
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ")
  );
}

function parseHunkHeader(header: string): Omit<ProjectFilePatchHunk, "lines"> {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) {
    throw new Error("projectFilePatchDraft.patch contains malformed hunks");
  }
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] ? Number(match[2]) : 1,
    newStart: Number(match[3]),
    newCount: match[4] ? Number(match[4]) : 1,
  };
}

function normalizePatchHeaderPath(
  value: string,
  side: "old" | "new"
): string | undefined {
  const token = value.trim().split(/\t/)[0]?.trim() ?? "";
  if (token === "/dev/null") {
    return undefined;
  }
  if (token.startsWith("\"")) {
    throw new Error("projectFilePatchDraft.patch cannot use quoted paths");
  }
  const withoutPrefix =
    token.startsWith("a/") || token.startsWith("b/") ? token.slice(2) : token;
  try {
    return normalizeProjectFilePath(withoutPrefix);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid path";
    throw new Error(
      `projectFilePatchDraft.patch ${side} path is invalid: ${message}`
    );
  }
}

function toProjectFilePatchDraftRecord(
  row: ProjectFilePatchDraftRow
): ProjectFilePatchDraftRecord {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    runId: row.run_id ?? undefined,
    patch: row.patch,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    filePaths: decodeJson<string[]>(row.file_paths_json, []),
    metadata: decodeJson(row.metadata_json, null),
    status: row.status,
    appliedMutationId: row.applied_mutation_id ?? undefined,
    appliedAt: row.applied_at ?? undefined,
    appliedSha256: row.applied_sha256 ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rolledBackAt: row.rolled_back_at ?? undefined,
  };
}
