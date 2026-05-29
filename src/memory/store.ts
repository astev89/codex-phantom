import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../platform/database.ts";
import { encodeJson } from "../platform/database.ts";
import { createId } from "../shared/ids.ts";
import type {
  MemoryCategory,
  MemoryContextEnvelope,
  MemoryEntry,
} from "../shared/types.ts";
import type { EmbeddingService } from "./embedding.ts";
import { MemoryLifecycleService } from "./lifecycle.ts";
import {
  dedupeStrings,
  MEMORY_ROW_COLUMNS,
  type MemoryRow,
  normalizeText,
  toMemoryEntry,
  trimLine,
  vectorPointForRow,
} from "./records.ts";
import { buildMemoryRetrievalContext } from "./retrieval-policy.ts";
import type {
  MemoryInsightSet,
  MemoryMaintenanceOutcome,
  MemoryStatus,
  MemoryTurnRecord,
  StoreMemoryEntryInput,
  VectorPoint,
  VectorStore,
} from "./types.ts";
import { QdrantVectorStore, SQLiteVectorStore } from "./vector-store.ts";

export class MemoryStore {
  private readonly database: AppDatabase;
  private readonly config: AppConfig;
  private readonly embeddings: EmbeddingService;
  private readonly primaryVectorStore: VectorStore;
  private readonly fallbackVectorStore: VectorStore;
  private readonly lifecycle: MemoryLifecycleService;

  constructor(
    database: AppDatabase,
    config: AppConfig,
    embeddings: EmbeddingService,
    primaryVectorStore?: VectorStore,
    fallbackVectorStore?: VectorStore
  ) {
    this.database = database;
    this.config = config;
    this.embeddings = embeddings;
    this.primaryVectorStore =
      primaryVectorStore ?? new QdrantVectorStore(config);
    this.fallbackVectorStore =
      fallbackVectorStore ?? new SQLiteVectorStore(database);
    this.lifecycle = new MemoryLifecycleService({
      database,
      config,
      primaryVectorStore: this.primaryVectorStore,
      embeddingModel: embeddings.model,
      embedOrNull: (texts) => this.embedOrNull(texts),
      upsertToVectorBackend: (points) => this.upsertToVectorBackend(points),
    });
  }

  async query(input: string): Promise<MemoryContextEnvelope> {
    const queryEmbedding = (await this.embedOrNull([input]))?.[0] ?? null;
    const activeVectorStore =
      queryEmbedding && this.primaryVectorStore.isAvailable()
        ? this.primaryVectorStore
        : this.fallbackVectorStore;

    const results = queryEmbedding
      ? await activeVectorStore.search(queryEmbedding, this.config.memoryTopK)
      : [];

    const ids = results.map((result) => result.id);
    const rows =
      ids.length > 0
        ? this.database.all<MemoryRow>(
            `
            SELECT ${MEMORY_ROW_COLUMNS}
            FROM memory_entries
            WHERE id IN (${ids.map(() => "?").join(",")})
          `,
            ...ids
          )
        : this.database.all<MemoryRow>(
            `
            SELECT ${MEMORY_ROW_COLUMNS}
            FROM memory_entries
            ORDER BY created_at DESC
            LIMIT 240
          `
          );

    const retrieval = buildMemoryRetrievalContext({
      rows,
      queryText: input,
      queryEmbedding,
      vectorScores: new Map(results.map((item) => [item.id, item.score])),
      memorySummaryLimit: this.config.memorySummaryLimit,
      memoryPerCategoryLimit: this.config.memoryPerCategoryLimit,
    });
    this.lifecycle.persistDecayScores(retrieval.decayUpdates);
    this.lifecycle.markAccessed(retrieval.returnedEntries);

    return retrieval.envelope;
  }

