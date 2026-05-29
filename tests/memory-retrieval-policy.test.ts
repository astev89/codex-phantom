import test from "node:test";
import assert from "node:assert/strict";
import { buildMemoryRetrievalContext } from "../src/memory/retrieval-policy.ts";
import type { MemoryRow } from "../src/memory/records.ts";

test("retrieval policy ranks active rows and reports decay updates", () => {
  const nowMs = Date.parse("2026-05-27T00:00:00.000Z");
  const rows = [
    memoryRow({
      id: "mem_old",
      category: "semantic",
      content: "Release checklist mentions smoke tests",
      created_at: "2026-04-12T00:00:00.000Z",
      importance: 0.7,
      reinforcement_score: 0,
      embedding_json: "[0.7,0.1]",
    }),
    memoryRow({
      id: "mem_reinforced",
      category: "semantic",
      content: "Release checklist mentions database restore",
      created_at: "2026-04-12T00:00:00.000Z",
      importance: 0.7,
      reinforcement_score: 2,
      access_count: 4,
      embedding_json: "[0.7,0.1]",
    }),
    memoryRow({
      id: "mem_vector",
      category: "semantic",
      content: "Restore evidence belongs in the release checklist",
      created_at: "2026-05-26T00:00:00.000Z",
      importance: 0.4,
      vector_backend: "qdrant",
      embedding_json: "[1,0]",
    }),
    memoryRow({
      id: "mem_inactive",
      category: "semantic",
      content: "Release checklist says skip restore",
      lifecycle_state: "superseded",
      importance: 1,
    }),
  ];

  const result = buildMemoryRetrievalContext({
    rows,
    queryText: "release checklist restore",
    queryEmbedding: [1, 0],
    vectorScores: new Map([["mem_vector", 0.99]]),
    memorySummaryLimit: 2,
    memoryPerCategoryLimit: 3,
    nowMs,
  });

  assert.deepEqual(
    result.envelope.semantic.map((entry) => entry.id),
    ["mem_vector", "mem_reinforced", "mem_old"]
  );
  assert.equal(
    result.envelope.semantic.some((entry) => entry.id === "mem_inactive"),
    false
  );
  assert.equal(
    result.decayUpdates.find((update) => update.id === "mem_reinforced")
      ?.decayScore,
    1.5
  );
});

test("retrieval policy returns bounded summaries and per-category groups", () => {
  const result = buildMemoryRetrievalContext({
    rows: [
      memoryRow({
        id: "summary_1",
        category: "episodic",
        content: "Summary: release checklist restore",
        is_summary: 1,
        importance: 0.9,
      }),
      memoryRow({
        id: "summary_2",
        category: "episodic",
        content: "Summary: deployment checklist restore",
        is_summary: 1,
        importance: 0.8,
      }),
      memoryRow({
        id: "episodic_1",
        category: "episodic",
        content: "User discussed release restore",
      }),
      memoryRow({
        id: "semantic_1",
        category: "semantic",
        content: "Release restore is required",
      }),
      memoryRow({
        id: "procedural_1",
        category: "procedural",
        content: "Run restore validation before release",
      }),
      memoryRow({
        id: "procedural_2",
        category: "procedural",
        content: "Capture release evidence",
      }),
    ],
    queryText: "release restore",
    queryEmbedding: null,
    memorySummaryLimit: 1,
    memoryPerCategoryLimit: 1,
    nowMs: Date.parse("2026-05-27T00:00:00.000Z"),
  });

  assert.equal(result.envelope.summaries.length, 1);
  assert.equal(result.envelope.episodic.length, 1);
  assert.equal(result.envelope.semantic.length, 1);
  assert.equal(result.envelope.procedural.length, 1);
  assert.deepEqual(
    result.returnedEntries.map((entry) => entry.id),
    ["summary_1", "episodic_1", "semantic_1", "procedural_1"]
  );
});

function memoryRow(input: Partial<MemoryRow> & { id: string }): MemoryRow {
  return {
    id: input.id,
    category: input.category ?? "semantic",
    content: input.content ?? "release checklist",
    created_at: input.created_at ?? "2026-05-27T00:00:00.000Z",
    source_type: input.source_type ?? "semantic_fact",
    importance: input.importance ?? 0.7,
    reinforcement_score: input.reinforcement_score ?? 0,
    decay_score: input.decay_score ?? 0,
    last_accessed_at: input.last_accessed_at ?? null,
    access_count: input.access_count ?? 0,
    is_summary: input.is_summary ?? 0,
    is_fact: input.is_fact ?? 1,
    parent_summary_id: input.parent_summary_id ?? null,
    embedding_model: input.embedding_model ?? null,
    embedding_json: input.embedding_json ?? null,
    source_session_id: input.source_session_id ?? null,
    source_run_id: input.source_run_id ?? null,
    lifecycle_state: input.lifecycle_state ?? "active",
    superseded_by_memory_id: input.superseded_by_memory_id ?? null,
    contradicted_by_memory_id: input.contradicted_by_memory_id ?? null,
    vector_backend: input.vector_backend ?? "sqlite_fallback",
    vector_synced_at: input.vector_synced_at ?? null,
    vector_sync_error: input.vector_sync_error ?? null,
    vector_point_id: input.vector_point_id ?? input.id,
  };
}
