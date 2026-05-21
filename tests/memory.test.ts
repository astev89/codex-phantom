import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/memory/store.ts";
import { AppDatabase } from "../src/platform/database.ts";
import type { EmbeddingService } from "../src/memory/embedding.ts";
import {
  makeConfig,
  makeDisabledEmbeddings,
  makeFakeEmbeddings,
  makeFakeVectorStore,
} from "./helpers.ts";

test("new memories are written to sqlite and synced to qdrant when available", async () => {
  const database = new AppDatabase(":memory:");
  const qdrant = makeFakeVectorStore({ backend: "qdrant", available: true });
  const sqliteFallback = makeFakeVectorStore({
    backend: "sqlite_fallback",
    available: true,
  });
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
    assistantOutput: "Always follow the deploy checklist",
  };

  await memory.recordTurn(turn);
  await memory.consolidate(turn, async () => ({
    semanticFacts: ["Deployment checklist exists"],
    proceduralNotes: ["Run the deploy checklist before shipping"],
    summary: "Recent deploy conversations established a reusable checklist.",
  }));

  assert.ok(qdrant.points.size >= 2);
  const status = memory.getStatus();
  assert.equal(status.vectorBackend, "qdrant");
  assert.equal(status.qdrantReachable, true);
  database.close();
});

test("falls back to sqlite vector search when qdrant is unavailable", async () => {
  const database = new AppDatabase(":memory:");
  const qdrant = makeFakeVectorStore({
    backend: "qdrant",
    available: false,
    configured: true,
  });
  const sqliteFallback = makeFakeVectorStore({
    backend: "sqlite_fallback",
    available: true,
  });
  const embeddings = makeFakeEmbeddings({
    "User: deploy process\nAssistant: Run the deploy checklist before shipping":
      [1, 0, 1, 0],
    "deployment process": [1, 0, 1, 0],
  });
  const memory = new MemoryStore(
    database,
    makeConfig(".", { qdrantEnabled: true, qdrantUrl: "http://qdrant" }),
    embeddings,
    qdrant,
    sqliteFallback
  );

  const turn = {
    sessionId: "session-1",
    runId: "run-1",
    queryText: "deployment process",
    recentMessagesText:
      "USER: deploy\nASSISTANT: Run the deploy checklist before shipping",
    userInput: "deploy process",
    assistantOutput: "Run the deploy checklist before shipping",
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
  const memory = new MemoryStore(
    database,
    makeConfig(),
    makeFakeEmbeddings({}),
    qdrant,
    makeFakeVectorStore({ backend: "sqlite_fallback" })
  );

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
    makeFakeVectorStore({
      backend: "qdrant",
      available: false,
      configured: false,
    }),
    makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
  );
  const turn = {
    sessionId: "session-1",
    runId: "run-1",
    queryText: "schedule report",
    recentMessagesText: "USER: schedule\nASSISTANT: Use the report scheduler",
    userInput: "schedule the report",
    assistantOutput: "Use the report scheduler every Friday",
  };
  await memory.recordTurn(turn);
  await memory.consolidate(turn, async () => ({
    semanticFacts: [],
    proceduralNotes: ["Use the report scheduler every Friday"],
    summary: "Scheduling guidance recorded.",
  }));

  const result = await memory.query("report scheduler");
  assert.ok(result.procedural.length > 0);
  assert.equal(memory.getStatus().semanticRetrievalEnabled, false);
  database.close();
});

function makeFailingEmbeddings(
  message = "embedding timeout"
): EmbeddingService {
  return {
    enabled: true,
    model: "fake-embedding-model",
    async embed(): Promise<number[][]> {
      throw new Error(message);
    },
  };
}

test("embedding failures degrade memory writes instead of failing the turn flow", async () => {
  const database = new AppDatabase(":memory:");
  const memory = new MemoryStore(
    database,
    makeConfig(),
    makeFailingEmbeddings(),
    makeFakeVectorStore({
      backend: "qdrant",
      available: false,
      configured: false,
    }),
    makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
  );

  const turn = {
    sessionId: "session-1",
    runId: "run-1",
    queryText: "release reminder",
    recentMessagesText: "USER: remind me\nASSISTANT: Ship on Friday",
    userInput: "remember the release reminder",
    assistantOutput: "Ship on Friday",
  };

  await assert.doesNotReject(async () => memory.recordTurn(turn));
  await assert.doesNotReject(async () =>
    memory.consolidate(turn, async () => ({
      semanticFacts: ["Friday is release day"],
      proceduralNotes: ["Ship on Friday"],
      summary: "Release reminders captured.",
    }))
  );

  const entries = await memory.listEntries(10);
  assert.ok(entries.length >= 2);
  assert.equal(
    entries.every((entry) => entry.embeddingModel === undefined),
    true
  );
  database.close();
});

