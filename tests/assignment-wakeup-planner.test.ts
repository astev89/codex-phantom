import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { AppDatabase } from "../src/platform/database.ts";
import { AutonomousAssignmentService } from "../src/assignments/service.ts";
import { AutonomousMutationExecutor } from "../src/assignments/autonomous-mutations.ts";
import { AutonomousMutationLedger } from "../src/assignments/mutation-ledger.ts";
import { RuntimeConfigLimitsStore } from "../src/config/runtime-limits.ts";
import { MemoryPolicyStore } from "../src/memory/policy.ts";
import { loadRolePolicyConfig } from "../src/orchestration/role-config.ts";
import { RolePolicyRuntimeStore } from "../src/orchestration/role-policy-runtime.ts";
import { ProjectFileDraftStore } from "../src/project-files/drafts.ts";
import { ProjectFileApplyService } from "../src/project-files/apply.ts";
import {
  ASSIGNMENT_WAKEUP_JOB_NAME,
  AssignmentWakeupPlanner,
} from "../src/assignments/wakeup-planner.ts";
import { RunGraphStore } from "../src/orchestration/run-graph-store.ts";
import type { OrchestrationService } from "../src/orchestration/service.ts";
import {
  PromptManagedFragmentStore,
  PromptRuntimeGuidanceStore,
} from "../src/prompts/runtime-guidance.ts";
import { OperatorSettingsStore } from "../src/server/settings.ts";
import type { JobRecord } from "../src/scheduler/service.ts";
import { ToolBundleImportStore } from "../src/tools/bundles.ts";
import { ToolBundleLifecycleService } from "../src/tools/bundle-lifecycle.ts";
import { DynamicToolRegistry } from "../src/tools/dynamic-registry.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { makeConfig } from "./helpers.ts";

type ScheduledJob = JobRecord & {
  delayMs?: number;
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
      reschedule: (
        jobId: string,
        options: { message?: string; delayMs?: number; scheduledAt?: string }
      ) => Promise<JobRecord>;
      list: () => Promise<JobRecord[]>;
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
        const record: ScheduledJob = {
          id: `job_${jobs.length}`,
          name,
          message,
          scheduledAt,
          subagents: [],
          status: "scheduled",
          createdAt: now,
          attemptCount: 0,
          maxAttempts: options.maxAttempts ?? 1,
          delayMs: options.delayMs,
        };
        jobs.push(record);
        return record;
      },
      async reschedule(jobId, options) {
        const job = jobs.find((item) => item.id === jobId);
        if (!job || job.status !== "scheduled") {
          throw new Error(`Cannot reschedule non-scheduled job ${jobId}`);
        }
        job.message = options.message ?? job.message;
        job.scheduledAt = options.scheduledAt
          ? new Date(options.scheduledAt).toISOString()
          : new Date(Date.parse(now) + (options.delayMs ?? 0)).toISOString();
        job.delayMs = options.delayMs;
        return job;
      },
      async list() {
        return jobs;
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

test("AssignmentWakeupPlanner promotes child assignment markers and schedules child execution", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T15:00:00.000Z";
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
      [
        "Split out Docker smoke verification.",
        'ASSIGNMENT_CHILD: {"objective":"Verify Docker release smoke path","title":"Docker smoke","rationale":"The release smoke path can proceed independently.","autonomyLevel":"evolve","waitForChild":true,"metadata":{"source":"planner-marker"}}',
        "ASSIGNMENT_STATUS: continue",
        "NEXT_WAKEUP_MINUTES: 9",
      ].join("\n"),
    ]),
  });
  const parent = assignments.create({
    objective: "Coordinate release readiness",
    autonomyLevel: "execute",
    policy: {
      wakeupDelayMinMinutes: 5,
      wakeupDelayMaxMinutes: 60,
      childAssignments: { maxDepth: 2, maxActiveChildren: 2 },
    },
  });

  const result = await planner.wakeNow({
    assignmentId: parent.assignment.id,
    actor: "scheduler",
    reason: "scheduled wakeup",
  });

  const children = assignments.list({
    parentAssignmentId: parent.assignment.id,
  });
  assert.equal(result.status, "scheduled");
  assert.equal(result.assignment.assignment.lifecycleState, "waiting");
  assert.equal(children.length, 1);
  assert.equal(children[0]?.objective, "Verify Docker release smoke path");
  assert.equal(children[0]?.title, "Docker smoke");
  assert.equal(children[0]?.autonomyLevel, "execute");
  assert.deepEqual(children[0]?.metadata, {
    source: "planner-marker",
    parentAssignmentId: parent.assignment.id,
    parentWaitsForChild: true,
  });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]?.name, ASSIGNMENT_WAKEUP_JOB_NAME);
  assert.equal(jobs[0]?.delayMs, 0);
  assert.deepEqual(JSON.parse(jobs[0]?.message ?? "{}"), {
    assignmentId: children[0]?.id,
    reason: "Planner promoted child assignment",
  });
  assert.equal(jobs[1]?.name, ASSIGNMENT_WAKEUP_JOB_NAME);
  assert.equal(jobs[1]?.delayMs, 9 * 60_000);
  assert.deepEqual(JSON.parse(jobs[1]?.message ?? "{}"), {
    assignmentId: parent.assignment.id,
    reason: "Waiting for child assignment",
  });
  assert.match(
    (await runs.get("coord_wakeup_1"))?.objective ?? "",
    /ASSIGNMENT_CHILD/
  );
  assert.doesNotMatch(
    (await runs.get("coord_wakeup_1"))?.objective ?? "",
    /ASSIGNMENT_MUTATION/
  );
  assert.deepEqual(
    assignments
      .timeline(parent.assignment.id)
      .events.map((event) => event.type),
    [
      "created",
      "wakeup_started",
      "run_linked",
      "wakeup_run_completed",
      "child_assignment_created",
      "wakeup_scheduled",
    ]
  );

  const parentFollowupJob = jobs[1];
  assert.ok(parentFollowupJob);
  parentFollowupJob.status = "running";
  await planner.handleScheduledWakeup({
    ...parentFollowupJob,
  });
  assert.equal(
    assignments.getRequired(parent.assignment.id).assignment.wakeupCount,
    1
  );
  assert.equal(jobs.length, 3);
  assert.deepEqual(JSON.parse(jobs[2]?.message ?? "{}"), {
    assignmentId: parent.assignment.id,
    reason: "Waiting for active child assignment",
  });
});

