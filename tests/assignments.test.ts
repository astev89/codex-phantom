import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase, encodeJson } from "../src/platform/database.ts";
import { AutonomousAssignmentService } from "../src/assignments/service.ts";
import { RunGraphStore } from "../src/orchestration/run-graph-store.ts";

function withAssignments(
  work: (
    assignments: AutonomousAssignmentService,
    database: AppDatabase
  ) => void
): void {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  try {
    work(assignments, database);
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
    assert.deepEqual(created.assignment.policy.childAssignments, {
      maxDepth: 2,
      maxActiveChildren: 3,
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

test("AutonomousAssignmentService promotes bounded child assignments with inherited policy and parent evidence", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate release readiness",
      autonomyLevel: "operate",
      policy: {
        maxWakeups: 8,
        childAssignments: { maxDepth: 2, maxActiveChildren: 2 },
      },
    });

    const promoted = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Verify Docker release smoke path",
      title: "Docker smoke",
      autonomyLevel: "evolve",
      actor: "planner",
      rationale: "The release smoke path can proceed independently.",
      waitForChild: true,
      metadata: { source: "planner-marker" },
    });

    assert.equal(
      promoted.child.assignment.parentAssignmentId,
      parent.assignment.id
    );
    assert.equal(
      promoted.child.assignment.objective,
      "Verify Docker release smoke path"
    );
    assert.equal(promoted.child.assignment.title, "Docker smoke");
    assert.equal(promoted.child.assignment.autonomyLevel, "operate");
    assert.equal(promoted.child.assignment.policy.maxWakeups, 8);
    assert.deepEqual(promoted.child.assignment.policy.childAssignments, {
      maxDepth: 2,
      maxActiveChildren: 2,
    });
    assert.deepEqual(promoted.child.assignment.metadata, {
      source: "planner-marker",
      parentAssignmentId: parent.assignment.id,
      parentWaitsForChild: true,
    });

    const parentTimeline = assignments.timeline(parent.assignment.id).events;
    const childEvent = parentTimeline.find(
      (event) => event.type === "child_assignment_created"
    );
    assert.equal(childEvent?.importance, "milestone");
    assert.equal(childEvent?.compactable, false);
    assert.deepEqual(childEvent?.payload, {
      actor: "planner",
      childAssignmentId: promoted.child.assignment.id,
      objective: "Verify Docker release smoke path",
      rationale: "The release smoke path can proceed independently.",
      waitForChild: true,
    });

    assert.deepEqual(
      assignments
        .list({ parentAssignmentId: parent.assignment.id })
        .map((item) => item.id),
      [promoted.child.assignment.id]
    );
  });
});

test("AutonomousAssignmentService caps child policy at the parent authority envelope", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Govern delegated work",
      autonomyLevel: "evolve",
      policy: {
        maxWakeups: 4,
        maxTotalRuntimeMinutes: 30,
        maxConsecutiveFailures: 1,
        maxIdleHours: 12,
        wakeupDelayMinMinutes: 10,
        wakeupDelayMaxMinutes: 60,
        notificationCadence: {
          onWakeupStart: true,
          onBlocked: true,
          activeProgressIntervalMinutes: 15,
        },
        selfEvolution: {
          enabled: true,
          allowedMutationClasses: ["configuration.operator_settings"],
          maxRiskClass: "low",
        },
        childAssignments: { maxDepth: 1, maxActiveChildren: 1 },
      },
    });

    const child = assignments.create({
      parentAssignmentId: parent.assignment.id,
      objective: "Try to widen authority",
      autonomyLevel: "evolve",
      policy: {
        maxWakeups: 99,
        maxTotalRuntimeMinutes: 99,
        maxConsecutiveFailures: 9,
        maxIdleHours: 99,
        wakeupDelayMinMinutes: 1,
        wakeupDelayMaxMinutes: 240,
        notificationCadence: {
          onWakeupStart: false,
          onBlocked: false,
          activeProgressIntervalMinutes: 99,
        },
        selfEvolution: {
          enabled: true,
          allowedMutationClasses: [
            "configuration.operator_settings",
            "configuration.assignment_policy",
          ],
          maxRiskClass: "critical",
        },
        childAssignments: { maxDepth: 5, maxActiveChildren: 5 },
      },
    });

    assert.equal(child.assignment.policy.maxWakeups, 4);
    assert.equal(child.assignment.policy.maxTotalRuntimeMinutes, 30);
    assert.equal(child.assignment.policy.maxConsecutiveFailures, 1);
    assert.equal(child.assignment.policy.maxIdleHours, 12);
    assert.equal(child.assignment.policy.wakeupDelayMinMinutes, 10);
    assert.equal(child.assignment.policy.wakeupDelayMaxMinutes, 60);
    assert.equal(
      child.assignment.policy.notificationCadence.onWakeupStart,
      true
    );
    assert.equal(child.assignment.policy.notificationCadence.onBlocked, true);
    assert.equal(
      child.assignment.policy.notificationCadence.activeProgressIntervalMinutes,
      15
    );
    assert.deepEqual(child.assignment.policy.selfEvolution, {
      enabled: true,
      allowedMutationClasses: ["configuration.operator_settings"],
      maxRiskClass: "low",
    });
    assert.deepEqual(child.assignment.policy.childAssignments, {
      maxDepth: 1,
      maxActiveChildren: 1,
    });
  });
});

