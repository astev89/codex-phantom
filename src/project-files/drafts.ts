import { createHash } from "node:crypto";
import { isSafeTextContentType } from "../chat/content-policy.ts";
import { createId } from "../shared/ids.ts";
import type { JsonValue } from "../shared/types.ts";
import {
  decodeJson,
  encodeJson,
  type AppDatabase,
} from "../platform/database.ts";

export const MAX_PROJECT_FILE_DRAFT_BYTES = 200_000;

export type ProjectFileDraftStatus = "active" | "applied" | "rolled_back";

export type ProjectFileDraftRecord = {
  id: string;
  assignmentId: string;
  runId?: string;
  path: string;
  contentType: string;
  content: string;
  sizeBytes: number;
  sha256: string;
  metadata: JsonValue;
  status: ProjectFileDraftStatus;
  appliedMutationId?: string;
  appliedAt?: string;
  appliedSha256?: string;
  createdAt: string;
  updatedAt: string;
  rolledBackAt?: string;
};

export type ProjectFileDraftCreateInput = {
  assignmentId: string;
  runId?: string;
  path: string;
  content: string;
  contentType?: string;
  metadata?: JsonValue;
};

export type ProjectFileDraftSummary = Omit<
  ProjectFileDraftRecord,
  "content" | "metadata" | "createdAt" | "updatedAt" | "rolledBackAt"
>;

type ProjectFileDraftRow = {
  id: string;
  assignment_id: string;
  run_id: string | null;
  path: string;
  content_type: string;
  content: string;
  size_bytes: number;
  sha256: string;
  metadata_json: string;
  status: ProjectFileDraftStatus;
  applied_mutation_id: string | null;
  applied_at: string | null;
  applied_sha256: string | null;
  created_at: string;
  updated_at: string;
  rolled_back_at: string | null;
};

export class ProjectFileDraftStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  create(input: ProjectFileDraftCreateInput): ProjectFileDraftRecord {
    const normalized = normalizeProjectFileDraft(input);
    const now = new Date().toISOString();
    const record: ProjectFileDraftRecord = {
      id: createId("pfd"),
      assignmentId: input.assignmentId,
      runId: input.runId,
      path: normalized.path,
      contentType: normalized.contentType,
      content: normalized.content,
      sizeBytes: normalized.sizeBytes,
      sha256: normalized.sha256,
      metadata: input.metadata ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.database.run(
      `
        INSERT INTO project_file_drafts (
          id, assignment_id, run_id, path, content_type, content, size_bytes,
          sha256, metadata_json, status, created_at, updated_at, rolled_back_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.id,
      record.assignmentId,
      record.runId ?? null,
      record.path,
      record.contentType,
      record.content,
      record.sizeBytes,
      record.sha256,
      encodeJson(record.metadata),
      record.status,
      record.createdAt,
      record.updatedAt,
      null
    );
    return record;
  }

  get(id: string): ProjectFileDraftRecord | undefined {
    const row = this.database.get<ProjectFileDraftRow>(
      "SELECT * FROM project_file_drafts WHERE id = ?",
      id
    );
    return row ? toProjectFileDraftRecord(row) : undefined;
  }

  list(
    input: {
      assignmentId?: string;
      path?: string;
      status?: ProjectFileDraftStatus;
      limit?: number;
    } = {}
  ): ProjectFileDraftRecord[] {
    const filters: string[] = [];
    const values: Array<string | number> = [];
    if (input.assignmentId) {
      filters.push("assignment_id = ?");
      values.push(input.assignmentId);
    }
    if (input.path) {
      filters.push("path = ?");
      values.push(normalizeProjectFilePath(input.path));
    }
    if (input.status) {
      filters.push("status = ?");
      values.push(input.status);
    }
    const limit = Math.min(Math.max(input.limit ?? 250, 1), 500);
    values.push(limit);
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return this.database
      .all<ProjectFileDraftRow>(
        `SELECT * FROM project_file_drafts ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
        ...values
      )
      .map(toProjectFileDraftRecord);
  }