test("AssignmentWakeupPlanner keeps waiting parents parked while waited-on children are active", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:00:00.000Z";
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
      'ASSIGNMENT_STATUS: continue\nASSIGNMENT_CHILD: {"objective":"Investigate child path","rationale":"Parallel work","waitForChild":true,"policy":{"maxWakeups":2}}\nNEXT_WAKEUP_MINUTES: 9',
      "ASSIGNMENT_STATUS: continue\nNEXT_WAKEUP_MINUTES: 9",
    ]),
  });
  const parent = assignments.create({
    objective: "Coordinate parallel work",
    autonomyLevel: "execute",
    policy: {
      maxWakeups: 10,
      childAssignments: { maxDepth: 1, maxActiveChildren: 1 },
    },
  });

  await planner.wakeNow({ assignmentId: parent.assignment.id });
  const parentFollowupJob = jobs[1];
  assert.ok(parentFollowupJob);
  parentFollowupJob.status = "running";
  await planner.handleScheduledWakeup({
    ...parentFollowupJob,
  });

  assert.equal(
    assignments.getRequired(parent.assignment.id).assignment.wakeupCount,
    1
  );
  assert.equal(jobs.length, 3);
  assert.deepEqual(JSON.parse(jobs[2]?.message ?? "{}"), {
    assignmentId: parent.assignment.id,
    reason: "Waiting for active child assignment",
  });
});

test("AssignmentWakeupPlanner activates dependent children after dependencies complete", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:30:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, ["ASSIGNMENT_STATUS: complete"]),
  });
  const parent = assignments.create({
    objective: "Coordinate dependent child work",
    autonomyLevel: "execute",
    policy: {
      maxWakeups: 10,
      childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
    },
  });
  const prerequisite = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Produce prerequisite evidence",
    rationale: "Needed before the dependent child can run.",
    waitForChild: true,
    policy: { maxWakeups: 2 },
  });
  const dependent = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Run dependent verification",
    rationale: "Runs after prerequisite evidence exists.",
    waitForChild: true,
    dependsOnChildIds: [prerequisite.child.assignment.id],
    waitForChildren: "all",
    policy: { maxWakeups: 2 },
  });

  const parked = await planner.wakeNow({
    assignmentId: dependent.child.assignment.id,
    reason: "dependency check",
  });
  assert.equal(parked.status, "scheduled");
  assert.equal(
    assignments.getRequired(dependent.child.assignment.id).assignment
      .wakeupCount,
    0
  );
  assert.deepEqual(JSON.parse(jobs[0]?.message ?? "{}"), {
    assignmentId: dependent.child.assignment.id,
    reason: "Waiting for child assignment dependencies",
  });

  const result = await planner.wakeNow({
    assignmentId: prerequisite.child.assignment.id,
    reason: "finish prerequisite",
  });

  assert.equal(result.status, "completed");
  assert.equal(
    assignments.getRequired(dependent.child.assignment.id).assignment
      .lifecycleState,
    "active"
  );
  assert.equal(jobs.length, 1);
  assert.deepEqual(JSON.parse(jobs[0]?.message ?? "{}"), {
    assignmentId: dependent.child.assignment.id,
    reason: "Child assignment dependencies satisfied",
  });
});

test("AssignmentWakeupPlanner schedules every child activated by the same dependency", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:35:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, ["ASSIGNMENT_STATUS: complete"]),
  });
  const parent = assignments.create({
    objective: "Coordinate multiple dependent children",
    autonomyLevel: "execute",
    policy: {
      maxWakeups: 10,
      childAssignments: { maxDepth: 1, maxActiveChildren: 4 },
    },
  });
  const prerequisite = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Produce shared prerequisite evidence",
    rationale: "Multiple children wait for this same dependency.",
    waitForChild: true,
    policy: { maxWakeups: 2 },
  });
  const firstDependent = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Run first dependent verification",
    rationale: "Runs after prerequisite evidence exists.",
    waitForChild: true,
    dependsOnChildIds: [prerequisite.child.assignment.id],
    waitForChildren: "all",
    policy: { maxWakeups: 2 },
  });
  const secondDependent = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Run second dependent verification",
    rationale: "Also runs after prerequisite evidence exists.",
    waitForChild: true,
    dependsOnChildIds: [prerequisite.child.assignment.id],
    waitForChildren: "all",
    policy: { maxWakeups: 2 },
  });

  const result = await planner.wakeNow({
    assignmentId: prerequisite.child.assignment.id,
    reason: "finish prerequisite",
  });

  assert.equal(result.status, "completed");
  assert.equal(
    assignments.getRequired(firstDependent.child.assignment.id).assignment
      .lifecycleState,
    "active"
  );
  assert.equal(
    assignments.getRequired(secondDependent.child.assignment.id).assignment
      .lifecycleState,
    "active"
  );
  assert.deepEqual(
    jobs
      .map((job) => JSON.parse(job.message) as { assignmentId: string })
      .map((message) => message.assignmentId)
      .sort(),
    [
      firstDependent.child.assignment.id,
      secondDependent.child.assignment.id,
    ].sort()
  );
});

test("AssignmentWakeupPlanner does not requeue stale dependency continuation jobs", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:45:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, ["ASSIGNMENT_STATUS: complete"]),
  });
  const parent = assignments.create({
    objective: "Coordinate stale dependency job handling",
    autonomyLevel: "execute",
    policy: {
      maxWakeups: 10,
      childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
    },
  });
  const prerequisite = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Produce prerequisite evidence",
    rationale: "Needed before the dependent child can run.",
    waitForChild: true,
    policy: { maxWakeups: 2 },
  });
  const dependent = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Run dependent verification",
    rationale: "Runs after prerequisite evidence exists.",
    waitForChild: true,
    dependsOnChildIds: [prerequisite.child.assignment.id],
    waitForChildren: "all",
    policy: { maxWakeups: 2 },
  });

  await planner.wakeNow({
    assignmentId: dependent.child.assignment.id,
    reason: "dependency check",
  });
  await planner.wakeNow({
    assignmentId: prerequisite.child.assignment.id,
    reason: "finish prerequisite",
  });
  assert.equal(jobs.length, 1);
  assert.deepEqual(JSON.parse(jobs[0]?.message ?? "{}"), {
    assignmentId: dependent.child.assignment.id,
    reason: "Child assignment dependencies satisfied",
  });

  assignments.control(prerequisite.child.assignment.id, {
    action: "reopen",
    reason: "Prerequisite needs rework",
  });
  assert.equal(
    assignments.getRequired(dependent.child.assignment.id).assignment
      .lifecycleState,
    "waiting"
  );

  const staleJob = jobs[0];
  assert.ok(staleJob);
  staleJob.status = "running";
  await planner.handleScheduledWakeup({ ...staleJob });

  assert.equal(
    assignments.getRequired(dependent.child.assignment.id).assignment
      .wakeupCount,
    0
  );
  assert.equal(jobs.length, 1);
});

test("AssignmentWakeupPlanner blocks dependent children after required dependencies fail", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T13:00:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, ["ASSIGNMENT_STATUS: blocked"]),
  });
  const parent = assignments.create({
    objective: "Coordinate failing dependent child work",
    autonomyLevel: "execute",
    policy: {
      maxWakeups: 10,
      childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
    },
  });
  const prerequisite = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Produce prerequisite evidence",
    rationale: "May fail before dependent child runs.",
    waitForChild: true,
    policy: { maxWakeups: 2 },
  });
  const dependent = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Run dependent verification",
    rationale: "Should block when its dependency blocks.",
    waitForChild: true,
    dependsOnChildIds: [prerequisite.child.assignment.id],
    waitForChildren: "all",
    policy: { maxWakeups: 2 },
  });

  const result = await planner.wakeNow({
    assignmentId: prerequisite.child.assignment.id,
    reason: "dependency blocks",
  });

  assert.equal(result.status, "blocked");
  const blocked = assignments.getRequired(dependent.child.assignment.id);
  assert.equal(blocked.assignment.lifecycleState, "blocked");
  assert.equal(jobs.length, 1);
  assert.deepEqual(JSON.parse(jobs[0]?.message ?? "{}"), {
    assignmentId: parent.assignment.id,
    reason: "Waited child assignments satisfied",
  });
  assert.ok(
    assignments
      .timeline(dependent.child.assignment.id)
      .events.some(
        (event) =>
          event.type === "blocked" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          !Array.isArray(event.payload) &&
          event.payload.reason ===
            "Required child assignment dependency failed"
      )
  );
});

