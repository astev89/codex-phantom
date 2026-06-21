import { createId } from "../../shared/ids.ts";
import type { AppDatabase } from "../../platform/database.ts";
import type {
  JsonValue,
  MemoryCategory,
  MemorySourceType,
} from "../../shared/types.ts";
import { MEMORY_ROW_COLUMNS, type MemoryRow } from "../../memory/records.ts";
import { asJsonObject, requiredString } from "./common.ts";
import type { AutonomousMutationAdapter } from "./types.ts";

export const MEMORY_ENTRY_LIFECYCLE_MUTATION_CLASS = "memory.entry_lifecycle";

const MAX_MEMORY_CONTENT_CHARS = 2000;
const MAX_MEMORY_REASON_CHARS = 500;
const MEMORY_CATEGORIES = new Set<MemoryCategory>([
  "episodic",
  "semantic",
  "procedural",
]);

export function createMemoryEntryLifecycleAutonomousMutationAdapter(
  database: AppDatabase
): AutonomousMutationAdapter {
  return {
    target: "memory",
    mutationType: "entry_lifecycle",
    mutationClass: MEMORY_ENTRY_LIFECYCLE_MUTATION_CLASS,
    affectedResources: [],
    minimumRiskClass: "high",
    rollbackConflictScope: "affected_resources",
    apply(input) {
      const proposedChange = asJsonObject(
        input.proposedChange,
        "proposedChange"
      );
      const memoryEntry = asJsonObject(
        proposedChange.memoryEntry,
        "proposedChange.memoryEntry"
      );
      const action = normalizeMemoryLifecycleAction(memoryEntry.action);
      if (action === "create") {
        const entry = insertMemoryEntry(database, {
          category: normalizeMemoryCategory(memoryEntry.category),
          content: normalizeMemoryContent(memoryEntry.content),
          importance: normalizeMemoryImportance(memoryEntry.importance),
          runId: input.request.runId,
        });
        return {
          before: { entry: null } as JsonValue,
          after: { entry: memoryEntryEvidence(entry) } as JsonValue,
          rollback: {
            memoryEntry: { action: "delete_created", memoryId: entry.id },
          } as JsonValue,
          affectedResources: [{ type: "memory", id: entry.id }] as JsonValue,
          verificationMethod: "memory_entry_lifecycle_update",
        };
      }

      const memoryId = requiredString(
        memoryEntry.memoryId,
        "memoryEntry.memoryId"
      );
      const before = getRequiredMemoryEntry(database, memoryId);
      assertActiveMemoryEntry(before);

      if (action === "deactivate") {
        const reason = optionalMemoryReason(memoryEntry.reason);
        database.run(
          `
            UPDATE memory_entries
            SET lifecycle_state = 'deactivated',
                superseded_by_memory_id = NULL,
                contradicted_by_memory_id = NULL
            WHERE id = ?
          `,
          before.id
        );
        const after = getRequiredMemoryEntry(database, before.id);
        return {
          before: { entry: memoryEntryEvidence(before) } as JsonValue,
          after: { entry: memoryEntryEvidence(after), reason } as JsonValue,
          rollback: {
            memoryEntry: {
              action: "restore_lifecycle",
              memoryId: before.id,
              lifecycleLinkIds: lifecycleLinkIdsForMemory(database, before.id),
              lifecycle: lifecycleEvidence(before),
            },
          } as JsonValue,
          affectedResources: [{ type: "memory", id: before.id }] as JsonValue,
          verificationMethod: "memory_entry_lifecycle_update",
        };
      }

      const replacement = insertMemoryEntry(database, {
        category: normalizeMemoryCategory(memoryEntry.category),
        content: normalizeMemoryContent(memoryEntry.content),
        importance: normalizeMemoryImportance(memoryEntry.importance),
        runId: input.request.runId,
      });
      const reason = optionalMemoryReason(memoryEntry.reason);
      const lifecycleLinkId = createId("memlink");
      database.transaction(() => {
        database.run(
          `
            INSERT INTO memory_lifecycle_links (
              id, source_memory_id, target_memory_id, relationship, reason,
              source_session_id, source_run_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
          lifecycleLinkId,
          replacement.id,
          before.id,
          "supersedes",
          reason ?? null,
          null,
          input.request.runId ?? null,
          replacement.created_at
        );
        database.run(
          `
            UPDATE memory_entries
            SET lifecycle_state = 'superseded',
                superseded_by_memory_id = ?,
                contradicted_by_memory_id = NULL
            WHERE id = ?
          `,
          replacement.id,
          before.id
        );
      });
      const afterTarget = getRequiredMemoryEntry(database, before.id);
      return {
        before: { target: memoryEntryEvidence(before) } as JsonValue,
        after: {
          target: memoryEntryEvidence(afterTarget),
          entry: memoryEntryEvidence(replacement),
        } as JsonValue,
        rollback: {
          memoryEntry: {
            action: "delete_created_and_restore",
            createdMemoryId: replacement.id,
            targetMemoryId: before.id,
            lifecycleLinkIds: [lifecycleLinkId],
            targetLifecycleLinkIds: lifecycleLinkIdsForMemory(
              database,
              before.id
            ),
            lifecycle: lifecycleEvidence(before),
          },
        } as JsonValue,
        affectedResources: [
          { type: "memory", id: before.id },
          { type: "memory", id: replacement.id },
        ] as JsonValue,
        verificationMethod: "memory_entry_lifecycle_update",
      };
    },
    rollback(input) {
      const rollback = asJsonObject(input.rollback, "rollback");
      const memoryEntry = asJsonObject(
        rollback.memoryEntry,
        "rollback.memoryEntry"
      );
      const action = normalizeMemoryLifecycleRollbackAction(memoryEntry.action);
      if (action === "delete_created") {
        deleteMemoryEntry(
          database,
          requiredString(memoryEntry.memoryId, "memoryEntry.memoryId"),
          normalizeLifecycleLinkIds(memoryEntry.lifecycleLinkIds)
        );
      } else if (action === "restore_lifecycle") {
        restoreMemoryLifecycle(
          database,
          requiredString(memoryEntry.memoryId, "memoryEntry.memoryId"),
          asJsonObject(memoryEntry.lifecycle, "memoryEntry.lifecycle"),
          normalizeLifecycleLinkIds(memoryEntry.lifecycleLinkIds)
        );
      } else {
        const createdMemoryId = requiredString(
          memoryEntry.createdMemoryId,
          "memoryEntry.createdMemoryId"
        );
        const targetMemoryId = requiredString(
          memoryEntry.targetMemoryId,
          "memoryEntry.targetMemoryId"
        );
        assertNoExternalLifecycleLinks(database, targetMemoryId, [
          ...normalizeLifecycleLinkIds(memoryEntry.targetLifecycleLinkIds),
          ...normalizeLifecycleLinkIds(memoryEntry.lifecycleLinkIds),
        ]);
        database.transaction(() => {
          deleteMemoryEntry(
            database,
            createdMemoryId,
            normalizeLifecycleLinkIds(memoryEntry.lifecycleLinkIds)
          );
          restoreMemoryLifecycle(
            database,
            targetMemoryId,
            asJsonObject(memoryEntry.lifecycle, "memoryEntry.lifecycle"),
            normalizeLifecycleLinkIds(memoryEntry.targetLifecycleLinkIds)
          );
        });
      }
      return { verificationMethod: "memory_entry_lifecycle_rollback" };
    },
  };
}

type MemoryLifecycleAction = "create" | "deactivate" | "supersede";
type MemoryLifecycleRollbackAction =
  | "delete_created"
  | "restore_lifecycle"
  | "delete_created_and_restore";

function normalizeMemoryLifecycleAction(
  value: JsonValue
): MemoryLifecycleAction {
  if (value !== "create" && value !== "deactivate" && value !== "supersede") {
    throw new Error(
      "memoryEntry.action must be create, deactivate, or supersede"
    );
  }
  return value;
}

function normalizeMemoryLifecycleRollbackAction(
  value: JsonValue
): MemoryLifecycleRollbackAction {
  if (
    value !== "delete_created" &&
    value !== "restore_lifecycle" &&
    value !== "delete_created_and_restore"
  ) {
    throw new Error("memoryEntry.action is not a supported rollback action");
  }
  return value;
}

function normalizeMemoryCategory(value: JsonValue): MemoryCategory {
  if (
    typeof value !== "string" ||
    !MEMORY_CATEGORIES.has(value as MemoryCategory)
  ) {
    throw new Error(
      "memoryEntry.category must be episodic, semantic, or procedural"
    );
  }
  return value as MemoryCategory;
}

function normalizeMemoryContent(value: JsonValue): string {
  if (typeof value !== "string") {
    throw new Error("memoryEntry.content must be a string");
  }
  const content = value.trim();
  if (!content) {
    throw new Error("memoryEntry.content must be a non-empty string");
  }
  if (content.length > MAX_MEMORY_CONTENT_CHARS) {
    throw new Error("memoryEntry.content must be 2000 characters or less");
  }
  return content;
}

function normalizeMemoryImportance(value: JsonValue): number {
  if (value === undefined) {
    return 0.7;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error("memoryEntry.importance must be a number between 0 and 1");
  }
  return value;
}

function optionalMemoryReason(value: JsonValue): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("memoryEntry.reason must be a string");
  }
  const reason = value.trim();
  if (reason.length > MAX_MEMORY_REASON_CHARS) {
    throw new Error("memoryEntry.reason must be 500 characters or less");
  }
  return reason || undefined;
}

function normalizeLifecycleLinkIds(value: JsonValue): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("memoryEntry.lifecycleLinkIds must be an array");
  }
  return value.map((item) =>
    requiredString(item, "memoryEntry.lifecycleLinkIds[]")
  );
}

function insertMemoryEntry(
  database: AppDatabase,
  input: {
    category: MemoryCategory;
    content: string;
    importance: number;
    runId?: string;
  }
): MemoryRow {
  const id = createId("mem");
  const now = new Date().toISOString();
  const sourceType = sourceTypeForCategory(input.category);
  database.run(
    `
      INSERT INTO memory_entries (
        id, category, content, created_at, source_user_input, source_assistant_output, score,
        embedding_json, embedding_model, source_type, importance, last_accessed_at, access_count,
        is_summary, is_fact, parent_summary_id, source_session_id, source_run_id,
        vector_backend, vector_synced_at, vector_sync_error, vector_point_id,
        lifecycle_state, superseded_by_memory_id, contradicted_by_memory_id,
        reinforcement_score, decay_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    id,
    input.category,
    input.content,
    now,
    null,
    null,
    0,
    null,
    null,
    sourceType,
    input.importance,
    null,
    0,
    0,
    input.category === "semantic" || input.category === "procedural" ? 1 : 0,
    null,
    null,
    input.runId ?? null,
    "sqlite_fallback",
    null,
    null,
    id,
    "active",
    null,
    null,
    0,
    0
  );
  return getRequiredMemoryEntry(database, id);
}

function sourceTypeForCategory(category: MemoryCategory): MemorySourceType {
  if (category === "episodic") {
    return "raw_turn";
  }
  return category === "semantic" ? "semantic_fact" : "procedural_note";
}

function getRequiredMemoryEntry(
  database: AppDatabase,
  memoryId: string
): MemoryRow {
  const row = database.get<MemoryRow>(
    `
      SELECT ${MEMORY_ROW_COLUMNS}
      FROM memory_entries
      WHERE id = ?
    `,
    memoryId
  );
  if (!row) {
    throw new Error("memoryEntry.memoryId was not found");
  }
  return row;
}

function assertActiveMemoryEntry(row: MemoryRow): void {
  if ((row.lifecycle_state ?? "active") !== "active") {
    throw new Error("memoryEntry.memoryId must reference an active memory entry");
  }
}

function deleteMemoryEntry(
  database: AppDatabase,
  memoryId: string,
  allowedLifecycleLinkIds: string[] = []
): void {
  const links = assertNoExternalLifecycleLinks(
    database,
    memoryId,
    allowedLifecycleLinkIds
  );
  if (links.length > 0) {
    database.run(
      `DELETE FROM memory_lifecycle_links WHERE id IN (${links
        .map(() => "?")
        .join(",")})`,
      ...links.map((link) => link.id)
    );
  }
  database.run(
    "DELETE FROM memory_reinforcement_events WHERE memory_id = ?",
    memoryId
  );
  database.run("DELETE FROM memory_entries WHERE id = ?", memoryId);
}

function restoreMemoryLifecycle(
  database: AppDatabase,
  memoryId: string,
  lifecycle: { [key: string]: JsonValue },
  allowedLifecycleLinkIds: string[] = []
): void {
  assertNoExternalLifecycleLinks(database, memoryId, allowedLifecycleLinkIds);
  database.run(
    `
      UPDATE memory_entries
      SET lifecycle_state = ?,
          superseded_by_memory_id = ?,
          contradicted_by_memory_id = ?
      WHERE id = ?
    `,
    normalizeLifecycleState(lifecycle.lifecycleState),
    optionalString(lifecycle.supersededByMemoryId),
    optionalString(lifecycle.contradictedByMemoryId),
    memoryId
  );
}

function assertNoExternalLifecycleLinks(
  database: AppDatabase,
  memoryId: string,
  allowedLifecycleLinkIds: string[]
): Array<{ id: string }> {
  const links = lifecycleLinksForMemory(database, memoryId);
  const allowed = new Set(allowedLifecycleLinkIds);
  const externalLinks = links.filter((link) => !allowed.has(link.id));
  if (externalLinks.length > 0) {
    throw new Error(
      "Cannot roll back memory entry lifecycle mutation while newer memory lifecycle links exist"
    );
  }
  return links;
}

function lifecycleLinkIdsForMemory(
  database: AppDatabase,
  memoryId: string
): string[] {
  return lifecycleLinksForMemory(database, memoryId).map((link) => link.id);
}

function lifecycleLinksForMemory(
  database: AppDatabase,
  memoryId: string
): Array<{ id: string }> {
  return database.all<{ id: string }>(
    `
      SELECT id
      FROM memory_lifecycle_links
      WHERE source_memory_id = ? OR target_memory_id = ?
    `,
    memoryId,
    memoryId
  );
}

function normalizeLifecycleState(value: JsonValue): string {
  if (
    value !== "active" &&
    value !== "superseded" &&
    value !== "contradicted" &&
    value !== "deactivated"
  ) {
    throw new Error("memoryEntry.lifecycleState is not supported");
  }
  return value;
}

function optionalString(value: JsonValue): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("memoryEntry lifecycle ids must be strings");
  }
  return value;
}

function lifecycleEvidence(row: MemoryRow): JsonValue {
  return {
    lifecycleState: row.lifecycle_state ?? "active",
    supersededByMemoryId: row.superseded_by_memory_id ?? null,
    contradictedByMemoryId: row.contradicted_by_memory_id ?? null,
  };
}

function memoryEntryEvidence(row: MemoryRow): JsonValue {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    sourceType: row.source_type,
    importance: row.importance,
    lifecycleState: row.lifecycle_state ?? "active",
    supersededByMemoryId: row.superseded_by_memory_id ?? null,
    contradictedByMemoryId: row.contradicted_by_memory_id ?? null,
  };
}
