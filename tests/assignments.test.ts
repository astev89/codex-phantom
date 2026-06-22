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
      childDependencyConfigValidated: false,
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

test("AutonomousAssignmentService parks child assignments until dependencies are satisfied", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate dependent work",
      policy: {
        maxWakeups: 10,
        childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
      },
    });
    const prerequisite = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Finish prerequisite",
      rationale: "The dependent task needs this evidence first.",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });

    const dependent = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Run dependent verification",
      rationale: "This should not start before the prerequisite finishes.",
      dependsOnChildIds: [prerequisite.child.assignment.id],
      waitForChildren: "all",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });

    assert.equal(dependent.child.assignment.lifecycleState, "waiting");
    assert.deepEqual(dependent.child.assignment.metadata, {
      parentAssignmentId: parent.assignment.id,
      parentWaitsForChild: true,
      childDependencyConfigValidated: true,
      dependsOnChildIds: [prerequisite.child.assignment.id],
      waitForChildren: "all",
    });
    assert.throws(
      () =>
        assignments.startWakeup({
          assignmentId: dependent.child.assignment.id,
          reason: "should still be parked",
        }),
      /Assignment is waiting for child assignment dependencies/
    );

    const childEvent = assignments
      .timeline(parent.assignment.id)
      .events.find(
        (event) =>
          event.type === "child_assignment_created" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          !Array.isArray(event.payload) &&
          event.payload.childAssignmentId === dependent.child.assignment.id
      );
    assert.deepEqual(childEvent?.payload, {
      actor: "planner",
      childAssignmentId: dependent.child.assignment.id,
      objective: "Run dependent verification",
      rationale: "This should not start before the prerequisite finishes.",
      waitForChild: true,
      dependsOnChildIds: [prerequisite.child.assignment.id],
      waitForChildren: "all",
    });
  });
});

test("AutonomousAssignmentService rejects cross-parent child dependencies", () => {
  withAssignments((assignments) => {
    const firstParent = assignments.create({
      objective: "First root",
      policy: { childAssignments: { maxDepth: 1, maxActiveChildren: 2 } },
    });
    const secondParent = assignments.create({
      objective: "Second root",
      policy: { childAssignments: { maxDepth: 1, maxActiveChildren: 2 } },
    });
    const foreignChild = assignments.promoteChild({
      parentAssignmentId: firstParent.assignment.id,
      objective: "Foreign child",
      rationale: "Belongs to a different parent.",
    });

    assert.throws(
      () =>
        assignments.promoteChild({
          parentAssignmentId: secondParent.assignment.id,
          objective: "Invalid dependent",
          rationale: "Should not cross parent scope.",
          dependsOnChildIds: [foreignChild.child.assignment.id],
        }),
      /Child assignment dependencies must belong to the same parent assignment/
    );
  });
});

test("AutonomousAssignmentService blocks dependents when required dependencies are already failed", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate failed dependency work",
      policy: {
        maxWakeups: 10,
        childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
      },
    });
    const prerequisite = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Prerequisite that fails",
      rationale: "This dependency will fail before dependent promotion.",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });
    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "failed",
      reason: "Prerequisite failed",
    });

    const dependent = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Dependent should block immediately",
      rationale: "Its required dependency has already failed.",
      dependsOnChildIds: [prerequisite.child.assignment.id],
      waitForChildren: "all",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });

    assert.equal(dependent.child.assignment.lifecycleState, "blocked");
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
});

test("AutonomousAssignmentService resolves dependencies after operator lifecycle controls", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate operator-cancelled dependency work",
      policy: {
        maxWakeups: 10,
        childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
      },
    });
    const prerequisite = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Prerequisite that may be cancelled",
      rationale: "Operator may cancel this dependency.",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });
    const dependent = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Dependent should block on cancellation",
      rationale: "Its required dependency may be cancelled.",
      dependsOnChildIds: [prerequisite.child.assignment.id],
      waitForChildren: "all",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });

    assignments.control(prerequisite.child.assignment.id, {
      action: "cancel",
      reason: "Operator cancelled prerequisite",
    });

    const blocked = assignments.getRequired(dependent.child.assignment.id);
    assert.equal(blocked.assignment.lifecycleState, "blocked");
    const blockedEvent = assignments
      .timeline(dependent.child.assignment.id)
      .events.find((event) => event.type === "blocked");
    assert.deepEqual(blockedEvent?.payload, {
      decision: "blocked",
      reason: "Required child assignment dependency failed",
      blockingDependencies: [
        {
          childAssignmentId: prerequisite.child.assignment.id,
          lifecycleState: "cancelled",
        },
      ],
      nextWakeupAt: null,
    });
  });
});