test("AssignmentWakeupPlanner leaves parent scheduling unchanged after background child completion", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T13:30:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, ["ASSIGNMENT_STATUS: complete"]),
  });
  const parent = assignments.create({
    objective: "Coordinate background child work",
    autonomyLevel: "execute",
    policy: {
      maxWakeups: 10,
      wakeupDelayMinMinutes: 1,
      wakeupDelayMaxMinutes: 240,
      childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
    },
  });
  const background = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Run background verification",
    rationale: "This child should not wake the parent when done.",
    waitForChild: false,
    policy: { maxWakeups: 2 },
  });
  await planner.scheduleNext({
    assignmentId: parent.assignment.id,
    reason: "normal parent cadence",
    delayMinutes: 120,
  });

  const result = await planner.wakeNow({
    assignmentId: background.child.assignment.id,
    reason: "finish background child",
  });

  assert.equal(result.status, "completed");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.delayMs, 120 * 60 * 1000);
  assert.deepEqual(JSON.parse(jobs[0]?.message ?? "{}"), {
    assignmentId: parent.assignment.id,
    reason: "normal parent cadence",
  });
});

test("AssignmentWakeupPlanner wakes waited parents with long prior timelines", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T13:45:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, ["ASSIGNMENT_STATUS: complete"]),
  });
  const parent = assignments.create({
    objective: "Coordinate waited child after long history",
    autonomyLevel: "execute",
    policy: {
      maxWakeups: 10,
      childAssignments: { maxDepth: 1, maxActiveChildren: 1 },
    },
  });
  for (let index = 0; index < 55; index += 1) {
    assignments.control(parent.assignment.id, {
      action: "add_context",
      context: {
        content: `prior event ${index}`,
        importance: "low",
      },
    });
  }
  const child = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Finish waited child",
    rationale: "The parent should wake after this waited child completes.",
    waitForChild: true,
    policy: { maxWakeups: 2 },
  });
  assignments.applyWakeupDecision({
    assignmentId: parent.assignment.id,
    decision: "waiting",
    reason: "Planner promoted child assignment",
  });
  for (let index = 0; index < 55; index += 1) {
    assignments.control(parent.assignment.id, {
      action: "add_context",
      context: {
        content: `later event ${index}`,
        importance: "low",
      },
    });
  }

  const result = await planner.wakeNow({
    assignmentId: child.child.assignment.id,
    reason: "finish waited child",
  });

  assert.equal(result.status, "completed");
  assert.equal(jobs.length, 1);
  assert.deepEqual(JSON.parse(jobs[0]?.message ?? "{}"), {
    assignmentId: parent.assignment.id,
    reason: "Waited child assignments satisfied",
  });
});

test("AssignmentWakeupPlanner wakes tight-budget parents after waited children block", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T14:00:00.000Z";
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
      "ASSIGNMENT_STATUS: blocked",
      "ASSIGNMENT_STATUS: complete",
    ]),
  });
  const parent = assignments.create({
    objective: "Coordinate tight-budget waited child work",
    autonomyLevel: "execute",
    policy: {
      maxWakeups: 1,
      childAssignments: { maxDepth: 1, maxActiveChildren: 1 },
    },
  });
  const child = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Waited child may block",
    rationale: "The parent should wake after the child blocks.",
    waitForChild: true,
    policy: { maxWakeups: 1 },
  });

  const childResult = await planner.wakeNow({
    assignmentId: child.child.assignment.id,
    reason: "child blocks",
  });
  assert.equal(childResult.status, "blocked");
  assert.deepEqual(JSON.parse(jobs[0]?.message ?? "{}"), {
    assignmentId: parent.assignment.id,
    reason: "Waited child assignments satisfied",
  });

  const parentResult = await planner.wakeNow({
    assignmentId: parent.assignment.id,
    reason: "inspect blocked child",
  });
  assert.equal(parentResult.status, "completed");
});

test("AssignmentWakeupPlanner does not wake operator-paused parents after waited children finish", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T14:15:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, ["ASSIGNMENT_STATUS: complete"]),
  });
  const parent = assignments.create({
    objective: "Paused parent should stay paused",
    policy: {
      maxWakeups: 5,
      childAssignments: { maxDepth: 1, maxActiveChildren: 1 },
    },
  });
  const child = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Waited child",
    rationale: "Parent waits on this child.",
    waitForChild: true,
    policy: { maxWakeups: 1 },
  });
  const parkedParentJob = await planner.scheduleNext({
    assignmentId: parent.assignment.id,
    reason: "Waiting for child assignment",
    delayMinutes: 120,
  });
  assignments.control(parent.assignment.id, {
    action: "pause",
    reason: "Operator pause",
  });
  assignments.applyWakeupDecision({
    assignmentId: child.child.assignment.id,
    decision: "completed",
    reason: "Child completed",
  });

  await planner.scheduleDependencyContinuationsForAssignment(
    child.child.assignment.id
  );

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.id, parkedParentJob.id);
  assert.deepEqual(JSON.parse(jobs[0]?.message ?? "{}"), {
    assignmentId: parent.assignment.id,
    reason: "Waiting for child assignment",
  });
  assert.equal(
    assignments.getRequired(parent.assignment.id).assignment.lifecycleState,
    "waiting"
  );
});

test("AssignmentWakeupPlanner does not schedule terminal parents after waited children finish", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T14:20:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, ["ASSIGNMENT_STATUS: complete"]),
  });
  const parent = assignments.create({
    objective: "Terminal parent should stay terminal",
    policy: {
      maxWakeups: 5,
      childAssignments: { maxDepth: 1, maxActiveChildren: 1 },
    },
  });
  const child = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Waited child",
    rationale: "Parent would have waited on this child.",
    waitForChild: true,
    policy: { maxWakeups: 1 },
  });
  assignments.control(parent.assignment.id, {
    action: "cancel",
    reason: "Operator cancelled parent",
  });
  assignments.applyWakeupDecision({
    assignmentId: child.child.assignment.id,
    decision: "completed",
    reason: "Child completed",
  });

  await planner.scheduleDependencyContinuationsForAssignment(
    child.child.assignment.id
  );

  assert.equal(jobs.length, 0);
  assert.equal(
    assignments.getRequired(parent.assignment.id).assignment.lifecycleState,
    "cancelled"
  );
});

