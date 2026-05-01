import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { ChannelRegistry } from "../src/channels/registry.ts";
import type { AgentAdapter, AgentRunEvent, AgentRunRequest, AgentRunResult } from "../src/agent/types.ts";
import { SessionStore } from "../src/chat/session-store.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { DynamicToolRegistry } from "../src/tools/dynamic-registry.ts";
import { ToolGovernanceService } from "../src/tools/governance.ts";
import { RunGraphStore } from "../src/orchestration/run-graph-store.ts";
import { OrchestrationService } from "../src/orchestration/service.ts";
import { SchedulerService } from "../src/scheduler/service.ts";
import { McpAuditStore } from "../src/mcp/audit.ts";
import { McpServer } from "../src/mcp/server.ts";
import { HttpServer } from "../src/server/http-server.ts";
import { buildJsonExport, buildNdjsonExport } from "../src/server/export.ts";
import { AppDatabase } from "../src/platform/database.ts";
import { Logger } from "../src/platform/logger.ts";
import { MetricsStore } from "../src/platform/metrics.ts";
import { makeConfig, makeDisabledEmbeddings, makeFakeVectorStore } from "./helpers.ts";
import { SlackChannel, type SlackTransport } from "../src/channels/slack.ts";
import { ChannelDeliveryStore } from "../src/channels/delivery-log.ts";

class FakeAdapter implements AgentAdapter {
  readonly name = "fake-codex";
  readonly capabilities = {
    supportsResume: true,
    supportsStreaming: true,
    supportsToolStreaming: true,
    supportsStructuredOutput: true,
    supportsParallelToolCalls: false,
    supportsReasoningEffort: true
  };

  async run(
    request: AgentRunRequest,
    onEvent: (event: AgentRunEvent) => Promise<void> | void
  ): Promise<AgentRunResult> {
    const outputText = `assistant:${request.messages.at(-1)?.content ?? ""}`;
    await onEvent({ type: "init", runId: request.runId, sessionId: request.sessionId });
    await onEvent({ type: "text_delta", runId: request.runId, delta: outputText });
    await onEvent({
      type: "structured_message",
      runId: request.runId,
      message: { role: "assistant", content: outputText }
    });
    await onEvent({
      type: "final",
      runId: request.runId,
      outputText,
      previousResponseId: `resp_${request.runId}`,
      providerSessionId: `provider_${request.sessionId}`
    });

    return {
      runId: request.runId,
      outputText,
      previousResponseId: `resp_${request.runId}`,
      providerSessionId: `provider_${request.sessionId}`,
      transcript: [...request.messages, { role: "assistant", content: outputText }],
      toolCalls: []
    };
  }
}

class FakeSlackTransport implements SlackTransport {
  readonly sent: Array<{ channel: string; text: string; threadTs?: string }> = [];
  private readonly responses: Array<{ ok: boolean; ts?: string; error?: string; statusCode?: number; retryAfterMs?: number }>;

  constructor(responses: Array<{ ok: boolean; ts?: string; error?: string; statusCode?: number; retryAfterMs?: number }> = [
    { ok: true, ts: "1713900000.000100", statusCode: 200 }
  ]) {
    this.responses = responses;
  }

  async sendMessage(input: { token: string; channel: string; text: string; threadTs?: string }): Promise<{
    ok: boolean;
    ts?: string;
    error?: string;
    statusCode?: number;
    retryAfterMs?: number;
  }> {
    this.sent.push(input.threadTs ? { channel: input.channel, text: input.text, threadTs: input.threadTs } : { channel: input.channel, text: input.text });
    return this.responses.shift() ?? { ok: true, ts: "1713900000.000100", statusCode: 200 };
  }
}

function signedWebhookHeaders(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000).toString()): Record<string, string> {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return {
    "Content-Type": "application/json",
    "x-channel-timestamp": timestamp,
    "x-channel-signature": `sha256=${signature}`
  };
}

function signedSlackHeaders(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000).toString()): Record<string, string> {
  const signature = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return {
    "Content-Type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${signature}`
  };
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  let latest = await read();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate(latest)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    latest = await read();
  }
  return latest;
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
        statusCode: 200
      }
    ]
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
        statusCode: 200
      }
    ]
  });
});

