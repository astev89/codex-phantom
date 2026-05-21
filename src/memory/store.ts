import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson } from "../platform/database.ts";
import { createId } from "../shared/ids.ts";
import type {
  MemoryCategory,
  MemoryContextEnvelope,
  MemoryEntry,
  MemoryLifecycleLink,
} from "../shared/types.ts";
import type { EmbeddingService } from "./embedding.ts";
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

type MemoryRow = {
  id: string;
  category: MemoryCategory;
  content: string;
  created_at: string;
  source_type: MemoryEntry["sourceType"];
  importance: number;
  reinforcement_score?: number | null;
  decay_score?: number | null;
  last_accessed_at: string | null;
  access_count: number;
  is_summary: number;
  is_fact: number;
  parent_summary_id: string | null;
  embedding_model: string | null;
  embedding_json: string | null;
  source_session_id: string | null;
  source_run_id: string | null;
  lifecycle_state?: "active" | "superseded" | "contradicted" | null;
  superseded_by_memory_id?: string | null;
  contradicted_by_memory_id?: string | null;
  vector_backend: "qdrant" | "sqlite_fallback" | null;
  vector_synced_at: string | null;
  vector_sync_error: string | null;
  vector_point_id: string | null;
};

type MemoryLifecycleLinkRow = {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  relationship: MemoryLifecycleLink["relationship"];
  reason: string | null;
  source_session_id: string | null;
  source_run_id: string | null;
  created_at: string;
};

