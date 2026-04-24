import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.ts";
import { modelAdapterMode } from "../config.ts";
import type { JsonValue } from "../shared/types.ts";
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
import { OperatorSettingsStore } from "./settings.ts";
import { RequestAuditStore } from "./request-audit.ts";
import { buildStartupDiagnostics } from "./diagnostics.ts";
import { buildOperatorExport } from "./export.ts";
import {
  validateChannelUpdateBody,
  validateDynamicToolBody,
  HttpError,
  parseJsonBody,
  validateOperatorSettingsBody,
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
  private readonly settings: OperatorSettingsStore;
  private readonly requestAudits: RequestAuditStore;

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
    this.settings = new OperatorSettingsStore(database);
    this.requestAudits = new RequestAuditStore(database);
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
        this.requireOperatorAuth(req);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderOperatorConsole(this.config.agentName));
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        const publicHealth = {
          ok: true,
          agent: this.config.agentName,
          environment: this.config.appEnv,
          readiness: {
            database: this.database.isReady(),
            scheduler: this.scheduler.isRunning(),
            modelAdapter: modelAdapterMode(this.config),
            semanticRetrieval: this.memory.getStatus().semanticRetrievalEnabled,
            authConfigured:
              this.config.operatorBearerToken.length > 0 &&
              this.config.mcpBearerToken.length > 0 && this.config.externalChannelSecret.length > 0
          }
        };
        if (!this.hasOperatorAuth(req)) {
          this.json(res, 200, publicHealth);
          return;
        }
        this.json(res, 200, {
          ...publicHealth,
          logging: {
            provider: "pino",
            level: this.config.logLevel
          },
          memory: this.memory.getStatus(),
          channels: this.channels.summary(),
          channelDeliveries: this.channelDeliveries.summary(),
          governance: this.governance.summary(),
          settings: this.settings.get(),
          metrics: this.metrics.snapshot()
        });
        return;
      }

      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        this.requireOperatorAuth(req);
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        this.requireOperatorAuth(req);
        this.json(res, 200, this.metrics.snapshot());
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/summary") {
        this.requireOperatorAuth(req);
        const channels = this.channels.list();
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
          settings: this.settings.get(),
          requestAudits: { recent: this.requestAudits.list(10).length },
          channels,
          diagnostics: buildStartupDiagnostics(this.config, this.memory.getStatus(), channels)
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/diagnostics") {
        this.requireOperatorAuth(req);
        const channels = this.channels.list();
        this.json(res, 200, {
          diagnostics: buildStartupDiagnostics(this.config, this.memory.getStatus(), channels)
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/export") {
        this.requireOperatorAuth(req);
        const scope = url.searchParams.get("scope") ?? "timeline";
        const format = url.searchParams.get("format") === "ndjson" ? "ndjson" : "json";
        const payload = this.buildExportPayload(scope);
        const exportPayload = buildOperatorExport(format, {
          scope,
          items: payload.items
        });
        if (exportPayload.format === "ndjson") {
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
          res.end(exportPayload.body);
          return;
        }
        this.json(res, 200, exportPayload);
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/timeline") {
        this.requireOperatorAuth(req);
        const settings = this.settings.get();
        const runs = await this.runs.list();
        const runsWithCounts = await Promise.all(
          runs.slice(0, settings.memoryTimelineLimit).map(async (run) => ({
            ...run,
            eventCount: (await this.runs.listEvents(run.runId)).length
          }))
        );
        this.json(res, 200, {
          sessions: (await this.sessions.list()).slice(0, settings.memoryTimelineLimit),
          runs: runsWithCounts,
          jobs: (await this.scheduler.list()).slice(0, settings.memoryTimelineLimit),
          memory: (await this.memory.listEntries(settings.memoryTimelineLimit)),
          governanceAudit: this.governance.listAudit(settings.memoryTimelineLimit)
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/channels") {
        this.requireOperatorAuth(req);
        this.json(res, 200, { channels: this.channels.list() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/channels") {
        this.requireOperatorAuth(req);
        const body = validateChannelUpdateBody(parseJsonBody(await readTextBody(req)));
        const channel = this.channels.upsert(body);
        this.json(res, 200, { requestId, channel });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/channels/deliveries") {
        this.requireOperatorAuth(req);
        const channelId = url.searchParams.get("channelId") ?? undefined;
        this.json(res, 200, { deliveries: this.channelDeliveries.list(channelId) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/tools/governance") {
        this.requireOperatorAuth(req);
        this.json(res, 200, { tools: this.governance.list(), summary: this.governance.summary() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/settings") {
        this.requireOperatorAuth(req);
        this.json(res, 200, { settings: this.settings.get() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/settings") {
        this.requireOperatorAuth(req);
        const body = validateOperatorSettingsBody(parseJsonBody(await readTextBody(req)));
        const settings = this.settings.update(body);
        this.json(res, 200, { requestId, settings });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/tools/approve") {
        this.requireOperatorAuth(req);
        const body = validateToolApprovalBody(parseJsonBody(await readTextBody(req)));
        const tool = this.governance.approve(body.toolId, body.approvedBy, body.notes);
        this.dynamicTools.activateApprovedTool(body.toolId);
        this.json(res, 200, { requestId, tool });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/admin/sessions/")) {
        this.requireOperatorAuth(req);
        const sessionId = decodeURIComponent(url.pathname.replace("/admin/sessions/", ""));
        const session = await this.sessions.get(sessionId);
        if (!session) {
          throw new HttpError(404, "Session not found");
        }
        this.json(res, 200, { session });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/admin/runs/")) {
        this.requireOperatorAuth(req);
        const runId = decodeURIComponent(url.pathname.replace("/admin/runs/", ""));
        const run = await this.runs.get(runId);
        if (!run) {
          throw new HttpError(404, "Run not found");
        }
        this.json(res, 200, {
          run,
          events: await this.runs.listEvents(runId),
          children: await this.runs.listChildren(runId)
        });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/admin/jobs/")) {
        this.requireOperatorAuth(req);
        const jobId = decodeURIComponent(url.pathname.replace("/admin/jobs/", ""));
        const job = (await this.scheduler.list()).find((entry) => entry.id === jobId);
        if (!job) {
          throw new HttpError(404, "Job not found");
        }
        this.json(res, 200, { job });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/admin/memory/")) {
        this.requireOperatorAuth(req);
        const memoryId = decodeURIComponent(url.pathname.replace("/admin/memory/", ""));
        const entry = await this.memory.getEntry(memoryId);
        if (!entry) {
          throw new HttpError(404, "Memory entry not found");
        }
        this.json(res, 200, { entry });
        return;
      }

      if (req.method === "GET" && url.pathname === "/memory") {
        this.requireOperatorAuth(req);
        const limit = url.searchParams.get("limit");
        const entries = await this.memory.listEntries(limit ? Number(limit) : 50);
        this.json(res, 200, { entries });
        return;
      }

      if (req.method === "POST" && url.pathname === "/chat/message") {
        this.requireOperatorAuth(req);
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
        this.requireOperatorAuth(req);
        const body = validateSlackMessageBody(parseJsonBody(await readTextBody(req)));
        const result = await this.slack.sendMessage(body);
        this.json(res, 200, { requestId, ...result });
        return;
      }

      if (req.method === "GET" && url.pathname === "/scheduler/jobs") {
        this.requireOperatorAuth(req);
        this.json(res, 200, { jobs: await this.scheduler.list() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/scheduler/jobs") {
        this.requireOperatorAuth(req);
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
        this.requireOperatorAuth(req);
        this.json(res, 200, { tools: this.dynamicTools.list() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/tools/dynamic") {
        this.requireOperatorAuth(req);
        const body = validateDynamicToolBody(parseJsonBody(await readTextBody(req)));
        const tool = this.dynamicTools.register(body);
        this.json(res, 200, { requestId, tool });
        return;
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/tools/dynamic/")) {
        this.requireOperatorAuth(req);
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
        this.requireOperatorAuth(req);
        this.json(res, 200, { sessions: await this.sessions.list() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/runs") {
        this.requireOperatorAuth(req);
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
      if (error instanceof OperatorAuthError) {
        res.setHeader("WWW-Authenticate", "Basic realm=\"codex-phantom operator\"");
      }
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
      this.requestAudits.record({
        requestId,
        method: req.method ?? "UNKNOWN",
        path: url.pathname,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt
      });
      this.metrics.increment(`http.${req.method?.toLowerCase() ?? "unknown"}.${url.pathname}`);
      this.metrics.observe("http.request.duration_ms", Date.now() - startedAt);
    }
  }

  private buildExportPayload(scope: string): { items: Array<Record<string, JsonValue>> } {
    switch (scope) {
      case "requests":
        return { items: this.requestAudits.list(250) };
      case "channels":
        return { items: this.channelDeliveries.list(undefined, 250) };
      case "governance":
        return { items: this.governance.listAudit(250) };
      case "runs":
        return { items: this.database.all("SELECT * FROM run_events ORDER BY created_at DESC LIMIT 250") };
      case "timeline":
      default:
        return {
          items: [
            ...this.requestAudits.list(50),
            ...this.channelDeliveries.list(undefined, 50),
            ...this.governance.listAudit(50)
          ]
        };
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(`${JSON.stringify(body)}\n`);
  }

  private requireOperatorAuth(req: IncomingMessage): void {
    if (!this.hasOperatorAuth(req)) {
      throw new OperatorAuthError();
    }
  }

  private hasOperatorAuth(req: IncomingMessage): boolean {
    const authorization = req.headers.authorization;
    if (authorization === `Bearer ${this.config.operatorBearerToken}`) {
      return true;
    }
    if (authorization?.startsWith("Basic ")) {
      const credentials = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
      const [, password] = credentials.split(":", 2);
      if (password === this.config.operatorBearerToken) {
        return true;
      }
    }
    return req.headers["x-operator-token"] === this.config.operatorBearerToken;
  }
}

class OperatorAuthError extends HttpError {
  constructor() {
    super(401, "Unauthorized");
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
