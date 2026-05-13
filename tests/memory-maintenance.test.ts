import test from "node:test";
import assert from "node:assert/strict";
import { MemoryMaintenanceService } from "../src/memory/maintenance.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { AppDatabase } from "../src/platform/database.ts";
import {
  makeConfig,
  makeDisabledEmbeddings,
  makeFakeVectorStore,
} from "./helpers.ts";

function makeMemory(database: AppDatabase): MemoryStore {
  return new MemoryStore(
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
}

test("scheduled memory maintenance summarizes, promotes, and prunes bounded active entries", async () => {
  const database = new AppDatabase(":memory:");
  const memory = makeMemory(database);

  for (let index = 0; index < 6; index += 1) {
    await memory.recordTurn({
      sessionId: "session-maintenance",
      runId: `run-${index}`,
      queryText: "deploy continuity",
      recentMessagesText: "recent deploy conversation",
      userInput: `deploy note ${index}`,
      assistantOutput: `assistant result ${index}`,
    });
  }

  for (let index = 0; index < 82; index += 1) {
    await memory.storeEntry({
      category: "semantic",
      content: `bounded semantic fact ${index}`,
      sourceType: "semantic_fact",
      importance: index < 80 ? 0.9 : 0.1,
      isFact: true,
    });
  }

  const outcome = await memory.runMaintenance();

  assert.equal(outcome.summarizedCount, 4);
  assert.equal(outcome.promotedCount, 1);
  assert.equal(outcome.summaryMemoryIds.length, 1);
  assert.equal(outcome.prunedCount, 2);

  const linkedRawCount = database.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM memory_entries WHERE parent_summary_id = ?",
    outcome.summaryMemoryIds[0]
  )?.count;
  assert.equal(linkedRawCount, 4);

  const activeSemanticCount = database.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM memory_entries WHERE category = 'semantic'"
  )?.count;
  assert.equal(activeSemanticCount, 80);
  database.close();
});

test("memory maintenance service persists outcomes and recovers interrupted runs", async () => {
  const database = new AppDatabase(":memory:");
  const memory = makeMemory(database);
  const service = new MemoryMaintenanceService(database, memory, 3_600_000);

  database.run(
    `
      INSERT INTO memory_maintenance_runs (
        id, status, scheduled_at, started_at, finished_at, summarized_count,
        promoted_count, pruned_count, summary_memory_ids_json,
        promoted_memory_ids_json, pruned_memory_ids_json, failure_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    "memmaint_interrupted",
    "running",
    new Date(Date.now() - 60_000).toISOString(),
    new Date(Date.now() - 30_000).toISOString(),
    null,
    0,
    0,
    0,
    "[]",
    "[]",
    "[]",
    null,
    new Date(Date.now() - 120_000).toISOString()
  );

  await service.start();
  await service.stop();

  const recovered = service
    .list(10)
    .find((run) => run.id === "memmaint_interrupted");
  assert.equal(recovered?.status, "failed");
  assert.equal(
    recovered?.failureReason,
    "Memory maintenance was interrupted during shutdown"
  );
  assert.ok(service.list(10).some((run) => run.status === "scheduled"));

  const completed = await service.runNow();
  assert.equal(completed.status, "completed");
  assert.equal(completed.failureReason, undefined);
  assert.ok(service.list(10).some((run) => run.id === completed.id));
  database.close();
});
