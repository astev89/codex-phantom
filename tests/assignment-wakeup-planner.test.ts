import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/platform/database.ts";
import { AutonomousAssignmentService } from "../src/assignments/service.ts";
import {
  ASSIGNMENT_WAKEUP_JOB_NAME,
  AssignmentWakeupPlanner,
} from "../src/assignments/wakeup-planner.ts";
import { RunGraphStore } from "../src/orchestration/run-graph-store.ts";
import type { OrchestrationService } from "../src/orchestration/service.ts";
import type { JobRecord } from "../src/scheduler/service.ts";

type ScheduledJob = {
  name: string;
  message: string;
  delayMs?: number;
  maxAttempts?: number;
  scheduledAt: string;
};

type CoordinatorInput = Parameters<OrchestrationService["runCoordinator"]>[0];

function makeScheduler(now: string): {
  jobs: ScheduledJob[];
  scheduler: {
    schedule: (
      name: string,
      message: string,
      options: { delayMs?: number; maxAttempts?: number }
    ) => Promise<JobRecord>;
  };
} {
  const jobs: ScheduledJob[] = [];
  return {
    jobs,
    scheduler: {
      async schedule(name, message, options) {
        const scheduledAt = new Date(
          Date.parse(now) + (options.delayMs ?? 0)
        ).toISOString();
        jobs.push({ name, message, ...options, scheduledAt });
        return {
          id: `job_${jobs.length}`,
          name,
          message,
          scheduledAt,
          subagents: [],
          status: "scheduled",
          createdAt: now,
          attemptCount: 0,
          maxAttempts: options.maxAttempts ?? 1,
        };
      },
    },
  };
}

function makeOrchestration(
  runs: RunGraphStore,
  outputs: string[]
): OrchestrationService {
  let count = 0;
  return {
    async runCoordinator(input: CoordinatorInput) {
      const runId = `coord_wakeup_${count + 1}`;
      const outputText = outputs[count] ?? "ASSIGNMENT_STATUS: continue";
      count += 1;
      await runs.upsert({
        runId,
        role: "coordinator",
        objective: input.message,
        status: "completed",
        permissionPolicy: {
          mode: "read_only",
          fileGlobs: [],
          allowedToolIds: [],
          allowedMcpServers: [],
        },
        allowedMcpServers: [],
        allowedToolIds: [],
        childRunIds: [],
        transcript: [],
        summary: outputText,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      return { sessionId: "session", runId, outputText };
    },
  } as unknown as OrchestrationService;
}

test("AssignmentWakeupPlanner runs a wakeup, links the run, and schedules the next wakeup", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-04-28T12:00:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      "Made progress.\nASSIGNMENT_STATUS: continue\nNEXT_WAKEUP_MINUTES: 9",
    ]),
  });
  const created = assignments.create({
    objective: "Keep researching wakeup planning",
    policy: { wakeupDelayMinMinutes: 5, wakeupDelayMaxMinutes: 60 },
  });

  const result = await planner.wakeNow({
    assignmentId: created.assignment.id,
    actor: "operator",
    reason: "manual smoke",
    source: "force_wakeup",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(result.runId, "coord_wakeup_1");
  assert.equal(result.assignment.assignment.lifecycleState, "waiting");
  assert.equal(result.assignment.assignment.wakeupCount, 1);
  assert.equal(result.assignment.runLinks[0]?.runId, "coord_wakeup_1");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.name, ASSIGNMENT_WAKEUP_JOB_NAME);
  assert.equal(jobs[0]?.delayMs, 9 * 60_000);
  assert.equal(jobs[0]?.maxAttempts, 1);
  assert.deepEqual(JSON.parse(jobs[0]?.message ?? "{}"), {
    assignmentId: created.assignment.id,
    reason: "Planner requested continuation",
  });
  assert.deepEqual(
    assignments
      .timeline(created.assignment.id)
      .events.map((event) => event.type),
    [
      "created",
      "wakeup_started",
      "run_linked",
      "wakeup_run_completed",
      "wakeup_scheduled",
    ]
  );
});

