import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/platform/database.ts";
import { AutonomousAssignmentService } from "../src/assignments/service.ts";
import { AutonomousMutationLedger } from "../src/assignments/mutation-ledger.ts";

function withLedger(
  work: (
    ledger: AutonomousMutationLedger,
    assignments: AutonomousAssignmentService
  ) => void
): void {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  try {
    work(ledger, assignments);
  } finally {
    database.close();
  }
}

test("AutonomousMutationLedger records planned mutations and assignment timeline milestones", () => {
  withLedger((ledger, assignments) => {
    const assignment = assignments.create({
      objective: "Tune autonomous mutation evidence",
      autonomyLevel: "evolve",
    });

    const planned = ledger.recordPlanned({
      assignmentId: assignment.assignment.id,
      runId: "coord_mutation_plan",
      target: "configuration",
      mutationType: "operator_settings",
      autonomyLevel: "evolve",
      authorizingPolicy: { rule: "assignment.policy.selfEvolution" },
      rationale: "Adjust local operator cadence for this assignment.",
      riskClass: "low",
      affectedResources: [{ type: "settings", id: "operator" }],
    });

    assert.match(planned.id, /^asgnmut_/);
    assert.equal(planned.assignmentId, assignment.assignment.id);
    assert.equal(planned.runId, "coord_mutation_plan");
    assert.equal(planned.status, "planned");
    assert.deepEqual(planned.authorizingPolicy, {
      rule: "assignment.policy.selfEvolution",
    });
    assert.deepEqual(ledger.get(planned.id), planned);

    const timeline = assignments.timeline(assignment.assignment.id);
    const event = timeline.events.find(
      (item) => item.type === "mutation_planned"
    );
    assert.equal(event?.importance, "milestone");
    assert.equal(event?.compactable, false);
    assert.equal(
      (event?.payload as { mutationId?: string }).mutationId,
      planned.id
    );
  });
});

