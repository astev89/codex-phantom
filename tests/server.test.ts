import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { ChannelRegistry } from "../src/channels/registry.ts";
import type {
  AgentAdapter,
  AgentRunEvent,
  AgentRunRequest,
  AgentRunResult,
} from "../src/agent/types.ts";
import { SessionStore } from "../src/chat/session-store.ts";
import { MemoryMaintenanceService } from "../src/memory/maintenance.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { DynamicToolRegistry } from "../src/tools/dynamic-registry.ts";
import { ToolGovernanceService } from "../src/tools/governance.ts";
import { RunGraphStore } from "../src/orchestration/run-graph-store.ts";
import { OrchestrationService } from "../src/orchestration/service.ts";
import { SchedulerService } from "../src/scheduler/service.ts";
import { McpAuditStore } from "../src/mcp/audit.ts";
import { McpServer } from "../src/mcp/server.ts";
import { renderChatApp } from "../src/server/chat-ui.ts";
import { HttpServer } from "../src/server/http-server.ts";
import { buildJsonExport, buildNdjsonExport } from "../src/server/export.ts";
import { AppDatabase } from "../src/platform/database.ts";
import { Logger } from "../src/platform/logger.ts";
import { MetricsStore } from "../src/platform/metrics.ts";
import {
  makeConfig,
  makeDisabledEmbeddings,
  makeFakeVectorStore,
} from "./helpers.ts";
import {
  SlackChannel,
  type SlackBlock,
  type SlackTransport,
} from "../src/channels/slack.ts";
import { ChannelDeliveryStore } from "../src/channels/delivery-log.ts";

class FakeAdapter implements AgentAdapter {
  readonly name = "fake-codex";
  readonly capabilities = {
    supportsResume: true,
    supportsStreaming: true,
    supportsToolStreaming: true,
    supportsStructuredOutput: true,
    supportsParallelToolCalls: false,
    supportsReasoningEffort: true,
  };

  async run(
    request: AgentRunRequest,
    onEvent: (event: AgentRunEvent) => Promise<void> | void
  ): Promise<AgentRunResult> {
    const lastMessage = request.messages.at(-1);
    const lastContent = lastMessage?.content ?? "";
    if (
      lastMessage?.role === "user" &&
      lastContent === "create automatic artifact"
    ) {
      return {
        runId: request.runId,
        outputText: "",
        transcript: request.messages,
        toolCalls: [
          {
            toolCallId: "tool_auto_artifact",
            toolName: "echo.summary",
            argumentsText: JSON.stringify({
              artifacts: [
                {
                  title: "Auto Summary",
                  kind: "text",
                  contentType: "text/markdown",
                  content: "# Auto\nGenerated",
                  metadata: { scenario: "tool-output" },
                },
                {
                  title: "Ignored Binary",
                  kind: "file",
                  contentType: "application/octet-stream",
                  content: "unsafe",
                },
              ],
            }),
          },
        ],
      };
    }

    const outputText =
      lastMessage?.role === "tool"
        ? JSON.stringify({
            artifact: {
              title: "Final Structured Artifact",
              kind: "json",
              contentType: "application/json",
              content: { ok: true },
            },
          })
        : `assistant:${lastContent}`;
    await onEvent({
      type: "init",
      runId: request.runId,
      sessionId: request.sessionId,
    });
    await onEvent({
      type: "text_delta",
      runId: request.runId,
      delta: outputText,
    });
    await onEvent({
      type: "structured_message",
      runId: request.runId,
      message: { role: "assistant", content: outputText },
    });
    await onEvent({
      type: "final",
      runId: request.runId,
      outputText,
      previousResponseId: `resp_${request.runId}`,
      providerSessionId: `provider_${request.sessionId}`,
    });

    return {
      runId: request.runId,
      outputText,
      previousResponseId: `resp_${request.runId}`,
      providerSessionId: `provider_${request.sessionId}`,
      transcript: [
        ...request.messages,
        { role: "assistant", content: outputText },
      ],
      toolCalls: [],
    };
  }
}

class FakeSlackTransport implements SlackTransport {
  readonly sent: Array<{
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: SlackBlock[];
  }> = [];
  readonly updated: Array<{
    channel: string;
    ts: string;
    text: string;
    blocks?: SlackBlock[];
  }> = [];
  readonly reactions: Array<{
    channel: string;
    timestamp: string;
    name: string;
  }> = [];
  readonly removedReactions: Array<{
    channel: string;
    timestamp: string;
    name: string;
  }> = [];
  private readonly responses: Array<{
    ok: boolean;
    ts?: string;
    error?: string;
    statusCode?: number;
    retryAfterMs?: number;
  }>;

  constructor(
    responses: Array<{
      ok: boolean;
      ts?: string;
      error?: string;
      statusCode?: number;
      retryAfterMs?: number;
    }> = [{ ok: true, ts: "1713900000.000100", statusCode: 200 }]
  ) {
    this.responses = responses;
  }

  async sendMessage(input: {
    token: string;
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: SlackBlock[];
  }): Promise<{
    ok: boolean;
    ts?: string;
    error?: string;
    statusCode?: number;
    retryAfterMs?: number;
  }> {
    this.sent.push(
      input.threadTs
        ? {
            channel: input.channel,
            text: input.text,
            threadTs: input.threadTs,
            blocks: input.blocks,
          }
        : { channel: input.channel, text: input.text, blocks: input.blocks }
    );
    return (
      this.responses.shift() ?? {
        ok: true,
        ts: "1713900000.000100",
        statusCode: 200,
      }
    );
  }

  async updateMessage(input: {
    token: string;
    channel: string;
    ts: string;
    text: string;
    blocks?: SlackBlock[];
  }) {
    this.updated.push({
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      blocks: input.blocks,
    });
    return (
      this.responses.shift() ?? { ok: true, ts: input.ts, statusCode: 200 }
    );
  }

  async addReaction(input: {
    token: string;
    channel: string;
    timestamp: string;
    name: string;
  }) {
    this.reactions.push({
      channel: input.channel,
      timestamp: input.timestamp,
      name: input.name,
    });
    return this.responses.shift() ?? { ok: true, statusCode: 200 };
  }

  async removeReaction(input: {
    token: string;
    channel: string;
    timestamp: string;
    name: string;
  }) {
    this.removedReactions.push({
      channel: input.channel,
      timestamp: input.timestamp,
      name: input.name,
    });
    return this.responses.shift() ?? { ok: true, statusCode: 200 };
  }
}

function signedWebhookHeaders(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000).toString()
): Record<string, string> {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "x-channel-timestamp": timestamp,
    "x-channel-signature": `sha256=${signature}`,
  };
}