test("AssignmentWakeupPlanner does not schedule planner children born blocked", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T14:30:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const parent = assignments.create({
    objective: "Coordinate blocked planner child",
    autonomyLevel: "execute",
    policy: {
      maxWakeups: 10,
      childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
    },
  });
  const prerequisite = assignments.promoteChild({
    parentAssignmentId: parent.assignment.id,
    objective: "Prerequisite that already failed",
    rationale: "Planner will create a child depending on it.",
    waitForChild: true,
    policy: { maxWakeups: 2 },
  });
  assignments.applyWakeupDecision({
    assignmentId: prerequisite.child.assignment.id,
    decision: "failed",
    reason: "Prerequisite failed before planner marker",
  });
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      `ASSIGNMENT_STATUS: continue\nASSIGNMENT_CHILD: {"objective":"Run impossible dependent child","rationale":"Should block immediately.","waitForChild":true,"dependsOnChildIds":["${prerequisite.child.assignment.id}"],"waitForChildren":"all"}`,
    ]),
  });

  const result = await planner.wakeNow({
    assignmentId: parent.assignment.id,
    reason: "parent emits impossible child",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(jobs.length, 1);
  assert.deepEqual(JSON.parse(jobs[0]?.message ?? "{}"), {
    assignmentId: parent.assignment.id,
    reason: "Waited child assignments satisfied",
  });
  const children = assignments.list({
    parentAssignmentId: parent.assignment.id,
    limit: 10,
  });
  const blockedChild = children.find(
    (child) => child.objective === "Run impossible dependent child"
  );
  assert.equal(blockedChild?.lifecycleState, "blocked");
});

test("AssignmentWakeupPlanner applies allowed autonomous mutation markers through the executor", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:00:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
  });
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Adjusted settings.",
        'ASSIGNMENT_MUTATION: {"target":"configuration","mutationType":"operator_settings","rationale":"Slow down refresh during autonomous work.","proposedChange":{"operatorSettings":{"dashboardRefreshSeconds":13}}}',
        "ASSIGNMENT_STATUS: continue",
        "NEXT_WAKEUP_MINUTES: 8",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should tune operator settings",
    autonomyLevel: "evolve",
    policy: { wakeupDelayMinMinutes: 5, wakeupDelayMaxMinutes: 60 },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    actor: "scheduler",
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(settings.get().dashboardRefreshSeconds, 13);
  assert.equal(jobs[0]?.delayMs, 8 * 60_000);
  const mutations = ledger.list({ assignmentId: assignment.assignment.id });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.status, "applied");
  assert.equal(mutations[0]?.runId, "coord_wakeup_1");
  assert.equal(mutations[0]?.mutationType, "operator_settings");
  assert.deepEqual(mutations[0]?.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: ["configuration.operator_settings"],
    mutationClass: "configuration.operator_settings",
    actor: "planner",
  });
  assert.deepEqual(
    assignments
      .timeline(assignment.assignment.id)
      .events.map((event) => event.type),
    [
      "created",
      "wakeup_started",
      "run_linked",
      "wakeup_run_completed",
      "mutation_planned",
      "mutation_applied",
      "wakeup_scheduled",
    ]
  );
});

test("AssignmentWakeupPlanner applies explicitly allowed assignment policy mutation markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:30:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
  });
  const runs = new RunGraphStore(database);
  const { scheduler } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Widened wakeup budget.",
        'ASSIGNMENT_MUTATION: {"target":"configuration","mutationType":"assignment_policy","rationale":"Give this assignment more wakeups.","proposedChange":{"assignmentPolicy":{"maxWakeups":7}}}',
        "ASSIGNMENT_STATUS: complete",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should tune assignment policy",
    autonomyLevel: "evolve",
    policy: {
      maxWakeups: 4,
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.assignment_policy",
        ],
      },
    },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    actor: "scheduler",
    reason: "scheduled wakeup",
  });

  const updated = assignments.getRequired(assignment.assignment.id).assignment;
  assert.equal(result.status, "completed");
  assert.equal(updated.policy.maxWakeups, 7);
  assert.deepEqual(updated.policy.selfEvolution.allowedMutationClasses, [
    "configuration.operator_settings",
    "configuration.assignment_policy",
  ]);
  const mutations = ledger.list({ assignmentId: assignment.assignment.id });
  assert.equal(mutations[0]?.status, "applied");
  assert.equal(mutations[0]?.mutationType, "assignment_policy");
  assert.equal(mutations[0]?.runId, "coord_wakeup_1");
});

test("AssignmentWakeupPlanner applies explicitly allowed runtime config limit mutation markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:35:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const config = makeConfig();
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const runtimeConfigLimits = new RuntimeConfigLimitsStore(database, config);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    runtimeConfigLimits,
  });
  const runs = new RunGraphStore(database);
  const { scheduler } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Adjusted runtime limits.",
        'ASSIGNMENT_MUTATION: {"target":"configuration","mutationType":"runtime_limits","rationale":"Allow a longer next run.","proposedChange":{"runtimeLimits":{"defaultRunTimeoutMs":45000}}}',
        "ASSIGNMENT_STATUS: continue",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should tune runtime config limits",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.runtime_limits",
        ],
      },
    },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    actor: "scheduler",
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(config.defaultRunTimeoutMs, 45_000);
  const mutations = ledger.list({ assignmentId: assignment.assignment.id });
  assert.equal(mutations[0]?.status, "applied");
  assert.equal(mutations[0]?.mutationType, "runtime_limits");
  assert.equal(mutations[0]?.runId, "coord_wakeup_1");
  assert.deepEqual(mutations[0]?.affectedResources, [
    { type: "runtime_config", id: "limits" },
  ]);
});

test("AssignmentWakeupPlanner applies explicitly allowed prompt runtime guidance mutation markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:40:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const promptGuidance = new PromptRuntimeGuidanceStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    promptGuidance,
  });
  const runs = new RunGraphStore(database);
  const { scheduler } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Tightened runtime guidance.",
        'ASSIGNMENT_MUTATION: {"target":"prompt","mutationType":"runtime_guidance","rationale":"Prefer evidence-first wakeup summaries.","proposedChange":{"runtimeGuidance":{"text":"Prefer evidence-first wakeup summaries."}}}',
        "ASSIGNMENT_STATUS: complete",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should tune prompt runtime guidance",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "prompt.runtime_guidance",
        ],
      },
    },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    actor: "scheduler",
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "completed");
  assert.equal(
    promptGuidance.get().text,
    "Prefer evidence-first wakeup summaries."
  );
  const mutations = ledger.list({ assignmentId: assignment.assignment.id });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.status, "applied");
  assert.equal(mutations[0]?.target, "prompt");
  assert.equal(mutations[0]?.mutationType, "runtime_guidance");
  assert.equal(mutations[0]?.runId, "coord_wakeup_1");
  assert.deepEqual(mutations[0]?.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "prompt.runtime_guidance",
    ],
    mutationClass: "prompt.runtime_guidance",
    actor: "planner",
  });
});