  async recordTurn(record: MemoryTurnRecord): Promise<void> {
    await this.storeEntries([
      {
        category: "episodic",
        content: trimLine(
          `User: ${record.userInput}\nAssistant: ${record.assistantOutput}`
        ),
        sourceType: "raw_turn",
        importance: 0.55,
        sourceSessionId: record.sessionId,
        sourceRunId: record.runId,
        sourceUserInput: record.userInput,
        sourceAssistantOutput: record.assistantOutput,
      },
    ]);
  }

  async consolidate(
    record: MemoryTurnRecord,
    generateInsights: (record: MemoryTurnRecord) => Promise<MemoryInsightSet>
  ): Promise<void> {
    const insights = await generateInsights(record);
    const entries: StoreMemoryEntryInput[] = [];

    for (const fact of dedupeStrings(insights.semanticFacts)) {
      if (!fact.trim()) {
        continue;
      }
      if (!(await this.hasSimilarMemory("semantic", fact))) {
        entries.push({
          category: "semantic",
          content: trimLine(fact),
          sourceType: "semantic_fact",
          importance: 0.72,
          isFact: true,
          sourceSessionId: record.sessionId,
          sourceRunId: record.runId,
          sourceUserInput: record.userInput,
          sourceAssistantOutput: record.assistantOutput,
        });
      }
    }

    for (const note of dedupeStrings(insights.proceduralNotes)) {
      if (!note.trim()) {
        continue;
      }
      if (!(await this.hasSimilarMemory("procedural", note))) {
        entries.push({
          category: "procedural",
          content: trimLine(note),
          sourceType: "procedural_note",
          importance: 0.84,
          isFact: true,
          sourceSessionId: record.sessionId,
          sourceRunId: record.runId,
          sourceUserInput: record.userInput,
          sourceAssistantOutput: record.assistantOutput,
        });
      }
    }

    if (entries.length > 0) {
      await this.storeEntries(entries);
    }

    await this.lifecycle.compactEpisodicMemories(record, insights.summary);
    await this.lifecycle.pruneByCategory("semantic", 80);
    await this.lifecycle.pruneByCategory("procedural", 60);
    await this.lifecycle.pruneByCategory("episodic", 120);
  }

  async runMaintenance(): Promise<MemoryMaintenanceOutcome> {
    const summary = await this.lifecycle.compactEpisodicMemories();
    const prunedIds = [
      ...(await this.lifecycle.pruneByCategory("semantic", 80)),
      ...(await this.lifecycle.pruneByCategory("procedural", 60)),
      ...(await this.lifecycle.pruneByCategory("episodic", 120)),
    ];

    return {
      summarizedCount: summary?.sourceMemoryIds.length ?? 0,
      promotedCount: summary ? 1 : 0,
      prunedCount: prunedIds.length,
      summaryMemoryIds: summary ? [summary.summaryMemoryId] : [],
      promotedMemoryIds: summary ? [summary.summaryMemoryId] : [],
      prunedMemoryIds: prunedIds,
    };
  }

  async backfillEmbeddings(): Promise<void> {
    const rows = this.database.all<Pick<MemoryRow, "id" | "content">>(
      `
        SELECT id, content
        FROM memory_entries
        WHERE embedding_json IS NULL OR embedding_json = ''
        ORDER BY created_at ASC
      `
    );

    for (
      let index = 0;
      index < rows.length;
      index += this.config.memoryEmbeddingBatchSize
    ) {
      const batch = rows.slice(
        index,
        index + this.config.memoryEmbeddingBatchSize
      );
      const vectors = await this.embedOrNull(batch.map((row) => row.content));
      this.database.transaction(() => {
        batch.forEach((row, batchIndex) => {
          const vector = vectors?.[batchIndex] ?? null;
          this.database.run(
            "UPDATE memory_entries SET embedding_json = ?, embedding_model = ? WHERE id = ?",
            vector ? encodeJson(vector) : null,
            vector ? this.embeddings.model : null,
            row.id
          );
        });
      });
    }
  }

  async initializeVectorStore(): Promise<void> {
    await this.primaryVectorStore.initialize(1536);
  }

