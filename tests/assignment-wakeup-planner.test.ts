import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/platform/database.ts";
import { AutonomousAssignmentService } from "../src/assignments/service.ts";
import { AutonomousMutationExecutor } from "../src/assignments/autonomous-mutations.ts";
import { AutonomousMutationLedger } from "../src/assignments/mutation-ledger.ts";
import {
  ASSIGNMENT_WAKEUP_JOB_NAME,
  AssignmentWakeupPlanner,
} from "../src/assignments/wakeup-planner.ts";
import { RunGraphStore } from "../src/orchestration/run-graph-store.ts";
import type { OrchestrationService } from "../src/orchestration/service.ts";
import { PromptRuntimeGuidanceStore } from "../src/prompts/runtime-guidance.ts";
import { OperatorSettingsStore } from "../src/server/settings.ts";
import type { JobRecord } from "../src/scheduler/service.ts";
import { ToolBundleImportStore } from "../src/tools/bundles.ts";
import { ToolBundleLifecycleService } from "../src/tools/bundle-lifecycle.ts";
import { DynamicToolRegistry } from "../src/tools/dynamic-registry.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

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
    reason: "first",
  });
});

test("AssignmentWakeupPlanner force wakeups do not reuse later scheduled jobs", async (t) => {
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

  assert.notEqual(future.id, forced.id);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]?.delayMs, 120 * 60_000);
  assert.equal(jobs[1]?.delayMs, 0);
  assert.deepEqual(JSON.parse(jobs[1]?.message ?? "{}"), {
    assignmentId: assignment.assignment.id,
    reason: "force",
  });
});
