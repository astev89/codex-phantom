import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/platform/database.ts";
import { MemoryLifecycleService } from "../src/memory/lifecycle.ts";
import { toMemoryEntry, type MemoryRow } from "../src/memory/records.ts";
import { makeConfig, makeFakeVectorStore } from "./helpers.ts";

test("lifecycle links mark targets and preserve the correcting row as active", () => {
  const { database, lifecycle } = makeHarness();
  const stale = insertMemory(database, {
    id: "mem_stale",
    category: "semantic",
    content: "Deployment happens on Friday",
  });
  const contradicted = insertMemory(database, {
    id: "mem_contradicted",
    category: "procedural",
    content: "Use the old release checklist",
  });
  const current = insertMemory(database, {
    id: "mem_current",
    category: "semantic",
    content: "Deployment happens on Monday",
  });

  lifecycle.recordLifecycleLinks(
    current,
    {
      category: "semantic",
      content: current.content,
      sourceType: "semantic_fact",
      importance: current.importance,
      supersedesMemoryIds: [stale.id],
      contradictsMemoryIds: [contradicted.id],
      lifecycleReason: "Operator corrected release timing",
    },
    NOW
  );

  assert.equal(readLifecycleState(database, stale.id), "superseded");
  assert.equal(readLifecycleState(database, contradicted.id), "contradicted");
  assert.equal(readLifecycleState(database, current.id), "active");
  assert.deepEqual(
    lifecycle
      .listLifecycleLinks(stale.id)
      .map((link) => [link.relationship, link.targetMemoryId, link.reason]),
    [["supersedes", stale.id, "Operator corrected release timing"]]
  );
  database.close();
});

test("reinforcement and retrieval access no-op for inactive rows", () => {
  const { database, lifecycle } = makeHarness();
  const active = insertMemory(database, {
    id: "mem_active",
    lifecycle_state: "active",
  });
  const inactive = insertMemory(database, {
    id: "mem_inactive",
    lifecycle_state: "superseded",
    superseded_by_memory_id: active.id,
  });

  lifecycle.reinforceEntry(active.id, {
    weight: 1,
    signal: "operator",
    reason: "useful",
  });
  lifecycle.reinforceEntry(inactive.id, {
    weight: 1,
    signal: "operator",
    reason: "should be ignored",
  });
  lifecycle.markAccessed([
    toMemoryEntry({ row: active, score: 1 }),
    toMemoryEntry({ row: inactive, score: 1 }),
  ]);

  assert.equal(readMemory(database, active.id).reinforcement_score, 1.05);
  assert.equal(readMemory(database, active.id).access_count, 1);
  assert.equal(readMemory(database, inactive.id).reinforcement_score, 0);
  assert.equal(readMemory(database, inactive.id).access_count, 0);
  assert.deepEqual(readSignals(database, inactive.id), []);
  database.close();
});

test("pruning deletes active surplus rows and leaves inactive audit rows", async () => {
  const { database, lifecycle } = makeHarness();
  insertMemory(database, {
    id: "mem_keep_high",
    category: "semantic",
    importance: 0.9,
    created_at: "2026-05-27T00:00:00.000Z",
  });
  insertMemory(database, {
    id: "mem_keep_new",
    category: "semantic",
    importance: 0.8,
    created_at: "2026-05-27T00:00:00.000Z",
  });
  insertMemory(database, {
    id: "mem_prune_old",
    category: "semantic",
    importance: 0.1,
    created_at: "2026-04-01T00:00:00.000Z",
  });
  insertMemory(database, {
    id: "mem_audit",
    category: "semantic",
    importance: 1,
    lifecycle_state: "contradicted",
  });

  const pruned = await lifecycle.pruneByCategory("semantic", 2);

  assert.deepEqual(pruned, ["mem_prune_old"]);
  assert.equal(Boolean(findMemory(database, "mem_prune_old")), false);
  assert.equal(Boolean(readMemory(database, "mem_audit")), true);
  database.close();
});

test("episodic compaction creates a summary and parents the source cluster", async () => {
  const vectorStore = makeFakeVectorStore({
    backend: "qdrant",
    available: true,
  });
  const { database, lifecycle } = makeHarness({ vectorStore });
  insertMemory(database, {
    id: "mem_1",
    category: "episodic",
    content: "First release discussion",
    created_at: "2026-05-24T00:00:00.000Z",
    source_type: "raw_turn",
    is_fact: 0,
  });
  insertMemory(database, {
    id: "mem_2",
    category: "episodic",
    content: "Second release discussion",
    created_at: "2026-05-25T00:00:00.000Z",
    source_type: "raw_turn",
    is_fact: 0,
  });
  insertMemory(database, {
    id: "mem_3",
    category: "episodic",
    content: "Third release discussion",
    created_at: "2026-05-26T00:00:00.000Z",
    source_type: "raw_turn",
    is_fact: 0,
  });

  const result = await lifecycle.compactEpisodicMemories(
    {
      sessionId: "session-1",
      runId: "run-1",
      queryText: "release",
      recentMessagesText: "release",
      userInput: "release",
      assistantOutput: "recorded",
    },
    "Release discussion summary."
  );

  assert.equal(result?.sourceMemoryIds.length, 2);
  assert.equal(vectorStore.points.has(result?.summaryMemoryId ?? ""), true);
  assert.equal(
    readMemory(database, "mem_1").parent_summary_id,
    result?.summaryMemoryId
  );
  assert.equal(
    readMemory(database, "mem_2").parent_summary_id,
    result?.summaryMemoryId
  );
  assert.equal(readMemory(database, "mem_3").parent_summary_id, null);
  database.close();
});