test("AutonomousAssignmentService reactivates dependency-blocked children after prerequisites recover", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate recoverable dependency work",
      policy: {
        maxWakeups: 10,
        childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
      },
    });
    const prerequisite = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Prerequisite that may recover",
      rationale: "The prerequisite can be reopened after a failure.",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });
    const dependent = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Dependent should recover",
      rationale: "Its dependency may recover after failing.",
      dependsOnChildIds: [prerequisite.child.assignment.id],
      waitForChildren: "all",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });

    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "failed",
      reason: "Prerequisite failed transiently",
    });
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "blocked"
    );

    assignments.control(prerequisite.child.assignment.id, {
      action: "reopen",
      reason: "Retry prerequisite",
    });
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "waiting"
    );

    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "completed",
      reason: "Prerequisite recovered",
    });

    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "active"
    );
  });
});

test("AutonomousAssignmentService keeps recovered dependents parked when parent child slots are full", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate constrained dependency recovery",
      policy: {
        maxWakeups: 10,
        childAssignments: { maxDepth: 1, maxActiveChildren: 1 },
      },
    });
    const prerequisite = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Recoverable prerequisite",
      rationale: "The prerequisite can finish, reopen, and recover.",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });
    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "completed",
      reason: "Initial prerequisite completion",
    });
    const dependent = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Recovered dependent",
      rationale: "Should not bypass the parent active child envelope.",
      waitForChild: true,
      dependsOnChildIds: [prerequisite.child.assignment.id],
      waitForChildren: "all",
      policy: { maxWakeups: 2 },
    });

    assignments.control(prerequisite.child.assignment.id, {
      action: "reopen",
      reason: "Prerequisite needs rework",
    });
    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "failed",
      reason: "Prerequisite failed during rework",
    });
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "blocked"
    );

    const replacement = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Replacement work",
      rationale: "Uses the only active child slot.",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });
    assignments.control(prerequisite.child.assignment.id, {
      action: "reopen",
      reason: "Retry prerequisite",
    });
    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "completed",
      reason: "Prerequisite recovered",
    });

    assert.equal(
      assignments.getRequired(replacement.child.assignment.id).assignment
        .lifecycleState,
      "active"
    );
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "waiting"
    );

    assert.throws(
      () =>
        assignments.control(dependent.child.assignment.id, {
          action: "resume",
          reason: "Operator retries recovered dependent",
        }),
      /Assignment parent has no child capacity/
    );
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "waiting"
    );

    assignments.applyWakeupDecision({
      assignmentId: replacement.child.assignment.id,
      decision: "completed",
      reason: "Replacement completed",
    });
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "active"
    );
  });
});

test("AutonomousAssignmentService softens recovered dependency chains back to waiting", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate chained dependency work",
      policy: {
        maxWakeups: 10,
        childAssignments: { maxDepth: 1, maxActiveChildren: 4 },
      },
    });
    const prerequisite = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Root prerequisite",
      rationale: "The chain starts here.",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });
    const middle = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Middle dependent",
      rationale: "Runs after the root prerequisite.",
      waitForChild: true,
      dependsOnChildIds: [prerequisite.child.assignment.id],
      waitForChildren: "all",
      policy: { maxWakeups: 2 },
    });
    const tail = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Tail dependent",
      rationale: "Runs after the middle dependent.",
      waitForChild: true,
      dependsOnChildIds: [middle.child.assignment.id],
      waitForChildren: "all",
      policy: { maxWakeups: 2 },
    });

    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "failed",
      reason: "Root failed",
    });
    assert.equal(
      assignments.getRequired(tail.child.assignment.id).assignment
        .lifecycleState,
      "blocked"
    );

    assignments.control(prerequisite.child.assignment.id, {
      action: "reopen",
      reason: "Retry root",
    });
    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "completed",
      reason: "Root recovered",
    });

    assert.equal(
      assignments.getRequired(middle.child.assignment.id).assignment
        .lifecycleState,
      "active"
    );
    assert.equal(
      assignments.getRequired(tail.child.assignment.id).assignment
        .lifecycleState,
      "waiting"
    );
    assert.throws(
      () =>
        assignments.startWakeup({
          assignmentId: parent.assignment.id,
          reason: "tail should still wait",
        }),
      /waiting for active child assignment/
    );
  });
});

