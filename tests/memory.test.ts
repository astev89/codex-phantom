import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/memory/store.ts";
import { AppDatabase } from "../src/platform/database.ts";
import { makeConfig, makeDisabledEmbeddings, makeFakeEmbeddings, makeFakeVectorStore } from "./helpers.ts";

test("new memories are written to sqlite and synced to qdrant when available", async () => {
  const database = new AppDatabase(":memory:");
  const qdrant = makeFakeVectorStore({ backend: "qdrant", available: true });
  const sqliteFallback = makeFakeVectorStore({ backend: "sqlite_fallback", available: true });
  const memory = new MemoryStore(
    database,
    makeConfig(),
    makeFakeEmbeddings({}),
    qdrant,
    sqliteFallback
  );

  const turn = {
    sessionId: "session-1",
    runId: "run-1",
    queryText: "deploy summary",
    recentMessagesText: "USER: deploy\nASSISTANT: use the deploy checklist",
    userInput: "remember the deploy checklist",
    assistantOutput: "Always follow the deploy checklist"
  };

  await memory.recordTurn(turn);
  await memory.consolidate(turn, async () => ({
    semanticFacts: ["Deployment checklist exists"],
    proceduralNotes: ["Run the deploy checklist before shipping"],
    summary: "Recent deploy conversations established a reusable checklist."
  }));

  assert.ok(qdrant.points.size >= 2);
  const status = memory.getStatus();
  assert.equal(status.vectorBackend, "qdrant");
  assert.equal(status.qdrantReachable, true);
  database.close();
});

test("falls back to sqlite vector search when qdrant is unavailable", async () => {
  const database = new AppDatabase(":memory:");
  const qdrant = makeFakeVectorStore({ backend: "qdrant", available: false, configured: true });
  const sqliteFallback = makeFakeVectorStore({ backend: "sqlite_fallback", available: true });
  const embeddings = makeFakeEmbeddings({
    "User: deploy process\nAssistant: Run the deploy checklist before shipping": [1, 0, 1, 0],
    "deployment process": [1, 0, 1, 0]
  });
  const memory = new MemoryStore(database, makeConfig(".", { qdrantEnabled: true, qdrantUrl: "http://qdrant" }), embeddings, qdrant, sqliteFallback);

  const turn = {
    sessionId: "session-1",
    runId: "run-1",
    queryText: "deployment process",
    recentMessagesText: "USER: deploy\nASSISTANT: Run the deploy checklist before shipping",
    userInput: "deploy process",
    assistantOutput: "Run the deploy checklist before shipping"
  };
  await memory.recordTurn(turn);
  const result = await memory.query("deployment process");
  assert.ok(result.episodic.length > 0);
  assert.equal(memory.getStatus().vectorBackend, "sqlite_fallback");
  database.close();
});

test("backfills existing sqlite memories into qdrant", async () => {
  const database = new AppDatabase(":memory:");
  const qdrant = makeFakeVectorStore({ backend: "qdrant", available: true });
  const memory = new MemoryStore(database, makeConfig(), makeFakeEmbeddings({}), qdrant, makeFakeVectorStore({ backend: "sqlite_fallback" }));

  database.run(
    `
      INSERT INTO memory_entries (
        id, category, content, created_at, source_user_input, source_assistant_output, score,
        embedding_json, embedding_model, source_type, importance, last_accessed_at, access_count,
        is_summary, is_fact, parent_summary_id, source_session_id, source_run_id,
        vector_backend, vector_synced_at, vector_sync_error, vector_point_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    "mem_1",
    "semantic",
    "Deployment checklist exists",
    new Date().toISOString(),
    null,
    null,
    0,
    JSON.stringify([1, 0, 1, 0]),
    "fake-embedding-model",
    "semantic_fact",
    0.7,
    null,
    0,
    0,
    1,
    null,
    "session-1",
    "run-1",
    null,
    null,
    null,
    "mem_1"
  );

  await memory.backfillVectors();
  assert.equal(qdrant.points.has("mem_1"), true);
  assert.equal(memory.getStatus().pendingVectorSyncCount, 0);
  database.close();
});

test("missing embeddings still degrades cleanly to keyword recall", async () => {
  const database = new AppDatabase(":memory:");
  const memory = new MemoryStore(
    database,
    makeConfig(".", { semanticRetrievalEnabled: false }),
    makeDisabledEmbeddings(),
    makeFakeVectorStore({ backend: "qdrant", available: false, configured: false }),
    makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
  );
  const turn = {
    sessionId: "session-1",
    runId: "run-1",
    queryText: "schedule report",
    recentMessagesText: "USER: schedule\nASSISTANT: Use the report scheduler",
    userInput: "schedule the report",
    assistantOutput: "Use the report scheduler every Friday"
  };
  await memory.recordTurn(turn);
  await memory.consolidate(turn, async () => ({
    semanticFacts: [],
    proceduralNotes: ["Use the report scheduler every Friday"],
    summary: "Scheduling guidance recorded."
  }));

  const result = await memory.query("report scheduler");
  assert.ok(result.procedural.length > 0);
  assert.equal(memory.getStatus().semanticRetrievalEnabled, false);
  database.close();
});