test("buildNdjsonExport emits one serialized record per line", () => {
  const payload = buildNdjsonExport({
    scope: "channels",
    exportedAt: "2026-04-23T12:00:00.000Z",
    items: [
      {
        channelId: "slack",
        status: "delivered"
      },
      {
        channelId: "webhook",
        status: "failed"
      }
    ]
  });

  assert.equal(payload.scope, "channels");
  assert.equal(payload.format, "ndjson");
  assert.equal(payload.exportedAt, "2026-04-23T12:00:00.000Z");
  assert.equal(payload.count, 2);
  assert.equal(
    payload.body,
    [
      "{\"channelId\":\"slack\",\"status\":\"delivered\"}",
      "{\"channelId\":\"webhook\",\"status\":\"failed\"}"
    ].join("\n")
  );
});

test("slack delivery retries transient failures and records attempt counts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-slack-"));
  const config = makeConfig(dataDir, { slackBotToken: "xoxb-test-token" });
  const database = new AppDatabase(join(dataDir, "slack.sqlite"));
  const channels = new ChannelRegistry(database, config);
  channels.upsert({ id: "slack", enabled: true });
  const deliveries = new ChannelDeliveryStore(database);
  const transport = new FakeSlackTransport([
    { ok: false, error: "server_error", statusCode: 500, retryAfterMs: 1 },
    { ok: false, error: "rate_limited", statusCode: 429, retryAfterMs: 1 },
    { ok: true, ts: "1713900000.000200", statusCode: 200 }
  ]);

  try {
    const slack = new SlackChannel(config, channels, deliveries, transport);
    const result = await slack.sendMessage({ channel: "C123456", text: "retry me" });

    assert.equal(result.delivery.status, "delivered");
    assert.equal(result.delivery.attemptCount, 3);
    assert.equal(result.result.ts, "1713900000.000200");
    assert.equal(transport.sent.length, 3);

    const failingTransport = new FakeSlackTransport([
      { ok: false, error: "server_error", statusCode: 500, retryAfterMs: 1 },
      { ok: false, error: "server_error", statusCode: 500, retryAfterMs: 1 },
      { ok: false, error: "server_error", statusCode: 500, retryAfterMs: 1 }
    ]);
    const failingSlack = new SlackChannel(config, channels, deliveries, failingTransport);
    await assert.rejects(() => failingSlack.sendMessage({ channel: "C999999", text: "fail me" }), /server_error/);

    const summary = deliveries.summary();
    assert.equal(summary.delivered, 1);
    assert.equal(summary.failed, 1);
    assert.ok(summary.recentFailed.some((delivery) =>
      delivery.destination === "C999999" &&
      delivery.status === "failed" &&
      delivery.attemptCount === 3
    ));
  } finally {
    database.close();
  }
});