test("embedding failures degrade memory query to keyword recall", async () => {
  const database = new AppDatabase(":memory:");
  const memory = new MemoryStore(
    database,
    makeConfig(),
    makeFailingEmbeddings(),
    makeFakeVectorStore({
      backend: "qdrant",
      available: false,
      configured: false,
    }),
    makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
  );

  database.run(
    `
      INSERT INTO memory_entries (
        id, category, content, created_at, source_user_input, source_assistant_output, score,
        embedding_json, embedding_model, source_type, importance, last_accessed_at, access_count,
        is_summary, is_fact, parent_summary_id, source_session_id, source_run_id,
        vector_backend, vector_synced_at, vector_sync_error, vector_point_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    "mem_query",
    "procedural",
    "Use the release checklist before shipping",
    new Date().toISOString(),
    null,
    null,
    0,
    null,
    null,
    "procedural_note",
    0.8,
    null,
    0,
    0,
    1,
    null,
    "session-1",
    "run-1",
    "sqlite_fallback",
    null,
    null,
    "mem_query"
  );

  const result = await memory.query("release checklist");
  assert.ok(result.procedural.some((entry) => entry.id === "mem_query"));
  database.close();
});

test("embedding failures degrade embedding backfill instead of aborting startup", async () => {
  const database = new AppDatabase(":memory:");
  const memory = new MemoryStore(
    database,
    makeConfig(),
    makeFailingEmbeddings(),
    makeFakeVectorStore({
      backend: "qdrant",
      available: false,
      configured: false,
    }),
    makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
  );

  database.run(
    `
      INSERT INTO memory_entries (
        id, category, content, created_at, source_user_input, source_assistant_output, score,
        embedding_json, embedding_model, source_type, importance, last_accessed_at, access_count,
        is_summary, is_fact, parent_summary_id, source_session_id, source_run_id,
        vector_backend, vector_synced_at, vector_sync_error, vector_point_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    "mem_backfill",
    "semantic",
    "Release checklist exists",
    new Date().toISOString(),
    null,
    null,
    0,
    null,
    null,
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
    "mem_backfill"
  );

  await assert.doesNotReject(async () => memory.backfillEmbeddings());
  assert.equal(memory.getStatus().pendingBackfillCount, 1);
  database.close();
});

test("memory supersession and contradiction lifecycle is persisted and excluded from retrieval", async () => {
  const database = new AppDatabase(":memory:");
  const memory = new MemoryStore(
    database,
    makeConfig(".", { semanticRetrievalEnabled: false }),
    makeDisabledEmbeddings(),
    makeFakeVectorStore({
      backend: "qdrant",
      available: false,
      configured: false,
    }),
    makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
  );

  const stale = await memory.storeEntry({
    category: "semantic",
    content: "Deployment happens on Friday",
    sourceType: "semantic_fact",
    importance: 0.9,
    isFact: true,
    sourceSessionId: "session-1",
    sourceRunId: "run-1",
  });
  const contradicted = await memory.storeEntry({
    category: "procedural",
    content: "Use the old release checklist",
    sourceType: "procedural_note",
    importance: 0.9,
    isFact: true,
    sourceSessionId: "session-1",
    sourceRunId: "run-1",
  });
  const current = await memory.storeEntry({
    category: "semantic",
    content: "Deployment happens on Monday",
    sourceType: "semantic_fact",
    importance: 0.95,
    isFact: true,
    supersedesMemoryIds: [stale.id],
    contradictsMemoryIds: [contradicted.id],
    lifecycleReason: "Operator corrected release timing",
    sourceSessionId: "session-2",
    sourceRunId: "run-2",
  });

  const reloaded = new MemoryStore(
    database,
    makeConfig(".", { semanticRetrievalEnabled: false }),
    makeDisabledEmbeddings(),
    makeFakeVectorStore({
      backend: "qdrant",
      available: false,
      configured: false,
    }),
    makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
  );
  const entries = await reloaded.listEntries(10);
  const staleAfter = entries.find((entry) => entry.id === stale.id);
  const contradictedAfter = entries.find(
    (entry) => entry.id === contradicted.id
  );
  assert.equal(staleAfter?.lifecycleState, "superseded");
  assert.equal(staleAfter?.supersededByMemoryId, current.id);
  assert.equal(contradictedAfter?.lifecycleState, "contradicted");
  assert.equal(contradictedAfter?.contradictedByMemoryId, current.id);

  const links = database.all<{
    relationship: string;
    target_memory_id: string;
    reason: string;
  }>(
    "SELECT relationship, target_memory_id, reason FROM memory_lifecycle_links ORDER BY relationship ASC"
  );
  assert.deepEqual(
    links.map((link) => link.relationship),
    ["contradicts", "supersedes"]
  );
  assert.ok(
    links.every((link) => link.reason === "Operator corrected release timing")
  );
  const staleDetail = await reloaded.getEntry(stale.id);
  assert.deepEqual(
    staleDetail?.lifecycleLinks?.map((link) => ({
      relationship: link.relationship,
      targetMemoryId: link.targetMemoryId,
      reason: link.reason,
    })),
    [
      {
        relationship: "supersedes",
        targetMemoryId: stale.id,
        reason: "Operator corrected release timing",
      },
    ]
  );

  const result = await reloaded.query("deployment release checklist");
  const returnedIds = [
    ...result.semantic,
    ...result.procedural,
    ...result.episodic,
    ...result.summaries,
  ].map((entry) => entry.id);
  assert.ok(returnedIds.includes(current.id));
  assert.ok(!returnedIds.includes(stale.id));
  assert.ok(!returnedIds.includes(contradicted.id));
  database.close();
});

test("memory reinforcement and decay tune fallback retrieval without bypassing lifecycle exclusions", async () => {
  const database = new AppDatabase(":memory:");
  const memory = new MemoryStore(
    database,
    makeConfig(".", { semanticRetrievalEnabled: false }),
    makeDisabledEmbeddings(),
    makeFakeVectorStore({
      backend: "qdrant",
      available: false,
      configured: false,
    }),
    makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
  );

  const older = await memory.storeEntry({
    category: "semantic",
    content: "Release checklist mentions smoke tests",
    sourceType: "semantic_fact",
    importance: 0.7,
    isFact: true,
  });
  const reinforced = await memory.storeEntry({
    category: "semantic",
    content: "Release checklist mentions database restore",
    sourceType: "semantic_fact",
    importance: 0.7,
    isFact: true,
  });
  const superseded = await memory.storeEntry({
    category: "semantic",
    content: "Release checklist says skip restore",
    sourceType: "semantic_fact",
    importance: 0.99,
    isFact: true,
  });
  await memory.storeEntry({
    category: "semantic",
    content: "Release checklist requires restore validation",
    sourceType: "semantic_fact",
    importance: 0.5,
    isFact: true,
    supersedesMemoryIds: [superseded.id],
    lifecycleReason: "Restore validation is required",
  });

  const oldDate = new Date(Date.now() - 45 * 86_400_000).toISOString();
  database.run(
    "UPDATE memory_entries SET created_at = ? WHERE id IN (?, ?, ?)",
    oldDate,
    older.id,
    reinforced.id,
    superseded.id
  );
  memory.reinforceEntry(reinforced.id, {
    weight: 1,
    signal: "operator",
    reason: "Restore checklist was useful",
  });
  memory.reinforceEntry(reinforced.id, {
    weight: 1,
    signal: "operator",
    reason: "Restore checklist was useful again",
  });
  memory.reinforceEntry(superseded.id, {
    weight: 1,
    signal: "operator",
    reason: "Inactive memories should not re-enter retrieval",
  });

  const result = await memory.query("release checklist restore");
  const semanticIds = result.semantic.map((entry) => entry.id);
  assert.ok(
    semanticIds.indexOf(reinforced.id) > -1 &&
      semanticIds.indexOf(older.id) > -1 &&
      semanticIds.indexOf(reinforced.id) < semanticIds.indexOf(older.id)
  );
  assert.ok(!result.semantic.some((entry) => entry.id === superseded.id));
  const reinforcedResult = result.semantic.find(
    (entry) => entry.id === reinforced.id
  );
  assert.ok((reinforcedResult?.reinforcementScore ?? 0) >= 2);
  assert.ok((reinforcedResult?.decayScore ?? 0) > 0);
  assert.ok((reinforcedResult?.rankingScore ?? 0) > 0);

  const events = database.all<{
    memory_id: string;
    signal: string;
    weight: number;
  }>(
    "SELECT memory_id, signal, weight FROM memory_reinforcement_events WHERE memory_id = ? ORDER BY created_at ASC",
    reinforced.id
  );
  assert.ok(
    events.some((event) => event.signal === "operator" && event.weight === 1)
  );
  assert.ok(
    events.some(
      (event) => event.signal === "retrieval" && event.weight === 0.05
    )
  );

  const persisted = await memory.getEntry(reinforced.id);
  assert.ok((persisted?.decayScore ?? 0) > 0);
  database.close();
});
