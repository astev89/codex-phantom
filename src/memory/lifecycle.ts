import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../platform/database.ts";
import { encodeJson } from "../platform/database.ts";
import { createId } from "../shared/ids.ts";
import type {
  MemoryCategory,
  MemoryEntry,
  MemoryLifecycleLink,
} from "../shared/types.ts";
import type {
  MemoryTurnRecord,
  StoreMemoryEntryInput,
  VectorPoint,
  VectorStore,
} from "./types.ts";
import {
  buildVectorPayload,
  MEMORY_ROW_COLUMNS,
  type MemoryLifecycleLinkRow,
  type MemoryRow,
  trimLine,
} from "./records.ts";

export class MemoryLifecycleService {
  private readonly database: AppDatabase;
  private readonly config: AppConfig;
  private readonly primaryVectorStore: VectorStore;
  private readonly embeddingModel: string;
  private readonly embedOrNull: (texts: string[]) => Promise<number[][] | null>;
  private readonly upsertToVectorBackend: (
    points: VectorPoint[]
  ) => Promise<void>;

  constructor(input: {
    database: AppDatabase;
    config: AppConfig;
    primaryVectorStore: VectorStore;
    embeddingModel: string;
    embedOrNull: (texts: string[]) => Promise<number[][] | null>;
    upsertToVectorBackend: (points: VectorPoint[]) => Promise<void>;
  }) {
    this.database = input.database;
    this.config = input.config;
    this.primaryVectorStore = input.primaryVectorStore;
    this.embeddingModel = input.embeddingModel;
    this.embedOrNull = input.embedOrNull;
    this.upsertToVectorBackend = input.upsertToVectorBackend;
  }

