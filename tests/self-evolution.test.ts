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
    highRisk: 0,
    criticalRisk: 0,
    recent: [proposal],
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