  async backfillVectors(): Promise<void> {
    const rows = this.database.all<MemoryRow>(
      `
        SELECT ${MEMORY_ROW_COLUMNS}
        FROM memory_entries
        WHERE embedding_json IS NOT NULL
          AND (
            vector_backend IS NULL OR
            vector_backend != 'qdrant' OR
            vector_synced_at IS NULL
          )
        ORDER BY created_at ASC
      `
    );
    if (rows.length === 0) {
      return;
    }
    if (!this.primaryVectorStore.isAvailable()) {
      return;
    }
    await this.syncRowsToPrimary(rows);
  }

  getStatus(): MemoryStatus {
    const pendingBackfill =
      this.database.get<{ count: number }>(
        `
        SELECT COUNT(*) AS count
        FROM memory_entries
        WHERE embedding_json IS NULL OR embedding_json = ''
      `
      )?.count ?? 0;
    const pendingVectorSyncCount =
      this.database.get<{ count: number }>(
        `
        SELECT COUNT(*) AS count
        FROM memory_entries
        WHERE embedding_json IS NOT NULL
          AND (
            vector_backend IS NULL OR
            vector_backend != 'qdrant' OR
            vector_synced_at IS NULL
          )
      `
      )?.count ?? 0;

    return {
      semanticRetrievalEnabled: this.embeddings.enabled,
      embeddingModel: this.embeddings.model,
      pendingBackfillCount: pendingBackfill,
      pendingVectorSyncCount,
      vectorBackend: this.primaryVectorStore.isAvailable()
        ? "qdrant"
        : "sqlite_fallback",
      qdrantConfigured: this.primaryVectorStore.isConfigured(),
      qdrantReachable: this.primaryVectorStore.isAvailable(),
    };
  }

  async listEntries(limit = 50): Promise<MemoryEntry[]> {
    const normalizedLimit = Math.max(1, Math.min(limit, 200));
    return this.database
      .all<MemoryRow>(
        `
          SELECT
            ${MEMORY_ROW_COLUMNS}
          FROM memory_entries
          ORDER BY created_at DESC
          LIMIT ?
        `,
        normalizedLimit
      )
      .map((row) => toMemoryEntry({ row, score: row.importance }));
  }

  async getEntry(entryId: string): Promise<MemoryEntry | null> {
    const row = this.database.get<MemoryRow>(
      `
        SELECT
          ${MEMORY_ROW_COLUMNS}
        FROM memory_entries
        WHERE id = ?
      `,
      entryId
    );
    if (!row) {
      return null;
    }
    return {
      ...toMemoryEntry({ row, score: row.importance }),
      lifecycleLinks: this.lifecycle.listLifecycleLinks(entryId),
    };
  }

  async storeEntry(input: StoreMemoryEntryInput): Promise<MemoryEntry> {
    const [entry] = await this.storeEntries([input]);
    if (!entry) {
      throw new Error("Failed to store memory entry");
    }
    return entry;
  }

  reinforceEntry(
    memoryId: string,
    options: { weight?: number; signal?: string; reason?: string } = {}
  ): void {
    this.lifecycle.reinforceEntry(memoryId, options);
  }

