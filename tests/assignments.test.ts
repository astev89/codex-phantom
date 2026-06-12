import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/platform/database.ts";
import { AutonomousAssignmentService } from "../src/assignments/service.ts";
import { RunGraphStore } from "../src/orchestration/run-graph-store.ts";

function withAssignments(
  work: (assignments: AutonomousAssignmentService) => void
): void {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  try {
    work(assignments);
  } finally {
    database.close();
  }
}

test("AutonomousAssignmentService creates an active assignment with default policy and a durable created event", () => {
  withAssignments((assignments) => {
    const created = assignments.create({
      objective: "Research autonomous Slack intake and report a first plan",
      source: {
        channelId: "slack",
        conversationId: "phantom-test-0-0-1",
        userId: "U123",
      },
      createdBy: "operator",
    });

    assert.match(created.assignment.id, /^asgn_/);
    assert.equal(created.assignment.lifecycleState, "active");
    assert.equal(created.assignment.autonomyLevel, "execute");
    assert.equal(created.assignment.policy.maxWakeups, 5);
    assert.equal(created.assignment.policy.maxTotalRuntimeMinutes, 60);
    assert.equal(created.assignment.policy.maxConsecutiveFailures, 2);
    assert.equal(created.assignment.policy.maxIdleHours, 24);
    assert.equal(created.assignment.policy.wakeupDelayMinMinutes, 5);
    assert.equal(created.assignment.policy.wakeupDelayMaxMinutes, 240);
    assert.equal(
      created.assignment.policy.notificationCadence
        .activeProgressIntervalMinutes,
      30
    );
    assert.deepEqual(created.assignment.policy.selfEvolution, {
      enabled: true,
      allowedMutationClasses: ["configuration.operator_settings"],
      maxRiskClass: "medium",
    });

    const timeline = assignments.timeline(created.assignment.id);
    assert.equal(timeline.assignmentId, created.assignment.id);
    assert.equal(timeline.events.length, 1);
    assert.match(timeline.events[0]?.id ?? "", /^asgnevt_/);
    assert.equal(timeline.events[0]?.type, "created");
    assert.equal(timeline.events[0]?.importance, "audit");
    assert.equal(timeline.events[0]?.compactable, false);
    assert.equal(timeline.events[0]?.retention.expiresAt, undefined);
  });
});

test("AutonomousAssignmentService lists and gets assignments through domain filters", () => {
  withAssignments((assignments) => {
    const slackParent = assignments.create({
      objective: "Parent Slack assignment",
      autonomyLevel: "operate",
      source: { channelId: "slack" },
    });
    const slackChild = assignments.create({
      objective: "Child Slack assignment",
      parentAssignmentId: slackParent.assignment.id,
      autonomyLevel: "execute",
      source: { channelId: "slack" },
    });
    assignments.create({
      objective: "Email assignment",
      autonomyLevel: "draft",
      source: { channelId: "email" },
    });
    assignments.control(slackChild.assignment.id, {
      action: "pause",
      actor: "operator",
      reason: "Wait for business hours",
    });

    assert.deepEqual(
      assignments.list({ lifecycleState: "waiting" }).map((item) => item.id),
      [slackChild.assignment.id]
    );
    assert.deepEqual(
      assignments.list({ autonomyLevel: "operate" }).map((item) => item.id),
      [slackParent.assignment.id]
    );
    assert.deepEqual(
      assignments
        .list({ parentAssignmentId: slackParent.assignment.id })
        .map((item) => item.id),
      [slackChild.assignment.id]
    );
    assert.equal(assignments.list({ sourceChannelId: "slack" }).length, 2);
    assert.throws(
      () => assignments.list({ limit: 0 }),
      /limit must be a positive integer/
    );
    assert.equal(
      assignments.get(slackParent.assignment.id)?.assignment.objective,
      "Parent Slack assignment"
    );
    assert.equal(assignments.get("asgn_missing"), null);
  });
});

