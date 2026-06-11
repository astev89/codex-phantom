import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/platform/database.ts";
import { AutonomousAssignmentService } from "../src/assignments/service.ts";
import {
  ASSIGNMENT_WAKEUP_JOB_NAME,
  AssignmentWakeupPlanner,
} from "../src/assignments/wakeup-planner.ts";
import {
  AssignmentIntakeService,
  classifyAssignmentIntent,
} from "../src/assignments/intake.ts";
import type { JobRecord } from "../src/scheduler/service.ts";

type ScheduledJob = JobRecord & {
  delayMs?: number;
};

function makeWakeups(): {
  jobs: ScheduledJob[];
  wakeups: Pick<AssignmentWakeupPlanner, "scheduleNext">;
} {
  const jobs: ScheduledJob[] = [];
  return {
    jobs,
    wakeups: {
      async scheduleNext(input) {
        const job: ScheduledJob = {
          id: `job_${jobs.length + 1}`,
          name: ASSIGNMENT_WAKEUP_JOB_NAME,
          message: JSON.stringify({
            assignmentId: input.assignmentId,
            reason: input.reason,
          }),
          scheduledAt: new Date(
            Date.now() + (input.delayMinutes ?? 0) * 60_000
          ).toISOString(),
          subagents: [],
          status: "scheduled",
          createdAt: new Date().toISOString(),
          attemptCount: 0,
          maxAttempts: 1,
          delayMs: input.force ? 0 : (input.delayMinutes ?? 0) * 60_000,
        };
        jobs.push(job);
        return job;
      },
    },
  };
}

test("assignment intake classifier preserves one-shot behavior by default", () => {
  assert.deepEqual(
    classifyAssignmentIntent({
      message: "What is the current readiness status?",
    }).kind,
    "one_shot"
  );
});

test("assignment intake classifier detects explicit persistence intent", () => {
  const decision = classifyAssignmentIntent({
    message: "Monitor this deploy and check back later.",
  });

  assert.equal(decision.kind, "create_assignment");
  assert.match(
    decision.kind === "create_assignment" ? decision.objective : "",
    /Monitor this deploy/
  );
});

test("assignment intake classifier honors structured assignment overrides", () => {
  assert.equal(
    classifyAssignmentIntent({
      message: "Run once only.",
      assignment: { create: false },
    }).kind,
    "one_shot"
  );

  const decision = classifyAssignmentIntent({
    message: "Research this.",
    assignment: {
      create: true,
      title: "Research task",
      autonomyLevel: "execute",
      policy: { maxWakeups: 3 },
    },
  });

  assert.equal(decision.kind, "create_assignment");
  if (decision.kind !== "create_assignment") {
    throw new Error("expected create_assignment");
  }
  assert.equal(decision.title, "Research task");
  assert.equal(decision.autonomyLevel, "execute");
  assert.equal(decision.policy?.maxWakeups, 3);
});

test("AssignmentIntakeService creates assignments and schedules an immediate wakeup", async () => {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const { wakeups, jobs } = makeWakeups();
  const intake = new AssignmentIntakeService(assignments, wakeups);
  try {
    const result = await intake.handle({
      channelId: "slack",
      providerEventId: "evt_123",
      conversationId: "slack:C123:171",
      senderId: "U123",
      message: "Keep working on the deploy until it is green.",
      rawPayload: { type: "event_callback" },
    });

    assert.equal(result.kind, "assignment_created");
    if (result.kind !== "assignment_created") {
      throw new Error("expected assignment_created");
    }
    assert.equal(result.assignment.assignment.source.channelId, "slack");
    assert.equal(
      result.assignment.assignment.source.conversationId,
      "slack:C123:171"
    );
    assert.equal(result.assignment.assignment.source.userId, "U123");
    assert.equal(result.assignment.assignment.createdBy, "U123");
    assert.deepEqual(result.assignment.assignment.metadata, {
      intake: {
        providerEventId: "evt_123",
        reason: "persistence_intent",
        rawPayload: { type: "event_callback" },
      },
    });
    assert.equal(result.nextJob?.name, ASSIGNMENT_WAKEUP_JOB_NAME);
    assert.equal(jobs[0]?.delayMs, 0);
    assert.match(result.acknowledgementText, /Created assignment asgn_/);
  } finally {
    database.close();
  }
});

test("AssignmentIntakeService preserves one-shot messages", async () => {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const { wakeups, jobs } = makeWakeups();
  const intake = new AssignmentIntakeService(assignments, wakeups);
  try {
    const result = await intake.handle({
      channelId: "web",
      conversationId: "web-chat",
      senderId: "operator",
      message: "Answer this once.",
      rawPayload: {},
    });

    assert.equal(result.kind, "one_shot");
    assert.equal(assignments.list().length, 0);
    assert.equal(jobs.length, 0);
  } finally {
    database.close();
  }
});

test("AssignmentIntakeService is idempotent for repeated provider events", async () => {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const { wakeups, jobs } = makeWakeups();
  const intake = new AssignmentIntakeService(assignments, wakeups);
  try {
    const first = await intake.handle({
      channelId: "slack",
      providerEventId: "evt_duplicate",
      conversationId: "slack:C123:171",
      senderId: "U123",
      message: "Keep working on this until it is complete.",
      rawPayload: { retry: 1 },
    });
    const second = await intake.handle({
      channelId: "slack",
      providerEventId: "evt_duplicate",
      conversationId: "slack:C123:171",
      senderId: "U123",
      message: "Keep working on this until it is complete.",
      rawPayload: { retry: 2 },
    });

    assert.equal(first.kind, "assignment_created");
    assert.equal(second.kind, "assignment_created");
    if (
      first.kind !== "assignment_created" ||
      second.kind !== "assignment_created"
    ) {
      throw new Error("expected assignment_created");
    }
    assert.equal(
      first.assignment.assignment.id,
      second.assignment.assignment.id
    );
    assert.equal(assignments.list().length, 1);
    assert.equal(jobs.length, 1);
  } finally {
    database.close();
  }
});
