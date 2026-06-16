import test from "node:test";
import assert from "node:assert/strict";
import {
  type AutonomousMutationAdapter,
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
    mutationClass: "configuration.operator_settings",
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

test("AutonomousMutationExecutor supports injected autonomous mutation adapters", () => {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const fakeState = { value: "before" };
  const fakeAdapter: AutonomousMutationAdapter = {
    target: "configuration",
    mutationType: "fake_settings",
    mutationClass: "configuration.fake_settings",
    affectedResources: [{ type: "settings", id: "fake" }],
    apply(input) {
      const proposedChange = input.proposedChange as {
        fakeSettings?: { value?: string };
      };
      const nextValue = proposedChange.fakeSettings?.value;
      if (!nextValue) {
        throw new Error("fakeSettings.value is required");
      }
      const before = { value: fakeState.value };
      fakeState.value = nextValue;
      return {
        before,
        after: { value: fakeState.value },
        rollback: { fakeSettings: before },
        affectedResources: [{ type: "settings", id: "fake" }],
        verificationMethod: "fake_settings_update",
      };
    },
    rollback(input) {
      const rollback = input.rollback as { fakeSettings?: { value?: string } };
      const previousValue = rollback.fakeSettings?.value;
      if (!previousValue) {
        throw new Error("rollback.fakeSettings.value is required");
      }
      fakeState.value = previousValue;
      return {
        verificationMethod: "fake_settings_rollback",
      };
    },
  };
  const executor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
    adapters: [fakeAdapter],
  });
  const assignment = assignments.create({
    objective: "Apply injected mutation adapter",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: ["configuration.fake_settings"],
      },
    },
  });

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    target: "configuration",
    mutationType: "fake_settings",
    rationale: "Exercise the adapter registry.",
    proposedChange: {
      fakeSettings: { value: "after" },
    },
  });

  assert.equal(fakeState.value, "after");
  assert.equal(applied.mutation.status, "applied");
  assert.equal(applied.mutation.mutationType, "fake_settings");
  assert.deepEqual(applied.mutation.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: ["configuration.fake_settings"],
    mutationClass: "configuration.fake_settings",
  });
  assert.deepEqual(applied.mutation.rollback, {
    fakeSettings: { value: "before" },
  });
  assert.deepEqual(applied.mutation.affectedResources, [
    { type: "settings", id: "fake" },
  ]);
  assert.deepEqual(applied.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "fake_settings_update",
  });

  const defaultOnlyExecutor = new AutonomousMutationExecutor({
    assignments,
    ledger,
    settings,
  });
  assert.throws(
    () =>
      defaultOnlyExecutor.rollback({
        assignmentId: assignment.assignment.id,
        mutationId: applied.mutation.id,
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.match(error.message, /Only configuration\.operator_settings/);
      return true;
    }
  );
  assert.equal(fakeState.value, "after");

  const rolledBack = executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
  });

  assert.equal(fakeState.value, "before");
  assert.equal(rolledBack.mutation.status, "rolled_back");
  assert.deepEqual(rolledBack.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "fake_settings_rollback",
  });

  database.close();
});

