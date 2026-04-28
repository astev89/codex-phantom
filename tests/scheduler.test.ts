import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/platform/database.ts";
import { SchedulerService } from "../src/scheduler/service.ts";
import { validateScheduleBody } from "../src/server/validation.ts";
import type { OrchestrationService } from "../src/orchestration/service.ts";

type OrchestrationResult = {
  sessionId: string;
  runId: string;
  outputText: string;
};

function insertJob(
  database: AppDatabase,
  input: {
    id: string;
    status: "scheduled" | "running" | "completed" | "failed";
    scheduledAt: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    attemptCount: number;
    maxAttempts: number;
    failureReason?: string;
  }
): void {
  database.run(
    `
      INSERT INTO jobs (
        id, name, message, scheduled_at, subagents_json, status, created_at,
        started_at, finished_at, attempt_count, max_attempts, failure_reason, last_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.id,
    input.id,
    "run me",
    input.scheduledAt,
    "[]",
    input.status,
    input.createdAt,
    input.startedAt ?? null,
    input.finishedAt ?? null,
    input.attemptCount,
    input.maxAttempts,
    input.failureReason ?? null,
    null
  );
}

function makeOrchestration(
  runCoordinator: () => Promise<OrchestrationResult>
): OrchestrationService {
  return {
    runCoordinator
  } as unknown as OrchestrationService;
}

test("start recovers stale running jobs back to scheduled deterministically", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const now = Date.UTC(2026, 3, 28, 12, 0, 0);
  t.mock.timers.setTime(now);

  const database = new AppDatabase(":memory:");
  t.after(() => database.close());

  insertJob(database, {
    id: "job-stale",
    status: "running",
    scheduledAt: new Date(now - 1_000).toISOString(),
    createdAt: new Date(now - 120_000).toISOString(),
    startedAt: new Date(now - 60_000).toISOString(),
    attemptCount: 1,
    maxAttempts: 3
  });

  const scheduler = new SchedulerService(
    database,
    makeOrchestration(async () => ({
      sessionId: "session",
      runId: "run",
      outputText: "ok"
    }))
  );

  await scheduler.start();

  const job = (await scheduler.list()).find((item) => item.id === "job-stale");
  assert.equal(job?.status, "scheduled");
  assert.equal(job?.scheduledAt, new Date(now).toISOString());
  assert.equal(job?.failureReason, "Recovered after interrupted run");
});

test("start marks exhausted stale running jobs as failed", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const now = Date.UTC(2026, 3, 28, 12, 5, 0);
  t.mock.timers.setTime(now);

  const database = new AppDatabase(":memory:");
  t.after(() => database.close());

  insertJob(database, {
    id: "job-exhausted",
    status: "running",
    scheduledAt: new Date(now - 1_000).toISOString(),
    createdAt: new Date(now - 120_000).toISOString(),
    startedAt: new Date(now - 60_000).toISOString(),
    attemptCount: 3,
    maxAttempts: 3
  });

  const scheduler = new SchedulerService(
    database,
    makeOrchestration(async () => ({
      sessionId: "session",
      runId: "run",
      outputText: "ok"
    }))
  );

  await scheduler.start();

  const job = (await scheduler.list()).find((item) => item.id === "job-exhausted");
  assert.equal(job?.status, "failed");
  assert.equal(job?.failureReason, "Job was running during shutdown and attempts are exhausted");
  assert.equal(job?.finishedAt, new Date(now).toISOString());
});

test("retry scheduling uses deterministic exponential backoff", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const now = Date.UTC(2026, 3, 28, 12, 10, 0);
  t.mock.timers.setTime(now);

  const database = new AppDatabase(":memory:");
  t.after(() => database.close());

  insertJob(database, {
    id: "job-retry",
    status: "scheduled",
    scheduledAt: new Date(now + 10_000).toISOString(),
    createdAt: new Date(now - 120_000).toISOString(),
    attemptCount: 2,
    maxAttempts: 5
  });

  const scheduler = new SchedulerService(
    database,
    makeOrchestration(async () => {
      throw new Error("scheduler failed");
    })
  );

  await scheduler.start();
  await (scheduler as unknown as { execute(jobId: string): Promise<void> }).execute("job-retry");

  const job = (await scheduler.list()).find((item) => item.id === "job-retry");
  assert.equal(job?.status, "scheduled");
  assert.equal(job?.attemptCount, 3);
  assert.equal(job?.scheduledAt, new Date(now + 4_000).toISOString());
});

test("retry scheduling caps backoff at sixty seconds", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const now = Date.UTC(2026, 3, 28, 12, 15, 0);
  t.mock.timers.setTime(now);

  const database = new AppDatabase(":memory:");
  t.after(() => database.close());

  insertJob(database, {
    id: "job-retry-cap",
    status: "scheduled",
    scheduledAt: new Date(now + 10_000).toISOString(),
    createdAt: new Date(now - 120_000).toISOString(),
    attemptCount: 7,
    maxAttempts: 10
  });

  const scheduler = new SchedulerService(
    database,
    makeOrchestration(async () => {
      throw new Error("scheduler failed");
    })
  );

  await scheduler.start();
  await (scheduler as unknown as { execute(jobId: string): Promise<void> }).execute("job-retry-cap");

  const job = (await scheduler.list()).find((item) => item.id === "job-retry-cap");
  assert.equal(job?.status, "scheduled");
  assert.equal(job?.attemptCount, 8);
  assert.equal(job?.scheduledAt, new Date(now + 60_000).toISOString());
});

test("schedule validation rejects maxAttempts above the allowed upper bound", () => {
  assert.throws(
    () =>
      validateScheduleBody({
        name: "retry-job",
        message: "run me",
        delayMs: 1_000,
        maxAttempts: 11
      }),
    /maxAttempts must be less than or equal to 10/
  );
});