test("AutonomousAssignmentService controls lifecycle and records milestone events", () => {
  withAssignments((assignments) => {
    const created = assignments.create({ objective: "Control test" });

    assert.equal(
      assignments.control(created.assignment.id, { action: "pause" }).assignment
        .lifecycleState,
      "waiting"
    );
    assert.equal(
      assignments.control(created.assignment.id, { action: "resume" })
        .assignment.lifecycleState,
      "active"
    );
    assignments.control(created.assignment.id, {
      action: "force_wakeup",
      actor: "operator",
      reason: "Smoke the planner seam",
    });
    assert.equal(
      assignments.control(created.assignment.id, {
        action: "cancel",
        reason: "No longer needed",
      }).assignment.lifecycleState,
      "cancelled"
    );
    assert.equal(
      assignments.control(created.assignment.id, { action: "reopen" })
        .assignment.lifecycleState,
      "active"
    );

    const eventTypes = assignments
      .timeline(created.assignment.id)
      .events.map((event) => event.type);
    assert.deepEqual(eventTypes, [
      "created",
      "paused",
      "resumed",
      "planner_wakeup_requested",
      "cancelled",
      "reopened",
    ]);
    const wakeupEvent = assignments
      .timeline(created.assignment.id)
      .events.find((event) => event.type === "planner_wakeup_requested");
    assert.equal(
      (wakeupEvent?.payload as { plannerStatus?: string }).plannerStatus,
      "placeholder_only"
    );
  });
});

test("AutonomousAssignmentService persists context additions and policy changes with retention metadata", () => {
  withAssignments((assignments) => {
    const created = assignments.create({
      objective: "Context and policy test",
    });

    const withContext = assignments.control(created.assignment.id, {
      action: "add_context",
      actor: "operator",
      context: {
        note: "Slack channel has already been permissioned for app mentions.",
      },
    });
    assert.deepEqual(withContext.assignment.context, [
      { note: "Slack channel has already been permissioned for app mentions." },
    ]);

    const withPolicy = assignments.control(created.assignment.id, {
      action: "change_policy",
      actor: "operator",
      reason: "Give the first assignment more room",
      policy: {
        maxWakeups: 7,
        notificationCadence: {
          ...created.assignment.policy.notificationCadence,
          activeProgressIntervalMinutes: 45,
        },
        selfEvolution: {
          maxRiskClass: "low",
        },
      },
    });
    assert.equal(withPolicy.assignment.policy.maxWakeups, 7);
    assert.equal(
      withPolicy.assignment.policy.notificationCadence
        .activeProgressIntervalMinutes,
      45
    );
    assert.deepEqual(withPolicy.assignment.policy.selfEvolution, {
      enabled: true,
      allowedMutationClasses: ["configuration.operator_settings"],
      maxRiskClass: "low",
    });

    const events = assignments.timeline(created.assignment.id).events;
    const contextEvent = events.find((event) => event.type === "context_added");
    assert.equal(contextEvent?.importance, "detail");
    assert.equal(contextEvent?.compactable, true);
    assert.equal(typeof contextEvent?.retention.expiresAt, "string");
    assert.equal(
      events.find((event) => event.type === "policy_changed")?.compactable,
      false
    );
    assert.throws(
      () =>
        assignments.control(created.assignment.id, {
          action: "change_policy",
          policy: { wakeupDelayMinMinutes: 60, wakeupDelayMaxMinutes: 30 },
        }),
      /wakeupDelayMinMinutes/
    );
    const beforeNoopPolicyPatchEvents = assignments.timeline(
      created.assignment.id
    ).events.length;
    assert.throws(
      () =>
        assignments.control(created.assignment.id, {
          action: "change_policy",
          policy: { notificationCadence: {} },
        }),
      /policy is required/
    );
    assert.equal(
      assignments.timeline(created.assignment.id).events.length,
      beforeNoopPolicyPatchEvents
    );
    assert.throws(
      () => assignments.timeline(created.assignment.id, 0),
      /limit must be a positive integer/
    );
  });
});

test("AutonomousAssignmentService preserves notification cadence fields across partial policy changes", () => {
  withAssignments((assignments) => {
    const created = assignments.create({ objective: "Partial policy patch" });
    const withoutFailureNotice = assignments.control(created.assignment.id, {
      action: "change_policy",
      policy: {
        notificationCadence: {
          onFailure: false,
        },
      },
    });
    assert.equal(
      withoutFailureNotice.assignment.policy.notificationCadence.onFailure,
      false
    );

    const withLongerInterval = assignments.control(created.assignment.id, {
      action: "change_policy",
      policy: {
        notificationCadence: {
          activeProgressIntervalMinutes: 60,
        },
      },
    });

    assert.equal(
      withLongerInterval.assignment.policy.notificationCadence.onFailure,
      false
    );
    assert.equal(
      withLongerInterval.assignment.policy.notificationCadence
        .activeProgressIntervalMinutes,
      60
    );
  });
});

