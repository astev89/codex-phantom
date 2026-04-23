import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.ts";
import { modelAdapterMode } from "../config.ts";
import { validateWebhookSecret } from "../channels/webhook.ts";
import { ChannelRegistry } from "../channels/registry.ts";
import { ChannelDeliveryStore } from "../channels/delivery-log.ts";
import type { SlackTransport } from "../channels/slack.ts";
import { SlackChannel } from "../channels/slack.ts";
import { OrchestrationService } from "../orchestration/service.ts";
import { SchedulerService } from "../scheduler/service.ts";
import { SessionStore } from "../chat/session-store.ts";
import { McpServer } from "../mcp/server.ts";
import type { AgentRunEvent } from "../agent/types.ts";
import { RunGraphStore } from "../orchestration/run-graph-store.ts";
import { AppDatabase } from "../platform/database.ts";
import { Logger } from "../platform/logger.ts";
import { MetricsStore } from "../platform/metrics.ts";
import { MemoryStore } from "../memory/store.ts";
import { DynamicToolRegistry } from "../tools/dynamic-registry.ts";
import { ToolGovernanceService } from "../tools/governance.ts";
import { renderOperatorConsole } from "./ui.ts";
import {
  validateChannelUpdateBody,
  validateDynamicToolBody,
  HttpError,
  parseJsonBody,
  validateSlackMessageBody,
  validateChatBody,
  validateMcpBody,
  validateScheduleBody,
  validateToolApprovalBody,
  validateWebhookBody
} from "./validation.ts";

export class HttpServer {
  private readonly server: Server;
  private readonly config: AppConfig;
  private readonly orchestration: OrchestrationService;
  private readonly scheduler: SchedulerService;
  private readonly sessions: SessionStore;
  private readonly runs: RunGraphStore;
  private readonly mcp: McpServer;
  private readonly database: AppDatabase;
  private readonly logger: Logger;
  private readonly metrics: MetricsStore;
  private readonly memory: MemoryStore;
  private readonly dynamicTools: DynamicToolRegistry;
  private readonly channels: ChannelRegistry;
  private readonly channelDeliveries: ChannelDeliveryStore;
  private readonly governance: ToolGovernanceService;
  private readonly slack: SlackChannel;

