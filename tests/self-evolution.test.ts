import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/platform/database.ts";
import { SelfEvolutionProposalStore } from "../src/self-evolution/proposals.ts";

test("self-evolution proposals persist as auditable proposed records", () => {
  const database = new AppDatabase(":memory:");
  const store = new SelfEvolutionProposalStore(database);

  const proposal = store.create({
    target: "prompt",
    title: "Tighten memory prompt",
    rationale: "The coordinator should cite durable memory confidence.",
    riskClass: "medium",
    proposedChange: {
      summary: "Add confidence wording to the memory context prompt.",
      diff: "- old\n+ new",
    },
    metadata: { issue: 13 },
    proposedBy: "agent",
  });

  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.target, "prompt");
  assert.equal(proposal.riskClass, "medium");
  assert.equal(proposal.proposedBy, "agent");
  assert.deepEqual(proposal.metadata, { issue: 13 });
  assert.equal(store.get(proposal.id)?.id, proposal.id);
  assert.equal(store.list()[0]?.id, proposal.id);
  assert.deepEqual(store.summary(), {
    proposed: 1,
    approved: 0,
    applied: 0,
    failed: 0,
    rolledBack: 0,
    highRisk: 0,
    criticalRisk: 0,
    recent: [proposal],
    recentMutations: [],
  });

  database.close();
});

test("self-evolution proposals reject malformed or direct-apply requests", () => {
  const database = new AppDatabase(":memory:");
  const store = new SelfEvolutionProposalStore(database);

  assert.throws(
    () =>
      store.create({
        target: "filesystem" as "prompt",
        title: "Rewrite files",
        rationale: "Unsafe target",
        riskClass: "critical",
        proposedChange: { summary: "mutate" },
      }),
    /target must be/
  );

  assert.throws(
    () =>
      store.create({
        target: "configuration",
        title: "Apply config now",
        rationale: "Direct apply should wait for approval.",
        riskClass: "high",
        proposedChange: { summary: "change config", applyNow: true },
      }),
    /immediate apply/
  );

  assert.throws(
    () =>
      store.create({
        target: "tool",
        title: "Bad shape",
        rationale: "Proposed change needs structure.",
        riskClass: "low",
        proposedChange: "replace tool" as unknown as { summary: string },
      }),
    /JSON object/
  );

  assert.equal(store.list().length, 0);
  database.close();
});

test("self-evolution approvals, apply records, failures, and rollback are audited", () => {
  const database = new AppDatabase(":memory:");
  const store = new SelfEvolutionProposalStore(database);
  const proposal = store.create({
    target: "configuration",
    title: "Tune operator refresh",
    rationale: "Operators need a slower console refresh during incidents.",
    riskClass: "low",
    proposedChange: {
      summary: "Increase refresh interval.",
      operatorSettings: { dashboardRefreshSeconds: 10 },
    },
  });

  const approved = store.approve(proposal.id, {
    reviewedBy: "operator",
    notes: "Safe operator-console-only change.",
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.reviewedBy, "operator");

  const mutation = store.recordApplySuccess({
    proposalId: proposal.id,
    target: "configuration",
    mutationType: "operator_settings",
    before: { dashboardRefreshSeconds: 5 },
    after: { dashboardRefreshSeconds: 10 },
    rollback: { operatorSettings: { dashboardRefreshSeconds: 5 } },
    actor: "operator",
  });
  assert.equal(mutation.status, "applied");
  assert.equal(store.get(proposal.id)?.status, "applied");
  assert.equal(store.summary().applied, 1);

  const rolledBack = store.recordRollback({
    proposalId: proposal.id,
    mutationId: mutation.id,
    actor: "operator",
  });
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(store.listMutations(proposal.id)[0]?.status, "rolled_back");

  const failedProposal = store.create({
    target: "tool",
    title: "Unsupported apply",
    rationale: "Tool application is deferred.",
    riskClass: "medium",
    proposedChange: { summary: "Install tool bundle later" },
  });
  store.approve(failedProposal.id, { reviewedBy: "operator" });
  const failure = store.recordApplyFailure({
    proposalId: failedProposal.id,
    target: "tool",
    mutationType: "operator_settings",
    actor: "operator",
    errorMessage: "Unsupported mutation class",
  });
  assert.equal(failure.status, "failed");
  assert.equal(
    store.get(failedProposal.id)?.applyError,
    "Unsupported mutation class"
  );

  database.close();
});