function makeHarness(options?: {
  vectorStore?: ReturnType<typeof makeFakeVectorStore>;
}): {
  database: AppDatabase;
  lifecycle: MemoryLifecycleService;
} {
  const database = new AppDatabase(":memory:");
  const vectorStore =
    options?.vectorStore ??
    makeFakeVectorStore({ backend: "qdrant", available: true });
  const lifecycle = new MemoryLifecycleService({
    database,
    config: makeConfig(".", {
      memorySummaryTriggerCount: 3,
      memorySummaryClusterSize: 2,
    }),
    primaryVectorStore: vectorStore,
    embeddingModel: "fake-embedding-model",
    async embedOrNull(texts) {
      return texts.map(() => [1, 0, 0, 0]);
    },
    upsertToVectorBackend: async (points) => {
      await vectorStore.upsert(points);
    },
  });
  return { database, lifecycle };
}

function insertMemory(
  database: AppDatabase,
  input: Partial<MemoryRow> & { id: string }
): MemoryRow {
  const row = memoryRow(input);
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
    row.id,
    row.category,
    row.content,
    row.created_at,
    null,
    null,
    0,
    row.embedding_json,
    row.embedding_model,
    row.source_type,
    row.importance,
    row.last_accessed_at,
    row.access_count,
    row.is_summary,
    row.is_fact,
    row.parent_summary_id,
    row.source_session_id,
    row.source_run_id,
    row.vector_backend,
    row.vector_synced_at,
    row.vector_sync_error,
    row.vector_point_id,
    row.lifecycle_state ?? "active",
    row.superseded_by_memory_id ?? null,
    row.contradicted_by_memory_id ?? null,
    row.reinforcement_score ?? 0,
    row.decay_score ?? 0
  );
  return row;
}

function memoryRow(input: Partial<MemoryRow> & { id: string }): MemoryRow {
  return {
    id: input.id,
    category: input.category ?? "semantic",
    content: input.content ?? "release checklist",
    created_at: input.created_at ?? NOW,
    source_type: input.source_type ?? "semantic_fact",
    importance: input.importance ?? 0.7,
    reinforcement_score: input.reinforcement_score ?? 0,
    decay_score: input.decay_score ?? 0,
    last_accessed_at: input.last_accessed_at ?? null,
    access_count: input.access_count ?? 0,
    is_summary: input.is_summary ?? 0,
    is_fact: input.is_fact ?? 1,
    parent_summary_id: input.parent_summary_id ?? null,
    embedding_model: input.embedding_model ?? "fake-embedding-model",
    embedding_json: input.embedding_json ?? "[1,0,0,0]",
    source_session_id: input.source_session_id ?? "session-1",
    source_run_id: input.source_run_id ?? "run-1",
    lifecycle_state: input.lifecycle_state ?? "active",
    superseded_by_memory_id: input.superseded_by_memory_id ?? null,
    contradicted_by_memory_id: input.contradicted_by_memory_id ?? null,
    vector_backend: input.vector_backend ?? "qdrant",
    vector_synced_at: input.vector_synced_at ?? null,
    vector_sync_error: input.vector_sync_error ?? null,
    vector_point_id: input.vector_point_id ?? input.id,
  };
}

function readLifecycleState(database: AppDatabase, id: string): string | null {
  return readMemory(database, id).lifecycle_state ?? null;
}

function readMemory(database: AppDatabase, id: string): MemoryRow {
  const row = findMemory(database, id);
  assert.ok(row);
  return row;
}

function findMemory(database: AppDatabase, id: string): MemoryRow | null {
  return database.get<MemoryRow>(
    "SELECT * FROM memory_entries WHERE id = ?",
    id
  );
}

function readSignals(database: AppDatabase, id: string): string[] {
  return database
    .all<{
      signal: string;
    }>("SELECT signal FROM memory_reinforcement_events WHERE memory_id = ? ORDER BY created_at ASC", id)
    .map((row) => row.signal);
}

const NOW = "2026-05-27T00:00:00.000Z";
