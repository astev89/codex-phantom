import test from "node:test";
import assert from "node:assert/strict";
import {
  AutonomousMutationExecutionError,
  AutonomousMutationExecutor,
} from "../src/assignments/autonomous-mutations.ts";
import { AutonomousMutationLedger } from "../src/assignments/mutation-ledger.ts";
import { AutonomousAssignmentService } from "../src/assignments/service.ts";
import { AppDatabase } from "../src/platform/database.ts";
import { OperatorSettingsStore } from "../src/server/settings.ts";

function createHarness() {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
  });
  return { assignments, database, executor, ledger, settings };
}

test("AutonomousMutationExecutor applies bounded operator settings mutations for evolve assignments", () => {
  const { assignments, database, executor, ledger, settings } = createHarness();
  const assignment = assignments.create({
    objective: "Tune autonomous operator settings",
    autonomyLevel: "evolve",
  });

  const result = executor.apply({
    assignmentId: assignment.assignment.id,
    runId: "coord_autonomous_config",
    target: "configuration",
    mutationType: "operator_settings",
    rationale:
      "Slow down the operator console while autonomous work is active.",
    actor: "alice",
    proposedChange: {
      operatorSettings: { dashboardRefreshSeconds: 12 },
    },
  });

  assert.equal(settings.get().dashboardRefreshSeconds, 12);
  assert.equal(result.assignment.assignment.id, assignment.assignment.id);
  assert.equal(result.mutation.status, "applied");
  assert.equal(result.mutation.assignmentId, assignment.assignment.id);
  assert.equal(result.mutation.runId, "coord_autonomous_config");
  assert.equal(result.mutation.target, "configuration");
  assert.equal(result.mutation.mutationType, "operator_settings");
  assert.equal(result.mutation.autonomyLevel, "evolve");
  assert.deepEqual(result.mutation.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: ["configuration.operator_settings"],
    actor: "alice",
  });
  assert.deepEqual(result.mutation.before, {
    dashboardRefreshSeconds: 5,
    chatDefaultConversationId: "operator-console",
    memoryTimelineLimit: 20,
  });
  assert.deepEqual(result.mutation.after, {
    dashboardRefreshSeconds: 12,
    chatDefaultConversationId: "operator-console",
    memoryTimelineLimit: 20,
  });
  assert.deepEqual(result.mutation.rollback, {
    operatorSettings: {
      dashboardRefreshSeconds: 5,
      chatDefaultConversationId: "operator-console",
      memoryTimelineLimit: 20,
    },
  });
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      id: mutation.id,
      status: mutation.status,
    })),
    [{ id: result.mutation.id, status: "applied" }]
  );
  const timelineEvents = assignments.timeline(assignment.assignment.id).events;
  assert.deepEqual(
    timelineEvents.map((event) => event.type),
    ["created", "mutation_planned", "mutation_applied"]
  );
  assert.deepEqual(
    timelineEvents
      .filter((event) => event.type.startsWith("mutation_"))
      .map((event) => (event.payload as { actor?: string }).actor),
    ["alice", "alice"]
  );

  database.close();
});

test("AutonomousMutationExecutor blocks non-evolve assignments without mutation evidence", () => {
  for (const autonomyLevel of ["execute", "draft", "observe"] as const) {
    const { assignments, database, executor, ledger, settings } =
      createHarness();
    const assignment = assignments.create({
      objective: `Blocked ${autonomyLevel} mutation`,
      autonomyLevel,
    });

    assert.throws(
      () =>
        executor.apply({
          assignmentId: assignment.assignment.id,
          target: "configuration",
          mutationType: "operator_settings",
          rationale: "Try to mutate without evolve authority.",
          proposedChange: {
            operatorSettings: { dashboardRefreshSeconds: 12 },
          },
        }),
      (error) => {
        assert.ok(error instanceof AutonomousMutationExecutionError);
        assert.equal(error.status, 403);
        assert.match(error.message, /must be evolve/);
        return true;
      }
    );
    assert.equal(settings.get().dashboardRefreshSeconds, 5);
    assert.deepEqual(
      ledger.list({ assignmentId: assignment.assignment.id }),
      []
    );

    database.close();
  }
});

