import test from "node:test";
import assert from "node:assert/strict";
import {
  OperatorExportService,
  buildJsonExport,
  buildNdjsonExport,
  buildOperatorExport,
  type OperatorExportRecord,
} from "../src/server/export.ts";

type Calls = Record<string, unknown[][]>;
type SourceRecords = Record<string, OperatorExportRecord[]>;

function createExportHarness(overrides: Partial<SourceRecords> = {}) {
  const calls: Calls = {};
  const record = (name: string, args: unknown[]): void => {
    calls[name] = [...(calls[name] ?? []), args];
  };
  const records = {
    requests: [{ source: "request" }],
    deliveries: [{ source: "delivery" }],
    inbound: [{ source: "inbound" }],
    feedback: [{ source: "feedback" }],
    governance: [{ source: "governance" }],
    proposals: [{ id: "sep_1", source: "proposal" }],
    mutations: [{ id: "sem_1", source: "mutation" }],
    bundles: [{ id: "tbi_1", source: "bundle" }],
    mcp: [{ source: "mcp" }],
    runs: [{ source: "run_event" }],
    chat: [{ source: "chat" }],
    maintenance: [{ source: "maintenance" }],
    ...overrides,
  };
  const service = new OperatorExportService({
    requestAudits: {
      list: (limit) => {
        record("requests", [limit]);
        return records.requests;
      },
    },
    channelDeliveries: {
      list: (channelId, limit) => {
        record("deliveries", [channelId, limit]);
        return records.deliveries;
      },
    },
    channelInbound: {
      list: (options) => {
        record("inbound", [options]);
        return records.inbound;
      },
    },
    slackFeedback: {
      list: (limit) => {
        record("feedback", [limit]);
        return records.feedback;
      },
    },
    governance: {
      listAudit: (limit) => {
        record("governance", [limit]);
        return records.governance;
      },
    },
    selfEvolution: {
      list: (limit) => {
        record("proposals", [limit]);
        return records.proposals;
      },
      listMutations: (proposalId, limit) => {
        record("mutations", [proposalId, limit]);
        return records.mutations;
      },
    },
    toolBundles: {
      list: (limit) => {
        record("bundles", [limit]);
        return records.bundles;
      },
    },
    mcpAudit: {
      list: (limit) => {
        record("mcp", [limit]);
        return records.mcp;
      },
    },
    runEvents: {
      all: (sql) => {
        record("runs", [sql]);
        return records.runs;
      },
    },
    chatArtifacts: {
      listChatExportItems: async (limit) => {
        record("chat", [limit]);
        return records.chat;
      },
    },
    memoryMaintenance: {
      list: (limit) => {
        record("maintenance", [limit]);
        return records.maintenance;
      },
    },
  });
  return { service, calls };
}

test("buildJsonExport wraps records in an operator-friendly envelope", () => {
  const payload = buildJsonExport({
    scope: "requests",
    exportedAt: "2026-04-23T12:00:00.000Z",
    meta: { requestedBy: "operator-console" },
    items: [
      {
        requestId: "req_123",
        path: "/health",
        statusCode: 200,
      },
    ],
  });

  assert.deepEqual(payload, {
    scope: "requests",
    format: "json",
    exportedAt: "2026-04-23T12:00:00.000Z",
    count: 1,
    meta: { requestedBy: "operator-console" },
    items: [
      {
        requestId: "req_123",
        path: "/health",
        statusCode: 200,
      },
    ],
  });
});

test("buildNdjsonExport emits one serialized record per line", () => {
  const payload = buildNdjsonExport({
    scope: "channels",
    exportedAt: "2026-04-23T12:00:00.000Z",
    items: [
      {
        channelId: "slack",
        status: "delivered",
      },
      {
        channelId: "webhook",
        status: "failed",
      },
    ],
  });

  assert.equal(payload.scope, "channels");
  assert.equal(payload.format, "ndjson");
  assert.equal(payload.exportedAt, "2026-04-23T12:00:00.000Z");
  assert.equal(payload.count, 2);
  assert.equal(
    payload.body,
    [
      '{"channelId":"slack","status":"delivered"}',
      '{"channelId":"webhook","status":"failed"}',
    ].join("\n")
  );
});