function signedSlackHeaders(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000).toString()
): Record<string, string> {
  const signature = createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${signature}`,
  };
}

async function eventually<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean
): Promise<T> {
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

test("renderChatApp preserves fenced code blocks and safely injects title data", () => {
  const html = renderChatApp("Bad </script><script>alert(1)</script>");

  assert.match(
    html,
    /<title>Bad &lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; Chat<\/title>/
  );
  assert.match(
    html,
    /document\.getElementById\('title'\)\.textContent = "Bad \\u003c\/script>\\u003cscript>alert\(1\)\\u003c\/script> Chat";/
  );
  assert.match(html, /const codeBlocks = \[\];/);
  assert.match(html, /withoutCodeBlocks/);
  assert.match(html, /escapeHtml\(code\)/);
  assert.match(html, /CODE_BLOCK_/);
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
    { ok: true, ts: "1713900000.000200", statusCode: 200 },
  ]);

  try {
    const slack = new SlackChannel(config, channels, deliveries, transport);
    const result = await slack.sendMessage({
      channel: "C123456",
      text: "retry me",
    });

    assert.equal(result.delivery.status, "delivered");
    assert.equal(result.delivery.attemptCount, 3);
    assert.equal(result.result.ts, "1713900000.000200");
    assert.equal(transport.sent.length, 3);

    const failingTransport = new FakeSlackTransport([
      { ok: false, error: "server_error", statusCode: 500, retryAfterMs: 1 },
      { ok: false, error: "server_error", statusCode: 500, retryAfterMs: 1 },
      { ok: false, error: "server_error", statusCode: 500, retryAfterMs: 1 },
    ]);
    const failingSlack = new SlackChannel(
      config,
      channels,
      deliveries,
      failingTransport
    );
    await assert.rejects(
      () => failingSlack.sendMessage({ channel: "C999999", text: "fail me" }),
      /server_error/
    );

    const summary = deliveries.summary();
    assert.equal(summary.delivered, 1);
    assert.equal(summary.failed, 1);
    assert.ok(
      summary.recentFailed.some(
        (delivery) =>
          delivery.destination === "C999999" &&
          delivery.status === "failed" &&
          delivery.attemptCount === 3
      )
    );
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
    slackBotUserId: "B999",
  });
  const database = new AppDatabase(join(dataDir, "server.sqlite"));
  const sessions = new SessionStore(database);
  const channels = new ChannelRegistry(database, config);
  const memory = new MemoryStore(
    database,
    config,
    makeDisabledEmbeddings(),
    makeFakeVectorStore({
      backend: "qdrant",
      available: false,
      configured: false,
    }),
    makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
  );
  const tools = new ToolRegistry();
  tools.register({
    id: "echo.summary",
    description: "echo",
    scopes: ["read"],
    kind: "in_process",
    handler: async (input) => input,
  });

  const runtime = new AgentRuntime(
    config,
    new FakeAdapter(),
    sessions,
    memory,
    tools
  );
  const runs = new RunGraphStore(database);
  const orchestration = new OrchestrationService(runtime, tools, runs);
  const scheduler = new SchedulerService(database, orchestration);
  const memoryMaintenance = new MemoryMaintenanceService(database, memory);
  await scheduler.start();
  const metrics = new MetricsStore();
  const mcpAudit = new McpAuditStore(database);
  const mcp = new McpServer(
    config.mcpBearerToken,
    tools,
    metrics,
    undefined,
    mcpAudit
  );
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
    slackTransport,
    memoryMaintenance
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
      padding: "x".repeat(1_100_000),
    });
    const oversizedMcpResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.mcpBearerToken}`,
      },
      body: oversizedMcpBody,
    });
    assert.equal(oversizedMcpResponse.status, 413);
    const oversizedMcpJson = (await oversizedMcpResponse.json()) as {
      error?: string;
      status?: number;
    };
    assert.equal(oversizedMcpJson.status, 413);
    assert.match(oversizedMcpJson.error ?? "", /body/i);

    const oversizedChatBody = JSON.stringify({
      conversationId: "oversized",
      message: "x".repeat(1_100_000),
    });
    const oversizedChatResponse = await fetch(`${baseUrl}/chat/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.operatorBearerToken}`,
      },
      body: oversizedChatBody,
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
      "/admin/memory/maintenance",
      "/scheduler/jobs",
    ];
    for (const path of protectedGetPaths) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(
        response.status,
        401,
        `${path} should require operator auth`
      );
      assert.equal(
        response.headers.get("www-authenticate"),
        'Basic realm="codex-phantom operator"'
      );
    }
    const unauthenticatedAdminResponse = await fetch(
      `http://127.0.0.1:${port}/admin/summary`
    );
    const unauthenticatedAdminJson =
      (await unauthenticatedAdminResponse.json()) as {
        error: string;
        status: number;
      };
    assert.equal(unauthenticatedAdminJson.error, "Unauthorized");
    assert.equal(unauthenticatedAdminJson.status, 401);

    const unauthenticatedChatResponse = await fetch(
      `http://127.0.0.1:${port}/chat/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: "web-unauth",
          message: "blocked",
        }),
      }
    );
    assert.equal(unauthenticatedChatResponse.status, 401);

    const unauthenticatedAttachmentForm = new FormData();
    unauthenticatedAttachmentForm.set("sessionId", "blocked");
    unauthenticatedAttachmentForm.set(
      "file",
      new Blob(["blocked"], { type: "text/plain" }),
      "blocked.txt"
    );
    const unauthenticatedAttachmentResponse = await fetch(
      `http://127.0.0.1:${port}/chat/attachments`,
      {
        method: "POST",
        body: unauthenticatedAttachmentForm,
      }
    );
    assert.equal(unauthenticatedAttachmentResponse.status, 401);

    const unauthenticatedArtifactResponse = await fetch(
      `http://127.0.0.1:${port}/chat/artifacts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "blocked",
          title: "Blocked",
          kind: "text",
          contentType: "text/plain",
          content: "blocked",
        }),
      }
    );
    assert.equal(unauthenticatedArtifactResponse.status, 401);

    const unauthenticatedScheduleResponse = await fetch(
      `http://127.0.0.1:${port}/scheduler/jobs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "blocked-job",
          message: "blocked",
          delayMs: 10,
        }),
      }
    );
    assert.equal(unauthenticatedScheduleResponse.status, 401);

    const unauthenticatedMaintenanceRunResponse = await fetch(
      `http://127.0.0.1:${port}/admin/memory/maintenance/run`,
      {
        method: "POST",
      }
    );
    assert.equal(unauthenticatedMaintenanceRunResponse.status, 401);

    const badWebhookResponse = await fetch(
      `http://127.0.0.1:${port}/channels/webhook`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-channel-secret": "wrong-secret",
        },
        body: JSON.stringify({
          conversationId: "bad-hook",
          message: "blocked",
        }),
      }
    );
    assert.equal(badWebhookResponse.status, 401);
    assert.equal(badWebhookResponse.headers.get("www-authenticate"), null);

    const staleWebhookBody = JSON.stringify({
      conversationId: "stale-hook",
      message: "blocked",
    });
    const staleWebhookResponse = await fetch(
      `http://127.0.0.1:${port}/channels/webhook`,
      {
        method: "POST",
        headers: signedWebhookHeaders(
          config.externalChannelSecret,
          staleWebhookBody,
          "1713900000"
        ),
        body: staleWebhookBody,
      }
    );
    assert.equal(staleWebhookResponse.status, 401);

    const wrongSignatureWebhookBody = JSON.stringify({
      conversationId: "wrong-signature-hook",
      message: "blocked",
    });
    const wrongSignatureWebhookResponse = await fetch(
      `http://127.0.0.1:${port}/channels/webhook`,
      {
        method: "POST",
        headers: signedWebhookHeaders(
          "wrong-secret",
          wrongSignatureWebhookBody
        ),
        body: wrongSignatureWebhookBody,
      }
    );
    assert.equal(wrongSignatureWebhookResponse.status, 401);

    const consoleResponse = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`operator:${config.operatorBearerToken}`).toString("base64")}`,
      },
    });
    assert.equal(consoleResponse.status, 200);
    assert.match(await consoleResponse.text(), /Operator Console/);

    const authenticatedUnknownAdminResponse = await fetch(
      `http://127.0.0.1:${port}/admin/not-real`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    assert.equal(authenticatedUnknownAdminResponse.status, 404);

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    const healthJson = (await healthResponse.json()) as {
      ok: boolean;
      readiness: {
        scheduler: boolean;
        semanticRetrieval: boolean;
        setupReady: boolean;
      };
      memory?: {
        pendingBackfillCount: number;
        vectorBackend: string;
        qdrantConfigured: boolean;
      };
      logging?: { provider: string };
    };
    assert.equal(healthResponse.status, 200);
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.readiness.scheduler, true);
    assert.equal(healthJson.readiness.semanticRetrieval, false);
    assert.equal(healthJson.readiness.setupReady, true);
    assert.equal(healthJson.memory, undefined);
    assert.equal(healthJson.logging, undefined);

    const detailedHealthResponse = await fetch(
      `http://127.0.0.1:${port}/health`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const detailedHealthJson = (await detailedHealthResponse.json()) as {
      ok: boolean;
      readiness: {
        scheduler: boolean;
        semanticRetrieval: boolean;
        setupReady: boolean;
      };
      setupReadiness: {
        ok: boolean;
        status: string;
        summary: { warnings: number; failures: number };
      };
      memory: {
        pendingBackfillCount: number;
        vectorBackend: string;
        qdrantConfigured: boolean;
      };
      logging: { provider: string };
    };
    assert.equal(detailedHealthResponse.status, 200);
    assert.equal(detailedHealthJson.ok, true);
    assert.equal(detailedHealthJson.readiness.scheduler, true);
    assert.equal(detailedHealthJson.readiness.semanticRetrieval, false);
    assert.equal(detailedHealthJson.readiness.setupReady, true);
    assert.equal(detailedHealthJson.setupReadiness.ok, true);
    assert.equal(detailedHealthJson.setupReadiness.status, "warning");
    assert.equal(detailedHealthJson.setupReadiness.summary.failures, 0);
    assert.ok(detailedHealthJson.setupReadiness.summary.warnings >= 1);
    assert.equal(detailedHealthJson.memory.pendingBackfillCount, 0);
    assert.equal(detailedHealthJson.memory.vectorBackend, "sqlite_fallback");
    assert.equal(detailedHealthJson.memory.qdrantConfigured, false);
    assert.equal(detailedHealthJson.logging.provider, "pino");

    const readinessResponse = await fetch(
      `http://127.0.0.1:${port}/admin/readiness`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const readinessJson = (await readinessResponse.json()) as {
      readiness: {
        ok: boolean;
        status: string;
        checks: Array<{ id: string; status: string; action?: string }>;
      };
    };
    assert.equal(readinessResponse.status, 200);
    assert.equal(readinessJson.readiness.ok, true);
    assert.equal(readinessJson.readiness.status, "warning");
    assert.ok(
      readinessJson.readiness.checks.some(
        (check) => check.id === "role-config" && check.status === "pass"
      )
    );

    const streamResponse = await fetch(
      `http://127.0.0.1:${port}/chat/message`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({
          conversationId: "web-1",
          message: "hello from web",
          attachments: [
            {
              name: "notes.md",
              contentType: "text/markdown",
              sizeBytes: 42,
              description: "Operator notes",
            },
          ],
        }),
      }
    );
    const streamText = await streamResponse.text();
    assert.match(streamText, /event: request.started/);
    assert.match(streamText, /event: agent.event/);
    assert.match(streamText, /event: run.completed/);
    assert.match(streamText, /event: request.completed/);
    assert.match(streamText, /"type":"init"/);
    assert.match(streamText, /"type":"text_delta"/);
    assert.match(streamText, /"type":"final"/);
    assert.match(streamText, /assistant:hello from web/);

    const chatPageResponse = await fetch(`http://127.0.0.1:${port}/chat`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
    });
    assert.equal(chatPageResponse.status, 200);
    const chatPageHtml = await chatPageResponse.text();
    assert.match(chatPageHtml, /data-testid="chat-app"/);
    assert.match(chatPageHtml, /BroadcastChannel/);
    assert.match(chatPageHtml, /renderMarkdown/);
    assert.match(chatPageHtml, /Notification\.requestPermission/);

    const chatSessionsResponse = await fetch(
      `http://127.0.0.1:${port}/chat/sessions`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    assert.equal(chatSessionsResponse.status, 200);
    const chatSessionsJson = (await chatSessionsResponse.json()) as {
      sessions: Array<{
        sessionId: string;
        title?: string;
        titleSource?: string;
        runIds: string[];
      }>;
    };
    const webSession = chatSessionsJson.sessions.find(
      (session) => session.title === "Hello From Web"
    );
    assert.ok(webSession);
    assert.equal(webSession.titleSource, "auto");
    assert.ok(webSession.runIds.length > 0);

    const chatSessionResponse = await fetch(
      `http://127.0.0.1:${port}/chat/sessions/${webSession.sessionId}`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    assert.equal(chatSessionResponse.status, 200);
    const chatSessionJson = (await chatSessionResponse.json()) as {
      session: { sessionId: string; title?: string };
      runs: Array<{
        runId: string;
        transcript: Array<{ role: string; content: string }>;
      }>;
      attachments: Array<{
        id: string;
        runId?: string;
        name: string;
        contentType: string;
        sizeBytes: number;
        description?: string;
        sha256?: string;
        downloadUrl?: string;
      }>;
      artifacts: Array<{
        id: string;
        runId?: string;
        title: string;
        kind: string;
        contentType: string;
        sizeBytes: number;
        sha256: string;
        downloadUrl: string;
      }>;
    };
    assert.equal(chatSessionJson.session.title, "Hello From Web");
    assert.ok(
      chatSessionJson.runs.some((run) =>
        run.transcript.some((message) => message.content === "hello from web")
      )
    );
    assert.ok(
      chatSessionJson.runs.every(
        (run) => run.runId.startsWith("coord_") || run.runId.startsWith("sub_")
      )
    );
    assert.deepEqual(chatSessionJson.artifacts, []);
    assert.deepEqual(
      chatSessionJson.attachments.map((attachment) => ({
        name: attachment.name,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        description: attachment.description,
      })),
      [
        {
          name: "notes.md",
          contentType: "text/markdown",
          sizeBytes: 42,
          description: "Operator notes",
        },
      ]
    );

    const uploadForm = new FormData();
    uploadForm.set("sessionId", webSession.sessionId);
    uploadForm.set(
      "file",
      new Blob(["hello attachment"], { type: "text/plain" }),
      "hello.txt"
    );
    const uploadResponse = await fetch(`${baseUrl}/chat/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      body: uploadForm,
    });
    assert.equal(uploadResponse.status, 201);
    const uploadJson = (await uploadResponse.json()) as {
      attachments: Array<{
        id: string;
        sessionId: string;
        name: string;
        contentType: string;
        sizeBytes: number;
        sha256: string;
        downloadUrl: string;
      }>;
    };
    assert.equal(uploadJson.attachments.length, 1);
    const uploadedAttachment = uploadJson.attachments[0];
    assert.equal(uploadedAttachment.sessionId, webSession.sessionId);
    assert.equal(uploadedAttachment.name, "hello.txt");
    assert.equal(uploadedAttachment.contentType, "text/plain");
    assert.equal(uploadedAttachment.sizeBytes, 16);
    assert.equal(
      uploadedAttachment.sha256,
      createHash("sha256").update("hello attachment").digest("hex")
    );
    assert.equal(
      uploadedAttachment.downloadUrl,
      `/chat/attachments/${uploadedAttachment.id}`
    );

    const attachmentDownloadResponse = await fetch(
      `${baseUrl}/chat/attachments/${uploadedAttachment.id}`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    assert.equal(attachmentDownloadResponse.status, 200);
    assert.equal(
      attachmentDownloadResponse.headers.get("content-type"),
      "text/plain"
    );
    assert.match(
      attachmentDownloadResponse.headers.get("content-disposition") ?? "",
      /filename="hello\.txt"/
    );
    assert.equal(await attachmentDownloadResponse.text(), "hello attachment");

    const linkedStreamResponse = await fetch(
      `http://127.0.0.1:${port}/chat/message`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({
          sessionId: webSession.sessionId,
          message: "use uploaded attachment",
          attachmentIds: [uploadedAttachment.id],
        }),
      }
    );
    assert.equal(linkedStreamResponse.status, 200);
    assert.match(
      await linkedStreamResponse.text(),
      /assistant:use uploaded attachment/
    );

    const linkedSessionResponse = await fetch(
      `http://127.0.0.1:${port}/chat/sessions/${webSession.sessionId}`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const linkedSessionJson = (await linkedSessionResponse.json()) as {
      attachments: Array<{
        id: string;
        runId?: string;
        name: string;
        sha256?: string;
        downloadUrl?: string;
      }>;
      runs: Array<{ runId: string }>;
      artifacts: Array<{ id: string }>;
    };
    const linkedAttachment = linkedSessionJson.attachments.find(
      (attachment) => attachment.id === uploadedAttachment.id
    );
    assert.ok(linkedAttachment);
    assert.ok(linkedAttachment.runId?.startsWith("coord_"));
    assert.equal(linkedAttachment.sha256, uploadedAttachment.sha256);
    assert.equal(
      linkedAttachment.downloadUrl,
      `/chat/attachments/${uploadedAttachment.id}`
    );

    const autoArtifactStreamResponse = await fetch(
      `http://127.0.0.1:${port}/chat/message`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({
          sessionId: webSession.sessionId,
          message: "create automatic artifact",
        }),
      }
    );
    const autoArtifactStreamText = await autoArtifactStreamResponse.text();
    assert.match(autoArtifactStreamText, /Auto Summary/);
    assert.match(autoArtifactStreamText, /Final Structured Artifact/);

    const sessionWithAutoArtifactsResponse = await fetch(
      `http://127.0.0.1:${port}/chat/sessions/${webSession.sessionId}`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const sessionWithAutoArtifactsJson =
      (await sessionWithAutoArtifactsResponse.json()) as {
        artifacts: Array<{
          id: string;
          runId?: string;
          title: string;
          kind: string;
          contentType: string;
          sizeBytes: number;
          sha256: string;
          downloadUrl: string;
          metadata: {
            autoExtracted?: boolean;
            source?: {
              sourceType?: string;
              toolName?: string;
              toolCallId?: string;
            };
            originalMetadata?: { scenario?: string } | null;
          };
        }>;
      };
    const autoSummaryArtifact = sessionWithAutoArtifactsJson.artifacts.find(
      (artifact) => artifact.title === "Auto Summary"
    );
    assert.ok(autoSummaryArtifact);
    assert.ok(autoSummaryArtifact.runId?.startsWith("coord_"));
    assert.equal(autoSummaryArtifact.kind, "text");
    assert.equal(autoSummaryArtifact.contentType, "text/markdown");
    assert.equal(
      autoSummaryArtifact.sizeBytes,
      Buffer.byteLength("# Auto\nGenerated")
    );
    assert.equal(
      autoSummaryArtifact.sha256,
      createHash("sha256").update("# Auto\nGenerated").digest("hex")
    );
    assert.equal(autoSummaryArtifact.metadata.autoExtracted, true);
    assert.equal(autoSummaryArtifact.metadata.source?.sourceType, "tool_event");
    assert.equal(autoSummaryArtifact.metadata.source?.toolName, "echo.summary");
    assert.equal(
      autoSummaryArtifact.metadata.source?.toolCallId,
      "tool_auto_artifact"
    );
    assert.equal(
      autoSummaryArtifact.metadata.originalMetadata?.scenario,
      "tool-output"
    );
    assert.ok(
      sessionWithAutoArtifactsJson.artifacts.some(
        (artifact) =>
          artifact.title === "Final Structured Artifact" &&
          artifact.kind === "json" &&
          artifact.metadata.source?.sourceType === "final_output"
      )
    );
    assert.ok(
      sessionWithAutoArtifactsJson.artifacts.every(
        (artifact) => artifact.title !== "Ignored Binary"
      )
    );

    const autoArtifactDownloadResponse = await fetch(
      `${baseUrl}/chat/artifacts/${autoSummaryArtifact.id}`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    assert.equal(autoArtifactDownloadResponse.status, 200);
    assert.equal(
      await autoArtifactDownloadResponse.text(),
      "# Auto\nGenerated"
    );

    const artifactResponse = await fetch(`${baseUrl}/chat/artifacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.operatorBearerToken}`,
      },
      body: JSON.stringify({
        sessionId: webSession.sessionId,
        runId: linkedAttachment.runId,
        title: "Research Summary",
        kind: "text",
        contentType: "text/markdown",
        content: "# Summary\nDone",
        metadata: { source: "server-test" },
      }),
    });
    assert.equal(artifactResponse.status, 201);
    const artifactJson = (await artifactResponse.json()) as {
      artifact: {
        id: string;
        sessionId: string;
        runId?: string;
        title: string;
        kind: string;
        contentType: string;
        sizeBytes: number;
        sha256: string;
        downloadUrl: string;
      };
    };
    assert.equal(artifactJson.artifact.sessionId, webSession.sessionId);
    assert.equal(artifactJson.artifact.runId, linkedAttachment.runId);
    assert.equal(artifactJson.artifact.title, "Research Summary");
    assert.equal(artifactJson.artifact.kind, "text");
    assert.equal(artifactJson.artifact.contentType, "text/markdown");
    assert.equal(
      artifactJson.artifact.sizeBytes,
      Buffer.byteLength("# Summary\nDone")
    );
    assert.equal(
      artifactJson.artifact.sha256,
      createHash("sha256").update("# Summary\nDone").digest("hex")
    );
    assert.equal(
      artifactJson.artifact.downloadUrl,
      `/chat/artifacts/${artifactJson.artifact.id}`
    );

    const artifactDownloadResponse = await fetch(
      `${baseUrl}/chat/artifacts/${artifactJson.artifact.id}`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    assert.equal(artifactDownloadResponse.status, 200);
    assert.equal(
      artifactDownloadResponse.headers.get("content-type"),
      "text/markdown"
    );
    assert.match(
      artifactDownloadResponse.headers.get("content-disposition") ?? "",
      /filename="Research Summary\.md"/
    );
    assert.equal(await artifactDownloadResponse.text(), "# Summary\nDone");

    const invalidArtifactResponse = await fetch(`${baseUrl}/chat/artifacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.operatorBearerToken}`,
      },
      body: JSON.stringify({
        sessionId: webSession.sessionId,
        title: "Bad",
        kind: "image",
        contentType: "text/plain",
        content: "bad",
      }),
    });
    assert.equal(invalidArtifactResponse.status, 400);

    const sessionWithArtifactResponse = await fetch(
      `http://127.0.0.1:${port}/chat/sessions/${webSession.sessionId}`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const sessionWithArtifactJson =
      (await sessionWithArtifactResponse.json()) as {
        artifacts: Array<{ id: string; title: string; downloadUrl: string }>;
      };
    assert.ok(
      sessionWithArtifactJson.artifacts.some(
        (artifact) =>
          artifact.id === artifactJson.artifact.id &&
          artifact.title === "Research Summary" &&
          artifact.downloadUrl === `/chat/artifacts/${artifactJson.artifact.id}`
      )
    );

    const webhookBody = JSON.stringify({
      conversationId: "hook-1",
      message: "hello from webhook",
    });
    const webhookResponse = await fetch(
      `http://127.0.0.1:${port}/channels/webhook`,
      {
        method: "POST",
        headers: signedWebhookHeaders(
          config.externalChannelSecret,
          webhookBody
        ),
        body: webhookBody,
      }
    );
    const webhookJson = (await webhookResponse.json()) as {
      sessionId: string;
      outputText: string;
      inboundEvent: { channelId: string; status: string };
    };
    assert.equal(webhookJson.outputText, "assistant:hello from webhook");
    assert.equal(webhookJson.inboundEvent.channelId, "webhook");
    assert.equal(webhookJson.inboundEvent.status, "completed");

    await fetch(`http://127.0.0.1:${port}/scheduler/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.operatorBearerToken}`,
      },
      body: JSON.stringify({
        name: "quick-job",
        message: "scheduled task",
        delayMs: 10,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const jobsResponse = await fetch(
      `http://127.0.0.1:${port}/scheduler/jobs`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const jobsJson = (await jobsResponse.json()) as {
      jobs: Array<{ status: string }>;
    };
    assert.ok(jobsJson.jobs.some((job) => job.status === "completed"));

    const mcpResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.mcpBearerToken}`,
      },
      body: JSON.stringify({ method: "tools/list" }),
    });
    const mcpJson = (await mcpResponse.json()) as {
      tools: Array<{ id: string }>;
    };
    assert.ok(mcpJson.tools.some((tool) => tool.id === "echo.summary"));

    const adminMcpAuditResponse = await fetch(
      `http://127.0.0.1:${port}/admin/mcp/audit`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    assert.equal(adminMcpAuditResponse.status, 200);
    const adminMcpAuditJson = (await adminMcpAuditResponse.json()) as {
      audit: Array<{ method: string; outcome: string; toolName?: string }>;
    };
    assert.ok(Array.isArray(adminMcpAuditJson.audit));
    assert.ok(
      adminMcpAuditJson.audit.some(
        (entry) => entry.method === "tools/list" && entry.outcome === "success"
      )
    );

    const invalidAuditLimitResponse = await fetch(
      `http://127.0.0.1:${port}/admin/mcp/audit?limit=foo`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    assert.equal(invalidAuditLimitResponse.status, 200);
    const invalidAuditLimitJson = (await invalidAuditLimitResponse.json()) as {
      audit: unknown[];
    };
    assert.ok(Array.isArray(invalidAuditLimitJson.audit));

    const unauthorizedMcpResponse = await fetch(
      `http://127.0.0.1:${port}/mcp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ method: "tools/list" }),
      }
    );
    assert.equal(unauthorizedMcpResponse.status, 401);

    for (let index = 0; index < 11; index += 1) {
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ method: "tools/list" }),
      });
    }
    const rateLimitedMcpResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ method: "tools/list" }),
    });
    assert.equal(rateLimitedMcpResponse.status, 429);

    const dynamicToolResponse = await fetch(
      `http://127.0.0.1:${port}/tools/dynamic`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({
          id: "project.brief",
          description: "Return a short project brief",
          scopes: ["read"],
          inputSchema: {
            type: "object",
            properties: {
              topic: { type: "string" },
            },
          },
          responseTemplate: "Brief for {{topic}}",
        }),
      }
    );
    const dynamicToolJson = (await dynamicToolResponse.json()) as {
      tool: { id: string; approvalState: string };
    };
    assert.equal(dynamicToolJson.tool.id, "project.brief");
    assert.equal(dynamicToolJson.tool.approvalState, "pending");

    const dynamicToolsResponse = await fetch(
      `http://127.0.0.1:${port}/tools/dynamic`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const dynamicToolsJson = (await dynamicToolsResponse.json()) as {
      tools: Array<{ id: string; approvalState: string }>;
    };
    assert.ok(
      dynamicToolsJson.tools.some((tool) => tool.id === "project.brief")
    );
    assert.ok(
      dynamicToolsJson.tools.some(
        (tool) =>
          tool.id === "project.brief" && tool.approvalState === "pending"
      )
    );

    const bundlePreviewResponse = await fetch(
      `http://127.0.0.1:${port}/admin/tools/bundles/preview`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({
          importedBy: "operator",
          manifest: {
            id: "internal.research",
            name: "Internal Research Tools",
            version: "1.0.0",
            tools: [
              {
                id: "internal.research.lookup",
                description: "Lookup research notes.",
                scopes: ["read"],
                inputSchema: { type: "object" },
                responseTemplate: "lookup:{{query}}",
              },
            ],
          },
        }),
      }
    );
    const bundlePreviewJson = (await bundlePreviewResponse.json()) as {
      preview: { id: string; status: string; bundleId: string };
    };
    assert.equal(bundlePreviewResponse.status, 200);
    assert.equal(bundlePreviewJson.preview.status, "valid");
    assert.equal(bundlePreviewJson.preview.bundleId, "internal.research");

    const blockedEnableResponse = await fetch(
      `http://127.0.0.1:${port}/admin/tools/bundles/${encodeURIComponent(bundlePreviewJson.preview.id)}/enable`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({ actor: "operator" }),
      }
    );
    assert.equal(blockedEnableResponse.status, 409);

    const approveBundleResponse = await fetch(
      `http://127.0.0.1:${port}/admin/tools/bundles/${encodeURIComponent(bundlePreviewJson.preview.id)}/approve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({
          actor: "operator",
          notes: "read-only internal bundle",
        }),
      }
    );
    const approveBundleJson = (await approveBundleResponse.json()) as {
      bundle: { lifecycleState: string; approvedBy: string };
    };
    assert.equal(approveBundleResponse.status, 200);
    assert.equal(approveBundleJson.bundle.lifecycleState, "approved");
    assert.equal(approveBundleJson.bundle.approvedBy, "operator");

    const enableBundleResponse = await fetch(
      `http://127.0.0.1:${port}/admin/tools/bundles/${encodeURIComponent(bundlePreviewJson.preview.id)}/enable`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({ actor: "operator" }),
      }
    );
    const enableBundleJson = (await enableBundleResponse.json()) as {
      bundle: { lifecycleState: string; enabledBy: string };
    };
    assert.equal(enableBundleResponse.status, 200);
    assert.equal(enableBundleJson.bundle.lifecycleState, "enabled");
    assert.equal(enableBundleJson.bundle.enabledBy, "operator");

    const bundleMcpListResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.mcpBearerToken}`,
      },
      body: JSON.stringify({ method: "tools/list" }),
    });
    const bundleMcpListJson = (await bundleMcpListResponse.json()) as {
      tools: Array<{ id: string; scopes: string[] }>;
    };
    assert.ok(
      bundleMcpListJson.tools.some(
        (tool) =>
          tool.id === "internal.research.lookup" && tool.scopes.includes("read")
      )
    );

    const disableBundleResponse = await fetch(
      `http://127.0.0.1:${port}/admin/tools/bundles/${encodeURIComponent(bundlePreviewJson.preview.id)}/disable`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({ actor: "operator" }),
      }
    );
    const disableBundleJson = (await disableBundleResponse.json()) as {
      bundle: { lifecycleState: string; disabledBy: string };
    };
    assert.equal(disableBundleResponse.status, 200);
    assert.equal(disableBundleJson.bundle.lifecycleState, "disabled");

    const disabledBundleMcpListResponse = await fetch(
      `http://127.0.0.1:${port}/mcp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.mcpBearerToken}`,
        },
        body: JSON.stringify({ method: "tools/list" }),
      }
    );
    const disabledBundleMcpListJson =
      (await disabledBundleMcpListResponse.json()) as {
        tools: Array<{ id: string }>;
      };
    assert.equal(
      disabledBundleMcpListJson.tools.some(
        (tool) => tool.id === "internal.research.lookup"
      ),
      false
    );

    const uninstallBundleResponse = await fetch(
      `http://127.0.0.1:${port}/admin/tools/bundles/${encodeURIComponent(bundlePreviewJson.preview.id)}/uninstall`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({ actor: "operator" }),
      }
    );
    const uninstallBundleJson = (await uninstallBundleResponse.json()) as {
      bundle: { lifecycleState: string; uninstalledBy: string };
    };
    assert.equal(uninstallBundleResponse.status, 200);
    assert.equal(uninstallBundleJson.bundle.lifecycleState, "uninstalled");

    const invalidBundlePreviewResponse = await fetch(
      `http://127.0.0.1:${port}/admin/tools/bundles/preview`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({
          manifest: {
            id: "unsafe.bundle",
            name: "Unsafe Bundle",
            version: "1.0.0",
            tools: [
              {
                id: "unsafe.bundle.write",
                description: "Write something.",
                scopes: ["write"],
                responseTemplate: "unsafe",
              },
            ],
          },
        }),
      }
    );
    const invalidBundlePreviewJson =
      (await invalidBundlePreviewResponse.json()) as {
        preview: { status: string; diagnostics: Array<{ level: string }> };
      };
    assert.equal(invalidBundlePreviewResponse.status, 400);
    assert.equal(invalidBundlePreviewJson.preview.status, "invalid");
    assert.ok(
      invalidBundlePreviewJson.preview.diagnostics.some(
        (item) => item.level === "error"
      )
    );

    const bundleImportsResponse = await fetch(
      `http://127.0.0.1:${port}/admin/tools/bundles`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const bundleImportsJson = (await bundleImportsResponse.json()) as {
      imports: Array<{ id: string; status: string; lifecycleState: string }>;
      audit: Array<{ action: string; importId: string }>;
      summary: { valid: number; invalid: number; uninstalled: number };
    };
    assert.equal(bundleImportsResponse.status, 200);
    assert.ok(
      bundleImportsJson.imports.some(
        (entry) => entry.id === bundlePreviewJson.preview.id
      )
    );
    assert.equal(bundleImportsJson.summary.valid, 1);
    assert.equal(bundleImportsJson.summary.invalid, 1);
    assert.equal(bundleImportsJson.summary.uninstalled, 1);
    assert.ok(
      bundleImportsJson.audit.some(
        (entry) =>
          entry.importId === bundlePreviewJson.preview.id &&
          entry.action === "uninstalled"
      )
    );

    const dynamicMcpListResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.mcpBearerToken}`,
      },
      body: JSON.stringify({ method: "tools/list" }),
    });
    const dynamicMcpListJson = (await dynamicMcpListResponse.json()) as {
      tools: Array<{ id: string }>;
    };
    assert.equal(
      dynamicMcpListJson.tools.some((tool) => tool.id === "project.brief"),
      false
    );

    const approvalResponse = await fetch(
      `http://127.0.0.1:${port}/admin/tools/approve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({
          toolId: "project.brief",
          approvedBy: "operator",
          notes: "read-only summary tool",
        }),
      }
    );
    const approvalJson = (await approvalResponse.json()) as {
      tool: { id: string; approvalState: string };
    };
    assert.equal(approvalJson.tool.id, "project.brief");
    assert.equal(approvalJson.tool.approvalState, "approved");

    const approvedMcpListResponse = await fetch(
      `http://127.0.0.1:${port}/mcp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.mcpBearerToken}`,
        },
        body: JSON.stringify({ method: "tools/list" }),
      }
    );
    const approvedMcpListJson = (await approvedMcpListResponse.json()) as {
      tools: Array<{ id: string }>;
    };
    assert.ok(
      approvedMcpListJson.tools.some((tool) => tool.id === "project.brief")
    );

    const dynamicCallResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.mcpBearerToken}`,
      },
      body: JSON.stringify({
        method: "tools/call",
        params: {
          name: "project.brief",
          input: { topic: "deployment" },
        },
      }),
    });
    const dynamicCallJson = (await dynamicCallResponse.json()) as {
      output: { content: string };
    };
    assert.equal(dynamicCallJson.output.content, "Brief for deployment");

    const memoryResponse = await fetch(`http://127.0.0.1:${port}/memory`, {
      headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
    });
    const memoryJson = (await memoryResponse.json()) as {
      entries: Array<{ id: string; category: string }>;
    };
    assert.ok(memoryJson.entries.length > 0);

    const maintenanceRunResponse = await fetch(
      `http://127.0.0.1:${port}/admin/memory/maintenance/run`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    assert.equal(maintenanceRunResponse.status, 202);
    const maintenanceRunJson = (await maintenanceRunResponse.json()) as {
      maintenance: { id: string; status: string };
    };
    assert.equal(maintenanceRunJson.maintenance.status, "completed");

    const maintenanceResponse = await fetch(
      `http://127.0.0.1:${port}/admin/memory/maintenance`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const maintenanceJson = (await maintenanceResponse.json()) as {
      maintenance: Array<{ id: string; status: string }>;
    };
    assert.ok(
      maintenanceJson.maintenance.some(
        (run) => run.id === maintenanceRunJson.maintenance.id
      )
    );

    const channelsResponse = await fetch(
      `http://127.0.0.1:${port}/admin/channels`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const channelsJson = (await channelsResponse.json()) as {
      channels: Array<{
        id: string;
        enabled: boolean;
        secretPresent: boolean;
        config: { requiredSecretEnvVars?: string[] };
      }>;
    };
    assert.ok(channelsJson.channels.some((channel) => channel.id === "web"));
    assert.ok(channelsJson.channels.some((channel) => channel.id === "slack"));
    assert.ok(
      channelsJson.channels.some(
        (channel) =>
          channel.id === "slack" &&
          channel.secretPresent === true &&
          channel.config.requiredSecretEnvVars?.includes("SLACK_SIGNING_SECRET")
      )
    );

    const channelUpdateResponse = await fetch(
      `http://127.0.0.1:${port}/admin/channels`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({
          id: "slack",
          enabled: true,
        }),
      }
    );
    const channelUpdateJson = (await channelUpdateResponse.json()) as {
      channel: { id: string; enabled: boolean };
    };
    assert.equal(channelUpdateJson.channel.id, "slack");
    assert.equal(channelUpdateJson.channel.enabled, true);

    const slackMessageResponse = await fetch(
      `http://127.0.0.1:${port}/channels/slack/message`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({
          channel: "C123456",
          text: "hello from codex-phantom",
        }),
      }
    );
    const slackMessageJson = (await slackMessageResponse.json()) as {
      delivery: {
        channelId: string;
        status: string;
        destination: string;
        attemptCount: number;
      };
      result: { ts: string };
    };
    assert.equal(slackMessageJson.delivery.channelId, "slack");
    assert.equal(slackMessageJson.delivery.status, "delivered");
    assert.equal(slackMessageJson.delivery.destination, "C123456");
    assert.equal(slackMessageJson.delivery.attemptCount, 1);
    assert.equal(slackMessageJson.result.ts, "1713900000.000100");
    assert.deepEqual(slackTransport.sent[0], {
      channel: "C123456",
      text: "hello from codex-phantom",
      blocks: undefined,
    });

    const slackEventBody = JSON.stringify({
      type: "event_callback",
      event_id: "EvInbound123",
      event: {
        type: "app_mention",
        user: "U123",
        channel: "C123456",
        text: "<@B999> hello from slack",
        ts: "1713900001.000100",
        thread_ts: "1713900001.000000",
      },
    });
    const slackEventResponse = await fetch(
      `http://127.0.0.1:${port}/channels/slack/events`,
      {
        method: "POST",
        headers: signedSlackHeaders(config.slackSigningSecret!, slackEventBody),
        body: slackEventBody,
      }
    );
    const slackEventJson = (await slackEventResponse.json()) as {
      status: string;
      inboundEventId: string;
    };
    assert.equal(slackEventResponse.status, 202);
    assert.equal(slackEventJson.status, "accepted");
    assert.ok(slackEventJson.inboundEventId);

    const inboundAfterSlack = await eventually(
      async () => {
        const inboundResponse = await fetch(
          `http://127.0.0.1:${port}/admin/channels/inbound?channelId=slack`,
          {
            headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
          }
        );
        return (await inboundResponse.json()) as {
          events: Array<{
            providerEventId: string;
            status: string;
            outputText?: string;
            runId?: string;
            progressState?: string;
            statusReaction?: string;
            progress?: Array<{ state: string; summary: string }>;
          }>;
        };
      },
      (body) =>
        body.events.some(
          (event) =>
            event.providerEventId === "EvInbound123" &&
            event.status === "completed"
        )
    );
    assert.ok(
      inboundAfterSlack.events.some(
        (event) =>
          event.providerEventId === "EvInbound123" &&
          event.status === "completed" &&
          event.outputText === "assistant:hello from slack" &&
          typeof event.runId === "string" &&
          event.progressState === "completed" &&
          event.statusReaction === "white_check_mark" &&
          event.progress?.some((progress) => progress.state === "completed")
      )
    );
    assert.ok(
      slackTransport.sent.some(
        (message) =>
          message.channel === "C123456" &&
          message.threadTs === "1713900001.000000" &&
          message.text === "Queued..."
      )
    );
    assert.ok(
      slackTransport.updated.some(
        (message) =>
          message.channel === "C123456" && message.text.startsWith("Completed:")
      )
    );
    assert.deepEqual(
      slackTransport.reactions.map((reaction) => reaction.name),
      ["hourglass", "hourglass_flowing_sand", "white_check_mark"]
    );
    assert.ok(
      slackTransport.removedReactions.some(
        (reaction) => reaction.name === "hourglass"
      )
    );
    assert.ok(
      slackTransport.removedReactions.some(
        (reaction) => reaction.name === "hourglass_flowing_sand"
      )
    );
    assert.ok(
      slackTransport.sent.some(
        (message) =>
          message.channel === "C123456" &&
          message.text === "assistant:hello from slack"
      )
    );
    const finalSlackReply = slackTransport.sent.find(
      (message) =>
        message.channel === "C123456" &&
        message.threadTs === "1713900001.000000" &&
        message.text === "assistant:hello from slack"
    );
    assert.ok(finalSlackReply?.blocks);
    assert.ok(
      finalSlackReply.blocks.some((block) =>
        JSON.stringify(block).includes(slackEventJson.inboundEventId)
      )
    );

    const interactionPayload = {
      type: "block_actions",
      user: { id: "U123" },
      channel: { id: "C123456" },
      container: { message_ts: "1713900000.000100" },
      message: {
        ts: "1713900000.000100",
        thread_ts: "1713900001.000000",
      },
      actions: [
        {
          action_id: "codex_feedback_positive",
          value: slackEventJson.inboundEventId,
          action_ts: "1713900002.000000",
        },
      ],
    };
    const interactionBody = new URLSearchParams({
      payload: JSON.stringify(interactionPayload),
    }).toString();
    const interactionResponse = await fetch(
      `http://127.0.0.1:${port}/channels/slack/interactions`,
      {
        method: "POST",
        headers: signedSlackHeaders(
          config.slackSigningSecret!,
          interactionBody
        ),
        body: interactionBody,
      }
    );
    const interactionJson = (await interactionResponse.json()) as {
      status: string;
      duplicate: boolean;
      feedback: { rating: string; source: string; inboundEventId: string };
    };
    assert.equal(interactionResponse.status, 200);
    assert.equal(interactionJson.status, "recorded");
    assert.equal(interactionJson.duplicate, false);
    assert.equal(interactionJson.feedback.rating, "positive");
    assert.equal(interactionJson.feedback.source, "button");
    assert.equal(
      interactionJson.feedback.inboundEventId,
      slackEventJson.inboundEventId
    );

    const duplicateInteractionResponse = await fetch(
      `http://127.0.0.1:${port}/channels/slack/interactions`,
      {
        method: "POST",
        headers: signedSlackHeaders(
          config.slackSigningSecret!,
          interactionBody
        ),
        body: interactionBody,
      }
    );
    const duplicateInteractionJson =
      (await duplicateInteractionResponse.json()) as {
        status: string;
        duplicate: boolean;
      };
    assert.equal(duplicateInteractionResponse.status, 200);
    assert.equal(duplicateInteractionJson.status, "duplicate");
    assert.equal(duplicateInteractionJson.duplicate, true);

    const invalidInteractionResponse = await fetch(
      `http://127.0.0.1:${port}/channels/slack/interactions`,
      {
        method: "POST",
        headers: signedSlackHeaders("wrong-secret", interactionBody),
        body: interactionBody,
      }
    );
    assert.equal(invalidInteractionResponse.status, 401);

    const reactionFeedbackBody = JSON.stringify({
      type: "event_callback",
      event_id: "EvFeedbackReaction",
      event: {
        type: "reaction_added",
        user: "U456",
        reaction: "thumbsdown",
        item: { channel: "C123456", ts: "1713900000.000100" },
      },
    });
    const reactionFeedbackResponse = await fetch(
      `http://127.0.0.1:${port}/channels/slack/events`,
      {
        method: "POST",
        headers: signedSlackHeaders(
          config.slackSigningSecret!,
          reactionFeedbackBody
        ),
        body: reactionFeedbackBody,
      }
    );
    const reactionFeedbackJson = (await reactionFeedbackResponse.json()) as {
      status: string;
      duplicate: boolean;
      feedback: {
        rating: string;
        source: string;
        inboundEventId: string;
        threadTs?: string;
      };
    };
    assert.equal(reactionFeedbackResponse.status, 202);
    assert.equal(reactionFeedbackJson.status, "feedback");
    assert.equal(reactionFeedbackJson.duplicate, false);
    assert.equal(reactionFeedbackJson.feedback.rating, "negative");
    assert.equal(reactionFeedbackJson.feedback.source, "reaction");
    assert.equal(reactionFeedbackJson.feedback.threadTs, "1713900001.000000");

    const duplicateSlackEventResponse = await fetch(
      `http://127.0.0.1:${port}/channels/slack/events`,
      {
        method: "POST",
        headers: signedSlackHeaders(config.slackSigningSecret!, slackEventBody),
        body: slackEventBody,
      }
    );
    const duplicateSlackEventJson =
      (await duplicateSlackEventResponse.json()) as {
        status: string;
        duplicate: boolean;
      };
    assert.equal(duplicateSlackEventResponse.status, 202);
    assert.equal(duplicateSlackEventJson.status, "duplicate");
    assert.equal(duplicateSlackEventJson.duplicate, true);

    const deliveriesResponse = await fetch(
      `http://127.0.0.1:${port}/admin/channels/deliveries?channelId=slack`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const deliveriesJson = (await deliveriesResponse.json()) as {
      deliveries: Array<{
        channelId: string;
        status: string;
        destination: string;
        attemptCount: number;
        payload: { thread_ts?: string };
      }>;
    };
    assert.ok(
      deliveriesJson.deliveries.some(
        (delivery) =>
          delivery.channelId === "slack" &&
          delivery.status === "delivered" &&
          delivery.destination === "C123456" &&
          delivery.attemptCount === 1
      )
    );
    assert.ok(
      deliveriesJson.deliveries.some(
        (delivery) => delivery.payload.thread_ts === "1713900001.000000"
      )
    );

    const adminSummaryResponse = await fetch(
      `http://127.0.0.1:${port}/admin/summary`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const adminSummaryJson = (await adminSummaryResponse.json()) as {
      logging: { provider: string };
      deployment: { qdrantEnabled: boolean };
      governance: { pendingDynamicTools: number; approvedDynamicTools: number };
      toolBundles: { valid: number; invalid: number; uninstalled: number };
      selfEvolution: { proposed: number };
      channelDeliveries: { delivered: number; recentFailed: unknown[] };
      channelInbound: {
        completed: number;
        failed: number;
        recentFailed: unknown[];
      };
      channelFeedback: {
        positive: number;
        negative: number;
        recent: Array<{ rating: string; source: string }>;
      };
      setupReadiness: { ok: boolean; status: string };
      rolePolicy: { source: string; valid: boolean; roles: string[] };
      settings: { dashboardRefreshSeconds: number };
      channels: Array<{ id: string; enabled: boolean }>;
    };
    assert.equal(adminSummaryJson.logging.provider, "pino");
    assert.equal(adminSummaryJson.deployment.qdrantEnabled, false);
    assert.equal(adminSummaryJson.governance.pendingDynamicTools, 0);
    assert.equal(adminSummaryJson.governance.approvedDynamicTools, 1);
    assert.equal(adminSummaryJson.toolBundles.valid, 1);
    assert.equal(adminSummaryJson.toolBundles.invalid, 1);
    assert.equal(adminSummaryJson.toolBundles.uninstalled, 1);
    assert.equal(adminSummaryJson.selfEvolution.proposed, 0);
    assert.ok(adminSummaryJson.channelDeliveries.delivered >= 2);
    assert.deepEqual(adminSummaryJson.channelDeliveries.recentFailed, []);
    assert.ok(adminSummaryJson.channelInbound.completed >= 2);
    assert.deepEqual(adminSummaryJson.channelInbound.recentFailed, []);
    assert.ok(adminSummaryJson.channelFeedback.positive >= 1);
    assert.ok(adminSummaryJson.channelFeedback.negative >= 1);
    assert.ok(
      adminSummaryJson.channelFeedback.recent.some(
        (feedback) =>
          feedback.rating === "positive" && feedback.source === "button"
      )
    );
    assert.equal(adminSummaryJson.setupReadiness.ok, true);
    assert.equal(adminSummaryJson.setupReadiness.status, "warning");
    assert.equal(adminSummaryJson.rolePolicy.source, "compiled_fallback");
    assert.equal(adminSummaryJson.rolePolicy.valid, true);
    assert.ok(adminSummaryJson.rolePolicy.roles.includes("explorer"));
    assert.equal(adminSummaryJson.settings.dashboardRefreshSeconds, 5);
    assert.ok(
      adminSummaryJson.channels.some(
        (channel) => channel.id === "slack" && channel.enabled === true
      )
    );

    const unauthenticatedProposalResponse = await fetch(
      `http://127.0.0.1:${port}/admin/self-evolution/proposals`
    );
    assert.equal(unauthenticatedProposalResponse.status, 401);

    const proposalResponse = await fetch(
      `http://127.0.0.1:${port}/admin/self-evolution/proposals`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.operatorBearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          target: "role",
          title: "Allow verifier docs reads",
          rationale: "Verifier agents need docs context for parity checks.",
          riskClass: "medium",
          proposedChange: {
            summary: "Add docs/**/* to verifier file globs.",
            fileGlobs: ["src/**/*", "tests/**/*", "docs/**/*"],
          },
          metadata: { issue: 13 },
        }),
      }
    );
    const proposalJson = (await proposalResponse.json()) as {
      proposal: {
        id: string;
        target: string;
        status: string;
        proposedBy: string;
      };
    };
    assert.equal(proposalResponse.status, 201);
    assert.equal(proposalJson.proposal.target, "role");
    assert.equal(proposalJson.proposal.status, "proposed");
    assert.equal(proposalJson.proposal.proposedBy, "operator");

    const directApplyProposalResponse = await fetch(
      `http://127.0.0.1:${port}/admin/self-evolution/proposals`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.operatorBearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          target: "configuration",
          title: "Apply immediately",
          rationale: "Should be rejected.",
          riskClass: "high",
          proposedChange: { summary: "unsafe", applyNow: true },
        }),
      }
    );
    assert.equal(directApplyProposalResponse.status, 400);

    const proposalListResponse = await fetch(
      `http://127.0.0.1:${port}/admin/self-evolution/proposals`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const proposalListJson = (await proposalListResponse.json()) as {
      proposals: Array<{ id: string; title: string }>;
      summary: { proposed: number };
    };
    assert.equal(proposalListResponse.status, 200);
    assert.ok(
      proposalListJson.proposals.some(
        (proposal) => proposal.id === proposalJson.proposal.id
      )
    );
    assert.equal(proposalListJson.summary.proposed, 1);

    const applyProposalResponse = await fetch(
      `http://127.0.0.1:${port}/admin/self-evolution/proposals`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.operatorBearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          target: "configuration",
          title: "Tune operator refresh",
          rationale: "Exercise approved self-evolution apply and rollback.",
          riskClass: "high",
          proposedChange: {
            summary: "Change only operator settings.",
            operatorSettings: { dashboardRefreshSeconds: 9 },
          },
        }),
      }
    );
    const applyProposalJson = (await applyProposalResponse.json()) as {
      proposal: { id: string; status: string };
    };
    assert.equal(applyProposalResponse.status, 201);

    const approveProposalResponse = await fetch(
      `http://127.0.0.1:${port}/admin/self-evolution/proposals/${encodeURIComponent(applyProposalJson.proposal.id)}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.operatorBearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reviewedBy: "operator",
          notes: "High risk confirmed for route behavior test.",
        }),
      }
    );
    const approveProposalJson = (await approveProposalResponse.json()) as {
      proposal: { status: string; reviewedBy: string };
    };
    assert.equal(approveProposalResponse.status, 200);
    assert.equal(approveProposalJson.proposal.status, "approved");
    assert.equal(approveProposalJson.proposal.reviewedBy, "operator");

    const blockedApplyResponse = await fetch(
      `http://127.0.0.1:${port}/admin/self-evolution/proposals/${encodeURIComponent(applyProposalJson.proposal.id)}/apply`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.operatorBearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ appliedBy: "operator" }),
      }
    );
    assert.equal(blockedApplyResponse.status, 409);

    const confirmedApplyResponse = await fetch(
      `http://127.0.0.1:${port}/admin/self-evolution/proposals/${encodeURIComponent(applyProposalJson.proposal.id)}/apply`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.operatorBearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          appliedBy: "operator",
          confirmHighRisk: true,
        }),
      }
    );
    const confirmedApplyJson = (await confirmedApplyResponse.json()) as {
      proposal: { status: string; appliedBy: string };
      mutation: { status: string; mutationType: string };
    };
    assert.equal(confirmedApplyResponse.status, 200);
    assert.equal(confirmedApplyJson.proposal.status, "applied");
    assert.equal(confirmedApplyJson.proposal.appliedBy, "operator");
    assert.equal(confirmedApplyJson.mutation.status, "applied");
    assert.equal(confirmedApplyJson.mutation.mutationType, "operator_settings");

    const appliedSettingsResponse = await fetch(
      `http://127.0.0.1:${port}/admin/settings`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const appliedSettingsJson = (await appliedSettingsResponse.json()) as {
      settings: { dashboardRefreshSeconds: number };
    };
    assert.equal(appliedSettingsJson.settings.dashboardRefreshSeconds, 9);

    const rollbackResponse = await fetch(
      `http://127.0.0.1:${port}/admin/self-evolution/proposals/${encodeURIComponent(applyProposalJson.proposal.id)}/rollback`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.operatorBearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ rolledBackBy: "operator" }),
      }
    );
    const rollbackJson = (await rollbackResponse.json()) as {
      proposal: { status: string; rolledBackBy: string };
    };
    assert.equal(rollbackResponse.status, 200);
    assert.equal(rollbackJson.proposal.status, "rolled_back");
    assert.equal(rollbackJson.proposal.rolledBackBy, "operator");

    const rolledBackSettingsResponse = await fetch(
      `http://127.0.0.1:${port}/admin/settings`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const rolledBackSettingsJson =
      (await rolledBackSettingsResponse.json()) as {
        settings: { dashboardRefreshSeconds: number };
      };
    assert.equal(rolledBackSettingsJson.settings.dashboardRefreshSeconds, 5);

    const updatedSummaryResponse = await fetch(
      `http://127.0.0.1:${port}/admin/summary`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const updatedSummaryJson = (await updatedSummaryResponse.json()) as {
      selfEvolution: {
        proposed: number;
        highRisk: number;
        rolledBack: number;
        recentMutations: Array<{ status: string }>;
      };
    };
    assert.equal(updatedSummaryJson.selfEvolution.proposed, 1);
    assert.equal(updatedSummaryJson.selfEvolution.highRisk, 0);
    assert.equal(updatedSummaryJson.selfEvolution.rolledBack, 1);
    assert.ok(
      updatedSummaryJson.selfEvolution.recentMutations.some(
        (mutation) => mutation.status === "rolled_back"
      )
    );

    const feedbackResponse = await fetch(
      `http://127.0.0.1:${port}/admin/channels/feedback`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const feedbackJson = (await feedbackResponse.json()) as {
      feedback: Array<{
        rating: string;
        source: string;
        inboundEventId?: string;
      }>;
      summary: { positive: number; negative: number };
    };
    assert.equal(feedbackResponse.status, 200);
    assert.ok(feedbackJson.summary.positive >= 1);
    assert.ok(feedbackJson.summary.negative >= 1);
    assert.ok(
      feedbackJson.feedback.some(
        (feedback) =>
          feedback.inboundEventId === slackEventJson.inboundEventId &&
          feedback.source === "button"
      )
    );

    const timelineResponse = await fetch(
      `http://127.0.0.1:${port}/admin/timeline`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const timelineJson = (await timelineResponse.json()) as {
      sessions: Array<{ sessionId: string }>;
      runs: Array<{ runId: string; eventCount: number }>;
      jobs: Array<{ id: string }>;
      memory: Array<{ id: string }>;
      memoryMaintenance: Array<{ id: string; status: string }>;
      governanceAudit: Array<{ toolId: string; action: string }>;
      selfEvolutionProposals: Array<{ id: string; status: string }>;
      selfEvolutionMutations: Array<{ status: string }>;
      toolBundleImports: Array<{
        id: string;
        status: string;
        lifecycleState: string;
      }>;
    };
    assert.ok(timelineJson.sessions.length > 0);
    assert.ok(timelineJson.runs.length > 0);
    assert.ok(timelineJson.jobs.length > 0);
    assert.ok(timelineJson.memory.length > 0);
    assert.ok(
      timelineJson.memoryMaintenance.some(
        (run) => run.id === maintenanceRunJson.maintenance.id
      )
    );
    assert.ok(
      timelineJson.governanceAudit.some(
        (entry) =>
          entry.toolId === "project.brief" && entry.action === "approved"
      )
    );
    assert.ok(
      timelineJson.selfEvolutionProposals.some(
        (proposal) => proposal.id === proposalJson.proposal.id
      )
    );
    assert.ok(
      timelineJson.selfEvolutionMutations.some(
        (mutation) => mutation.status === "rolled_back"
      )
    );
    assert.ok(
      timelineJson.toolBundleImports.some(
        (entry) =>
          entry.id === bundlePreviewJson.preview.id &&
          entry.lifecycleState === "uninstalled"
      )
    );

    const sessionDetailResponse = await fetch(
      `http://127.0.0.1:${port}/admin/sessions/${encodeURIComponent(webhookJson.sessionId)}`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const sessionDetailJson = (await sessionDetailResponse.json()) as {
      session: { sessionId: string; runIds: string[] };
    };
    assert.equal(sessionDetailJson.session.sessionId, webhookJson.sessionId);
    assert.ok(sessionDetailJson.session.runIds.length > 0);

    const runWithEvents =
      timelineJson.runs.find((run) => run.eventCount > 0) ??
      timelineJson.runs[0];
    const firstRunId = runWithEvents?.runId;
    assert.ok(firstRunId);
    const runDetailResponse = await fetch(
      `http://127.0.0.1:${port}/admin/runs/${encodeURIComponent(firstRunId)}`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const runDetailJson = (await runDetailResponse.json()) as {
      run: { runId: string };
      events: Array<{ type: string }>;
      children: Array<{ runId: string }>;
    };
    assert.equal(runDetailJson.run.runId, firstRunId);
    assert.ok(Array.isArray(runDetailJson.events));

    const firstJobId = timelineJson.jobs[0]?.id;
    assert.ok(firstJobId);
    const jobDetailResponse = await fetch(
      `http://127.0.0.1:${port}/admin/jobs/${encodeURIComponent(firstJobId)}`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const jobDetailJson = (await jobDetailResponse.json()) as {
      job: { id: string; status: string };
    };
    assert.equal(jobDetailJson.job.id, firstJobId);

    const firstMemoryId = timelineJson.memory[0]?.id;
    assert.ok(firstMemoryId);
    const memoryDetailResponse = await fetch(
      `http://127.0.0.1:${port}/admin/memory/${encodeURIComponent(firstMemoryId)}`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const memoryDetailJson = (await memoryDetailResponse.json()) as {
      entry: { id: string; category: string };
    };
    assert.equal(memoryDetailJson.entry.id, firstMemoryId);

    const settingsResponse = await fetch(
      `http://127.0.0.1:${port}/admin/settings`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const settingsJson = (await settingsResponse.json()) as {
      settings: {
        dashboardRefreshSeconds: number;
        chatDefaultConversationId: string;
      };
    };
    assert.equal(settingsJson.settings.dashboardRefreshSeconds, 5);
    assert.equal(
      settingsJson.settings.chatDefaultConversationId,
      "operator-console"
    );

    const settingsUpdateResponse = await fetch(
      `http://127.0.0.1:${port}/admin/settings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.operatorBearerToken}`,
        },
        body: JSON.stringify({
          dashboardRefreshSeconds: 9,
          chatDefaultConversationId: "ops-room",
          memoryTimelineLimit: 25,
        }),
      }
    );
    const settingsUpdateJson = (await settingsUpdateResponse.json()) as {
      settings: {
        dashboardRefreshSeconds: number;
        chatDefaultConversationId: string;
        memoryTimelineLimit: number;
      };
    };
    assert.equal(settingsUpdateJson.settings.dashboardRefreshSeconds, 9);
    assert.equal(
      settingsUpdateJson.settings.chatDefaultConversationId,
      "ops-room"
    );
    assert.equal(settingsUpdateJson.settings.memoryTimelineLimit, 25);

    const requestExportResponse = await fetch(
      `http://127.0.0.1:${port}/admin/export?scope=requests&format=json`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const requestExportJson = (await requestExportResponse.json()) as {
      scope: string;
      format: string;
      items: Array<{ requestId: string; path: string; statusCode: number }>;
    };
    assert.equal(requestExportJson.scope, "requests");
    assert.equal(requestExportJson.format, "json");
    assert.ok(requestExportJson.items.some((item) => item.path === "/health"));
    assert.ok(
      requestExportJson.items.some(
        (item) => item.path === "/admin/summary" && item.statusCode === 401
      )
    );

    const channelExportResponse = await fetch(
      `http://127.0.0.1:${port}/admin/export?scope=channels&format=ndjson`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const channelExportText = await channelExportResponse.text();
    assert.match(channelExportText, /"channelId":"slack"/);
    assert.match(channelExportText, /"status":"delivered"/);

    const mcpExportResponse = await fetch(
      `http://127.0.0.1:${port}/admin/export?scope=mcp&format=json`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const mcpExportJson = (await mcpExportResponse.json()) as {
      scope: string;
      format: string;
      items: Array<{ method: string; outcome: string; toolName?: string }>;
    };
    assert.equal(mcpExportJson.scope, "mcp");
    assert.equal(mcpExportJson.format, "json");
    assert.ok(
      mcpExportJson.items.some(
        (item) => item.method === "tools/list" && item.outcome === "success"
      )
    );

    const chatExportResponse = await fetch(
      `http://127.0.0.1:${port}/admin/export?scope=chat&format=json`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const chatExportJson = (await chatExportResponse.json()) as {
      scope: string;
      items: Array<{ kind: string; id: string; sessionId: string }>;
    };
    assert.equal(chatExportJson.scope, "chat");
    assert.ok(
      chatExportJson.items.some(
        (item) =>
          item.kind === "attachment" &&
          item.id === uploadedAttachment.id &&
          item.sessionId === webSession.sessionId
      )
    );
    assert.ok(
      chatExportJson.items.some(
        (item) =>
          item.kind === "artifact" &&
          item.id === artifactJson.artifact.id &&
          item.sessionId === webSession.sessionId
      )
    );

    const diagnosticsResponse = await fetch(
      `http://127.0.0.1:${port}/admin/diagnostics`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    const diagnosticsJson = (await diagnosticsResponse.json()) as {
      diagnostics: {
        appEnv: string;
        modelAdapter: string;
        missingRecommendedEnv: string[];
        rolePolicy: { source: string; valid: boolean };
        channelReadiness: Array<{
          id: string;
          enabled: boolean;
          secretPresent: boolean;
        }>;
      };
    };
    assert.equal(diagnosticsJson.diagnostics.appEnv, "test");
    assert.equal(diagnosticsJson.diagnostics.modelAdapter, "fallback");
    assert.equal(
      diagnosticsJson.diagnostics.rolePolicy.source,
      "compiled_fallback"
    );
    assert.equal(diagnosticsJson.diagnostics.rolePolicy.valid, true);
    assert.ok(
      diagnosticsJson.diagnostics.missingRecommendedEnv.includes(
        "OPENAI_API_KEY"
      )
    );
    assert.ok(
      diagnosticsJson.diagnostics.channelReadiness.some(
        (channel) =>
          channel.id === "slack" &&
          channel.enabled === true &&
          channel.secretPresent === true
      )
    );

    const metricsResponse = await fetch(
      `http://127.0.0.1:${port}/metrics?format=prometheus`,
      {
        headers: { Authorization: `Bearer ${config.operatorBearerToken}` },
      }
    );
    assert.equal(
      metricsResponse.headers.get("content-type"),
      "text/plain; version=0.0.4"
    );
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
  const config = makeConfig(dataDir, {
    port: 0,
    slackBotToken: "xoxb-test-token",
  });
  const database = new AppDatabase(join(dataDir, "slack-inbound.sqlite"));
  const sessions = new SessionStore(database);
  const channels = new ChannelRegistry(database, config);
  const memory = new MemoryStore(
    database,
    config,
    makeDisabledEmbeddings(),
    makeFakeVectorStore({
      backend: "qdrant",
      available: false,
      configured: false,
    }),
    makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
  );
  const tools = new ToolRegistry();
  const runtime = new AgentRuntime(
    config,
    new FakeAdapter(),
    sessions,
    memory,
    tools
  );
  const runs = new RunGraphStore(database);
  const orchestration = new OrchestrationService(runtime, tools, runs);
  const scheduler = new SchedulerService(database, orchestration);
  await scheduler.start();
  const metrics = new MetricsStore();
  const mcpAudit = new McpAuditStore(database);
  const mcp = new McpServer(
    config.mcpBearerToken,
    tools,
    metrics,
    undefined,
    mcpAudit
  );
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
        ts: "1713900001.000100",
      },
    });

    const missingSecretResponse = await fetch(
      `http://127.0.0.1:${port}/channels/slack/events`,
      {
        method: "POST",
        headers: signedSlackHeaders("slack-signing-secret", body),
        body,
      }
    );
    assert.equal(missingSecretResponse.status, 412);

    config.slackSigningSecret = "slack-signing-secret";
    const disabledResponse = await fetch(
      `http://127.0.0.1:${port}/channels/slack/events`,
      {
        method: "POST",
        headers: signedSlackHeaders(config.slackSigningSecret, body),
        body,
      }
    );
    assert.equal(disabledResponse.status, 409);
  } finally {
    await scheduler.stop();
    await server.close();
    database.close();
  }
});