  constructor(
    config: AppConfig,
    orchestration: OrchestrationService,
    scheduler: SchedulerService,
    sessions: SessionStore,
    runs: RunGraphStore,
    mcp: McpServer,
    database: AppDatabase,
    logger: Logger,
    metrics: MetricsStore,
    memory: MemoryStore,
    dynamicTools: DynamicToolRegistry,
    channels: ChannelRegistry,
    governance: ToolGovernanceService,
    slackTransport?: SlackTransport
  ) {
    this.config = config;
    this.orchestration = orchestration;
    this.scheduler = scheduler;
    this.sessions = sessions;
    this.runs = runs;
    this.mcp = mcp;
    this.database = database;
    this.logger = logger;
    this.metrics = metrics;
    this.memory = memory;
    this.dynamicTools = dynamicTools;
    this.channels = channels;
    this.channelDeliveries = new ChannelDeliveryStore(database);
    this.governance = governance;
    this.slack = new SlackChannel(config, channels, this.channelDeliveries, slackTransport);
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async listen(): Promise<Server> {
    await new Promise<void>((resolve) => {
      this.server.listen(this.config.port, resolve);
    });
    return this.server;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const requestLogger = this.logger.child({
      requestId,
      path: url.pathname,
      method: req.method ?? "UNKNOWN"
    });

    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderOperatorConsole(this.config.agentName));
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        this.json(res, 200, {
          ok: true,
          agent: this.config.agentName,
          environment: this.config.appEnv,
          readiness: {
            database: this.database.isReady(),
            scheduler: this.scheduler.isRunning(),
            modelAdapter: modelAdapterMode(this.config),
            semanticRetrieval: this.memory.getStatus().semanticRetrievalEnabled,
            authConfigured:
              this.config.mcpBearerToken.length > 0 && this.config.externalChannelSecret.length > 0
          },
          logging: {
            provider: "pino",
            level: this.config.logLevel
          },
          memory: this.memory.getStatus(),
          channels: this.channels.summary(),
          channelDeliveries: this.channelDeliveries.summary(),
          governance: this.governance.summary(),
          metrics: this.metrics.snapshot()
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        this.json(res, 200, this.metrics.snapshot());
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/summary") {
        this.json(res, 200, {
          logging: { provider: "pino", level: this.config.logLevel },
          deployment: {
            appEnv: this.config.appEnv,
            qdrantEnabled: this.config.qdrantEnabled,
            qdrantUrl: this.config.qdrantUrl ?? null,
            databasePath: this.config.datastorePath
          },
          channelDeliveries: this.channelDeliveries.summary(),
          governance: this.governance.summary(),
          channels: this.channels.list()
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/channels") {
        this.json(res, 200, { channels: this.channels.list() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/channels") {
        const body = validateChannelUpdateBody(parseJsonBody(await readTextBody(req)));
        const channel = this.channels.upsert(body);
        this.json(res, 200, { requestId, channel });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/channels/deliveries") {
        const channelId = url.searchParams.get("channelId") ?? undefined;
        this.json(res, 200, { deliveries: this.channelDeliveries.list(channelId) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/tools/governance") {
        this.json(res, 200, { tools: this.governance.list(), summary: this.governance.summary() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/tools/approve") {
        const body = validateToolApprovalBody(parseJsonBody(await readTextBody(req)));
        const tool = this.governance.approve(body.toolId, body.approvedBy, body.notes);
        this.dynamicTools.activateApprovedTool(body.toolId);
        this.json(res, 200, { requestId, tool });
        return;
      }

      if (req.method === "GET" && url.pathname === "/memory") {
        const limit = url.searchParams.get("limit");
        const entries = await this.memory.listEntries(limit ? Number(limit) : 50);
        this.json(res, 200, { entries });
        return;
      }

      if (req.method === "POST" && url.pathname === "/chat/message") {
        const body = validateChatBody(parseJsonBody(await readTextBody(req)));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "Cache-Control": "no-cache",
          "X-Request-Id": requestId
        });
        const emit = (event: AgentRunEvent): void => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        try {
          const result = await this.orchestration.runCoordinator(
            {
              sessionId: body.sessionId,
              channelId: "web",
              conversationId: body.conversationId ?? "web-chat",
              message: body.message,
              subagents: body.subagents,
              timeoutMs: body.timeoutMs
            },
            emit
          );
          emit({ type: "final", runId: result.runId, outputText: result.outputText });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Chat run failed";
          emit({ type: "error", runId: "request_error", message, retryable: false });
        }
        res.end();
        return;
      }

      if (req.method === "POST" && url.pathname === "/channels/webhook") {
        const rawBody = await readTextBody(req);
        const request = toRequest(req, rawBody);
        if (!validateWebhookSecret(request, this.config.externalChannelSecret)) {
          throw new HttpError(401, "Unauthorized");
        }
        const body = validateWebhookBody(parseJsonBody(rawBody));
        const events: AgentRunEvent[] = [];
        const result = await this.orchestration.runCoordinator(
          {
            sessionId: body.sessionId,
            channelId: "webhook",
            conversationId: body.conversationId ?? "webhook",
            message: body.message,
            subagents: body.subagents,
            timeoutMs: body.timeoutMs
          },
          async (event) => {
            events.push(event);
          }
        );
        this.json(res, 200, { requestId, sessionId: result.sessionId, runId: result.runId, outputText: result.outputText, events });
        return;
      }

      if (req.method === "POST" && url.pathname === "/channels/slack/message") {
        const body = validateSlackMessageBody(parseJsonBody(await readTextBody(req)));
        const result = await this.slack.sendMessage(body);
        this.json(res, 200, { requestId, ...result });
        return;
      }

      if (req.method === "GET" && url.pathname === "/scheduler/jobs") {
        this.json(res, 200, { jobs: await this.scheduler.list() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/scheduler/jobs") {
        const body = validateScheduleBody(parseJsonBody(await readTextBody(req)));
        const job = await this.scheduler.schedule(body.name, body.message, {
          delayMs: body.delayMs,
          scheduledAt: body.scheduledAt,
          subagents: body.subagents,
          maxAttempts: body.maxAttempts
        });
        this.json(res, 200, { requestId, job });
        return;
      }

      if (req.method === "POST" && url.pathname === "/mcp") {
        const bodyText = await readTextBody(req);
        validateMcpBody(parseJsonBody(bodyText));
        const response = await this.mcp.handle(toRequest(req, bodyText));
        const text = await response.text();
        res.writeHead(response.status, { "Content-Type": "application/json", "X-Request-Id": requestId });
        res.end(text);
        return;
      }

      if (req.method === "GET" && url.pathname === "/tools/dynamic") {
        this.json(res, 200, { tools: this.dynamicTools.list() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/tools/dynamic") {
        const body = validateDynamicToolBody(parseJsonBody(await readTextBody(req)));
        const tool = this.dynamicTools.register(body);
        this.json(res, 200, { requestId, tool });
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/tools/dynamic/")) {
        const toolId = decodeURIComponent(url.pathname.replace("/tools/dynamic/", ""));
        if (!toolId) {
          throw new HttpError(400, "tool id is required");
        }
        const removed = this.dynamicTools.unregister(toolId);
        if (!removed) {
          throw new HttpError(404, "Dynamic tool not found");
        }
        this.json(res, 200, { requestId, removed: true, toolId });
        return;
      }

      if (req.method === "GET" && url.pathname === "/sessions") {
        this.json(res, 200, { sessions: await this.sessions.list() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/runs") {
        const runs = await this.runs.list();
        const withEvents = await Promise.all(
          runs.map(async (run) => ({
            ...run,
            events: await this.runs.listEvents(run.runId)
          }))
        );
        this.json(res, 200, { runs: withEvents });
        return;
      }

      throw new HttpError(404, "Not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Internal Server Error";
      requestLogger.error("request_failed", {
        status,
        error: message
      });
      this.json(res, status, {
        error: message,
        requestId,
        status
      });
    } finally {
      requestLogger.info("request_complete", {
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt
      });
      this.metrics.increment(`http.${req.method?.toLowerCase() ?? "unknown"}.${url.pathname}`);
      this.metrics.observe("http.request.duration_ms", Date.now() - startedAt);
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(`${JSON.stringify(body)}\n`);
  }
}

async function readTextBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toRequest(req: IncomingMessage, body?: string): Request {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  return new Request(url, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body
  });
}