test("AutonomousAssignmentService rejects child promotion beyond depth and active-child limits", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Root assignment",
      policy: { childAssignments: { maxDepth: 1, maxActiveChildren: 1 } },
    });
    const child = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "First child",
      rationale: "Allowed first child",
    });

    assert.throws(
      () =>
        assignments.promoteChild({
          parentAssignmentId: parent.assignment.id,
          objective: "Second child",
          rationale: "Too many direct children",
        }),
      /active child assignment limit/
    );
    assert.throws(
      () =>
        assignments.promoteChild({
          parentAssignmentId: child.child.assignment.id,
          objective: "Grandchild",
          rationale: "Too deep",
        }),
      /child assignment depth limit/
    );

    assignments.control(child.child.assignment.id, { action: "cancel" });
    const replacement = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Replacement child",
      rationale: "The first child was cancelled",
    });
    assert.equal(replacement.child.assignment.objective, "Replacement child");

    assignments.control(parent.assignment.id, { action: "cancel" });
    assert.throws(
      () =>
        assignments.promoteChild({
          parentAssignmentId: parent.assignment.id,
          objective: "Late child",
          rationale: "Parent is terminal",
        }),
      /Terminal assignments cannot promote child assignments/
    );
  });
});

test("AutonomousAssignmentService caps child wakeup budget at the parent remaining budget", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Parent with partially used budget",
      policy: { maxWakeups: 5 },
    });
    assignments.startWakeup({
      assignmentId: parent.assignment.id,
      reason: "first parent wakeup",
    });

    const firstChild = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "First child",
      rationale: "Split work after the first wakeup",
      policy: { maxWakeups: 2 },
    });
    const secondChild = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Second child",
      rationale: "Use the remaining unreserved wakeups",
      policy: { maxWakeups: 10 },
    });

    assert.equal(firstChild.child.assignment.policy.maxWakeups, 2);
    assert.equal(secondChild.child.assignment.policy.maxWakeups, 2);
    assert.throws(
      () =>
        assignments.promoteChild({
          parentAssignmentId: parent.assignment.id,
          objective: "Over budget child",
          rationale: "No unreserved child budget remains",
        }),
      /remaining wakeup budget/
    );

    assert.throws(
      () =>
        assignments.startWakeup({
          assignmentId: parent.assignment.id,
          reason: "parent budget is reserved",
        }),
      /reserved for active child assignments/
    );
  });
});

test("AutonomousAssignmentService returns child wakeup budget when active children terminate", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Parent with reusable child budget",
      policy: { maxWakeups: 3, childAssignments: { maxActiveChildren: 2 } },
    });
    const child = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Temporary child",
      rationale: "Will be cancelled",
      policy: { maxWakeups: 3 },
    });
    assert.equal(child.child.assignment.policy.maxWakeups, 3);
    assignments.control(child.child.assignment.id, { action: "cancel" });

    const replacement = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Replacement child",
      rationale: "Unused child budget returned after cancellation",
      policy: { maxWakeups: 3 },
    });
    assert.equal(replacement.child.assignment.policy.maxWakeups, 3);
    assignments.control(replacement.child.assignment.id, { action: "cancel" });

    assignments.startWakeup({
      assignmentId: parent.assignment.id,
      reason: "parent spends first wakeup",
    });
    assignments.startWakeup({
      assignmentId: parent.assignment.id,
      reason: "parent spends second wakeup",
    });
    assignments.startWakeup({
      assignmentId: parent.assignment.id,
      reason: "parent spends third wakeup",
    });
    assert.throws(
      () =>
        assignments.promoteChild({
          parentAssignmentId: parent.assignment.id,
          objective: "No budget child",
          rationale: "Parent budget is exhausted",
        }),
      /remaining wakeup budget/
    );
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

