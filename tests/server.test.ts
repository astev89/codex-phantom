import test from "node:test";
import assert from "node:assert/strict";
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
import { McpServer } from "../src/mcp/server.ts";
import { HttpServer } from "../src/server/http-server.ts";
import { AppDatabase } from "../src/platform/database.ts";
import { Logger } from "../src/platform/logger.ts";
import { MetricsStore } from "../src/platform/metrics.ts";
import { makeConfig, makeDisabledEmbeddings, makeFakeVectorStore } from "./helpers.ts";
import type { SlackTransport } from "../src/channels/slack.ts";

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
  readonly sent: Array<{ channel: string; text: string }> = [];

  async sendMessage(input: { token: string; channel: string; text: string }): Promise<{ ok: boolean; ts?: string; error?: string }> {
    this.sent.push({ channel: input.channel, text: input.text });
    return {
      ok: true,
      ts: "1713900000.000100"
    };
  }
}

test("chat streaming, health, scheduler, and mcp routes work", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-server-"));
  const config: AppConfig = makeConfig(dataDir, { port: 0, slackBotToken: "xoxb-test-token" });
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
  const mcp = new McpServer(config.mcpBearerToken, tools);
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
    new MetricsStore(),
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

  try {
    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    const healthJson = await healthResponse.json() as {
      ok: boolean;
      readiness: { scheduler: boolean; semanticRetrieval: boolean };
      memory: { pendingBackfillCount: number; vectorBackend: string; qdrantConfigured: boolean };
      logging: { provider: string };
    };
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.readiness.scheduler, true);
    assert.equal(healthJson.readiness.semanticRetrieval, false);
    assert.equal(healthJson.memory.pendingBackfillCount, 0);
    assert.equal(healthJson.memory.vectorBackend, "sqlite_fallback");
    assert.equal(healthJson.memory.qdrantConfigured, false);
    assert.equal(healthJson.logging.provider, "pino");

    const streamResponse = await fetch(`http://127.0.0.1:${port}/chat/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

    const webhookResponse = await fetch(`http://127.0.0.1:${port}/channels/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-channel-secret": config.externalChannelSecret
      },
      body: JSON.stringify({
        conversationId: "hook-1",
        message: "hello from webhook"
      })
    });
    const webhookJson = await webhookResponse.json() as { sessionId: string; outputText: string };
    assert.equal(webhookJson.outputText, "assistant:hello from webhook");

    await fetch(`http://127.0.0.1:${port}/scheduler/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "quick-job",
        message: "scheduled task",
        delayMs: 10
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const jobsResponse = await fetch(`http://127.0.0.1:${port}/scheduler/jobs`);
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

    const dynamicToolResponse = await fetch(`http://127.0.0.1:${port}/tools/dynamic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

    const dynamicToolsResponse = await fetch(`http://127.0.0.1:${port}/tools/dynamic`);
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
      headers: { "Content-Type": "application/json" },
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

    const memoryResponse = await fetch(`http://127.0.0.1:${port}/memory`);
    const memoryJson = await memoryResponse.json() as { entries: Array<{ id: string; category: string }> };
    assert.ok(memoryJson.entries.length > 0);

    const channelsResponse = await fetch(`http://127.0.0.1:${port}/admin/channels`);
    const channelsJson = await channelsResponse.json() as {
      channels: Array<{ id: string; enabled: boolean; secretPresent: boolean }>;
    };
    assert.ok(channelsJson.channels.some((channel) => channel.id === "web"));
    assert.ok(channelsJson.channels.some((channel) => channel.id === "slack"));
    assert.ok(channelsJson.channels.some((channel) => channel.id === "slack" && channel.secretPresent === true));

    const channelUpdateResponse = await fetch(`http://127.0.0.1:${port}/admin/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "C123456",
        text: "hello from codex-phantom"
      })
    });
    const slackMessageJson = await slackMessageResponse.json() as {
      delivery: { channelId: string; status: string; destination: string };
      result: { ts: string };
    };
    assert.equal(slackMessageJson.delivery.channelId, "slack");
    assert.equal(slackMessageJson.delivery.status, "delivered");
    assert.equal(slackMessageJson.delivery.destination, "C123456");
    assert.equal(slackMessageJson.result.ts, "1713900000.000100");
    assert.deepEqual(slackTransport.sent, [{ channel: "C123456", text: "hello from codex-phantom" }]);

    const deliveriesResponse = await fetch(`http://127.0.0.1:${port}/admin/channels/deliveries?channelId=slack`);
    const deliveriesJson = await deliveriesResponse.json() as {
      deliveries: Array<{ channelId: string; status: string; destination: string }>;
    };
    assert.ok(deliveriesJson.deliveries.some((delivery) =>
      delivery.channelId === "slack" &&
      delivery.status === "delivered" &&
      delivery.destination === "C123456"
    ));

    const adminSummaryResponse = await fetch(`http://127.0.0.1:${port}/admin/summary`);
    const adminSummaryJson = await adminSummaryResponse.json() as {
      logging: { provider: string };
      deployment: { qdrantEnabled: boolean };
      governance: { pendingDynamicTools: number; approvedDynamicTools: number };
      channelDeliveries: { delivered: number };
      settings: { dashboardRefreshSeconds: number };
      channels: Array<{ id: string; enabled: boolean }>;
    };
    assert.equal(adminSummaryJson.logging.provider, "pino");
    assert.equal(adminSummaryJson.deployment.qdrantEnabled, false);
    assert.equal(adminSummaryJson.governance.pendingDynamicTools, 0);
    assert.equal(adminSummaryJson.governance.approvedDynamicTools, 1);
    assert.equal(adminSummaryJson.channelDeliveries.delivered, 1);
    assert.equal(adminSummaryJson.settings.dashboardRefreshSeconds, 5);
    assert.ok(adminSummaryJson.channels.some((channel) => channel.id === "slack" && channel.enabled === true));

    const timelineResponse = await fetch(`http://127.0.0.1:${port}/admin/timeline`);
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

    const sessionDetailResponse = await fetch(`http://127.0.0.1:${port}/admin/sessions/${encodeURIComponent(webhookJson.sessionId)}`);
    const sessionDetailJson = await sessionDetailResponse.json() as { session: { sessionId: string; runIds: string[] } };
    assert.equal(sessionDetailJson.session.sessionId, webhookJson.sessionId);
    assert.ok(sessionDetailJson.session.runIds.length > 0);

    const runWithEvents = timelineJson.runs.find((run) => run.eventCount > 0) ?? timelineJson.runs[0];
    const firstRunId = runWithEvents?.runId;
    assert.ok(firstRunId);
    const runDetailResponse = await fetch(`http://127.0.0.1:${port}/admin/runs/${encodeURIComponent(firstRunId)}`);
    const runDetailJson = await runDetailResponse.json() as {
      run: { runId: string };
      events: Array<{ type: string }>;
      children: Array<{ runId: string }>;
    };
    assert.equal(runDetailJson.run.runId, firstRunId);
    assert.ok(Array.isArray(runDetailJson.events));

    const firstJobId = timelineJson.jobs[0]?.id;
    assert.ok(firstJobId);
    const jobDetailResponse = await fetch(`http://127.0.0.1:${port}/admin/jobs/${encodeURIComponent(firstJobId)}`);
    const jobDetailJson = await jobDetailResponse.json() as { job: { id: string; status: string } };
    assert.equal(jobDetailJson.job.id, firstJobId);

    const firstMemoryId = timelineJson.memory[0]?.id;
    assert.ok(firstMemoryId);
    const memoryDetailResponse = await fetch(`http://127.0.0.1:${port}/admin/memory/${encodeURIComponent(firstMemoryId)}`);
    const memoryDetailJson = await memoryDetailResponse.json() as { entry: { id: string; category: string } };
    assert.equal(memoryDetailJson.entry.id, firstMemoryId);

    const settingsResponse = await fetch(`http://127.0.0.1:${port}/admin/settings`);
    const settingsJson = await settingsResponse.json() as {
      settings: { dashboardRefreshSeconds: number; chatDefaultConversationId: string };
    };
    assert.equal(settingsJson.settings.dashboardRefreshSeconds, 5);
    assert.equal(settingsJson.settings.chatDefaultConversationId, "operator-console");

    const settingsUpdateResponse = await fetch(`http://127.0.0.1:${port}/admin/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  } finally {
    await scheduler.stop();
    await server.close();
    database.close();
  }
});