  private async storeEntries(
    entries: StoreMemoryEntryInput[]
  ): Promise<MemoryEntry[]> {
    if (entries.length === 0) {
      return [];
    }

    const embeddings = await this.embedOrNull(
      entries.map((entry) => entry.content)
    );
    const now = new Date().toISOString();
    const insertedRows: MemoryRow[] = [];

    this.database.transaction(() => {
      entries.forEach((entry, index) => {
        const id = createId("mem");
        const vector = embeddings?.[index] ?? null;
        const row: MemoryRow = {
          id,
          category: entry.category,
          content: entry.content,
          created_at: now,
          source_type: entry.sourceType,
          importance: entry.importance,
          reinforcement_score: 0,
          decay_score: 0,
          last_accessed_at: null,
          access_count: 0,
          is_summary: entry.isSummary ? 1 : 0,
          is_fact: entry.isFact ? 1 : 0,
          parent_summary_id: entry.parentSummaryId ?? null,
          embedding_model: vector ? this.embeddings.model : null,
          embedding_json: vector ? encodeJson(vector) : null,
          source_session_id: entry.sourceSessionId ?? null,
          source_run_id: entry.sourceRunId ?? null,
          lifecycle_state: "active",
          superseded_by_memory_id: null,
          contradicted_by_memory_id: null,
          vector_backend:
            vector && this.primaryVectorStore.isAvailable()
              ? "qdrant"
              : "sqlite_fallback",
          vector_synced_at: null,
          vector_sync_error: null,
          vector_point_id: id,
        };
        insertedRows.push(row);
        this.database.run(
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
          row.id,
          row.category,
          row.content,
          row.created_at,
          entry.sourceUserInput ?? null,
          entry.sourceAssistantOutput ?? null,
          0,
          row.embedding_json,
          row.embedding_model,
          row.source_type,
          row.importance,
          null,
          0,
          row.is_summary,
          row.is_fact,
          row.parent_summary_id,
          row.source_session_id,
          row.source_run_id,
          row.vector_backend,
          null,
          null,
          row.vector_point_id,
          row.lifecycle_state ?? "active",
          row.superseded_by_memory_id ?? null,
          row.contradicted_by_memory_id ?? null,
          row.reinforcement_score ?? 0,
          row.decay_score ?? 0
        );
        this.lifecycle.recordLifecycleLinks(row, entry, now);
      });
    });

    const points = insertedRows
      .map(vectorPointForRow)
      .filter((point) => point !== undefined);
    if (points.length > 0) {
      await this.upsertToVectorBackend(points);
    }
    return insertedRows.map((row) =>
      toMemoryEntry({ row, score: row.importance })
    );
  }

  private async upsertToVectorBackend(points: VectorPoint[]): Promise<void> {
    if (points.length === 0 || !this.primaryVectorStore.isAvailable()) {
      return;
    }

    try {
      await this.primaryVectorStore.upsert(points);
      const now = new Date().toISOString();
      this.database.transaction(() => {
        for (const point of points) {
          this.database.run(
            `
              UPDATE memory_entries
              SET vector_backend = 'qdrant',
                  vector_synced_at = ?,
                  vector_sync_error = NULL,
                  vector_point_id = ?
              WHERE id = ?
            `,
            now,
            point.id,
            point.id
          );
        }
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Vector sync failed";
      this.database.transaction(() => {
        for (const point of points) {
          this.database.run(
            `
              UPDATE memory_entries
              SET vector_backend = 'sqlite_fallback',
                  vector_synced_at = NULL,
                  vector_sync_error = ?,
                  vector_point_id = ?
              WHERE id = ?
            `,
            message,
            point.id,
            point.id
          );
        }
      });
    }
  }

  private async syncRowsToPrimary(rows: MemoryRow[]): Promise<void> {
    const points = rows
      .map(vectorPointForRow)
      .filter((point) => point !== undefined);
    await this.upsertToVectorBackend(points);
  }

  private async hasSimilarMemory(
    category: MemoryCategory,
    content: string
  ): Promise<boolean> {
    const normalized = normalizeText(content);
    const rows = this.database.all<Pick<MemoryRow, "content">>(
      "SELECT content FROM memory_entries WHERE category = ? AND COALESCE(lifecycle_state, 'active') = 'active' ORDER BY created_at DESC LIMIT 25",
      category
    );
    return rows.some((row) => normalizeText(row.content) === normalized);
  }

  private async embedOrNull(texts: string[]): Promise<number[][] | null> {
    if (!this.embeddings.enabled || texts.length === 0) {
      return null;
    }

    try {
      return await this.embeddings.embed(texts);
    } catch {
      return null;
    }
  }
}