test("AssignmentWakeupPlanner applies explicitly allowed managed prompt fragment mutation markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:41:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const promptFragments = new PromptManagedFragmentStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    promptFragments,
  });
  const runs = new RunGraphStore(database);
  const { scheduler } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Tightened managed prompt fragment.",
        'ASSIGNMENT_MUTATION: {"target":"prompt","mutationType":"managed_fragment","riskClass":"high","rationale":"Prefer evidence-first wakeup summaries.","proposedChange":{"promptFragment":{"id":"tone","mode":"upsert","text":"Prefer evidence-first wakeup summaries."}}}',
        "ASSIGNMENT_STATUS: complete",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should tune managed prompt fragments",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "prompt.managed_fragment",
        ],
        maxRiskClass: "high",
      },
    },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    actor: "scheduler",
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(promptFragments.get("tone"), {
    id: "tone",
    text: "Prefer evidence-first wakeup summaries.",
    active: true,
  });
  const mutations = ledger.list({ assignmentId: assignment.assignment.id });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.status, "applied");
  assert.equal(mutations[0]?.target, "prompt");
  assert.equal(mutations[0]?.mutationType, "managed_fragment");
  assert.equal(mutations[0]?.runId, "coord_wakeup_1");
  assert.deepEqual(mutations[0]?.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "high",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "prompt.managed_fragment",
    ],
    mutationClass: "prompt.managed_fragment",
    actor: "planner",
  });
});

test("AssignmentWakeupPlanner applies explicitly allowed memory policy mutation markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:42:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const memoryPolicy = new MemoryPolicyStore(database, makeConfig());
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    memoryPolicy,
  });
  const runs = new RunGraphStore(database);
  const { scheduler } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Reduced memory retrieval bounds.",
        'ASSIGNMENT_MUTATION: {"target":"memory_policy","mutationType":"runtime_bounds","rationale":"Reduce memory context for this work.","proposedChange":{"memoryPolicy":{"memoryPerCategoryLimit":1,"memorySummaryLimit":1}}}',
        "ASSIGNMENT_STATUS: complete",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should tune memory policy",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "memory_policy.runtime_bounds",
        ],
      },
    },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    actor: "scheduler",
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "completed");
  assert.equal(memoryPolicy.get().memoryPerCategoryLimit, 1);
  assert.equal(memoryPolicy.get().memorySummaryLimit, 1);
  const mutations = ledger.list({ assignmentId: assignment.assignment.id });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.status, "applied");
  assert.equal(mutations[0]?.target, "memory_policy");
  assert.equal(mutations[0]?.mutationType, "runtime_bounds");
  assert.equal(mutations[0]?.runId, "coord_wakeup_1");
  assert.deepEqual(mutations[0]?.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "memory_policy.runtime_bounds",
    ],
    mutationClass: "memory_policy.runtime_bounds",
    actor: "planner",
  });
});

test("AssignmentWakeupPlanner applies explicitly allowed role policy mutation markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:42:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const rolePolicy = new RolePolicyRuntimeStore(
    database,
    loadRolePolicyConfig(makeConfig().roleConfigPath)
  );
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    rolePolicy,
  });
  const runs = new RunGraphStore(database);
  const { scheduler } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Narrowed explorer role permissions.",
        'ASSIGNMENT_MUTATION: {"target":"role","mutationType":"permission_policy","rationale":"Limit explorer subagents to docs reads.","proposedChange":{"rolePolicy":{"roles":{"explorer":{"fileGlobs":["docs/**/*"],"allowedToolIds":["echo.summary"],"allowedMcpServers":["docs"]}}}}}',
        "ASSIGNMENT_STATUS: complete",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should tune role policy",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "role.permission_policy",
        ],
      },
    },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    actor: "scheduler",
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(rolePolicy.get().overrides.explorer, {
    fileGlobs: ["docs/**/*"],
    allowedToolIds: ["echo.summary"],
    allowedMcpServers: ["docs"],
  });
  const mutations = ledger.list({ assignmentId: assignment.assignment.id });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.status, "applied");
  assert.equal(mutations[0]?.target, "role");
  assert.equal(mutations[0]?.mutationType, "permission_policy");
  assert.equal(mutations[0]?.runId, "coord_wakeup_1");
  assert.deepEqual(mutations[0]?.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "role.permission_policy",
    ],
    mutationClass: "role.permission_policy",
    actor: "planner",
  });
});

test("AssignmentWakeupPlanner applies explicitly allowed project file draft mutation markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:44:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const projectFileDrafts = new ProjectFileDraftStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    projectFileDrafts,
  });
  const runs = new RunGraphStore(database);
  const { scheduler } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Drafted a project file for operator review.",
        'ASSIGNMENT_MUTATION: {"target":"project_file","mutationType":"draft","rationale":"Draft docs for review without filesystem writes.","proposedChange":{"projectFileDraft":{"path":"docs/planner-project-file-draft.md","content":"# Planner Draft\\n","contentType":"text/markdown"}}}',
        "ASSIGNMENT_STATUS: complete",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should draft project file",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "project_file.draft",
        ],
      },
    },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    actor: "scheduler",
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "completed");
  const drafts = projectFileDrafts.list({
    assignmentId: assignment.assignment.id,
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.path, "docs/planner-project-file-draft.md");
  assert.equal(drafts[0]?.content, "# Planner Draft\n");
  const mutations = ledger.list({ assignmentId: assignment.assignment.id });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.status, "applied");
  assert.equal(mutations[0]?.target, "project_file");
  assert.equal(mutations[0]?.mutationType, "draft");
  assert.equal(mutations[0]?.runId, "coord_wakeup_1");
  assert.deepEqual(mutations[0]?.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "project_file.draft",
    ],
    mutationClass: "project_file.draft",
    actor: "planner",
  });
});

test("AssignmentWakeupPlanner applies explicitly allowed project file apply draft mutation markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:44:30.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const targetPath = join(process.cwd(), "docs/planner-project-file-apply.md");
  const database = new AppDatabase(":memory:");
  t.after(() => {
    if (existsSync(targetPath)) {
      unlinkSync(targetPath);
    }
    database.close();
  });
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const projectFileDrafts = new ProjectFileDraftStore(database);
  const projectFileApply = new ProjectFileApplyService({
    repoRoot: process.cwd(),
  });
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    projectFileDrafts,
    projectFileApply,
  });
  const runs = new RunGraphStore(database);
  const { scheduler } = makeScheduler(now);
  const assignment = assignments.create({
    objective: "Planner should apply a project file draft",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "project_file.apply_draft",
        ],
        maxRiskClass: "high",
      },
    },
  });
  const draft = projectFileDrafts.create({
    assignmentId: assignment.assignment.id,
    path: "docs/planner-project-file-apply.md",
    content: "# Planner Apply\n",
    contentType: "text/markdown",
  });
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Applied a reviewed project file draft.",
        `ASSIGNMENT_MUTATION: {"target":"project_file","mutationType":"apply_draft","riskClass":"high","rationale":"Apply reviewed project file draft.","proposedChange":{"projectFileApply":{"draftId":"${draft.id}"}}}`,
        "ASSIGNMENT_STATUS: complete",
      ].join("\n"),
    ]),
    mutations: executor,
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    actor: "scheduler",
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "completed");
  assert.equal(readFileSync(targetPath, "utf8"), "# Planner Apply\n");
  assert.equal(projectFileDrafts.get(draft.id)?.status, "applied");
  const mutations = ledger.list({ assignmentId: assignment.assignment.id });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.status, "applied");
  assert.equal(mutations[0]?.target, "project_file");
  assert.equal(mutations[0]?.mutationType, "apply_draft");
  assert.equal(mutations[0]?.runId, "coord_wakeup_1");
  assert.deepEqual(mutations[0]?.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "high",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "project_file.apply_draft",
    ],
    mutationClass: "project_file.apply_draft",
    actor: "planner",
  });
});