export class MemoryStore {
  private readonly database: AppDatabase;
  private readonly config: AppConfig;
  private readonly embeddings: EmbeddingService;
  private readonly primaryVectorStore: VectorStore;
  private readonly fallbackVectorStore: VectorStore;

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
  }

  async query(input: string): Promise<MemoryContextEnvelope> {
    const queryEmbedding = (await this.embedOrNull([input]))?.[0] ?? null;
    const tokens = tokenize(input);
    const activeVectorStore =
      queryEmbedding && this.primaryVectorStore.isAvailable()
        ? this.primaryVectorStore
        : this.fallbackVectorStore;

    let results = queryEmbedding
      ? await activeVectorStore.search(queryEmbedding, this.config.memoryTopK)
      : [];

    const ids = results.map((result) => result.id);
    const rows =
      ids.length > 0
        ? this.database.all<MemoryRow>(
            `
            SELECT
              id, category, content, created_at, source_type, importance, last_accessed_at,
              reinforcement_score, decay_score, access_count, is_summary, is_fact,
              parent_summary_id, embedding_model, embedding_json,
              source_session_id, source_run_id, lifecycle_state, superseded_by_memory_id,
              contradicted_by_memory_id, vector_backend, vector_synced_at, vector_sync_error,
              vector_point_id
            FROM memory_entries
            WHERE id IN (${ids.map(() => "?").join(",")})
          `,
            ...ids
          )
        : this.database.all<MemoryRow>(
            `
            SELECT
              id, category, content, created_at, source_type, importance, last_accessed_at,
              reinforcement_score, decay_score, access_count, is_summary, is_fact,
              parent_summary_id, embedding_model, embedding_json,
              source_session_id, source_run_id, lifecycle_state, superseded_by_memory_id,
              contradicted_by_memory_id, vector_backend, vector_synced_at, vector_sync_error,
              vector_point_id
            FROM memory_entries
            ORDER BY created_at DESC
            LIMIT 240
          `
          );

    const scoreById = new Map(results.map((item) => [item.id, item.score]));
    const scored = rows
      .filter((row) => isActive(row))
      .map((row) => ({
        row,
        score: scoreMemoryRowHybrid(
          row,
          tokens,
          queryEmbedding,
          scoreById.get(row.id)
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
    this.persistDecayScores(scored.map((entry) => entry.row));

    const summaries = scored
      .filter((entry) => entry.row.is_summary === 1)
      .slice(0, this.config.memorySummaryLimit)
      .map(toMemoryEntry);
    const episodic = scored
      .filter(
        (entry) =>
          entry.row.category === "episodic" && entry.row.is_summary === 0
      )
      .slice(0, this.config.memoryPerCategoryLimit)
      .map(toMemoryEntry);
    const semantic = scored
      .filter(
        (entry) =>
          entry.row.category === "semantic" && entry.row.is_summary === 0
      )
      .slice(0, this.config.memoryPerCategoryLimit)
      .map(toMemoryEntry);
    const procedural = scored
      .filter(
        (entry) =>
          entry.row.category === "procedural" && entry.row.is_summary === 0
      )
      .slice(0, this.config.memoryPerCategoryLimit)
      .map(toMemoryEntry);

    await this.markAccessed([
      ...summaries,
      ...episodic,
      ...semantic,
      ...procedural,
    ]);

    return {
      episodic,
      semantic,
      procedural,
      summaries,
    };
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

    await this.compactEpisodicMemories(record, insights.summary);
    await this.pruneByCategory("semantic", 80);
    await this.pruneByCategory("procedural", 60);
    await this.pruneByCategory("episodic", 120);
  }

  async runMaintenance(): Promise<MemoryMaintenanceOutcome> {
    const summary = await this.compactEpisodicMemories();
    const prunedIds = [
      ...(await this.pruneByCategory("semantic", 80)),
      ...(await this.pruneByCategory("procedural", 60)),
      ...(await this.pruneByCategory("episodic", 120)),
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
        SELECT
          id, category, content, created_at, source_type, importance, last_accessed_at,
          reinforcement_score, decay_score, access_count, is_summary, is_fact,
          parent_summary_id, embedding_model, embedding_json,
          source_session_id, source_run_id, vector_backend, vector_synced_at, vector_sync_error, vector_point_id
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
            id, category, content, created_at, source_type, importance, last_accessed_at,
            reinforcement_score, decay_score, access_count, is_summary, is_fact,
            parent_summary_id, embedding_model, embedding_json,
            source_session_id, source_run_id, lifecycle_state, superseded_by_memory_id,
            contradicted_by_memory_id, vector_backend, vector_synced_at, vector_sync_error,
            vector_point_id
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
          id, category, content, created_at, source_type, importance, last_accessed_at,
          reinforcement_score, decay_score, access_count, is_summary, is_fact,
          parent_summary_id, embedding_model, embedding_json,
          source_session_id, source_run_id, lifecycle_state, superseded_by_memory_id,
          contradicted_by_memory_id, vector_backend, vector_synced_at, vector_sync_error,
          vector_point_id
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
      lifecycleLinks: this.listLifecycleLinks(entryId),
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
    const weight = clamp(options.weight ?? 0.25, -1, 1);
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

  private async compactEpisodicMemories(
    record?: MemoryTurnRecord,
    summaryHint?: string
  ): Promise<{ summaryMemoryId: string; sourceMemoryIds: string[] } | null> {
    const recentRaw = this.database.all<MemoryRow>(
      `
        SELECT
          id, category, content, created_at, source_type, importance, last_accessed_at,
          reinforcement_score, decay_score, access_count, is_summary, is_fact,
          parent_summary_id, embedding_model, embedding_json,
          source_session_id, source_run_id, vector_backend, vector_synced_at, vector_sync_error, vector_point_id
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
        vector ? this.embeddings.model : null,
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
        this.recordLifecycleLinks(row, entry, now);
      });
    });

    const points = insertedRows
      .filter((row) => row.embedding_json)
      .map((row) => ({
        id: row.id,
        vector: decodeJson(row.embedding_json, []),
        payload: buildVectorPayload(row),
      }));
    if (points.length > 0) {
      await this.upsertToVectorBackend(points);
    }
    return insertedRows.map((row) =>
      toMemoryEntry({ row, score: row.importance })
    );
  }

  private recordLifecycleLinks(
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
      .filter((row) => row.embedding_json)
      .map((row) => ({
        id: row.id,
        vector: decodeJson(row.embedding_json, []),
        payload: buildVectorPayload(row),
      }));
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

  private listLifecycleLinks(memoryId: string): MemoryLifecycleLink[] {
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

  private async pruneByCategory(
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

  private async markAccessed(entries: MemoryEntry[]): Promise<void> {
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
          `,
          now,
          entry.id
        );
        this.database.run(
          `
            INSERT INTO memory_reinforcement_events (
              id, memory_id, signal, weight, reason, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `,
          createId("memsig"),
          entry.id,
          "retrieval",
          0.05,
          "Returned in memory context",
          now
        );
      }
    });
  }

  private persistDecayScores(rows: MemoryRow[]): void {
    if (rows.length === 0) {
      return;
    }
    this.database.transaction(() => {
      for (const row of rows) {
        this.database.run(
          "UPDATE memory_entries SET decay_score = ? WHERE id = ?",
          row.decay_score ?? 0,
          row.id
        );
      }
    });
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

function buildVectorPayload(row: {
  category: MemoryCategory;
  source_type: MemoryEntry["sourceType"];
  is_summary: number;
  is_fact: number;
  importance: number;
  created_at: string;
  source_session_id: string | null;
  source_run_id: string | null;
}): Record<string, unknown> {
  return {
    category: row.category,
    sourceType: row.source_type,
    isSummary: row.is_summary === 1,
    isFact: row.is_fact === 1,
    importance: row.importance,
    createdAt: row.created_at,
    sourceSessionId: row.source_session_id,
    sourceRunId: row.source_run_id,
  };
}

function scoreMemoryRowFallback(
  row: MemoryRow,
  tokens: string[],
  queryEmbedding: number[] | null
): number {
  return scoreMemoryRowHybrid(row, tokens, queryEmbedding);
}

function scoreMemoryRowHybrid(
  row: MemoryRow,
  tokens: string[],
  queryEmbedding: number[] | null,
  vectorScore?: number
): number {
  const lowered = row.content.toLowerCase();
  const keywordBoost = tokens.reduce(
    (sum, token) => sum + (lowered.includes(token) ? 1.5 : 0),
    0
  );
  const ageDays = Math.max(
    0,
    (Date.now() - Date.parse(row.created_at)) / 86_400_000
  );
  const recencyBoost = Math.max(0, 4 - Math.floor(ageDays));
  const decayPenalty = Math.min(3, ageDays / 30);
  row.decay_score = decayPenalty;
  const categoryBoost =
    row.category === "procedural"
      ? 2.2
      : row.category === "semantic"
        ? 1.8
        : 1.2;
  const summaryBoost = row.is_summary === 1 ? 1.6 : 0;
  const semanticSimilarity =
    vectorScore !== undefined
      ? vectorScore * 8
      : queryEmbedding
        ? cosineSimilarity(queryEmbedding, decodeJson(row.embedding_json, [])) *
          8
        : 0;
  const accessBoost = Math.min(1.5, Math.log1p(row.access_count) * 0.35);
  const reinforcementBoost = clamp(row.reinforcement_score ?? 0, -1, 3);
  return (
    keywordBoost +
    recencyBoost +
    categoryBoost +
    summaryBoost +
    row.importance * 3 +
    semanticSimilarity +
    accessBoost +
    reinforcementBoost -
    decayPenalty
  );
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function toMemoryEntry(entry: { row: MemoryRow; score: number }): MemoryEntry {
  return {
    id: entry.row.id,
    category: entry.row.category,
    content: entry.row.content,
    createdAt: entry.row.created_at,
    score: entry.score,
    sourceType: entry.row.source_type,
    importance: entry.row.importance,
    reinforcementScore: entry.row.reinforcement_score ?? 0,
    decayScore: entry.row.decay_score ?? 0,
    rankingScore: entry.score,
    lastAccessedAt: entry.row.last_accessed_at ?? undefined,
    accessCount: entry.row.access_count,
    isSummary: entry.row.is_summary === 1,
    isFact: entry.row.is_fact === 1,
    parentSummaryId: entry.row.parent_summary_id ?? undefined,
    lifecycleState: entry.row.lifecycle_state ?? "active",
    supersededByMemoryId: entry.row.superseded_by_memory_id ?? undefined,
    contradictedByMemoryId: entry.row.contradicted_by_memory_id ?? undefined,
    embeddingModel: entry.row.embedding_model ?? undefined,
    vectorBackend: entry.row.vector_backend ?? undefined,
    vectorPointId: entry.row.vector_point_id ?? undefined,
    vectorSyncedAt: entry.row.vector_synced_at ?? undefined,
    vectorSyncError: entry.row.vector_sync_error ?? undefined,
    sourceSessionId: entry.row.source_session_id ?? undefined,
    sourceRunId: entry.row.source_run_id ?? undefined,
  };
}

function isActive(row: MemoryRow): boolean {
  return !row.lifecycle_state || row.lifecycle_state === "active";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

function trimLine(value: string): string {
  return value.length > 320 ? `${value.slice(0, 317)}...` : value;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(value.trim());
  }
  return output;
}