  recordLifecycleLinks(
    row: MemoryRow,
    entry: StoreMemoryEntryInput,
    now: string
  ): void {
    for (const targetId of entry.supersedesMemoryIds ?? []) {
      this.database.run(
        `
          INSERT INTO memory_lifecycle_links (
            id, source_memory_id, target_memory_id, relationship, reason,
            source_session_id, source_run_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        createId("memlink"),
        row.id,
        targetId,
        "supersedes",
        entry.lifecycleReason ?? null,
        row.source_session_id,
        row.source_run_id,
        now
      );
      this.database.run(
        "UPDATE memory_entries SET lifecycle_state = 'superseded', superseded_by_memory_id = ? WHERE id = ?",
        row.id,
        targetId
      );
    }
    for (const targetId of entry.contradictsMemoryIds ?? []) {
      this.database.run(
        `
          INSERT INTO memory_lifecycle_links (
            id, source_memory_id, target_memory_id, relationship, reason,
            source_session_id, source_run_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        createId("memlink"),
        row.id,
        targetId,
        "contradicts",
        entry.lifecycleReason ?? null,
        row.source_session_id,
        row.source_run_id,
        now
      );
      this.database.run(
        "UPDATE memory_entries SET lifecycle_state = 'contradicted', contradicted_by_memory_id = ? WHERE id = ?",
        row.id,
        targetId
      );
    }
  }

  listLifecycleLinks(memoryId: string): MemoryLifecycleLink[] {
    return this.database
      .all<MemoryLifecycleLinkRow>(
        `
        SELECT
          id, source_memory_id, target_memory_id, relationship, reason,
          source_session_id, source_run_id, created_at
        FROM memory_lifecycle_links
        WHERE source_memory_id = ? OR target_memory_id = ?
        ORDER BY created_at DESC
      `,
        memoryId,
        memoryId
      )
      .map((row) => ({
        id: row.id,
        sourceMemoryId: row.source_memory_id,
        targetMemoryId: row.target_memory_id,
        relationship: row.relationship,
        reason: row.reason ?? undefined,
        sourceSessionId: row.source_session_id ?? undefined,
        sourceRunId: row.source_run_id ?? undefined,
        createdAt: row.created_at,
      }));
  }

  reinforceEntry(
    memoryId: string,
    options: { weight?: number; signal?: string; reason?: string } = {}
  ): void {
    const existing = this.database.get<{ id: string }>(
      `
        SELECT id
        FROM memory_entries
        WHERE id = ?
          AND COALESCE(lifecycle_state, 'active') = 'active'
      `,
      memoryId
    );
    if (!existing) {
      return;
    }
    const weight = Math.min(1, Math.max(-1, options.weight ?? 0.25));
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE memory_entries
        SET reinforcement_score = MIN(3, MAX(-1, COALESCE(reinforcement_score, 0) + ?))
        WHERE id = ?
          AND COALESCE(lifecycle_state, 'active') = 'active'
      `,
      weight,
      memoryId
    );
    this.database.run(
      `
        INSERT INTO memory_reinforcement_events (
          id, memory_id, signal, weight, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      createId("memsig"),
      memoryId,
      options.signal ?? "operator",
      weight,
      options.reason ?? null,
      now
    );
  }

  async compactEpisodicMemories(
    record?: MemoryTurnRecord,
    summaryHint?: string
  ): Promise<{ summaryMemoryId: string; sourceMemoryIds: string[] } | null> {
    const recentRaw = this.database.all<MemoryRow>(
      `
        SELECT ${MEMORY_ROW_COLUMNS}
        FROM memory_entries
        WHERE category = 'episodic' AND is_summary = 0 AND parent_summary_id IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `,
      this.config.memorySummaryTriggerCount
    );

    if (recentRaw.length < this.config.memorySummaryTriggerCount) {
      return null;
    }

    const cluster = [...recentRaw]
      .sort(
        (left, right) =>
          Date.parse(left.created_at) - Date.parse(right.created_at)
      )
      .slice(0, this.config.memorySummaryClusterSize);
    const summaryContent = trimLine(
      summaryHint && summaryHint.trim() !== ""
        ? summaryHint
        : `Summary: ${cluster.map((row) => row.content).join(" | ")}`
    );
    const summaryId = createId("mem");
    const vector = (await this.embedOrNull([summaryContent]))?.[0] ?? null;
    const now = new Date().toISOString();

    this.database.transaction(() => {
      this.database.run(
        `
          INSERT INTO memory_entries (
            id, category, content, created_at, source_user_input, source_assistant_output, score,
            embedding_json, embedding_model, source_type, importance, last_accessed_at, access_count,
            is_summary, is_fact, parent_summary_id, source_session_id, source_run_id,
            vector_backend, vector_synced_at, vector_sync_error, vector_point_id,
            reinforcement_score, decay_score
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        summaryId,
        "episodic",
        summaryContent,
        now,
        record?.userInput ?? null,
        record?.assistantOutput ?? null,
        0,
        vector ? encodeJson(vector) : null,
        vector ? this.embeddingModel : null,
        "summary",
        0.88,
        null,
        0,
        1,
        0,
        null,
        record?.sessionId ?? null,
        record?.runId ?? null,
        vector && this.primaryVectorStore.isAvailable()
          ? "qdrant"
          : "sqlite_fallback",
        vector && this.primaryVectorStore.isAvailable() ? now : null,
        null,
        summaryId,
        0,
        0
      );

      for (const row of cluster) {
        this.database.run(
          "UPDATE memory_entries SET parent_summary_id = ? WHERE id = ?",
          summaryId,
          row.id
        );
      }
    });

    if (vector) {
      await this.upsertToVectorBackend([
        {
          id: summaryId,
          vector,
          payload: buildVectorPayload({
            category: "episodic",
            created_at: now,
            source_type: "summary",
            importance: 0.88,
            is_summary: 1,
            is_fact: 0,
            source_session_id: record?.sessionId ?? null,
            source_run_id: record?.runId ?? null,
          }),
        },
      ]);
    }
    return {
      summaryMemoryId: summaryId,
      sourceMemoryIds: cluster.map((row) => row.id),
    };
  }

  async pruneByCategory(
    category: MemoryCategory,
    keepCount: number
  ): Promise<string[]> {
    const surplus = this.database.all<{ id: string }>(
      `
        SELECT id
        FROM memory_entries
        WHERE category = ?
          AND COALESCE(lifecycle_state, 'active') = 'active'
        ORDER BY importance DESC, created_at DESC
        LIMIT -1 OFFSET ?
      `,
      category,
      keepCount
    );
    if (surplus.length === 0) {
      return [];
    }
    const ids = surplus.map((row) => row.id);
    this.database.transaction(() => {
      for (const row of surplus) {
        this.database.run("DELETE FROM memory_entries WHERE id = ?", row.id);
      }
    });
    await this.primaryVectorStore.delete(ids);
    return ids;
  }

  markAccessed(entries: MemoryEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    const now = new Date().toISOString();
    this.database.transaction(() => {
      for (const entry of entries) {
        this.database.run(
          `
            UPDATE memory_entries
            SET last_accessed_at = ?,
                access_count = access_count + 1,
                reinforcement_score = MIN(3, COALESCE(reinforcement_score, 0) + 0.05)
            WHERE id = ?
              AND COALESCE(lifecycle_state, 'active') = 'active'
          `,
          now,
          entry.id
        );
        this.database.run(
          `
            INSERT INTO memory_reinforcement_events (
              id, memory_id, signal, weight, reason, created_at
            )
            SELECT ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM memory_entries
              WHERE id = ? AND COALESCE(lifecycle_state, 'active') = 'active'
            )
          `,
          createId("memsig"),
          entry.id,
          "retrieval",
          0.05,
          "Returned in memory context",
          now,
          entry.id
        );
      }
    });
  }

  persistDecayScores(updates: Array<{ id: string; decayScore: number }>): void {
    if (updates.length === 0) {
      return;
    }
    this.database.transaction(() => {
      for (const update of updates) {
        this.database.run(
          "UPDATE memory_entries SET decay_score = ? WHERE id = ?",
          update.decayScore,
          update.id
        );
      }
    });
  }
}