test("AutonomousMutationExecutor audits unsupported and malformed autonomous mutations as failed", () => {
  const { assignments, database, executor, ledger, settings } = createHarness();
  const assignment = assignments.create({
    objective: "Audit failed autonomous mutations",
    autonomyLevel: "evolve",
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "tool",
        mutationType: "tool_bundle_enable",
        rationale: "Try a deferred mutation class.",
        proposedChange: { toolBundleId: "bundle_123" },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /Only configuration\.operator_settings/);
      return true;
    }
  );
  assert.equal(settings.get().dashboardRefreshSeconds, 5);

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "configuration",
        mutationType: "operator_settings",
        rationale: "Try malformed operator settings.",
        proposedChange: {
          operatorSettings: { dashboardRefreshSeconds: 0 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /positive integer/);
      return true;
    }
  );
  assert.equal(settings.get().dashboardRefreshSeconds, 5);

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "configuration",
        mutationType: "operator_settings",
        rationale: "Try out-of-range operator settings.",
        proposedChange: {
          operatorSettings: { memoryTimelineLimit: 999 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /less than or equal to 100/);
      return true;
    }
  );
  assert.equal(settings.get().memoryTimelineLimit, 20);

  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      target: mutation.target,
      mutationType: mutation.mutationType,
      status: mutation.status,
      errorMessage: mutation.errorMessage,
    })),
    [
      {
        target: "configuration",
        mutationType: "operator_settings",
        status: "failed",
        errorMessage:
          "operatorSettings.memoryTimelineLimit must be less than or equal to 100",
      },
      {
        target: "configuration",
        mutationType: "operator_settings",
        status: "failed",
        errorMessage:
          "operatorSettings.dashboardRefreshSeconds must be a positive integer",
      },
      {
        target: "tool",
        mutationType: "tool_bundle_enable",
        status: "failed",
        errorMessage:
          "Only configuration.operator_settings autonomous mutations are supported in this slice",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor rolls back applied operator settings mutations", () => {
  const { assignments, database, executor, settings } = createHarness();
  const assignment = assignments.create({
    objective: "Roll back autonomous operator settings",
    autonomyLevel: "evolve",
  });
  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "operator_settings",
    rationale: "Temporarily tune the operator console.",
    proposedChange: {
      operatorSettings: {
        dashboardRefreshSeconds: 15,
        chatDefaultConversationId: "autonomy-console",
      },
    },
  });
  assert.equal(settings.get().dashboardRefreshSeconds, 15);
  assert.equal(settings.get().chatDefaultConversationId, "autonomy-console");

  const rolledBack = executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
    actor: "bob",
  });

  assert.equal(rolledBack.mutation.status, "rolled_back");
  assert.deepEqual(settings.get(), {
    dashboardRefreshSeconds: 5,
    chatDefaultConversationId: "operator-console",
    memoryTimelineLimit: 20,
  });
  const timelineEvents = assignments.timeline(assignment.assignment.id).events;
  assert.deepEqual(
    timelineEvents.map((event) => event.type),
    ["created", "mutation_planned", "mutation_applied", "mutation_rolled_back"]
  );
  assert.equal(
    (
      timelineEvents.find((event) => event.type === "mutation_rolled_back")
        ?.payload as { actor?: string }
    ).actor,
    "bob"
  );

  database.close();
});

test("AutonomousMutationExecutor blocks rollback when newer operator settings mutations are applied", () => {
  const { assignments, database, executor, ledger, settings } = createHarness();
  const assignment = assignments.create({
    objective: "Prevent stale autonomous operator settings rollback",
    autonomyLevel: "evolve",
  });
  const first = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "operator_settings",
    rationale: "Temporarily slow down the operator console.",
    proposedChange: {
      operatorSettings: { dashboardRefreshSeconds: 15 },
    },
  });
  const second = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "operator_settings",
    rationale: "Temporarily expand the assignment timeline.",
    proposedChange: {
      operatorSettings: { memoryTimelineLimit: 25 },
    },
  });
  const sameAppliedAt = "2026-06-12T22:00:00.000Z";
  database.run(
    "UPDATE assignment_mutations SET applied_at = ? WHERE id IN (?, ?)",
    sameAppliedAt,
    first.mutation.id,
    second.mutation.id
  );
  database.run(
    "UPDATE assignment_mutations SET id = ? WHERE id = ?",
    "asgnmut_same_z",
    first.mutation.id
  );
  database.run(
    "UPDATE assignment_mutations SET id = ? WHERE id = ?",
    "asgnmut_same_10",
    second.mutation.id
  );

  assert.throws(
    () =>
      executor.rollback({
        assignmentId: assignment.assignment.id,
        mutationId: "asgnmut_same_z",
        actor: "bob",
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 409);
      assert.match(error.message, /newer applied/);
      return true;
    }
  );
  assert.deepEqual(settings.get(), {
    dashboardRefreshSeconds: 15,
    chatDefaultConversationId: "operator-console",
    memoryTimelineLimit: 25,
  });
  assert.deepEqual(
    ledger
      .list({ assignmentId: assignment.assignment.id })
      .map((mutation) => ({
        id: mutation.id,
        status: mutation.status,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    [
      { id: "asgnmut_same_10", status: "applied" },
      { id: "asgnmut_same_z", status: "applied" },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor does not reuse apply actor for actorless rollback events", () => {
  const { assignments, database, executor, settings } = createHarness();
  const assignment = assignments.create({
    objective: "Keep rollback attribution distinct",
    autonomyLevel: "evolve",
  });
  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "operator_settings",
    rationale: "Temporarily tune the operator console.",
    actor: "alice",
    proposedChange: {
      operatorSettings: { dashboardRefreshSeconds: 15 },
    },
  });

  executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
  });

  assert.equal(settings.get().dashboardRefreshSeconds, 5);
  const rollbackEvent = assignments
    .timeline(assignment.assignment.id)
    .events.find((event) => event.type === "mutation_rolled_back");
  assert.deepEqual((rollbackEvent?.payload as { actor?: string }).actor, null);

  database.close();
});
