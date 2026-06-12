import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/platform/database.ts";
import { OperatorSettingsStore } from "../src/server/settings.ts";
import { SelfEvolutionProposalStore } from "../src/self-evolution/proposals.ts";
import {
  SelfEvolutionMutationError,
  SelfEvolutionMutationService,
  createOperatorSettingsMutationAdapter,
} from "../src/self-evolution/mutations.ts";

function createHarness() {
  const database = new AppDatabase(":memory:");
  const proposals = new SelfEvolutionProposalStore(database);
  const settings = new OperatorSettingsStore(database);
  const service = new SelfEvolutionMutationService({
    proposals,
    adapters: [createOperatorSettingsMutationAdapter(settings)],
  });
  return { database, proposals, settings, service };
}

test("self-evolution mutation service applies approved configuration proposals", () => {
  const { database, proposals, settings, service } = createHarness();
  const proposal = proposals.create({
    target: "configuration",
    title: "Tune operator refresh",
    rationale: "Operators need a slower console refresh during incidents.",
    riskClass: "low",
    proposedChange: {
      summary: "Increase refresh interval.",
      operatorSettings: { dashboardRefreshSeconds: 10 },
    },
  });
  proposals.approve(proposal.id, {
    reviewedBy: "operator",
    notes: "Safe operator-console-only change.",
  });

  const result = service.applyProposal(proposal.id, {
    appliedBy: "operator",
  });

  assert.equal(result.proposal.status, "applied");
  assert.equal(result.proposal.appliedBy, "operator");
  assert.equal(result.mutation.status, "applied");
  assert.equal(result.mutation.mutationType, "operator_settings");
  assert.deepEqual(result.mutation.before, {
    dashboardRefreshSeconds: 5,
    chatDefaultConversationId: "operator-console",
    memoryTimelineLimit: 20,
  });
  assert.deepEqual(result.mutation.after, {
    dashboardRefreshSeconds: 10,
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
  assert.equal(settings.get().dashboardRefreshSeconds, 10);
  assert.equal(proposals.get(proposal.id)?.status, "applied");

  database.close();
});

test("self-evolution mutation service requires explicit high-risk confirmation", () => {
  const { database, proposals, settings, service } = createHarness();
  const proposal = proposals.create({
    target: "configuration",
    title: "Tune operator refresh",
    rationale: "High-risk settings changes need explicit confirmation.",
    riskClass: "high",
    proposedChange: {
      summary: "Increase refresh interval.",
      operatorSettings: { dashboardRefreshSeconds: 10 },
    },
  });
  proposals.approve(proposal.id, { reviewedBy: "operator" });

  assert.throws(
    () => service.applyProposal(proposal.id, { appliedBy: "operator" }),
    (error) => {
      assert.ok(error instanceof SelfEvolutionMutationError);
      assert.equal(error.code, "confirmation_required");
      assert.match(error.message, /explicit confirmation/);
      return true;
    }
  );
  assert.equal(settings.get().dashboardRefreshSeconds, 5);
  assert.equal(proposals.get(proposal.id)?.status, "approved");
  assert.deepEqual(proposals.listMutations(proposal.id), []);

  database.close();
});

test("self-evolution mutation service records failed apply attempts without mutating settings", () => {
  const { database, proposals, settings, service } = createHarness();
  const unsupported = proposals.create({
    target: "tool",
    title: "Unsupported apply",
    rationale: "Tool application is deferred.",
    riskClass: "medium",
    proposedChange: { summary: "Install tool bundle later" },
  });
  proposals.approve(unsupported.id, { reviewedBy: "operator" });

  assert.throws(
    () => service.applyProposal(unsupported.id, { appliedBy: "operator" }),
    (error) => {
      assert.ok(error instanceof SelfEvolutionMutationError);
      assert.equal(error.code, "apply_failed");
      assert.match(error.message, /Only configuration proposals/);
      assert.equal(error.mutation?.status, "failed");
      return true;
    }
  );
  assert.equal(settings.get().dashboardRefreshSeconds, 5);
  assert.equal(proposals.get(unsupported.id)?.status, "failed");
  assert.equal(
    proposals.get(unsupported.id)?.applyError,
    "Only configuration proposals can be applied in this slice"
  );
  assert.equal(
    proposals.listMutations(unsupported.id)[0]?.mutationType,
    "operator_settings"
  );

  const malformed = proposals.create({
    target: "configuration",
    title: "Malformed operator setting",
    rationale: "Invalid settings should be audited as failed apply attempts.",
    riskClass: "low",
    proposedChange: {
      summary: "Set an invalid refresh interval.",
      operatorSettings: { dashboardRefreshSeconds: 0 },
    },
  });
  proposals.approve(malformed.id, { reviewedBy: "operator" });

  assert.throws(
    () => service.applyProposal(malformed.id, { appliedBy: "operator" }),
    (error) => {
      assert.ok(error instanceof SelfEvolutionMutationError);
      assert.equal(error.code, "apply_failed");
      assert.match(error.message, /positive integer/);
      assert.equal(error.mutation?.status, "failed");
      return true;
    }
  );
  assert.equal(settings.get().dashboardRefreshSeconds, 5);
  assert.equal(proposals.get(malformed.id)?.status, "failed");
  assert.equal(
    proposals.get(malformed.id)?.applyError,
    "operatorSettings.dashboardRefreshSeconds must be a positive integer"
  );

  const outOfRange = proposals.create({
    target: "configuration",
    title: "Out-of-range operator setting",
    rationale: "Settings beyond supported bounds should fail before clamping.",
    riskClass: "low",
    proposedChange: {
      summary: "Set an out-of-range memory timeline limit.",
      operatorSettings: { memoryTimelineLimit: 999 },
    },
  });
  proposals.approve(outOfRange.id, { reviewedBy: "operator" });

  assert.throws(
    () => service.applyProposal(outOfRange.id, { appliedBy: "operator" }),
    (error) => {
      assert.ok(error instanceof SelfEvolutionMutationError);
      assert.equal(error.code, "apply_failed");
      assert.match(error.message, /less than or equal to 100/);
      assert.equal(error.mutation?.status, "failed");
      return true;
    }
  );
  assert.equal(settings.get().memoryTimelineLimit, 20);
  assert.equal(proposals.get(outOfRange.id)?.status, "failed");
  assert.equal(
    proposals.get(outOfRange.id)?.applyError,
    "operatorSettings.memoryTimelineLimit must be less than or equal to 100"
  );

  database.close();
});

test("self-evolution mutation service rolls back applied configuration proposals", () => {
  const { database, proposals, settings, service } = createHarness();
  const proposal = proposals.create({
    target: "configuration",
    title: "Tune operator refresh",
    rationale: "Operators need a temporary refresh change.",
    riskClass: "low",
    proposedChange: {
      summary: "Increase refresh interval.",
      operatorSettings: {
        dashboardRefreshSeconds: 12,
        chatDefaultConversationId: "incident-console",
      },
    },
  });
  proposals.approve(proposal.id, { reviewedBy: "operator" });
  const applied = service.applyProposal(proposal.id, {
    appliedBy: "operator",
  });
  assert.equal(settings.get().dashboardRefreshSeconds, 12);
  assert.equal(settings.get().chatDefaultConversationId, "incident-console");

  const rolledBack = service.rollbackProposal(proposal.id, "operator");

  assert.equal(rolledBack.proposal.status, "rolled_back");
  assert.equal(rolledBack.proposal.rolledBackBy, "operator");
  assert.equal(rolledBack.mutation.id, applied.mutation.id);
  assert.equal(rolledBack.mutation.status, "rolled_back");
  assert.deepEqual(settings.get(), {
    dashboardRefreshSeconds: 5,
    chatDefaultConversationId: "operator-console",
    memoryTimelineLimit: 20,
  });
  assert.equal(proposals.get(proposal.id)?.status, "rolled_back");
  assert.equal(proposals.listMutations(proposal.id)[0]?.status, "rolled_back");

  database.close();
});