test("AssignmentWakeupPlanner applies explicitly allowed project file apply bundle mutation markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:44:45.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const firstPath = join(
    process.cwd(),
    "docs/planner-project-file-bundle-a.md"
  );
  const secondPath = join(
    process.cwd(),
    "docs/planner-project-file-bundle-b.md"
  );
  const database = new AppDatabase(":memory:");
  t.after(() => {
    if (existsSync(firstPath)) {
      unlinkSync(firstPath);
    }
    if (existsSync(secondPath)) {
      unlinkSync(secondPath);
    }
    database.close();
  });
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const projectFileDrafts = new ProjectFileDraftStore(database);
  const projectFileApply = new ProjectFileApplyService({
    repoRoot: process.cwd(),
  });
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    projectFileDrafts,
    projectFileApply,
  });
  const runs = new RunGraphStore(database);
  const { scheduler } = makeScheduler(now);
  const assignment = assignments.create({
    objective: "Planner should apply a project file draft bundle",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "project_file.apply_bundle",
        ],
        maxRiskClass: "high",
      },
    },
  });
  const firstDraft = projectFileDrafts.create({
    assignmentId: assignment.assignment.id,
    path: "docs/planner-project-file-bundle-a.md",
    content: "# Planner Bundle A\n",
    contentType: "text/markdown",
  });
  const secondDraft = projectFileDrafts.create({
    assignmentId: assignment.assignment.id,
    path: "docs/planner-project-file-bundle-b.md",
    content: "# Planner Bundle B\n",
    contentType: "text/markdown",
  });
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Applied reviewed project file drafts.",
        `ASSIGNMENT_MUTATION: {"target":"project_file","mutationType":"apply_bundle","riskClass":"high","rationale":"Apply reviewed project file drafts.","proposedChange":{"projectFileBundle":{"draftIds":["${firstDraft.id}","${secondDraft.id}"]}}}`,
        "ASSIGNMENT_STATUS: complete",
      ].join("\n"),
    ]),
    mutations: executor,
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    actor: "scheduler",
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "completed");
  assert.equal(readFileSync(firstPath, "utf8"), "# Planner Bundle A\n");
  assert.equal(readFileSync(secondPath, "utf8"), "# Planner Bundle B\n");
  assert.equal(projectFileDrafts.get(firstDraft.id)?.status, "applied");
  assert.equal(projectFileDrafts.get(secondDraft.id)?.status, "applied");
  const mutations = ledger.list({ assignmentId: assignment.assignment.id });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.status, "applied");
  assert.equal(mutations[0]?.target, "project_file");
  assert.equal(mutations[0]?.mutationType, "apply_bundle");
  assert.equal(mutations[0]?.runId, "coord_wakeup_1");
  assert.deepEqual(mutations[0]?.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "high",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "project_file.apply_bundle",
    ],
    mutationClass: "project_file.apply_bundle",
    actor: "planner",
  });
});

test("AssignmentWakeupPlanner uses planner-updated assignment policy for continuation decisions", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:45:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
  });
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Need one more wakeup after widening the budget.",
        'ASSIGNMENT_MUTATION: {"target":"configuration","mutationType":"assignment_policy","rationale":"Allow one more wakeup for verification.","proposedChange":{"assignmentPolicy":{"maxWakeups":2}}}',
        "ASSIGNMENT_STATUS: continue",
        "NEXT_WAKEUP_MINUTES: 9",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should use updated maxWakeups before expiring",
    autonomyLevel: "evolve",
    policy: {
      maxWakeups: 1,
      wakeupDelayMinMinutes: 5,
      wakeupDelayMaxMinutes: 60,
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.assignment_policy",
        ],
      },
    },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    actor: "scheduler",
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(jobs[0]?.delayMs, 9 * 60_000);
  const updated = assignments.getRequired(assignment.assignment.id).assignment;
  assert.equal(updated.policy.maxWakeups, 2);
  assert.equal(updated.lifecycleState, "waiting");
  const mutations = ledger.list({ assignmentId: assignment.assignment.id });
  assert.equal(mutations[0]?.status, "applied");
  assert.equal(mutations[0]?.mutationType, "assignment_policy");
});

test("AssignmentWakeupPlanner applies explicitly allowed tool bundle mutation markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T12:45:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const tools = new ToolRegistry();
  const dynamicTools = new DynamicToolRegistry(database, tools);
  const toolBundles = new ToolBundleImportStore(database);
  const toolBundleLifecycle = new ToolBundleLifecycleService({
    toolBundles,
    dynamicTools,
  });
  const preview = toolBundles.preview({
    importedBy: "operator",
    manifest: {
      id: "internal.planner",
      name: "Planner Internal Tools",
      version: "1.0.0",
      tools: [
        {
          id: "internal.planner.lookup",
          description: "Lookup planner evidence.",
          scopes: ["read"],
          responseTemplate: "planner",
        },
      ],
    },
  });
  const approved = toolBundles.approve(
    preview.id,
    "operator",
    "read-only planner bundle"
  );
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    toolBundles: toolBundleLifecycle,
  });
  const runs = new RunGraphStore(database);
  const { scheduler } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Enabled read-only bundle.",
        `ASSIGNMENT_MUTATION: {"target":"tool","mutationType":"bundle_enable","rationale":"Enable approved read-only tool bundle.","proposedChange":{"toolBundle":{"importId":"${approved.id}"}}}`,
        "ASSIGNMENT_STATUS: complete",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should enable approved tool bundle",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "tool.bundle_enable",
        ],
      },
    },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    actor: "scheduler",
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "completed");
  assert.equal(tools.has("internal.planner.lookup"), true);
  assert.equal(toolBundles.get(approved.id)?.lifecycleState, "enabled");
  const mutations = ledger.list({ assignmentId: assignment.assignment.id });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.status, "applied");
  assert.equal(mutations[0]?.runId, "coord_wakeup_1");
  assert.equal(mutations[0]?.target, "tool");
  assert.equal(mutations[0]?.mutationType, "bundle_enable");
  assert.deepEqual(mutations[0]?.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "tool.bundle_enable",
    ],
    mutationClass: "tool.bundle_enable",
    actor: "planner",
  });
});