test("AutonomousAssignmentService requires reopen for terminal assignments before pause or resume", () => {
  withAssignments((assignments) => {
    const created = assignments.create({ objective: "Terminal control test" });
    const cancelled = assignments.control(created.assignment.id, {
      action: "cancel",
    });
    assert.equal(cancelled.assignment.lifecycleState, "cancelled");

    assert.throws(
      () => assignments.control(created.assignment.id, { action: "resume" }),
      /reopened before they can be resumed/
    );
    assert.throws(
      () => assignments.control(created.assignment.id, { action: "pause" }),
      /reopened before they can be paused/
    );

    const reopened = assignments.control(created.assignment.id, {
      action: "reopen",
    });
    assert.equal(reopened.assignment.lifecycleState, "active");
    assert.equal(
      assignments
        .timeline(created.assignment.id)
        .events.find((event) => event.type === "reopened")?.importance,
      "audit"
    );
  });
});

test("AutonomousAssignmentService links runs and exposes them from assignment detail", async () => {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  try {
    const created = assignments.create({ objective: "Run link test" });
    const runId = "run_assignment_link_1";
    await runs.upsert({
      runId,
      role: "coordinator",
      objective: "Research assignment run",
      status: "queued",
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
      startedAt: new Date().toISOString(),
    });
    const link = assignments.linkRun({
      assignmentId: created.assignment.id,
      runId,
      stepId: "step-1",
      action: "initial_research",
      metadata: { coordinator: true },
    });

    assert.match(link.id, /^asgnrun_/);
    const detail = assignments.get(created.assignment.id);
    assert.equal(detail?.runLinks.length, 1);
    assert.equal(detail?.runLinks[0]?.runId, runId);
    assert.equal(detail?.runLinks[0]?.action, "initial_research");
    assert.equal(
      assignments
        .timeline(created.assignment.id)
        .events.some((event) => event.type === "run_linked"),
      true
    );
  } finally {
    database.close();
  }
});

test("AutonomousAssignmentService records wakeup lifecycle state through domain methods", async () => {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const runs = new RunGraphStore(database);
  try {
    const created = assignments.create({ objective: "Wakeup lifecycle test" });

    const started = assignments.startWakeup({
      assignmentId: created.assignment.id,
      actor: "operator",
      reason: "forced by operator",
      source: "force_wakeup",
    });
    assert.equal(started.assignment.wakeupCount, 1);
    assert.equal(started.assignment.lifecycleState, "active");

    const runId = "coord_wakeup_lifecycle_1";
    await runs.upsert({
      runId,
      role: "coordinator",
      objective: "Continue assignment",
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
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      summary: "ASSIGNMENT_STATUS: continue",
    });

    assignments.failWakeup({
      assignmentId: created.assignment.id,
      error: "temporary model error",
    });
    assert.equal(
      assignments.get(created.assignment.id)?.assignment
        .consecutiveFailureCount,
      1
    );

    const completed = assignments.completeWakeupRun({
      assignmentId: created.assignment.id,
      runId,
      outputText: "ASSIGNMENT_STATUS: continue",
    });
    assert.equal(completed.assignment.consecutiveFailureCount, 0);
    assert.equal(completed.runLinks[0]?.runId, runId);

    const waiting = assignments.applyWakeupDecision({
      assignmentId: created.assignment.id,
      decision: "waiting",
      reason: "Continue later",
      nextWakeupAt: "2026-04-28T13:00:00.000Z",
    });
    assert.equal(waiting.assignment.lifecycleState, "waiting");

    const eventTypes = assignments
      .timeline(created.assignment.id)
      .events.map((event) => event.type);
    assert.deepEqual(eventTypes, [
      "created",
      "wakeup_started",
      "wakeup_failed",
      "run_linked",
      "wakeup_run_completed",
      "wakeup_scheduled",
    ]);
    const runCompletedEvent = assignments
      .timeline(created.assignment.id)
      .events.find((event) => event.type === "wakeup_run_completed");
    assert.equal(runCompletedEvent?.compactable, true);
    assert.equal(typeof runCompletedEvent?.retention.expiresAt, "string");
  } finally {
    database.close();
  }
});