  listActiveSummariesForPath(path: string): ProjectFileDraftSummary[] {
    return this.list({ path, status: "active" }).map(projectFileDraftSummary);
  }

  markRolledBack(id: string): ProjectFileDraftRecord {
    const current = this.get(id);
    if (!current) {
      throw new Error("Project file draft not found");
    }
    if (current.status === "rolled_back") {
      return current;
    }
    if (current.status === "applied") {
      throw new Error(
        "Applied project file draft cannot be rolled back before its apply mutation is rolled back"
      );
    }
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE project_file_drafts
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
  ): ProjectFileDraftRecord {
    const current = this.get(id);
    if (!current) {
      throw new Error("Project file draft not found");
    }
    if (current.status !== "active") {
      throw new Error("Project file draft is not active");
    }
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE project_file_drafts
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

  markActiveAfterApplyRollback(id: string): ProjectFileDraftRecord {
    const current = this.get(id);
    if (!current) {
      throw new Error("Project file draft not found");
    }
    if (current.status === "active") {
      return current;
    }
    if (current.status === "rolled_back") {
      throw new Error("Rolled back project file draft cannot be reactivated");
    }
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE project_file_drafts
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

export function projectFileDraftSummary(
  draft: ProjectFileDraftRecord
): ProjectFileDraftSummary {
  return {
    id: draft.id,
    assignmentId: draft.assignmentId,
    runId: draft.runId,
    path: draft.path,
    contentType: draft.contentType,
    sizeBytes: draft.sizeBytes,
    sha256: draft.sha256,
    status: draft.status,
    ...(draft.appliedMutationId
      ? { appliedMutationId: draft.appliedMutationId }
      : {}),
    ...(draft.appliedAt ? { appliedAt: draft.appliedAt } : {}),
    ...(draft.appliedSha256 ? { appliedSha256: draft.appliedSha256 } : {}),
  };
}

export function normalizeProjectFileDraft(input: ProjectFileDraftCreateInput): {
  path: string;
  content: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
} {
  const path = normalizeProjectFilePath(input.path);
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw new Error("projectFileDraft.content must be a non-empty string");
  }
  const content = input.content.replace(/\u0000/g, "");
  if (content.trim().length === 0) {
    throw new Error("projectFileDraft.content must be a non-empty string");
  }
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > MAX_PROJECT_FILE_DRAFT_BYTES) {
    throw new Error(
      `projectFileDraft.content exceeds ${MAX_PROJECT_FILE_DRAFT_BYTES} bytes`
    );
  }
  const contentType = (input.contentType ?? "text/plain").trim().toLowerCase();
  if (!isSafeTextContentType(contentType)) {
    throw new Error(
      "projectFileDraft.contentType must be a safe text content type"
    );
  }
  return {
    path,
    content,
    contentType,
    sizeBytes,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export function normalizeProjectFilePath(path: string): string {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error("projectFileDraft.path must be a non-empty string");
  }
  const trimmed = path.trim();
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error("projectFileDraft.path must be relative");
  }
  if (trimmed.includes("\\") || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(
      "projectFileDraft.path must use clean forward-slash path segments"
    );
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === ".")) {
    throw new Error(
      "projectFileDraft.path must use clean forward-slash path segments"
    );
  }
  if (segments.includes("..")) {
    throw new Error("projectFileDraft.path cannot contain .. segments");
  }
  if (isProtectedProjectPath(segments)) {
    throw new Error(
      "projectFileDraft.path cannot target protected project location"
    );
  }
  return segments.join("/");
}

function isProtectedProjectPath(segments: string[]): boolean {
  const first = segments[0] ?? "";
  if (
    first === ".git" ||
    first === "node_modules" ||
    first === "dist" ||
    first === "coverage"
  ) {
    return true;
  }
  return segments.some(
    (segment) => segment === ".git" || segment.startsWith(".")
  );
}

function toProjectFileDraftRecord(
  row: ProjectFileDraftRow
): ProjectFileDraftRecord {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    runId: row.run_id ?? undefined,
    path: row.path,
    contentType: row.content_type,
    content: row.content,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
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