test("AssignmentWakeupPlanner records denied autonomous mutation markers without failing the wakeup", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T13:00:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
  });
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Tried to widen policy.",
        'ASSIGNMENT_MUTATION: {"target":"configuration","mutationType":"assignment_policy","rationale":"Try to widen wakeups.","proposedChange":{"assignmentPolicy":{"maxWakeups":9}}}',
        "ASSIGNMENT_STATUS: continue",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should fail denied assignment policy mutation",
    autonomyLevel: "evolve",
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(
    assignments.getRequired(assignment.assignment.id).assignment.policy
      .maxWakeups,
    5
  );
  assert.equal(jobs.length, 1);
  const mutations = ledger.list({ assignmentId: assignment.assignment.id });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.status, "failed");
  assert.equal(mutations[0]?.mutationType, "assignment_policy");
  assert.equal(
    mutations[0]?.errorMessage,
    "Assignment self-evolution policy does not allow configuration.assignment_policy"
  );
});

test("AssignmentWakeupPlanner ignores malformed autonomous mutation markers without failing the wakeup", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T13:30:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
  });
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Malformed mutation marker.",
        "ASSIGNMENT_MUTATION: {not-json}",
        "ASSIGNMENT_STATUS: continue",
        "NEXT_WAKEUP_MINUTES: 6",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should ignore malformed marker",
    autonomyLevel: "evolve",
    policy: { wakeupDelayMinMinutes: 5, wakeupDelayMaxMinutes: 60 },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(jobs[0]?.delayMs, 6 * 60_000);
  assert.deepEqual(ledger.list({ assignmentId: assignment.assignment.id }), []);
  assert.equal(settings.get().dashboardRefreshSeconds, 5);
});

test("AssignmentWakeupPlanner ignores unknown autonomous mutation targets without failing the wakeup", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T13:45:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
  });
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Mistyped mutation target.",
        'ASSIGNMENT_MUTATION: {"target":"settings","mutationType":"operator_settings","rationale":"Try a settings update.","proposedChange":{"operatorSettings":{"dashboardRefreshSeconds":11}}}',
        "ASSIGNMENT_STATUS: continue",
        "NEXT_WAKEUP_MINUTES: 7",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should ignore unknown mutation target",
    autonomyLevel: "evolve",
    policy: { wakeupDelayMinMinutes: 5, wakeupDelayMaxMinutes: 60 },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(jobs[0]?.delayMs, 7 * 60_000);
  assert.deepEqual(ledger.list({ assignmentId: assignment.assignment.id }), []);
  assert.equal(settings.get().dashboardRefreshSeconds, 5);
});

test("AssignmentWakeupPlanner does not invite non-evolve assignments to emit mutation markers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T14:00:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
  });
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, [
      [
        "Unexpected mutation marker despite no prompt.",
        'ASSIGNMENT_MUTATION: {"target":"configuration","mutationType":"operator_settings","rationale":"Try a settings update.","proposedChange":{"operatorSettings":{"dashboardRefreshSeconds":11}}}',
        "ASSIGNMENT_STATUS: continue",
        "NEXT_WAKEUP_MINUTES: 8",
      ].join("\n"),
    ]),
    mutations: executor,
  });
  const assignment = assignments.create({
    objective: "Planner should not invite execute-level mutation markers",
    autonomyLevel: "execute",
    policy: { wakeupDelayMinMinutes: 5, wakeupDelayMaxMinutes: 60 },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(jobs[0]?.delayMs, 8 * 60_000);
  assert.doesNotMatch(
    (await runs.get("coord_wakeup_1"))?.objective ?? "",
    /ASSIGNMENT_MUTATION/
  );
  assert.deepEqual(ledger.list({ assignmentId: assignment.assignment.id }), []);
  assert.equal(settings.get().dashboardRefreshSeconds, 5);
});

test("AssignmentWakeupPlanner ignores malformed child assignment markers without failing the wakeup", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T15:30:00.000Z";
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
      [
        "Malformed child marker.",
        "ASSIGNMENT_CHILD: {not-json}",
        "ASSIGNMENT_STATUS: continue",
        "NEXT_WAKEUP_MINUTES: 6",
      ].join("\n"),
    ]),
  });
  const assignment = assignments.create({
    objective: "Planner should ignore malformed child marker",
    autonomyLevel: "execute",
    policy: { wakeupDelayMinMinutes: 5, wakeupDelayMaxMinutes: 60 },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.delayMs, 6 * 60_000);
  assert.deepEqual(
    assignments.list({ parentAssignmentId: assignment.assignment.id }),
    []
  );
});

test("AssignmentWakeupPlanner rejects malformed child dependency markers without creating children", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T15:40:00.000Z";
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
      [
        "Malformed dependency marker.",
        'ASSIGNMENT_CHILD: {"objective":"Dependent work","rationale":"Invalid dependency shape should fail closed.","waitForChild":true,"dependsOnChildIds":"not-an-array"}',
        "ASSIGNMENT_STATUS: continue",
        "NEXT_WAKEUP_MINUTES: 6",
      ].join("\n"),
    ]),
  });
  const assignment = assignments.create({
    objective: "Planner should reject malformed dependency marker",
    autonomyLevel: "execute",
    policy: { wakeupDelayMinMinutes: 5, wakeupDelayMaxMinutes: 60 },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.delayMs, 6 * 60_000);
  assert.deepEqual(
    assignments.list({ parentAssignmentId: assignment.assignment.id }),
    []
  );
  assert.ok(
    assignments
      .timeline(assignment.assignment.id)
      .events.some((event) => event.type === "child_assignment_failed")
  );
});

test("AssignmentWakeupPlanner rejects child markers with unknown dependencies without failing the wakeup", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T15:42:00.000Z";
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
      [
        "Unknown dependency marker.",
        'ASSIGNMENT_CHILD: {"objective":"Dependent work","rationale":"Unknown dependency should fail closed.","waitForChild":true,"dependsOnChildIds":["asgn_missing"]}',
        "ASSIGNMENT_STATUS: continue",
        "NEXT_WAKEUP_MINUTES: 6",
      ].join("\n"),
    ]),
  });
  const assignment = assignments.create({
    objective: "Planner should reject unknown dependency marker",
    autonomyLevel: "execute",
    policy: { wakeupDelayMinMinutes: 5, wakeupDelayMaxMinutes: 60 },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.delayMs, 6 * 60_000);
  assert.deepEqual(
    assignments.list({ parentAssignmentId: assignment.assignment.id }),
    []
  );
  assert.ok(
    assignments
      .timeline(assignment.assignment.id)
      .events.some(
        (event) =>
          event.type === "child_assignment_failed" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          !Array.isArray(event.payload) &&
          String(event.payload.errorMessage).includes("not found")
      )
  );
  assert.equal(
    assignments
      .timeline(assignment.assignment.id)
      .events.some((event) => event.type === "wakeup_failed"),
    false
  );
});