test("AutonomousAssignmentService returns post-resolution child state", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate stale return prevention",
      policy: {
        maxWakeups: 10,
        childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
      },
    });
    const prerequisite = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Prerequisite that remains active",
      rationale: "Dependent should not start yet.",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });
    const dependent = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Dependent should stay waiting",
      rationale: "Its dependency remains active.",
      dependsOnChildIds: [prerequisite.child.assignment.id],
      waitForChildren: "all",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });

    const resumed = assignments.control(dependent.child.assignment.id, {
      action: "resume",
      reason: "Operator tries early resume",
    });
    assert.equal(resumed.assignment.lifecycleState, "waiting");
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "waiting"
    );

    const waiting = assignments.applyWakeupDecision({
      assignmentId: dependent.child.assignment.id,
      decision: "waiting",
      reason: "Planner tries early wake",
    });
    assert.equal(waiting.assignment.lifecycleState, "waiting");
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "waiting"
    );
  });
});

test("AutonomousAssignmentService preserves non-dependency waits on dependency children", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate paused dependency child",
      policy: {
        maxWakeups: 10,
        childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
      },
    });
    const prerequisite = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Completed prerequisite",
      rationale: "The dependent dependency is satisfied.",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });
    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "completed",
      reason: "Prerequisite done",
    });
    const dependent = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Dependent should remain controllable",
      rationale: "Satisfied dependencies should not undo pauses or retries.",
      dependsOnChildIds: [prerequisite.child.assignment.id],
      waitForChildren: "all",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });

    const paused = assignments.control(dependent.child.assignment.id, {
      action: "pause",
      reason: "Operator pause",
    });
    assert.equal(paused.assignment.lifecycleState, "waiting");
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "waiting"
    );

    const retryWait = assignments.applyWakeupDecision({
      assignmentId: dependent.child.assignment.id,
      decision: "waiting",
      reason: "Retry later",
    });
    assert.equal(retryWait.assignment.lifecycleState, "waiting");
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "waiting"
    );
  });
});

test("AutonomousAssignmentService reactivates dependency waits across repeated dependency cycles", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate repeated dependency cycles",
      policy: {
        maxWakeups: 10,
        childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
      },
    });
    const prerequisite = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Cycling prerequisite",
      rationale: "The prerequisite can complete, reopen, and complete again.",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });
    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "completed",
      reason: "First completion",
    });
    const dependent = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Dependent should reactivate twice",
      rationale: "Dependency wait provenance should stay current.",
      dependsOnChildIds: [prerequisite.child.assignment.id],
      waitForChildren: "all",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });

    assignments.control(prerequisite.child.assignment.id, {
      action: "reopen",
      reason: "Rework prerequisite",
    });
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "waiting"
    );

    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "completed",
      reason: "Second completion",
    });
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "active"
    );
  });
});

test("AutonomousAssignmentService preserves pauses after dependency wait cycles", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate pause after dependency wait",
      policy: {
        maxWakeups: 10,
        childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
      },
    });
    const prerequisite = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Prerequisite for paused child",
      rationale: "Starts active so dependent is initially dependency-waiting.",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });
    const dependent = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Dependent paused after activation",
      rationale: "Pause should not be mistaken for old dependency wait.",
      dependsOnChildIds: [prerequisite.child.assignment.id],
      waitForChildren: "all",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });

    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "completed",
      reason: "Prerequisite completed",
    });
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "active"
    );

    const paused = assignments.control(dependent.child.assignment.id, {
      action: "pause",
      reason: "Operator pause after dependency wait",
    });
    assert.equal(paused.assignment.lifecycleState, "waiting");
    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "waiting"
    );
  });
});