test("chat streaming, health, scheduler, channels, and mcp routes work", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-server-"));
  const config: AppConfig = makeConfig(dataDir, {
    port: 0,
    slackBotToken: "xoxb-test-token",
    slackSigningSecret: "slack-signing-secret",
    slackBotUserId: "B999"
  });
  const database = new AppDatabase(join(dataDir, "server.sqlite"));
  const sessions = new SessionStore(database);
  const channels = new ChannelRegistry(database, config);
  const memory = new MemoryStore(
    database,
    config,
    makeDisabledEmbeddings(),
    makeFakeVectorStore({ backend: "qdrant", available: false, configured: false }),
    makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
  );
  const tools = new ToolRegistry();
  tools.register({
    id: "echo.summary",
    description: "echo",
    scopes: ["read"],
    kind: "in_process",
    handler: async (input) => input
  });

  const runtime = new AgentRuntime(config, new FakeAdapter(), sessions, memory, tools);
  const runs = new RunGraphStore(database);
  const orchestration = new OrchestrationService(runtime, tools, runs);
  const scheduler = new SchedulerService(database, orchestration);
  await scheduler.start();
    const metrics = new MetricsStore();
    const mcpAudit = new McpAuditStore(database);
    const mcp = new McpServer(config.mcpBearerToken, tools, metrics, undefined, mcpAudit);
  const dynamicTools = new DynamicToolRegistry(database, tools);
  const governance = new ToolGovernanceService(database);
  const slackTransport = new FakeSlackTransport();
  const server = new HttpServer(
    config,
    orchestration,
    scheduler,
    sessions,
    runs,
    mcp,
    database,
    new Logger("error"),
    metrics,
    memory,
    dynamicTools,
    channels,
    governance,
    slackTransport
  );
  const instance = await server.listen();
  const address = instance.address();
  if (!address || typeof address === "string") {
    throw new Error("server failed to bind");
  }
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const oversizedMcpBody = JSON.stringify({
      method: "tools/list",
      padding: "x".repeat(1_100_000)
    });
    const oversizedMcpResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.mcpBearerToken}`
      },
      body: oversizedMcpBody
    });
    assert.equal(oversizedMcpResponse.status, 413);
    const oversizedMcpJson = await oversizedMcpResponse.json() as { error?: string; status?: number };
    assert.equal(oversizedMcpJson.status, 413);
    assert.match(oversizedMcpJson.error ?? "", /body/i);

    const oversizedChatBody = JSON.stringify({
      conversationId: "oversized",
      message: "x".repeat(1_100_000)
    });
    const oversizedChatResponse = await fetch(`${baseUrl}/chat/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.operatorBearerToken}`
      },
      body: oversizedChatBody
    });
    assert.equal(oversizedChatResponse.status, 413);

    const protectedGetPaths = [
      "/",
      "/admin/summary",
      "/admin/not-real",
      "/admin/export?scope=requests",
      "/tools/dynamic",
      "/sessions",
      "/runs",
      "/memory",
      "/scheduler/jobs"
    ];
    for (const path of protectedGetPaths) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 401, `${path} should require operator auth`);
      assert.equal(response.headers.get("www-authenticate"), "Basic realm=\"codex-phantom operator\"");
    }
    const unauthenticatedAdminResponse = await fetch(`http://127.0.0.1:${port}/admin/summary`);
    const unauthenticatedAdminJson = await unauthenticatedAdminResponse.json() as { error: string; status: number };
    assert.equal(unauthenticatedAdminJson.error, "Unauthorized");
    assert.equal(unauthenticatedAdminJson.status, 401);

    const unauthenticatedChatResponse = await fetch(`http://127.0.0.1:${port}/chat/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: "web-unauth",
        message: "blocked"
      })
    });
    assert.equal(unauthenticatedChatResponse.status, 401);

    const unauthenticatedScheduleResponse = await fetch(`http://127.0.0.1:${port}/scheduler/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "blocked-job",
        message: "blocked",
        delayMs: 10
      })
    });
    assert.equal(unauthenticatedScheduleResponse.status, 401);

    const badWebhookResponse = await fetch(`http://127.0.0.1:${port}/channels/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-channel-secret": "wrong-secret"
      },
      body: JSON.stringify({
        conversationId: "bad-hook",
        message: "blocked"
      })
    });
    assert.equal(badWebhookResponse.status, 401);
    assert.equal(badWebhookResponse.headers.get("www-authenticate"), null);

    const staleWebhookBody = JSON.stringify({
      conversationId: "stale-hook",
      message: "blocked"
    });
    const staleWebhookResponse = await fetch(`http://127.0.0.1:${port}/channels/webhook`, {
      method: "POST",
      headers: signedWebhookHeaders(config.externalChannelSecret, staleWebhookBody, "1713900000"),
      body: staleWebhookBody
    });
    assert.equal(staleWebhookResponse.status, 401);

    const wrongSignatureWebhookBody = JSON.stringify({
      conversationId: "wrong-signature-hook",
      message: "blocked"
    });
    const wrongSignatureWebhookResponse = await fetch(`http://127.0.0.1:${port}/channels/webhook`, {
      method: "POST",
      headers: signedWebhookHeaders("wrong-secret", wrongSignatureWebhookBody),
      body: wrongSignatureWebhookBody
    });
    assert.equal(wrongSignatureWebhookResponse.status, 401);

    const consoleResponse = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`operator:${config.operatorBearerToken}`).toString("base64")}`
      }
    });
    assert.equal(consoleResponse.status, 200);
    assert.match(await consoleResponse.text(), /Operator Console/);

    const authenticatedUnknownAdminResponse = await fetch(`http://127.0.0.1:${port}/admin/not-real`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    assert.equal(authenticatedUnknownAdminResponse.status, 404);

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    const healthJson = await healthResponse.json() as {
      ok: boolean;
      readiness: { scheduler: boolean; semanticRetrieval: boolean };
      memory?: { pendingBackfillCount: number; vectorBackend: string; qdrantConfigured: boolean };
      logging?: { provider: string };
    };
    assert.equal(healthResponse.status, 200);
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.readiness.scheduler, true);
    assert.equal(healthJson.readiness.semanticRetrieval, false);
    assert.equal(healthJson.memory, undefined);
    assert.equal(healthJson.logging, undefined);

    const detailedHealthResponse = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const detailedHealthJson = await detailedHealthResponse.json() as {
      ok: boolean;
      readiness: { scheduler: boolean; semanticRetrieval: boolean };
      memory: { pendingBackfillCount: number; vectorBackend: string; qdrantConfigured: boolean };
      logging: { provider: string };
    };
    assert.equal(detailedHealthResponse.status, 200);
    assert.equal(detailedHealthJson.ok, true);
    assert.equal(detailedHealthJson.readiness.scheduler, true);
    assert.equal(detailedHealthJson.readiness.semanticRetrieval, false);
    assert.equal(detailedHealthJson.memory.pendingBackfillCount, 0);
    assert.equal(detailedHealthJson.memory.vectorBackend, "sqlite_fallback");
    assert.equal(detailedHealthJson.memory.qdrantConfigured, false);
    assert.equal(detailedHealthJson.logging.provider, "pino");

    const streamResponse = await fetch(`http://127.0.0.1:${port}/chat/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.operatorBearerToken}` },
      body: JSON.stringify({
        conversationId: "web-1",
        message: "hello from web"
      })
    });
    const streamText = await streamResponse.text();
    assert.match(streamText, /"type":"init"/);
    assert.match(streamText, /"type":"text_delta"/);
    assert.match(streamText, /"type":"final"/);
    assert.match(streamText, /assistant:hello from web/);

    const webhookBody = JSON.stringify({
      conversationId: "hook-1",
      message: "hello from webhook"
    });
    const webhookResponse = await fetch(`http://127.0.0.1:${port}/channels/webhook`, {
      method: "POST",
      headers: signedWebhookHeaders(config.externalChannelSecret, webhookBody),
      body: webhookBody
    });
    const webhookJson = await webhookResponse.json() as { sessionId: string; outputText: string; inboundEvent: { channelId: string; status: string } };
    assert.equal(webhookJson.outputText, "assistant:hello from webhook");
    assert.equal(webhookJson.inboundEvent.channelId, "webhook");
    assert.equal(webhookJson.inboundEvent.status, "completed");

    await fetch(`http://127.0.0.1:${port}/scheduler/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.operatorBearerToken}` },
      body: JSON.stringify({
        name: "quick-job",
        message: "scheduled task",
        delayMs: 10
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const jobsResponse = await fetch(`http://127.0.0.1:${port}/scheduler/jobs`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const jobsJson = await jobsResponse.json() as { jobs: Array<{ status: string }> };
    assert.ok(jobsJson.jobs.some((job) => job.status === "completed"));

    const mcpResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.mcpBearerToken}`
      },
      body: JSON.stringify({ method: "tools/list" })
    });
    const mcpJson = await mcpResponse.json() as { tools: Array<{ id: string }> };
    assert.ok(mcpJson.tools.some((tool) => tool.id === "echo.summary"));

    const adminMcpAuditResponse = await fetch(`http://127.0.0.1:${port}/admin/mcp/audit`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    assert.equal(adminMcpAuditResponse.status, 200);
    const adminMcpAuditJson = await adminMcpAuditResponse.json() as {
      audit: Array<{ method: string; outcome: string; toolName?: string }>;
    };
    assert.ok(Array.isArray(adminMcpAuditJson.audit));
    assert.ok(adminMcpAuditJson.audit.some((entry) => entry.method === "tools/list" && entry.outcome === "success"));

    const invalidAuditLimitResponse = await fetch(`http://127.0.0.1:${port}/admin/mcp/audit?limit=foo`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    assert.equal(invalidAuditLimitResponse.status, 200);
    const invalidAuditLimitJson = await invalidAuditLimitResponse.json() as { audit: unknown[] };
    assert.ok(Array.isArray(invalidAuditLimitJson.audit));

    const unauthorizedMcpResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token"
      },
      body: JSON.stringify({ method: "tools/list" })
    });
    assert.equal(unauthorizedMcpResponse.status, 401);

    for (let index = 0; index < 11; index += 1) {
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token"
        },
        body: JSON.stringify({ method: "tools/list" })
      });
    }
    const rateLimitedMcpResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token"
      },
      body: JSON.stringify({ method: "tools/list" })
    });
    assert.equal(rateLimitedMcpResponse.status, 429);

    const dynamicToolResponse = await fetch(`http://127.0.0.1:${port}/tools/dynamic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.operatorBearerToken}` },
      body: JSON.stringify({
        id: "project.brief",
        description: "Return a short project brief",
        scopes: ["read"],
        inputSchema: {
          type: "object",
          properties: {
            topic: { type: "string" }
          }
        },
        responseTemplate: "Brief for {{topic}}"
      })
    });
    const dynamicToolJson = await dynamicToolResponse.json() as { tool: { id: string; approvalState: string } };
    assert.equal(dynamicToolJson.tool.id, "project.brief");
    assert.equal(dynamicToolJson.tool.approvalState, "pending");

    const dynamicToolsResponse = await fetch(`http://127.0.0.1:${port}/tools/dynamic`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const dynamicToolsJson = await dynamicToolsResponse.json() as { tools: Array<{ id: string; approvalState: string }> };
    assert.ok(dynamicToolsJson.tools.some((tool) => tool.id === "project.brief"));
    assert.ok(dynamicToolsJson.tools.some((tool) => tool.id === "project.brief" && tool.approvalState === "pending"));

    const dynamicMcpListResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.mcpBearerToken}`
      },
      body: JSON.stringify({ method: "tools/list" })
    });
    const dynamicMcpListJson = await dynamicMcpListResponse.json() as { tools: Array<{ id: string }> };
    assert.equal(dynamicMcpListJson.tools.some((tool) => tool.id === "project.brief"), false);

    const approvalResponse = await fetch(`http://127.0.0.1:${port}/admin/tools/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.operatorBearerToken}` },
      body: JSON.stringify({
        toolId: "project.brief",
        approvedBy: "operator",
        notes: "read-only summary tool"
      })
    });
    const approvalJson = await approvalResponse.json() as { tool: { id: string; approvalState: string } };
    assert.equal(approvalJson.tool.id, "project.brief");
    assert.equal(approvalJson.tool.approvalState, "approved");

    const approvedMcpListResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.mcpBearerToken}`
      },
      body: JSON.stringify({ method: "tools/list" })
    });
    const approvedMcpListJson = await approvedMcpListResponse.json() as { tools: Array<{ id: string }> };
    assert.ok(approvedMcpListJson.tools.some((tool) => tool.id === "project.brief"));

    const dynamicCallResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.mcpBearerToken}`
      },
      body: JSON.stringify({
        method: "tools/call",
        params: {
          name: "project.brief",
          input: { topic: "deployment" }
        }
      })
    });
    const dynamicCallJson = await dynamicCallResponse.json() as { output: { content: string } };
    assert.equal(dynamicCallJson.output.content, "Brief for deployment");

    const memoryResponse = await fetch(`http://127.0.0.1:${port}/memory`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const memoryJson = await memoryResponse.json() as { entries: Array<{ id: string; category: string }> };
    assert.ok(memoryJson.entries.length > 0);

    const channelsResponse = await fetch(`http://127.0.0.1:${port}/admin/channels`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const channelsJson = await channelsResponse.json() as {
      channels: Array<{ id: string; enabled: boolean; secretPresent: boolean }>;
    };
    assert.ok(channelsJson.channels.some((channel) => channel.id === "web"));
    assert.ok(channelsJson.channels.some((channel) => channel.id === "slack"));
    assert.ok(channelsJson.channels.some((channel) => channel.id === "slack" && channel.secretPresent === true));

    const channelUpdateResponse = await fetch(`http://127.0.0.1:${port}/admin/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.operatorBearerToken}` },
      body: JSON.stringify({
        id: "slack",
        enabled: true
      })
    });
    const channelUpdateJson = await channelUpdateResponse.json() as {
      channel: { id: string; enabled: boolean };
    };
    assert.equal(channelUpdateJson.channel.id, "slack");
    assert.equal(channelUpdateJson.channel.enabled, true);

    const slackMessageResponse = await fetch(`http://127.0.0.1:${port}/channels/slack/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.operatorBearerToken}` },
      body: JSON.stringify({
        channel: "C123456",
        text: "hello from codex-phantom"
      })
    });
    const slackMessageJson = await slackMessageResponse.json() as {
      delivery: { channelId: string; status: string; destination: string; attemptCount: number };
      result: { ts: string };
    };
    assert.equal(slackMessageJson.delivery.channelId, "slack");
    assert.equal(slackMessageJson.delivery.status, "delivered");
    assert.equal(slackMessageJson.delivery.destination, "C123456");
    assert.equal(slackMessageJson.delivery.attemptCount, 1);
    assert.equal(slackMessageJson.result.ts, "1713900000.000100");
    assert.deepEqual(slackTransport.sent, [{ channel: "C123456", text: "hello from codex-phantom" }]);

    const slackEventBody = JSON.stringify({
      type: "event_callback",
      event_id: "EvInbound123",
      event: {
        type: "app_mention",
        user: "U123",
        channel: "C123456",
        text: "<@B999> hello from slack",
        ts: "1713900001.000100",
        thread_ts: "1713900001.000000"
      }
    });
    const slackEventResponse = await fetch(`http://127.0.0.1:${port}/channels/slack/events`, {
      method: "POST",
      headers: signedSlackHeaders(config.slackSigningSecret!, slackEventBody),
      body: slackEventBody
    });
    const slackEventJson = await slackEventResponse.json() as { status: string; inboundEventId: string };
    assert.equal(slackEventResponse.status, 202);
    assert.equal(slackEventJson.status, "accepted");
    assert.ok(slackEventJson.inboundEventId);

    const inboundAfterSlack = await eventually(
      async () => {
        const inboundResponse = await fetch(`http://127.0.0.1:${port}/admin/channels/inbound?channelId=slack`, {
          headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
        });
        return await inboundResponse.json() as { events: Array<{ providerEventId: string; status: string; outputText?: string; runId?: string }> };
      },
      (body) => body.events.some((event) => event.providerEventId === "EvInbound123" && event.status === "completed")
    );
    assert.ok(inboundAfterSlack.events.some((event) =>
      event.providerEventId === "EvInbound123" &&
      event.status === "completed" &&
      event.outputText === "assistant:hello from slack" &&
      typeof event.runId === "string"
    ));
    assert.ok(slackTransport.sent.some((message) =>
      message.channel === "C123456" &&
      message.text === "assistant:hello from slack"
    ));

    const duplicateSlackEventResponse = await fetch(`http://127.0.0.1:${port}/channels/slack/events`, {
      method: "POST",
      headers: signedSlackHeaders(config.slackSigningSecret!, slackEventBody),
      body: slackEventBody
    });
    const duplicateSlackEventJson = await duplicateSlackEventResponse.json() as { status: string; duplicate: boolean };
    assert.equal(duplicateSlackEventResponse.status, 202);
    assert.equal(duplicateSlackEventJson.status, "duplicate");
    assert.equal(duplicateSlackEventJson.duplicate, true);

    const deliveriesResponse = await fetch(`http://127.0.0.1:${port}/admin/channels/deliveries?channelId=slack`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const deliveriesJson = await deliveriesResponse.json() as {
      deliveries: Array<{ channelId: string; status: string; destination: string; attemptCount: number }>;
    };
    assert.ok(deliveriesJson.deliveries.some((delivery) =>
      delivery.channelId === "slack" &&
      delivery.status === "delivered" &&
      delivery.destination === "C123456" &&
      delivery.attemptCount === 1
    ));

    const adminSummaryResponse = await fetch(`http://127.0.0.1:${port}/admin/summary`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const adminSummaryJson = await adminSummaryResponse.json() as {
      logging: { provider: string };
      deployment: { qdrantEnabled: boolean };
      governance: { pendingDynamicTools: number; approvedDynamicTools: number };
      channelDeliveries: { delivered: number; recentFailed: unknown[] };
      channelInbound: { completed: number; failed: number; recentFailed: unknown[] };
      settings: { dashboardRefreshSeconds: number };
      channels: Array<{ id: string; enabled: boolean }>;
    };
    assert.equal(adminSummaryJson.logging.provider, "pino");
    assert.equal(adminSummaryJson.deployment.qdrantEnabled, false);
    assert.equal(adminSummaryJson.governance.pendingDynamicTools, 0);
    assert.equal(adminSummaryJson.governance.approvedDynamicTools, 1);
    assert.equal(adminSummaryJson.channelDeliveries.delivered, 2);
    assert.deepEqual(adminSummaryJson.channelDeliveries.recentFailed, []);
    assert.ok(adminSummaryJson.channelInbound.completed >= 2);
    assert.deepEqual(adminSummaryJson.channelInbound.recentFailed, []);
    assert.equal(adminSummaryJson.settings.dashboardRefreshSeconds, 5);
    assert.ok(adminSummaryJson.channels.some((channel) => channel.id === "slack" && channel.enabled === true));

    const timelineResponse = await fetch(`http://127.0.0.1:${port}/admin/timeline`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const timelineJson = await timelineResponse.json() as {
      sessions: Array<{ sessionId: string }>;
      runs: Array<{ runId: string; eventCount: number }>;
      jobs: Array<{ id: string }>;
      memory: Array<{ id: string }>;
      governanceAudit: Array<{ toolId: string; action: string }>;
    };
    assert.ok(timelineJson.sessions.length > 0);
    assert.ok(timelineJson.runs.length > 0);
    assert.ok(timelineJson.jobs.length > 0);
    assert.ok(timelineJson.memory.length > 0);
    assert.ok(timelineJson.governanceAudit.some((entry) => entry.toolId === "project.brief" && entry.action === "approved"));

    const sessionDetailResponse = await fetch(`http://127.0.0.1:${port}/admin/sessions/${encodeURIComponent(webhookJson.sessionId)}`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const sessionDetailJson = await sessionDetailResponse.json() as { session: { sessionId: string; runIds: string[] } };
    assert.equal(sessionDetailJson.session.sessionId, webhookJson.sessionId);
    assert.ok(sessionDetailJson.session.runIds.length > 0);

    const runWithEvents = timelineJson.runs.find((run) => run.eventCount > 0) ?? timelineJson.runs[0];
    const firstRunId = runWithEvents?.runId;
    assert.ok(firstRunId);
    const runDetailResponse = await fetch(`http://127.0.0.1:${port}/admin/runs/${encodeURIComponent(firstRunId)}`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const runDetailJson = await runDetailResponse.json() as {
      run: { runId: string };
      events: Array<{ type: string }>;
      children: Array<{ runId: string }>;
    };
    assert.equal(runDetailJson.run.runId, firstRunId);
    assert.ok(Array.isArray(runDetailJson.events));

    const firstJobId = timelineJson.jobs[0]?.id;
    assert.ok(firstJobId);
    const jobDetailResponse = await fetch(`http://127.0.0.1:${port}/admin/jobs/${encodeURIComponent(firstJobId)}`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const jobDetailJson = await jobDetailResponse.json() as { job: { id: string; status: string } };
    assert.equal(jobDetailJson.job.id, firstJobId);

    const firstMemoryId = timelineJson.memory[0]?.id;
    assert.ok(firstMemoryId);
    const memoryDetailResponse = await fetch(`http://127.0.0.1:${port}/admin/memory/${encodeURIComponent(firstMemoryId)}`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const memoryDetailJson = await memoryDetailResponse.json() as { entry: { id: string; category: string } };
    assert.equal(memoryDetailJson.entry.id, firstMemoryId);

    const settingsResponse = await fetch(`http://127.0.0.1:${port}/admin/settings`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const settingsJson = await settingsResponse.json() as {
      settings: { dashboardRefreshSeconds: number; chatDefaultConversationId: string };
    };
    assert.equal(settingsJson.settings.dashboardRefreshSeconds, 5);
    assert.equal(settingsJson.settings.chatDefaultConversationId, "operator-console");

    const settingsUpdateResponse = await fetch(`http://127.0.0.1:${port}/admin/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.operatorBearerToken}` },
      body: JSON.stringify({
        dashboardRefreshSeconds: 9,
        chatDefaultConversationId: "ops-room",
        memoryTimelineLimit: 25
      })
    });
    const settingsUpdateJson = await settingsUpdateResponse.json() as {
      settings: { dashboardRefreshSeconds: number; chatDefaultConversationId: string; memoryTimelineLimit: number };
    };
    assert.equal(settingsUpdateJson.settings.dashboardRefreshSeconds, 9);
    assert.equal(settingsUpdateJson.settings.chatDefaultConversationId, "ops-room");
    assert.equal(settingsUpdateJson.settings.memoryTimelineLimit, 25);

    const requestExportResponse = await fetch(`http://127.0.0.1:${port}/admin/export?scope=requests&format=json`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const requestExportJson = await requestExportResponse.json() as {
      scope: string;
      format: string;
      items: Array<{ requestId: string; path: string; statusCode: number }>;
    };
    assert.equal(requestExportJson.scope, "requests");
    assert.equal(requestExportJson.format, "json");
    assert.ok(requestExportJson.items.some((item) => item.path === "/health"));
    assert.ok(requestExportJson.items.some((item) =>
      item.path === "/admin/summary" &&
      item.statusCode === 401
    ));

    const channelExportResponse = await fetch(`http://127.0.0.1:${port}/admin/export?scope=channels&format=ndjson`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const channelExportText = await channelExportResponse.text();
    assert.match(channelExportText, /"channelId":"slack"/);
    assert.match(channelExportText, /"status":"delivered"/);

    const mcpExportResponse = await fetch(`http://127.0.0.1:${port}/admin/export?scope=mcp&format=json`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const mcpExportJson = await mcpExportResponse.json() as {
      scope: string;
      format: string;
      items: Array<{ method: string; outcome: string; toolName?: string }>;
    };
    assert.equal(mcpExportJson.scope, "mcp");
    assert.equal(mcpExportJson.format, "json");
    assert.ok(mcpExportJson.items.some((item) => item.method === "tools/list" && item.outcome === "success"));

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${port}/admin/diagnostics`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    const diagnosticsJson = await diagnosticsResponse.json() as {
      diagnostics: {
        appEnv: string;
        modelAdapter: string;
        missingRecommendedEnv: string[];
        channelReadiness: Array<{ id: string; enabled: boolean; secretPresent: boolean }>;
      };
    };
    assert.equal(diagnosticsJson.diagnostics.appEnv, "test");
    assert.equal(diagnosticsJson.diagnostics.modelAdapter, "fallback");
    assert.ok(diagnosticsJson.diagnostics.missingRecommendedEnv.includes("OPENAI_API_KEY"));
    assert.ok(diagnosticsJson.diagnostics.channelReadiness.some((channel) => channel.id === "slack" && channel.enabled === true && channel.secretPresent === true));

    const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics?format=prometheus`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` }
    });
    assert.equal(metricsResponse.headers.get("content-type"), "text/plain; version=0.0.4");
    const metricsText = await metricsResponse.text();
    assert.match(metricsText, /codex_phantom_mcp_auth_failure 12/);
    assert.match(metricsText, /codex_phantom_mcp_rate_limited 1/);
    assert.match(metricsText, /codex_phantom_http_request_duration_ms_count/);
  } finally {
    await scheduler.stop();
    await server.close();
    database.close();
  }
});

test("slack inbound rejects missing signing secret and disabled channel", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-slack-inbound-"));
  const config = makeConfig(dataDir, { port: 0, slackBotToken: "xoxb-test-token" });
  const database = new AppDatabase(join(dataDir, "slack-inbound.sqlite"));
  const sessions = new SessionStore(database);
  const channels = new ChannelRegistry(database, config);
  const memory = new MemoryStore(
    database,
    config,
    makeDisabledEmbeddings(),
    makeFakeVectorStore({ backend: "qdrant", available: false, configured: false }),
    makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
  );
  const tools = new ToolRegistry();
  const runtime = new AgentRuntime(config, new FakeAdapter(), sessions, memory, tools);
  const runs = new RunGraphStore(database);
  const orchestration = new OrchestrationService(runtime, tools, runs);
  const scheduler = new SchedulerService(database, orchestration);
  await scheduler.start();
  const metrics = new MetricsStore();
  const mcpAudit = new McpAuditStore(database);
  const mcp = new McpServer(config.mcpBearerToken, tools, metrics, undefined, mcpAudit);
  const dynamicTools = new DynamicToolRegistry(database, tools);
  const governance = new ToolGovernanceService(database);
  const server = new HttpServer(
    config,
    orchestration,
    scheduler,
    sessions,
    runs,
    mcp,
    database,
    new Logger("error"),
    metrics,
    memory,
    dynamicTools,
    channels,
    governance,
    new FakeSlackTransport()
  );

  try {
    const instance = await server.listen();
    const address = instance.address();
    assert.equal(typeof address, "object");
    const port = address && typeof address === "object" ? address.port : 0;
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "EvReject",
      event: {
        type: "app_mention",
        user: "U123",
        channel: "C123456",
        text: "hello",
        ts: "1713900001.000100"
      }
    });

    const missingSecretResponse = await fetch(`http://127.0.0.1:${port}/channels/slack/events`, {
      method: "POST",
      headers: signedSlackHeaders("slack-signing-secret", body),
      body
    });
    assert.equal(missingSecretResponse.status, 412);

    config.slackSigningSecret = "slack-signing-secret";
    const disabledResponse = await fetch(`http://127.0.0.1:${port}/channels/slack/events`, {
      method: "POST",
      headers: signedSlackHeaders(config.slackSigningSecret, body),
      body
    });
    assert.equal(disabledResponse.status, 409);
  } finally {
    await scheduler.stop();
    await server.close();
    database.close();
  }
});