test("AssignmentWakeupPlanner records rejected child assignment markers without failing the wakeup", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T15:45:00.000Z";
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
      [
        "Tried to split too much work.",
        'ASSIGNMENT_CHILD: {"objective":"Overflow child","rationale":"Too many active children already exist.","waitForChild":true}',
        "ASSIGNMENT_STATUS: continue",
        "NEXT_WAKEUP_MINUTES: 6",
      ].join("\n"),
    ]),
  });
  const assignment = assignments.create({
    objective: "Planner should audit rejected child marker",
    autonomyLevel: "execute",
    policy: {
      wakeupDelayMinMinutes: 5,
      wakeupDelayMaxMinutes: 60,
      childAssignments: { maxDepth: 2, maxActiveChildren: 1 },
    },
  });
  assignments.promoteChild({
    parentAssignmentId: assignment.assignment.id,
    objective: "Existing child",
    rationale: "Occupy the active child slot",
    policy: { maxWakeups: 1 },
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.delayMs, 6 * 60_000);
  assert.equal(
    assignments.list({ parentAssignmentId: assignment.assignment.id }).length,
    1
  );
  const failedEvent = assignments
    .timeline(assignment.assignment.id)
    .events.find((event) => event.type === "child_assignment_failed");
  assert.deepEqual(failedEvent?.payload, {
    actor: "planner",
    objective: "Overflow child",
    rationale: "Too many active children already exist.",
    errorMessage:
      "Parent assignment active child assignment limit has been reached",
  });
});

test("AssignmentWakeupPlanner can replace blocked children at active child limit", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-06-16T16:15:00.000Z";
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
      [
        "Replace the blocked child.",
        'ASSIGNMENT_CHILD: {"objective":"Replacement child","rationale":"Blocked child released the active slot.","waitForChild":true}',
        "ASSIGNMENT_STATUS: continue",
        "NEXT_WAKEUP_MINUTES: 6",
      ].join("\n"),
    ]),
  });
  const assignment = assignments.create({
    objective: "Planner should replace blocked child",
    autonomyLevel: "execute",
    policy: {
      wakeupDelayMinMinutes: 5,
      wakeupDelayMaxMinutes: 60,
      childAssignments: { maxDepth: 2, maxActiveChildren: 1 },
    },
  });
  const child = assignments.promoteChild({
    parentAssignmentId: assignment.assignment.id,
    objective: "Blocked child",
    rationale: "This child frees the active slot once blocked.",
    waitForChild: true,
    policy: { maxWakeups: 1 },
  });
  assignments.applyWakeupDecision({
    assignmentId: child.child.assignment.id,
    decision: "blocked",
    reason: "Child is blocked",
  });

  const result = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    reason: "scheduled wakeup",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(jobs.length, 2);
  const children = assignments.list({ parentAssignmentId: assignment.assignment.id });
  const replacement = children.find(
    (item) => item.objective === "Replacement child"
  );
  assert.ok(replacement);
  assert.deepEqual(
    jobs.map((job) => JSON.parse(job.message) as Record<string, string>),
    [
      {
        assignmentId: replacement.id,
        reason: "Planner promoted child assignment",
      },
      {
        assignmentId: assignment.assignment.id,
        reason: "Waiting for child assignment",
      },
    ]
  );
  assert.equal(children.length, 2);
  assert.equal(
    replacement.lifecycleState,
    "active"
  );
  assert.equal(
    assignments
      .timeline(assignment.assignment.id)
      .events.some((event) => event.type === "child_assignment_failed"),
    false
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

test("AssignmentWakeupPlanner clamps zero-minute coordinator wakeup requests", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-04-28T14:15:00.000Z";
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
      "Keep going.\nASSIGNMENT_STATUS: continue\nNEXT_WAKEUP_MINUTES: 0",
    ]),
  });
  const assignment = assignments.create({
    objective: "Clamp zero",
    policy: { wakeupDelayMinMinutes: 5, wakeupDelayMaxMinutes: 15 },
  });

  await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    reason: "run",
  });

  assert.equal(jobs[0]?.delayMs, 5 * 60_000);
});

test("AssignmentWakeupPlanner skips overlapping wakeups for the same assignment", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-04-28T14:30:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler } = makeScheduler(now);
  let runCount = 0;
  let releaseCoordinator: (() => void) | undefined;
  const coordinatorGate = new Promise<void>((resolve) => {
    releaseCoordinator = resolve;
  });
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: {
      async runCoordinator(input: { message: string }) {
        runCount += 1;
        await coordinatorGate;
        const runId = `coord_overlap_${runCount}`;
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
          summary: "ASSIGNMENT_STATUS: complete",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        return {
          sessionId: "session",
          runId,
          outputText: "ASSIGNMENT_STATUS: complete",
        };
      },
    } as unknown as OrchestrationService,
  });
  const assignment = assignments.create({ objective: "Avoid overlap" });

  const firstWakeup = planner.wakeNow({
    assignmentId: assignment.assignment.id,
    reason: "first",
  });
  const skippedWakeup = await planner.wakeNow({
    assignmentId: assignment.assignment.id,
    reason: "second",
  });
  assert.equal(skippedWakeup.status, "skipped");
  assert.equal(runCount, 1);

  releaseCoordinator?.();
  const completed = await firstWakeup;
  assert.equal(completed.status, "completed");
  assert.equal(runCount, 1);
  assert.equal(
    assignments.getRequired(assignment.assignment.id).assignment.wakeupCount,
    1
  );
});

test("AssignmentWakeupPlanner reuses pending wakeup jobs for the same assignment", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-04-28T15:00:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, []),
  });
  const assignment = assignments.create({ objective: "Deduplicate jobs" });

  const first = await planner.scheduleNext({
    assignmentId: assignment.assignment.id,
    reason: "first",
    delayMinutes: 0,
    force: true,
  });
  const second = await planner.scheduleNext({
    assignmentId: assignment.assignment.id,
    reason: "second",
    delayMinutes: 0,
    force: true,
  });

  assert.equal(first.id, second.id);
  assert.equal(jobs.length, 1);
  assert.deepEqual(JSON.parse(jobs[0]?.message ?? "{}"), {
    assignmentId: assignment.assignment.id,
    reason: "second",
  });
});

test("AssignmentWakeupPlanner force wakeups reschedule later scheduled jobs", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const now = "2026-04-28T15:30:00.000Z";
  t.mock.timers.setTime(Date.parse(now));
  const database = new AppDatabase(":memory:");
  t.after(() => database.close());
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  const { scheduler, jobs } = makeScheduler(now);
  const planner = new AssignmentWakeupPlanner({
    assignments,
    scheduler,
    orchestration: makeOrchestration(runs, []),
  });
  const assignment = assignments.create({
    objective: "Force despite future job",
    policy: { wakeupDelayMinMinutes: 5, wakeupDelayMaxMinutes: 240 },
  });

  const future = await planner.scheduleNext({
    assignmentId: assignment.assignment.id,
    reason: "future",
    delayMinutes: 120,
  });
  const forced = await planner.scheduleNext({
    assignmentId: assignment.assignment.id,
    reason: "force",
    delayMinutes: 0,
    force: true,
  });

  assert.equal(future.id, forced.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.delayMs, 0);
  assert.deepEqual(JSON.parse(jobs[0]?.message ?? "{}"), {
    assignmentId: assignment.assignment.id,
    reason: "force",
  });
});