test("AutonomousAssignmentService preserves operator pauses across dependency failure recovery", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate paused child recovery",
      policy: {
        maxWakeups: 10,
        childAssignments: { maxDepth: 1, maxActiveChildren: 3 },
      },
    });
    const prerequisite = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Recoverable prerequisite",
      rationale: "The prerequisite may fail after a dependent is paused.",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });
    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "completed",
      reason: "Initial prerequisite complete",
    });
    const dependent = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Paused dependent",
      rationale: "Operator pause should survive dependency churn.",
      dependsOnChildIds: [prerequisite.child.assignment.id],
      waitForChildren: "all",
      waitForChild: true,
      policy: { maxWakeups: 2 },
    });
    assignments.control(dependent.child.assignment.id, {
      action: "pause",
      reason: "Operator pause",
    });

    assignments.control(prerequisite.child.assignment.id, {
      action: "reopen",
      reason: "Retry prerequisite",
    });
    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "failed",
      reason: "Prerequisite failed again",
    });
    assignments.control(prerequisite.child.assignment.id, {
      action: "reopen",
      reason: "Retry prerequisite again",
    });
    assignments.applyWakeupDecision({
      assignmentId: prerequisite.child.assignment.id,
      decision: "completed",
      reason: "Prerequisite recovered again",
    });

    assert.equal(
      assignments.getRequired(dependent.child.assignment.id).assignment
        .lifecycleState,
      "waiting"
    );
  });
});

test("AutonomousAssignmentService supports any dependency wait mode", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate any dependency work",
      policy: {
        maxWakeups: 10,
        childAssignments: { maxDepth: 1, maxActiveChildren: 4 },
      },
    });
    const completedDependency = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Completed dependency",
      rationale: "One successful dependency is enough.",
      policy: { maxWakeups: 2 },
    });
    const pendingDependency = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Pending dependency",
      rationale: "This dependency can remain pending.",
      policy: { maxWakeups: 2 },
    });
    assignments.applyWakeupDecision({
      assignmentId: completedDependency.child.assignment.id,
      decision: "completed",
      reason: "Dependency completed",
    });

    const dependent = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Any-mode dependent",
      rationale: "One completed dependency should release this child.",
      dependsOnChildIds: [
        completedDependency.child.assignment.id,
        pendingDependency.child.assignment.id,
      ],
      waitForChildren: "any",
      policy: { maxWakeups: 2 },
    });

    assert.equal(dependent.child.assignment.lifecycleState, "active");
    assert.deepEqual(dependent.child.assignment.metadata, {
      parentAssignmentId: parent.assignment.id,
      parentWaitsForChild: false,
      childDependencyConfigValidated: true,
      dependsOnChildIds: [
        completedDependency.child.assignment.id,
        pendingDependency.child.assignment.id,
      ],
      waitForChildren: "any",
    });
  });
});

test("AutonomousAssignmentService resolves dependencies outside the newest sibling page", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate long-lived child history",
      policy: {
        maxWakeups: 10,
        childAssignments: { maxDepth: 1, maxActiveChildren: 1 },
      },
    });
    const oldPrerequisite = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Old completed prerequisite",
      rationale: "This child should remain dependency-addressable by id.",
      policy: { maxWakeups: 1 },
    });
    assignments.applyWakeupDecision({
      assignmentId: oldPrerequisite.child.assignment.id,
      decision: "completed",
      reason: "Old prerequisite completed",
    });

    for (let index = 0; index < 500; index += 1) {
      const laterChild = assignments.promoteChild({
        parentAssignmentId: parent.assignment.id,
        objective: `Later completed child ${index}`,
        rationale: "Push the old prerequisite outside a bounded sibling page.",
        policy: { maxWakeups: 1 },
      });
      assignments.applyWakeupDecision({
        assignmentId: laterChild.child.assignment.id,
        decision: "completed",
        reason: "Later child completed",
      });
    }

    const dependent = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Dependent on old prerequisite",
      rationale: "Dependency lookup should not depend on sibling page recency.",
      waitForChild: true,
      dependsOnChildIds: [oldPrerequisite.child.assignment.id],
      waitForChildren: "all",
      policy: { maxWakeups: 1 },
    });

    assert.equal(dependent.child.assignment.lifecycleState, "active");
  });
});

test("AutonomousAssignmentService releases blocked child wakeup budget", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Parent with tight child budget",
      policy: { maxWakeups: 1 },
    });
    const child = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Waited child that blocks",
      rationale: "The parent should be able to wake after it blocks.",
      waitForChild: true,
      policy: { maxWakeups: 1 },
    });

    assert.throws(
      () =>
        assignments.startWakeup({
          assignmentId: parent.assignment.id,
          reason: "child still reserves budget",
        }),
      /waiting for active child assignment/
    );

    assignments.applyWakeupDecision({
      assignmentId: child.child.assignment.id,
      decision: "blocked",
      reason: "Child is blocked",
    });

    const started = assignments.startWakeup({
      assignmentId: parent.assignment.id,
      reason: "blocked child released budget",
    });
    assert.equal(started.assignment.wakeupCount, 1);
  });
});