test("AutonomousAssignmentService fails closed for legacy policy rows without selfEvolution", () => {
  withAssignments((assignments, database) => {
    const created = assignments.create({
      objective: "Legacy evolve assignment",
      autonomyLevel: "evolve",
    });
    const legacyPolicy = {
      ...created.assignment.policy,
    } as Record<string, unknown>;
    delete legacyPolicy.selfEvolution;
    database.run(
      "UPDATE assignments SET policy_json = ? WHERE id = ?",
      encodeJson(legacyPolicy),
      created.assignment.id
    );

    assert.deepEqual(
      assignments.get(created.assignment.id)?.assignment.policy.selfEvolution,
      {
        enabled: false,
        allowedMutationClasses: [],
        maxRiskClass: "low",
      }
    );
    assert.deepEqual(
      assignments.get(created.assignment.id)?.assignment.policy
        .childAssignments,
      {
        maxDepth: 2,
        maxActiveChildren: 3,
      }
    );
  });
});

test("AutonomousAssignmentService fails closed for legacy rows without child assignment policy", () => {
  withAssignments((assignments, database) => {
    const parent = assignments.create({
      objective: "Legacy parent assignment",
    });
    const legacyPolicy = {
      ...parent.assignment.policy,
    } as Record<string, unknown>;
    delete legacyPolicy.childAssignments;
    database.run(
      "UPDATE assignments SET policy_json = ? WHERE id = ?",
      encodeJson(legacyPolicy),
      parent.assignment.id
    );

    assert.deepEqual(
      assignments.get(parent.assignment.id)?.assignment.policy.childAssignments,
      {
        maxDepth: 0,
        maxActiveChildren: 0,
      }
    );
    assert.throws(
      () =>
        assignments.promoteChild({
          parentAssignmentId: parent.assignment.id,
          objective: "Should not spawn",
          rationale: "Legacy rows fail closed",
        }),
      /child assignment depth limit/
    );
  });
});

test("AutonomousAssignmentService fails closed for corrupt policy rows", () => {
  withAssignments((assignments, database) => {
    const created = assignments.create({
      objective: "Corrupt policy assignment",
      autonomyLevel: "evolve",
    });
    database.run(
      "UPDATE assignments SET policy_json = ? WHERE id = ?",
      "{not-json",
      created.assignment.id
    );

    assert.deepEqual(
      assignments.get(created.assignment.id)?.assignment.policy.selfEvolution,
      {
        enabled: false,
        allowedMutationClasses: [],
        maxRiskClass: "low",
      }
    );
    assert.deepEqual(
      assignments.get(created.assignment.id)?.assignment.policy
        .childAssignments,
      {
        maxDepth: 0,
        maxActiveChildren: 0,
      }
    );
  });
});

test("AutonomousAssignmentService normalizes malformed selfEvolution fields fail-closed", () => {
  withAssignments((assignments, database) => {
    const cases = [
      {
        policy: [],
        expected: {
          enabled: false,
          allowedMutationClasses: [],
          maxRiskClass: "low",
        },
      },
      {
        policy: {
          enabled: "yes",
          allowedMutationClasses: ["configuration.operator_settings"],
          maxRiskClass: "medium",
        },
        expected: {
          enabled: false,
          allowedMutationClasses: ["configuration.operator_settings"],
          maxRiskClass: "medium",
        },
      },
      {
        policy: {
          enabled: true,
          allowedMutationClasses: ["configuration.operator_settings", ""],
          maxRiskClass: "medium",
        },
        expected: {
          enabled: true,
          allowedMutationClasses: [],
          maxRiskClass: "medium",
        },
      },
      {
        policy: {
          enabled: true,
          allowedMutationClasses: ["configuration.operator_settings"],
          maxRiskClass: "extreme",
        },
        expected: {
          enabled: true,
          allowedMutationClasses: ["configuration.operator_settings"],
          maxRiskClass: "low",
        },
      },
    ];

    for (const [index, scenario] of cases.entries()) {
      const created = assignments.create({
        objective: `Malformed self-evolution assignment ${index}`,
        autonomyLevel: "evolve",
      });
      database.run(
        "UPDATE assignments SET policy_json = ? WHERE id = ?",
        encodeJson({
          ...created.assignment.policy,
          selfEvolution: scenario.policy,
        }),
        created.assignment.id
      );

      assert.deepEqual(
        assignments.get(created.assignment.id)?.assignment.policy.selfEvolution,
        scenario.expected
      );
    }
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