test("AutonomousMutationExecutor applies explicit assignment policy mutations", () => {
  const { assignments, database, executor, ledger } = createHarness();
  const assignment = assignments.create({
    objective: "Tune assignment execution policy",
    autonomyLevel: "evolve",
    policy: {
      maxWakeups: 4,
      wakeupDelayMinMinutes: 5,
      wakeupDelayMaxMinutes: 60,
      notificationCadence: {
        onFailure: true,
        activeProgressIntervalMinutes: 30,
      },
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.assignment_policy",
        ],
      },
    },
  });

  const applied = executor.apply({
    assignmentId: assignment.assignment.id,
    runId: "coord_assignment_policy",
    target: "configuration",
    mutationType: "assignment_policy",
    rationale: "Give this assignment a little more wakeup room.",
    actor: "alice",
    proposedChange: {
      assignmentPolicy: {
        maxWakeups: 8,
        wakeupDelayMinMinutes: 10,
        wakeupDelayMaxMinutes: 120,
        notificationCadence: {
          onFailure: false,
          activeProgressIntervalMinutes: 45,
        },
      },
    },
  });

  const updated = assignments.getRequired(assignment.assignment.id).assignment;
  assert.equal(updated.policy.maxWakeups, 8);
  assert.equal(updated.policy.wakeupDelayMinMinutes, 10);
  assert.equal(updated.policy.wakeupDelayMaxMinutes, 120);
  assert.equal(updated.policy.notificationCadence.onFailure, false);
  assert.equal(
    updated.policy.notificationCadence.activeProgressIntervalMinutes,
    45
  );
  assert.deepEqual(updated.policy.selfEvolution.allowedMutationClasses, [
    "configuration.operator_settings",
    "configuration.assignment_policy",
  ]);
  assert.equal(applied.mutation.status, "applied");
  assert.equal(applied.mutation.mutationType, "assignment_policy");
  assert.deepEqual(applied.mutation.authorizingPolicy, {
    rule: "assignment.policy.selfEvolution",
    maxRiskClass: "medium",
    allowedMutationClasses: [
      "configuration.operator_settings",
      "configuration.assignment_policy",
    ],
    mutationClass: "configuration.assignment_policy",
    actor: "alice",
  });
  assert.equal(
    (applied.mutation.before as { maxWakeups?: number }).maxWakeups,
    4
  );
  assert.equal(
    (applied.mutation.after as { maxWakeups?: number }).maxWakeups,
    8
  );
  assert.deepEqual(applied.mutation.rollback, {
    assignmentPolicy: assignment.assignment.policy,
  });
  assert.deepEqual(applied.mutation.affectedResources, [
    { type: "assignment_policy", id: assignment.assignment.id },
  ]);
  assert.deepEqual(applied.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "assignment_policy_update",
  });
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      id: mutation.id,
      status: mutation.status,
    })),
    [{ id: applied.mutation.id, status: "applied" }]
  );

  const rolledBack = executor.rollback({
    assignmentId: assignment.assignment.id,
    mutationId: applied.mutation.id,
    actor: "bob",
  });

  assert.equal(rolledBack.mutation.status, "rolled_back");
  assert.deepEqual(
    assignments.getRequired(assignment.assignment.id).assignment.policy,
    assignment.assignment.policy
  );
  assert.deepEqual(rolledBack.mutation.verification, {
    attempted: true,
    result: "passed",
    method: "assignment_policy_rollback",
  });
  assert.deepEqual(
    assignments
      .timeline(assignment.assignment.id)
      .events.map((event) => event.type),
    [
      "created",
      "mutation_planned",
      "policy_changed",
      "mutation_applied",
      "policy_changed",
      "mutation_rolled_back",
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor blocks assignment policy authority escalation", () => {
  const { assignments, database, executor, ledger } = createHarness();
  const assignment = assignments.create({
    objective: "Do not let assignment policy mutate self-evolution",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.assignment_policy",
        ],
      },
    },
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "configuration",
        mutationType: "assignment_policy",
        rationale: "Try to widen mutation authority.",
        proposedChange: {
          assignmentPolicy: {
            selfEvolution: {
              allowedMutationClasses: [
                "configuration.operator_settings",
                "configuration.assignment_policy",
                "tool.bundle_enable",
              ],
            },
          },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(
        error.message,
        /assignmentPolicy.selfEvolution cannot be changed/
      );
      return true;
    }
  );

  assert.deepEqual(
    assignments.getRequired(assignment.assignment.id).assignment.policy,
    assignment.assignment.policy
  );
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      status: mutation.status,
      mutationType: mutation.mutationType,
      errorMessage: mutation.errorMessage,
    })),
    [
      {
        status: "failed",
        mutationType: "assignment_policy",
        errorMessage:
          "assignmentPolicy.selfEvolution cannot be changed by autonomous assignment policy mutations",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor keeps assignment policy mutations opt-in", () => {
  const { assignments, database, executor, ledger } = createHarness();
  const assignment = assignments.create({
    objective: "Default policy should not mutate assignment policy",
    autonomyLevel: "evolve",
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "configuration",
        mutationType: "assignment_policy",
        rationale: "Try assignment policy mutation without explicit opt-in.",
        proposedChange: {
          assignmentPolicy: { maxWakeups: 9 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 403);
      assert.equal(error.mutation?.status, "failed");
      assert.match(
        error.message,
        /does not allow configuration\.assignment_policy/
      );
      return true;
    }
  );

  assert.equal(
    assignments.getRequired(assignment.assignment.id).assignment.policy
      .maxWakeups,
    5
  );
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      status: mutation.status,
      mutationType: mutation.mutationType,
      authorizingPolicy: mutation.authorizingPolicy,
      errorMessage: mutation.errorMessage,
    })),
    [
      {
        status: "failed",
        mutationType: "assignment_policy",
        authorizingPolicy: {
          rule: "assignment.policy.selfEvolution",
          maxRiskClass: "medium",
          allowedMutationClasses: ["configuration.operator_settings"],
          mutationClass: "configuration.assignment_policy",
        },
        errorMessage:
          "Assignment self-evolution policy does not allow configuration.assignment_policy",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor rejects malformed assignment policy mutations without changing policy", () => {
  const { assignments, database, executor, ledger } = createHarness();
  const assignment = assignments.create({
    objective: "Reject malformed assignment policy mutation",
    autonomyLevel: "evolve",
    policy: {
      maxWakeups: 5,
      selfEvolution: {
        allowedMutationClasses: [
          "configuration.operator_settings",
          "configuration.assignment_policy",
        ],
      },
    },
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: assignment.assignment.id,
        target: "configuration",
        mutationType: "assignment_policy",
        rationale: "Try an invalid wakeup budget.",
        proposedChange: {
          assignmentPolicy: { maxWakeups: 0 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 400);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /maxWakeups must be a positive integer/);
      return true;
    }
  );

  assert.equal(
    assignments.getRequired(assignment.assignment.id).assignment.policy
      .maxWakeups,
    5
  );
  assert.deepEqual(
    ledger.list({ assignmentId: assignment.assignment.id }).map((mutation) => ({
      status: mutation.status,
      errorMessage: mutation.errorMessage,
    })),
    [
      {
        status: "failed",
        errorMessage: "maxWakeups must be a positive integer",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor rejects duplicate autonomous mutation adapters", () => {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  const settings = new OperatorSettingsStore(database);
  const adapter: AutonomousMutationAdapter = {
    target: "configuration",
    mutationType: "fake_settings",
    mutationClass: "configuration.fake_settings",
    affectedResources: [{ type: "settings", id: "fake" }],
    apply() {
      return {
        before: { value: "before" },
        after: { value: "after" },
        rollback: { fakeSettings: { value: "before" } },
      };
    },
    rollback() {},
  };

  assert.throws(
    () =>
      new AutonomousMutationExecutor({
        assignments,
        ledger,
        settings,
        adapters: [adapter, adapter],
      }),
    /Duplicate autonomous mutation adapter for configuration\.fake_settings/
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
          "Only configuration.operator_settings and configuration.assignment_policy autonomous mutations are supported in this slice",
      },
    ]
  );

  database.close();
});

test("AutonomousMutationExecutor audits self-evolution policy denials as failed", () => {
  const { assignments, database, executor, ledger, settings } = createHarness();
  const disabled = assignments.create({
    objective: "Disabled self-evolution policy",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        enabled: false,
      },
    },
  });
  const disallowed = assignments.create({
    objective: "Disallowed self-evolution mutation class",
    autonomyLevel: "evolve",
    policy: {
      selfEvolution: {
        allowedMutationClasses: [],
      },
    },
  });

  assert.throws(
    () =>
      executor.apply({
        assignmentId: disabled.assignment.id,
        target: "configuration",
        mutationType: "operator_settings",
        rationale: "Try to mutate while self-evolution is disabled.",
        proposedChange: {
          operatorSettings: { dashboardRefreshSeconds: 12 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 403);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /self-evolution policy is disabled/);
      return true;
    }
  );

  assert.throws(
    () =>
      executor.apply({
        assignmentId: disallowed.assignment.id,
        target: "configuration",
        mutationType: "operator_settings",
        rationale: "Try to mutate without an allowed mutation class.",
        proposedChange: {
          operatorSettings: { dashboardRefreshSeconds: 12 },
        },
      }),
    (error) => {
      assert.ok(error instanceof AutonomousMutationExecutionError);
      assert.equal(error.status, 403);
      assert.equal(error.mutation?.status, "failed");
      assert.match(error.message, /does not allow/);
      return true;
    }
  );

  assert.equal(settings.get().dashboardRefreshSeconds, 5);
  assert.deepEqual(
    ledger.list({ assignmentId: disabled.assignment.id }).map((mutation) => ({
      status: mutation.status,
      errorMessage: mutation.errorMessage,
      authorizingPolicy: mutation.authorizingPolicy,
    })),
    [
      {
        status: "failed",
        errorMessage: "Assignment self-evolution policy is disabled",
        authorizingPolicy: {
          rule: "assignment.policy.selfEvolution",
          maxRiskClass: "medium",
          allowedMutationClasses: ["configuration.operator_settings"],
          mutationClass: "configuration.operator_settings",
        },
      },
    ]
  );
  assert.deepEqual(
    ledger.list({ assignmentId: disallowed.assignment.id }).map((mutation) => ({
      status: mutation.status,
      errorMessage: mutation.errorMessage,
      authorizingPolicy: mutation.authorizingPolicy,
    })),
    [
      {
        status: "failed",
        errorMessage:
          "Assignment self-evolution policy does not allow configuration.operator_settings",
        authorizingPolicy: {
          rule: "assignment.policy.selfEvolution",
          maxRiskClass: "medium",
          allowedMutationClasses: [],
          mutationClass: "configuration.operator_settings",
        },
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