test("AutonomousAssignmentService releases blocked child active slots", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Parent with tight child slots",
      policy: {
        maxWakeups: 3,
        childAssignments: { maxDepth: 1, maxActiveChildren: 1 },
      },
    });
    const child = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Child that blocks",
      rationale: "Blocked child should not occupy the only child slot.",
      waitForChild: true,
      policy: { maxWakeups: 1 },
    });
    assignments.applyWakeupDecision({
      assignmentId: child.child.assignment.id,
      decision: "blocked",
      reason: "Child is blocked",
    });

    const replacement = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Replacement child",
      rationale: "Blocked child released the active child slot.",
      waitForChild: true,
      policy: { maxWakeups: 1 },
    });

    assert.equal(replacement.child.assignment.lifecycleState, "active");
  });
});

test("AutonomousAssignmentService prevents blocked child resume from bypassing parent child slots", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Parent with one child slot",
      policy: {
        maxWakeups: 3,
        childAssignments: { maxDepth: 1, maxActiveChildren: 1 },
      },
    });
    const blocked = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Blocked child",
      rationale: "This child releases its slot while blocked.",
      waitForChild: true,
      policy: { maxWakeups: 1 },
    });
    assignments.applyWakeupDecision({
      assignmentId: blocked.child.assignment.id,
      decision: "blocked",
      reason: "Blocked on external evidence",
    });
    assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Replacement child",
      rationale: "This child claims the only slot.",
      waitForChild: true,
      policy: { maxWakeups: 1 },
    });

    assert.throws(
      () =>
        assignments.control(blocked.child.assignment.id, {
          action: "resume",
          reason: "Operator retries blocked child",
        }),
      /Assignment parent has no child capacity/
    );
    assert.equal(
      assignments.getRequired(blocked.child.assignment.id).assignment
        .lifecycleState,
      "blocked"
    );
  });
});