test("AssignmentWakeupPlanner completes or blocks assignments without scheduling another wakeup", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-04-28T12:30:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      "All done.\nASSIGNMENT_STATUS: complete",
      "Need operator input.\nASSIGNMENT_STATUS: blocked",
    ]),
  });

  const completed = assignments.create({ objective: "Complete me" });
  const completedResult = await planner.wakeNow({
    assignmentId: completed.assignment.id,
    actor: "operator",
    reason: "run",
  });
  assert.equal(completedResult.status, "completed");
  assert.equal(
    completedResult.assignment.assignment.lifecycleState,
    "completed"
  );

  const blocked = assignments.create({ objective: "Block me" });
  const blockedResult = await planner.wakeNow({
    assignmentId: blocked.assignment.id,
    actor: "operator",
    reason: "run",
  });
  assert.equal(blockedResult.status, "blocked");
  assert.equal(blockedResult.assignment.assignment.lifecycleState, "blocked");
  assert.equal(jobs.length, 0);
});

test("AssignmentWakeupPlanner enforces wakeup and failure budgets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-04-28T13:00:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  let shouldFail = false;
  const orchestration = {
    async runCoordinator(input: { message: string }) {
      if (shouldFail) {
        throw new Error("model unavailable");
      }
      const runId = "coord_budget_1";
      await runs.upsert({
        runId,
        role: "coordinator",
        objective: input.message,
        status: "completed",
        permissionPolicy: {
          mode: "read_only",
          fileGlobs: [],
          allowedToolIds: [],
          allowedMcpServers: [],
        },
        allowedMcpServers: [],
        allowedToolIds: [],
        childRunIds: [],
        transcript: [],
        summary: "ASSIGNMENT_STATUS: continue",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      return {
        sessionId: "session",
        runId,
        outputText: "ASSIGNMENT_STATUS: continue",
      };
    },
  } as unknown as OrchestrationService;
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration,
  });

  const oneWakeup = assignments.create({
    objective: "Expire after one wakeup",
    policy: { maxWakeups: 1 },
  });
  const expired = await planner.wakeNow({
    assignmentId: oneWakeup.assignment.id,
    reason: "budget",
  });
  assert.equal(expired.status, "expired");
  assert.equal(expired.assignment.assignment.lifecycleState, "expired");
  assert.equal(jobs.length, 0);

  shouldFail = true;
  const failureBudget = assignments.create({
    objective: "Fail after two errors",
    policy: { maxConsecutiveFailures: 2 },
  });
  const firstFailure = await planner.wakeNow({
    assignmentId: failureBudget.assignment.id,
    reason: "first",
  });
  assert.equal(firstFailure.status, "scheduled");
  assert.equal(firstFailure.assignment.assignment.consecutiveFailureCount, 1);
  assert.equal(jobs.length, 1);
  const secondFailure = await planner.wakeNow({
    assignmentId: failureBudget.assignment.id,
    reason: "second",
  });
  assert.equal(secondFailure.status, "failed");
  assert.equal(secondFailure.assignment.assignment.lifecycleState, "failed");
});

test("AssignmentWakeupPlanner clamps next wakeup delays and skips terminal assignments", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-04-28T14:00:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  let runCount = 0;
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: {
      async runCoordinator(input: { message: string }) {
        runCount += 1;
        const runId = `coord_clamp_${runCount}`;
        await runs.upsert({
          runId,
          role: "coordinator",
          objective: input.message,
          status: "completed",
          permissionPolicy: {
            mode: "read_only",
            fileGlobs: [],
            allowedToolIds: [],
            allowedMcpServers: [],
          },
          allowedMcpServers: [],
          allowedToolIds: [],
          childRunIds: [],
          transcript: [],
          summary: "ASSIGNMENT_STATUS: continue\nNEXT_WAKEUP_MINUTES: 999",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        return {
          sessionId: "session",
          runId,
          outputText: "ASSIGNMENT_STATUS: continue\nNEXT_WAKEUP_MINUTES: 999",
        };
      },
    } as unknown as OrchestrationService,
  });
  const clamped = assignments.create({
    objective: "Clamp me",
    policy: { wakeupDelayMinMinutes: 5, wakeupDelayMaxMinutes: 15 },
  });
  await planner.wakeNow({ assignmentId: clamped.assignment.id, reason: "run" });
  assert.equal(jobs[0]?.delayMs, 15 * 60_000);

  assignments.control(clamped.assignment.id, { action: "cancel" });
  const skipped = await planner.wakeNow({
    assignmentId: clamped.assignment.id,
    reason: "terminal",
  });
  assert.equal(skipped.status, "skipped");
  assert.equal(runCount, 1);
});