test("AutonomousMutationLedger records outcomes and enforces rollback evidence for applied records", () => {
  withLedger((ledger, assignments) => {
    const assignment = assignments.create({
      objective: "Apply autonomous mutation evidence",
      autonomyLevel: "evolve",
    });
    const planned = ledger.recordPlanned({
      assignmentId: assignment.assignment.id,
      target: "configuration",
      mutationType: "operator_settings",
      autonomyLevel: "evolve",
      authorizingPolicy: { maxRisk: "medium" },
      rationale: "Prepare a safe settings mutation.",
      riskClass: "medium",
      affectedResources: [{ type: "settings", id: "operator" }],
    });

    assert.throws(
      () =>
        ledger.recordApplied(planned.id, {
          after: { operatorSettings: { dashboardRefreshSeconds: 15 } },
          verification: { attempted: false },
        }),
      /rollback payload or before snapshot/
    );
    assert.throws(
      () =>
        ledger.recordApplied(planned.id, {
          before: null,
          after: { operatorSettings: { dashboardRefreshSeconds: 15 } },
          rollback: null,
        }),
      /rollback payload or before snapshot/
    );

    const applied = ledger.recordApplied(planned.id, {
      before: { operatorSettings: { dashboardRefreshSeconds: 30 } },
      after: { operatorSettings: { dashboardRefreshSeconds: 15 } },
      rollback: { operatorSettings: { dashboardRefreshSeconds: 30 } },
      verification: { attempted: true, result: "passed" },
      operatorNotification: { channelId: "slack", messageTs: "1713900000.0" },
    });
    assert.equal(applied.status, "applied");
    assert.deepEqual(applied.rollback, {
      operatorSettings: { dashboardRefreshSeconds: 30 },
    });
    assert.deepEqual(applied.verification, {
      attempted: true,
      result: "passed",
    });
    assert.deepEqual(applied.operatorNotification, {
      channelId: "slack",
      messageTs: "1713900000.0",
    });
    assert.match(applied.notifiedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.throws(
      () => ledger.recordOperatorNotification(applied.id, null),
      /operatorNotification must be a non-null JSON value/
    );

    const notified = ledger.recordOperatorNotification(applied.id, {
      channelId: "slack",
      messageTs: "1713900000.000100",
    });
    assert.equal(notified.status, "applied");
    assert.deepEqual(notified.operatorNotification, {
      channelId: "slack",
      messageTs: "1713900000.000100",
    });

    const rolledBack = ledger.recordRolledBack(applied.id, {
      verification: { attempted: true, result: "passed" },
    });
    assert.equal(rolledBack.status, "rolled_back");

    const failed = ledger.recordFailed({
      assignmentId: assignment.assignment.id,
      target: "project_file",
      mutationType: "workspace_patch",
      autonomyLevel: "evolve",
      authorizingPolicy: { maxRisk: "medium" },
      rationale: "Patch failed before apply.",
      riskClass: "medium",
      affectedResources: [{ type: "file", path: "README.md" }],
      errorMessage: "Patch rejected",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorMessage, "Patch rejected");

    const eventTypes = assignments
      .timeline(assignment.assignment.id)
      .events.map((event) => event.type);
    assert.deepEqual(eventTypes, [
      "created",
      "mutation_planned",
      "mutation_applied",
      "mutation_rolled_back",
      "mutation_failed",
    ]);
  });
});

test("AutonomousMutationLedger lists mutations through bounded domain filters", () => {
  withLedger((ledger, assignments) => {
    const first = assignments.create({
      objective: "First mutation list assignment",
      autonomyLevel: "evolve",
    });
    const second = assignments.create({
      objective: "Second mutation list assignment",
      autonomyLevel: "evolve",
    });
    const configuration = ledger.recordApplied(
      ledger.recordPlanned({
        assignmentId: first.assignment.id,
        runId: "coord_1",
        target: "configuration",
        mutationType: "operator_settings",
        autonomyLevel: "evolve",
        authorizingPolicy: { rule: "config" },
        rationale: "Config change",
        riskClass: "low",
      }).id,
      {
        before: { value: 1 },
        after: { value: 2 },
        rollback: { value: 1 },
      }
    );
    const fileMutation = ledger.recordFailed({
      assignmentId: second.assignment.id,
      runId: "coord_2",
      target: "project_file",
      mutationType: "workspace_patch",
      autonomyLevel: "evolve",
      authorizingPolicy: { rule: "file" },
      rationale: "File change",
      riskClass: "high",
      errorMessage: "not allowed",
    });

    assert.deepEqual(
      ledger.list({ assignmentId: first.assignment.id }).map((item) => item.id),
      [configuration.id]
    );
    assert.deepEqual(
      ledger.list({ runId: "coord_2" }).map((item) => item.id),
      [fileMutation.id]
    );
    assert.deepEqual(
      ledger.list({ target: "project_file" }).map((item) => item.id),
      [fileMutation.id]
    );
    assert.deepEqual(
      ledger.list({ status: "applied" }).map((item) => item.id),
      [configuration.id]
    );
    assert.throws(() => ledger.list({ limit: 0 }), /limit/);
    assert.equal(ledger.get("asgnmut_missing"), null);
  });
});

test("AutonomousMutationLedger returns only proven affected-resource rollback conflicts", () => {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  try {
    const assignment = assignments.create({
      objective: "Bound affected resource rollback scans",
      autonomyLevel: "evolve",
    });
    const current = ledger.recordApplied(
      ledger.recordPlanned({
        assignmentId: assignment.assignment.id,
        target: "project_file",
        mutationType: "apply_patch",
        autonomyLevel: "evolve",
        authorizingPolicy: { rule: "test" },
        rationale: "Apply current patch.",
        riskClass: "high",
        affectedResources: [{ type: "file", path: "docs/current.md" }],
      }).id,
      {
        before: { file: "before" },
        after: { file: "after" },
        rollback: { file: "before" },
        affectedResources: [{ type: "file", path: "docs/current.md" }],
      }
    );

    for (let index = 0; index < 1001; index += 1) {
      ledger.recordApplied(
        ledger.recordPlanned({
          assignmentId: assignment.assignment.id,
          target: "project_file",
          mutationType: "apply_patch",
          autonomyLevel: "evolve",
          authorizingPolicy: { rule: "test" },
          rationale: `Apply unrelated patch ${index}.`,
          riskClass: "high",
          affectedResources: [
            { type: "file", path: `docs/unrelated-${index}.md` },
          ],
        }).id,
        {
          before: { file: "before" },
          after: { file: "after" },
          rollback: { file: "before" },
          affectedResources: [
            { type: "file", path: `docs/unrelated-${index}.md` },
          ],
        }
      );
    }

    assert.equal(
      ledger.findNewerApplied({
        assignmentId: assignment.assignment.id,
        target: current.target,
        mutationType: current.mutationType,
        appliedAt: current.appliedAt ?? "",
        id: current.id,
        scope: "affected_resources",
        affectedResources: current.affectedResources,
      }),
      null
    );
  } finally {
    database.close();
  }
});

test("AutonomousMutationLedger finds affected-resource conflicts beyond unrelated rows", () => {
  const database = new AppDatabase(":memory:");
  const assignments = new AutonomousAssignmentService(database);
  const ledger = new AutonomousMutationLedger(database, assignments);
  try {
    const assignment = assignments.create({
      objective: "Find buried affected resource rollback conflicts",
      autonomyLevel: "evolve",
    });
    const current = ledger.recordApplied(
      ledger.recordPlanned({
        assignmentId: assignment.assignment.id,
        target: "project_file",
        mutationType: "apply_patch",
        autonomyLevel: "evolve",
        authorizingPolicy: { rule: "test" },
        rationale: "Apply current patch.",
        riskClass: "high",
        affectedResources: [{ type: "file", path: "docs/current.md" }],
      }).id,
      {
        before: { file: "before" },
        after: { file: "after" },
        rollback: { file: "before" },
        affectedResources: [{ type: "file", path: "docs/current.md" }],
      }
    );
    const conflict = ledger.recordApplied(
      ledger.recordPlanned({
        assignmentId: assignment.assignment.id,
        target: "project_file",
        mutationType: "apply_patch",
        autonomyLevel: "evolve",
        authorizingPolicy: { rule: "test" },
        rationale: "Apply conflicting patch.",
        riskClass: "high",
        affectedResources: [{ type: "file", path: "docs/current.md" }],
      }).id,
      {
        before: { file: "after" },
        after: { file: "newer" },
        rollback: { file: "after" },
        affectedResources: [{ type: "file", path: "docs/current.md" }],
      }
    );

    for (let index = 0; index < 1001; index += 1) {
      ledger.recordApplied(
        ledger.recordPlanned({
          assignmentId: assignment.assignment.id,
          target: "project_file",
          mutationType: "apply_patch",
          autonomyLevel: "evolve",
          authorizingPolicy: { rule: "test" },
          rationale: `Apply unrelated patch ${index}.`,
          riskClass: "high",
          affectedResources: [
            { type: "file", path: `docs/unrelated-${index}.md` },
          ],
        }).id,
        {
          before: { file: "before" },
          after: { file: "after" },
          rollback: { file: "before" },
          affectedResources: [
            { type: "file", path: `docs/unrelated-${index}.md` },
          ],
        }
      );
    }

    assert.equal(
      ledger.findNewerApplied({
        assignmentId: assignment.assignment.id,
        target: current.target,
        mutationType: current.mutationType,
        appliedAt: current.appliedAt ?? "",
        id: current.id,
        scope: "affected_resources",
        affectedResources: current.affectedResources,
      })?.id,
      conflict.id
    );
  } finally {
    database.close();
  }
});