test("AutonomousAssignmentService ignores dependency-shaped opaque child metadata", () => {
  withAssignments((assignments) => {
    const parent = assignments.create({
      objective: "Coordinate child metadata",
      policy: {
        maxWakeups: 3,
        childAssignments: { maxDepth: 1, maxActiveChildren: 2 },
      },
    });
    const child = assignments.promoteChild({
      parentAssignmentId: parent.assignment.id,
      objective: "Child with opaque metadata",
      rationale: "Legacy metadata keys should not become dependencies.",
      metadata: {
        childDependencyConfigValidated: true,
        dependsOnChildIds: ["not-a-sibling"],
        waitForChildren: "all",
      },
      policy: { maxWakeups: 1 },
    });

    assert.deepEqual(child.child.assignment.metadata, {
      childDependencyConfigValidated: false,
      dependsOnChildIds: ["not-a-sibling"],
      parentAssignmentId: parent.assignment.id,
      parentWaitsForChild: false,
      waitForChildren: "all",
    });

    const started = assignments.startWakeup({
      assignmentId: child.child.assignment.id,
      reason: "opaque metadata is not orchestration policy",
    });

    assert.equal(started.assignment.wakeupCount, 1);
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

test("AutonomousAssignmentService compacts expired compactable assignment events", () => {
  withAssignments((assignments, database) => {
    const created = assignments.create({
      objective: "Summarize noisy assignment detail",
    });
    assignments.control(created.assignment.id, {
      action: "add_context",
      actor: "operator",
      context: { note: "First noisy detail" },
    });
    assignments.control(created.assignment.id, {
      action: "add_context",
      actor: "operator",
      context: { note: "Second noisy detail" },
    });
    database.run(
      `UPDATE assignment_events
       SET expires_at = ?
       WHERE assignment_id = ? AND type = ?`,
      "2026-06-01T00:00:00.000Z",
      created.assignment.id,
      "context_added"
    );
    const before = assignments.timeline(created.assignment.id).events;
    const compactedIds = before
      .filter((event) => event.type === "context_added")
      .map((event) => event.id);

    const result = assignments.compactEvents({
      assignmentId: created.assignment.id,
      actor: "operator",
      reason: "Expired assignment detail retention window",
      compactBefore: "2026-06-16T00:00:00.000Z",
    });

    assert.equal(result.assignmentId, created.assignment.id);
    assert.equal(result.compactedCount, 2);
    assert.deepEqual(result.deletedEventIds, compactedIds);
    assert.equal(result.summaryEvent?.type, "events_compacted");
    assert.equal(result.summaryEvent?.compactable, false);
    assert.equal(result.summaryEvent?.importance, "milestone");
    assert.deepEqual(result.summaryEvent?.payload, {
      actor: "operator",
      reason: "Expired assignment detail retention window",
      compactedCount: 2,
      eventTypes: { context_added: 2 },
      firstEventAt: before.find((event) => event.id === compactedIds[0])
        ?.createdAt,
      lastEventAt: before.find((event) => event.id === compactedIds[1])
        ?.createdAt,
      deletedEventIds: compactedIds,
    });
    assert.deepEqual(
      assignments
        .timeline(created.assignment.id)
        .events.map((event) => event.type),
      ["created", "events_compacted"]
    );
  });
});

test("AutonomousAssignmentService preserves audit and milestone assignment events during compaction", () => {
  withAssignments((assignments, database) => {
    const created = assignments.create({
      objective: "Keep audit evidence",
    });
    assignments.control(created.assignment.id, {
      action: "add_context",
      actor: "operator",
      context: { note: "Compact me" },
    });
    assignments.control(created.assignment.id, {
      action: "change_policy",
      actor: "operator",
      reason: "Audit policy change",
      policy: { maxWakeups: 7 },
    });
    database.run(
      `UPDATE assignment_events
       SET expires_at = ?
       WHERE assignment_id = ?`,
      "2026-06-01T00:00:00.000Z",
      created.assignment.id
    );

    const result = assignments.compactEvents({
      assignmentId: created.assignment.id,
      compactBefore: "2026-06-16T00:00:00.000Z",
    });

    assert.equal(result.compactedCount, 1);
    assert.deepEqual(
      assignments
        .timeline(created.assignment.id)
        .events.map((event) => event.type),
      ["created", "policy_changed", "events_compacted"]
    );
  });
});

test("AutonomousAssignmentService no-ops assignment event compaction when no events are eligible", () => {
  withAssignments((assignments) => {
    const created = assignments.create({
      objective: "No noisy detail yet",
    });

    const result = assignments.compactEvents({
      assignmentId: created.assignment.id,
      compactBefore: "2026-06-16T00:00:00.000Z",
    });

    assert.equal(result.compactedCount, 0);
    assert.deepEqual(result.deletedEventIds, []);
    assert.equal(result.summaryEvent, undefined);
    assert.deepEqual(
      assignments
        .timeline(created.assignment.id)
        .events.map((event) => event.type),
      ["created"]
    );
  });
});

test("AutonomousAssignmentService compacts only events before the requested cutoff", () => {
  withAssignments((assignments, database) => {
    const created = assignments.create({
      objective: "Keep recent detail",
    });
    assignments.control(created.assignment.id, {
      action: "add_context",
      actor: "operator",
      context: { note: "Old detail" },
    });
    const oldEvent = assignments
      .timeline(created.assignment.id)
      .events.find((event) => event.type === "context_added");
    assignments.control(created.assignment.id, {
      action: "add_context",
      actor: "operator",
      context: { note: "Recent detail" },
    });
    database.run(
      `UPDATE assignment_events
       SET expires_at = ?
       WHERE id = ?`,
      "2026-06-01T00:00:00.000Z",
      oldEvent?.id ?? ""
    );
    database.run(
      `UPDATE assignment_events
       SET expires_at = ?
       WHERE assignment_id = ? AND type = ? AND id != ?`,
      "2026-06-20T00:00:00.000Z",
      created.assignment.id,
      "context_added",
      oldEvent?.id ?? ""
    );

    const result = assignments.compactEvents({
      assignmentId: created.assignment.id,
      compactBefore: "2026-06-16T00:00:00.000Z",
    });

    assert.equal(result.compactedCount, 1);
    assert.deepEqual(
      assignments
        .timeline(created.assignment.id)
        .events.map((event) => event.type),
      ["created", "context_added", "events_compacted"]
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