test("operator export service collects request exports with the full export limit", async () => {
  const { service, calls } = createExportHarness();

  const payload = await service.collect("requests");

  assert.deepEqual(payload.items, [{ source: "request" }]);
  assert.deepEqual(calls.requests, [[250]]);
});

test("operator export service collects channel exports from delivery, inbound, and feedback sources", async () => {
  const { service, calls } = createExportHarness();

  const payload = await service.collect("channels");

  assert.deepEqual(payload.items, [
    { source: "delivery" },
    { source: "inbound" },
    { source: "feedback" },
  ]);
  assert.deepEqual(calls.deliveries, [[undefined, 250]]);
  assert.deepEqual(calls.inbound, [[{ limit: 250 }]]);
  assert.deepEqual(calls.feedback, [[250]]);
});

test("operator export service preserves governance kind tags", async () => {
  const { service, calls } = createExportHarness();

  const payload = await service.collect("governance");

  assert.deepEqual(payload.items, [
    { source: "governance" },
    { id: "sep_1", source: "proposal", kind: "self_evolution_proposal" },
    { id: "sem_1", source: "mutation", kind: "self_evolution_mutation" },
    { id: "tbi_1", source: "bundle", kind: "tool_bundle_import" },
  ]);
  assert.deepEqual(calls.governance, [[250]]);
  assert.deepEqual(calls.proposals, [[250]]);
  assert.deepEqual(calls.mutations, [[undefined, 250]]);
  assert.deepEqual(calls.bundles, [[250]]);
});

test("operator export service routes mcp, run, and chat scopes to dedicated sources", async () => {
  const { service, calls } = createExportHarness();

  assert.deepEqual(await service.collect("mcp"), {
    items: [{ source: "mcp" }],
  });
  assert.deepEqual(await service.collect("runs"), {
    items: [{ source: "run_event" }],
  });
  assert.deepEqual(await service.collect("chat"), {
    items: [{ source: "chat" }],
  });

  assert.deepEqual(calls.mcp, [[250]]);
  assert.deepEqual(calls.runs, [
    ["SELECT * FROM run_events ORDER BY created_at DESC LIMIT 250"],
  ]);
  assert.deepEqual(calls.chat, [[250]]);
});

test("operator export service uses timeline sources for timeline and unknown scopes", async () => {
  const { service, calls } = createExportHarness();

  const payload = await service.collect("unrecognized");
  const envelope = buildOperatorExport("json", {
    scope: "unrecognized",
    exportedAt: "2026-04-23T12:00:00.000Z",
    items: payload.items,
  });

  assert.equal(envelope.scope, "unrecognized");
  assert.deepEqual(payload.items, [
    { source: "request" },
    { source: "delivery" },
    { source: "inbound" },
    { source: "feedback" },
    { source: "maintenance" },
    { source: "governance" },
    { id: "sep_1", source: "proposal", kind: "self_evolution_proposal" },
    { id: "sem_1", source: "mutation", kind: "self_evolution_mutation" },
    { id: "tbi_1", source: "bundle", kind: "tool_bundle_import" },
  ]);
  assert.deepEqual(calls.requests, [[50]]);
  assert.deepEqual(calls.deliveries, [[undefined, 50]]);
  assert.deepEqual(calls.inbound, [[{ limit: 50 }]]);
  assert.deepEqual(calls.feedback, [[50]]);
  assert.deepEqual(calls.maintenance, [[50]]);
  assert.deepEqual(calls.governance, [[50]]);
  assert.deepEqual(calls.proposals, [[50]]);
  assert.deepEqual(calls.mutations, [[undefined, 50]]);
  assert.deepEqual(calls.bundles, [[50]]);
});
