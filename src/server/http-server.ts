import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import type { AppConfig } from "../config.ts";
import { modelAdapterMode } from "../config.ts";
import type { JsonValue } from "../shared/types.ts";
import { validateWebhookSecret } from "../channels/webhook.ts";
import { RuntimeChannelCapabilities } from "../channels/capabilities.ts";
import { ChannelRegistry } from "../channels/registry.ts";
import { ChannelDeliveryStore } from "../channels/delivery-log.ts";
import type { ChannelDeliveryRecord } from "../channels/delivery-log.ts";
import {
  InboundChannelEventStore,
  InboundChannelRouter,
} from "../channels/inbound.ts";
import {
  SlackFeedbackStore,
  mapSlackInteractionFeedback,
  mapSlackReactionFeedback,
} from "../channels/slack-feedback.ts";
import {
  mapSlackEventToInboundMessage,
  validateSlackRequest,
  type SlackEventsPayload,
} from "../channels/slack-events.ts";
import {
  InboundResponseDispatcher,
  createSlackInboundResponseAdapter,
} from "../channels/inbound-response-dispatcher.ts";
import type { SlackTransport } from "../channels/slack.ts";
import { SlackChannel } from "../channels/slack.ts";
import { OrchestrationService } from "../orchestration/service.ts";
import { SchedulerService } from "../scheduler/service.ts";
import { SessionStore } from "../chat/session-store.ts";
import { ChatBlobStore } from "../chat/blob-store.ts";
import { ChatArtifactStore } from "../chat/artifact-store.ts";
import { AttachmentTextIndexStore } from "../chat/attachment-text-index.ts";
import { ChatArtifactService } from "../chat/artifacts.ts";
import { safeDownloadName } from "../chat/content-policy.ts";
import {
  extractArtifactDraftsFromEvent,
  extractArtifactDraftsFromOutputText,
  MAX_EXTRACTED_ARTIFACTS_PER_RUN,
  type ExtractedArtifactDraft,
} from "../chat/artifact-extraction.ts";
import { ChatWireEventBuilder, formatSseEvent } from "../chat/wire-events.ts";
import { McpServer } from "../mcp/server.ts";
import { McpAuditStore } from "../mcp/audit.ts";
import type { AgentRunEvent } from "../agent/types.ts";
import { RunGraphStore } from "../orchestration/run-graph-store.ts";
import { AppDatabase } from "../platform/database.ts";
import { Logger } from "../platform/logger.ts";
import { MetricsStore } from "../platform/metrics.ts";
import { MemoryStore } from "../memory/store.ts";
import type { MemoryMaintenanceService } from "../memory/maintenance.ts";
import { DynamicToolRegistry } from "../tools/dynamic-registry.ts";
import { ToolGovernanceService } from "../tools/governance.ts";
import { ToolBundleImportStore } from "../tools/bundles.ts";
import { SelfEvolutionProposalStore } from "../self-evolution/proposals.ts";
import {
  SelfEvolutionMutationError,
  SelfEvolutionMutationService,
  createOperatorSettingsMutationAdapter,
} from "../self-evolution/mutations.ts";
import {
  AssignmentNotFoundError,
  AssignmentValidationError,
  AutonomousAssignmentService,
} from "../assignments/service.ts";
import type {
  AssignmentAutonomyLevel,
  AssignmentLifecycleState,
} from "../assignments/types.ts";
import {
  ASSIGNMENT_AUTONOMY_LEVELS,
  ASSIGNMENT_LIFECYCLE_STATES,
} from "../assignments/types.ts";
import { renderOperatorConsole } from "./ui.ts";
import { renderChatApp } from "./chat-ui.ts";
import { OperatorSettingsStore } from "./settings.ts";
import { RequestAuditStore } from "./request-audit.ts";
import { buildStartupDiagnostics } from "./diagnostics.ts";
import { buildSetupReadiness } from "./readiness.ts";
import { OperatorExportService, buildOperatorExport } from "./export.ts";
import {
  validateChannelUpdateBody,
  validateDynamicToolBody,
  HttpError,
  parseJsonBody,
  validateAssignmentControlBody,
  validateAssignmentCreateBody,
  validateOperatorSettingsBody,
  validateSlackMessageBody,
  validateChatArtifactBody,
  validateChatBody,
  validateMcpBody,
  validateScheduleBody,
  validateSelfEvolutionApplyBody,
  validateSelfEvolutionProposalBody,
  validateSelfEvolutionReviewBody,
  validateSelfEvolutionRollbackBody,
  validateToolApprovalBody,
  validateToolBundleLifecycleBody,
  validateToolBundlePreviewBody,
  validateWebhookBody,
} from "./validation.ts";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

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
  private readonly memoryMaintenance?: MemoryMaintenanceService;
  private readonly dynamicTools: DynamicToolRegistry;
  private readonly toolBundles: ToolBundleImportStore;
  private readonly channels: ChannelRegistry;
  private readonly channelDeliveries: ChannelDeliveryStore;
  private readonly channelInbound: InboundChannelEventStore;
  private readonly slackFeedback: SlackFeedbackStore;
  private readonly inboundRouter: InboundChannelRouter;
  private readonly inboundResponses: InboundResponseDispatcher;
  private readonly assignments: AutonomousAssignmentService;
  private readonly chatArtifacts: ChatArtifactService;
  private readonly governance: ToolGovernanceService;
  private readonly selfEvolution: SelfEvolutionProposalStore;
  private readonly selfEvolutionMutations: SelfEvolutionMutationService;
  private readonly slack: SlackChannel;
  private readonly settings: OperatorSettingsStore;
  private readonly requestAudits: RequestAuditStore;
  private readonly mcpAudit: McpAuditStore;
  private readonly operatorExports: OperatorExportService;
  private readonly runtimeChannels: RuntimeChannelCapabilities;
  private readonly operatorTokenHash: Buffer;
  private readonly mcpTokenHash: Buffer;
  private readonly mcpRateLimiter = new SimpleRateLimiter(12, 60_000);

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
    slackTransport?: SlackTransport,
    memoryMaintenance?: MemoryMaintenanceService,
    runtimeChannels = new RuntimeChannelCapabilities(),
    assignments?: AutonomousAssignmentService
  ) {
    if (!assignments) {
      throw new Error("AutonomousAssignmentService is required");
    }
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
    this.memoryMaintenance = memoryMaintenance;
    this.dynamicTools = dynamicTools;
    this.toolBundles = new ToolBundleImportStore(database);
    this.channels = channels;
    this.channelDeliveries = new ChannelDeliveryStore(database);
    this.channelInbound = new InboundChannelEventStore(database);
    this.slackFeedback = new SlackFeedbackStore(database);
    this.inboundRouter = new InboundChannelRouter(
      channels,
      this.channelInbound,
      orchestration
    );
    this.chatArtifacts = new ChatArtifactService({
      sessions,
      runs,
      blobs: new ChatBlobStore(config.dataDir),
      artifacts: new ChatArtifactStore(database),
      attachmentTextIndexes: new AttachmentTextIndexStore(database),
    });
    this.governance = governance;
    this.selfEvolution = new SelfEvolutionProposalStore(database);
    this.settings = new OperatorSettingsStore(database);
    this.selfEvolutionMutations = new SelfEvolutionMutationService({
      proposals: this.selfEvolution,
      adapters: [createOperatorSettingsMutationAdapter(this.settings)],
    });
    this.slack = new SlackChannel(
      config,
      channels,
      this.channelDeliveries,
      slackTransport
    );
    this.inboundResponses = new InboundResponseDispatcher({
      logger,
      adapters: {
        slack_thread: createSlackInboundResponseAdapter({
          slack: this.slack,
          store: this.channelInbound,
          logger,
        }),
      },
    });
    this.requestAudits = new RequestAuditStore(database);
    this.mcpAudit = new McpAuditStore(database);
    this.operatorExports = new OperatorExportService({
      requestAudits: this.requestAudits,
      channelDeliveries: this.channelDeliveries,
      channelInbound: this.channelInbound,
      slackFeedback: this.slackFeedback,
      governance: this.governance,
      selfEvolution: this.selfEvolution,
      toolBundles: this.toolBundles,
      mcpAudit: this.mcpAudit,
      runEvents: this.database,
      chatArtifacts: this.chatArtifacts,
      memoryMaintenance: this.memoryMaintenance,
    });
    this.runtimeChannels = runtimeChannels;
    this.assignments = assignments;
    this.operatorTokenHash = hashToken(config.operatorBearerToken);
    this.mcpTokenHash = hashToken(config.mcpBearerToken);
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

  private async handle(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );
    const requestLogger = this.logger.child({
      requestId,
      path: url.pathname,
      method: req.method ?? "UNKNOWN",
    });

    try {
      if (req.method === "GET" && url.pathname === "/") {
        this.requireOperatorAuth(req);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderOperatorConsole(this.config.agentName));
        return;
      }

      if (req.method === "GET" && url.pathname === "/chat") {
        this.requireOperatorAuth(req);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderChatApp(this.config.agentName));
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        const memoryStatus = this.memory.getStatus();
        const channels = this.channels.list();
        const setupReadiness = buildSetupReadiness({
          config: this.config,
          memory: memoryStatus,
          channels,
          databaseReady: this.database.isReady(),
        });
        const publicHealth = {
          ok: true,
          agent: this.config.agentName,
          environment: this.config.appEnv,
          readiness: {
            database: this.database.isReady(),
            scheduler: this.scheduler.isRunning(),
            modelAdapter: modelAdapterMode(this.config),
            semanticRetrieval: memoryStatus.semanticRetrievalEnabled,
            authConfigured:
              this.config.operatorBearerToken.length > 0 &&
              this.config.mcpBearerToken.length > 0 &&
              this.config.externalChannelSecret.length > 0,
            setupReady: setupReadiness.ok,
          },
        };
        if (!this.hasOperatorAuth(req)) {
          this.json(res, 200, publicHealth);
          return;
        }
        this.json(res, 200, {
          ...publicHealth,
          logging: {
            provider: "pino",
            level: this.config.logLevel,
          },
          memory: memoryStatus,
          setupReadiness,
          channels: this.channels.summary(),
          channelDeliveries: this.channelDeliveries.summary(),
          channelInbound: this.channelInbound.summary(),
          channelFeedback: this.slackFeedback.summary(),
          governance: this.governance.summary(),
          toolBundles: this.toolBundles.summary(),
          selfEvolution: this.selfEvolution.summary(),
          settings: this.settings.get(),
          metrics: this.metrics.snapshot(),
        });
        return;
      }

      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        this.requireOperatorAuth(req);
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        this.requireOperatorAuth(req);
        if (url.searchParams.get("format") === "prometheus") {
          res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
          res.end(this.metrics.toPrometheus());
          return;
        }
        this.json(res, 200, this.metrics.snapshot());
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/summary") {
        this.requireOperatorAuth(req);
        const channels = this.channels.list();
        const memoryStatus = this.memory.getStatus();
        const setupReadiness = buildSetupReadiness({
          config: this.config,
          memory: memoryStatus,
          channels,
          databaseReady: this.database.isReady(),
        });
        this.json(res, 200, {
          logging: { provider: "pino", level: this.config.logLevel },
          deployment: {
            appEnv: this.config.appEnv,
            qdrantEnabled: this.config.qdrantEnabled,
            qdrantUrl: this.config.qdrantUrl ?? null,
            databasePath: this.config.datastorePath,
          },
          channelDeliveries: this.channelDeliveries.summary(),
          channelInbound: this.channelInbound.summary(),
          channelFeedback: this.slackFeedback.summary(),
          governance: this.governance.summary(),
          toolBundles: this.toolBundles.summary(),
          selfEvolution: this.selfEvolution.summary(),
          settings: this.settings.get(),
          setupReadiness,
          rolePolicy: this.orchestration.getRolePolicyStatus(),
          requestAudits: { recent: this.requestAudits.list(10).length },
          channels,
          diagnostics: this.buildDiagnostics(
            memoryStatus,
            channels,
            setupReadiness
          ),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/readiness") {
        this.requireOperatorAuth(req);
        const channels = this.channels.list();
        const memoryStatus = this.memory.getStatus();
        const setupReadiness = buildSetupReadiness({
          config: this.config,
          memory: memoryStatus,
          channels,
          databaseReady: this.database.isReady(),
        });
        this.json(res, setupReadiness.ok ? 200 : 503, {
          requestId,
          readiness: setupReadiness,
          diagnostics: this.buildDiagnostics(
            memoryStatus,
            channels,
            setupReadiness
          ),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/diagnostics") {
        this.requireOperatorAuth(req);
        const channels = this.channels.list();
        const memoryStatus = this.memory.getStatus();
        const setupReadiness = buildSetupReadiness({
          config: this.config,
          memory: memoryStatus,
          channels,
          databaseReady: this.database.isReady(),
        });
        this.json(res, 200, {
          diagnostics: this.buildDiagnostics(
            memoryStatus,
            channels,
            setupReadiness
          ),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/mcp/audit") {
        this.requireOperatorAuth(req);
        const limit = url.searchParams.get("limit");
        this.json(res, 200, {
          audit: this.mcpAudit.list(limit ? Number(limit) : 50),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/export") {
        this.requireOperatorAuth(req);
        const scope = url.searchParams.get("scope") ?? "timeline";
        const format =
          url.searchParams.get("format") === "ndjson" ? "ndjson" : "json";
        const payload = await this.operatorExports.collect(scope);
        const exportPayload = buildOperatorExport(format, {
          scope,
          items: payload.items,
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
            eventCount: (await this.runs.listEvents(run.runId)).length,
          }))
        );
        this.json(res, 200, {
          sessions: (await this.sessions.list()).slice(
            0,
            settings.memoryTimelineLimit
          ),
          runs: runsWithCounts,
          jobs: (await this.scheduler.list()).slice(
            0,
            settings.memoryTimelineLimit
          ),
          memory: await this.memory.listEntries(settings.memoryTimelineLimit),
          memoryMaintenance:
            this.memoryMaintenance?.list(settings.memoryTimelineLimit) ?? [],
          channelInbound: this.channelInbound.list({
            limit: settings.memoryTimelineLimit,
          }),
          governanceAudit: this.governance.listAudit(
            settings.memoryTimelineLimit
          ),
          selfEvolutionProposals: this.selfEvolution.list(
            settings.memoryTimelineLimit
          ),
          selfEvolutionMutations: this.selfEvolution.listMutations(
            undefined,
            settings.memoryTimelineLimit
          ),
          toolBundleImports: this.toolBundles.list(
            settings.memoryTimelineLimit
          ),
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
        const body = validateChannelUpdateBody(
          parseJsonBody(await readTextBody(req))
        );
        const channel = this.channels.upsert(body);
        await this.runtimeChannels.applyRuntimeState(
          channel.id,
          channel.enabled
        );
        this.json(res, 200, { requestId, channel });
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname === "/admin/channels/deliveries"
      ) {
        this.requireOperatorAuth(req);
        const channelId = url.searchParams.get("channelId") ?? undefined;
        this.json(res, 200, {
          deliveries: this.channelDeliveries.list(channelId),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/channels/inbound") {
        this.requireOperatorAuth(req);
        const channelId = url.searchParams.get("channelId") ?? undefined;
        const limit = url.searchParams.get("limit");
        this.json(res, 200, {
          events: this.channelInbound.list({
            channelId,
            limit: limit ? Number(limit) : undefined,
          }),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/channels/feedback") {
        this.requireOperatorAuth(req);
        const limit = url.searchParams.get("limit");
        this.json(res, 200, {
          feedback: this.slackFeedback.list(limit ? Number(limit) : 50),
          summary: this.slackFeedback.summary(),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/tools/governance") {
        this.requireOperatorAuth(req);
        this.json(res, 200, {
          tools: this.governance.list(),
          bundleImports: this.toolBundles.list(50),
          summary: this.governance.summary(),
          bundleSummary: this.toolBundles.summary(),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/tools/bundles") {
        this.requireOperatorAuth(req);
        const limit = url.searchParams.get("limit");
        this.json(res, 200, {
          imports: this.toolBundles.list(limit ? Number(limit) : 50),
          audit: this.toolBundles.listAudit(
            undefined,
            limit ? Number(limit) : 50
          ),
          summary: this.toolBundles.summary(),
        });
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/admin/tools/bundles/preview"
      ) {
        this.requireOperatorAuth(req);
        const body = validateToolBundlePreviewBody(
          parseJsonBody(await readTextBody(req))
        );
        const preview = this.toolBundles.preview({
          manifest: body.manifest,
          importedBy: body.importedBy ?? "operator",
        });
        this.json(res, preview.status === "valid" ? 200 : 400, {
          requestId,
          preview,
        });
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/admin/tools/bundles/")
      ) {
        this.requireOperatorAuth(req);
        const { importId, action } = parseToolBundleActionPath(url.pathname);
        const body = validateToolBundleLifecycleBody(
          parseJsonBody(await readTextBody(req))
        );
        if (action === "approve") {
          const bundle = this.toolBundles.approve(
            importId,
            body.actor,
            body.notes
          );
          this.json(res, 200, { requestId, bundle });
          return;
        }
        if (action === "enable") {
          const bundle = this.enableToolBundle(
            importId,
            body.actor,
            body.notes
          );
          this.json(res, 200, { requestId, bundle });
          return;
        }
        if (action === "disable") {
          const bundle = this.disableToolBundle(
            importId,
            body.actor,
            body.notes
          );
          this.json(res, 200, { requestId, bundle });
          return;
        }
        if (action === "uninstall") {
          const bundle = this.uninstallToolBundle(
            importId,
            body.actor,
            body.notes
          );
          this.json(res, 200, { requestId, bundle });
          return;
        }
        throw new HttpError(404, "Not found");
      }

      if (req.method === "POST" && url.pathname === "/admin/assignments") {
        this.requireOperatorAuth(req);
        const body = validateAssignmentCreateBody(
          parseJsonBody(await readTextBody(req))
        );
        const assignment = this.assignments.create({
          ...body,
          createdBy: body.createdBy ?? "operator",
        });
        this.json(res, 201, { requestId, ...assignment });
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/assignments") {
        this.requireOperatorAuth(req);
        this.json(res, 200, {
          assignments: this.assignments.list({
            lifecycleState: parseAssignmentLifecycleQuery(
              url.searchParams.get("lifecycleState") ??
                url.searchParams.get("state")
            ),
            autonomyLevel: parseAssignmentAutonomyQuery(
              url.searchParams.get("autonomyLevel")
            ),
            parentAssignmentId:
              url.searchParams.get("parentAssignmentId") ?? undefined,
            sourceChannelId:
              url.searchParams.get("sourceChannelId") ?? undefined,
            limit: parseOptionalPositiveIntegerQuery(
              url.searchParams.get("limit"),
              "limit"
            ),
          }),
        });
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname.startsWith("/admin/assignments/") &&
        trimTrailingSlash(url.pathname).endsWith("/timeline")
      ) {
        this.requireOperatorAuth(req);
        const assignmentId = decodeURIComponent(
          url.pathname
            .replace("/admin/assignments/", "")
            .replace("/timeline", "")
            .replace(/\/$/, "")
        );
        const timeline = this.assignments.timeline(
          assignmentId,
          parseOptionalPositiveIntegerQuery(
            url.searchParams.get("limit"),
            "limit"
          )
        );
        this.json(res, 200, { timeline });
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/admin/assignments/") &&
        trimTrailingSlash(url.pathname).endsWith("/control")
      ) {
        this.requireOperatorAuth(req);
        const assignmentId = decodeURIComponent(
          url.pathname
            .replace("/admin/assignments/", "")
            .replace("/control", "")
            .replace(/\/$/, "")
        );
        const body = validateAssignmentControlBody(
          parseJsonBody(await readTextBody(req))
        );
        const assignment = this.assignments.control(assignmentId, body);
        this.json(res, 200, { requestId, ...assignment });
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname.startsWith("/admin/assignments/")
      ) {
        this.requireOperatorAuth(req);
        const assignmentId = decodeURIComponent(
          url.pathname.replace("/admin/assignments/", "").replace(/\/$/, "")
        );
        const assignment = this.assignments.get(assignmentId);
        if (!assignment) {
          throw new HttpError(404, "Assignment not found");
        }
        this.json(res, 200, assignment);
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname === "/admin/self-evolution/proposals"
      ) {
        this.requireOperatorAuth(req);
        const limit = url.searchParams.get("limit");
        this.json(res, 200, {
          proposals: this.selfEvolution.list(limit ? Number(limit) : 50),
          mutations: this.selfEvolution.listMutations(
            undefined,
            limit ? Number(limit) : 50
          ),
          summary: this.selfEvolution.summary(),
        });
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/admin/self-evolution/proposals"
      ) {
        this.requireOperatorAuth(req);
        const body = validateSelfEvolutionProposalBody(
          parseJsonBody(await readTextBody(req))
        );
        const proposal = this.selfEvolution.create({
          ...body,
          proposedBy: body.proposedBy ?? "operator",
        });
        this.json(res, 201, { requestId, proposal });
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/admin/self-evolution/proposals/")
      ) {
        this.requireOperatorAuth(req);
        const { proposalId, action } = parseSelfEvolutionActionPath(
          url.pathname
        );
        if (action === "approve") {
          const body = validateSelfEvolutionReviewBody(
            parseJsonBody(await readTextBody(req))
          );
          const proposal = this.selfEvolution.approve(proposalId, body);
          this.json(res, 200, { requestId, proposal });
          return;
        }
        if (action === "reject") {
          const body = validateSelfEvolutionReviewBody(
            parseJsonBody(await readTextBody(req))
          );
          const proposal = this.selfEvolution.reject(proposalId, body);
          this.json(res, 200, { requestId, proposal });
          return;
        }
        if (action === "apply") {
          const body = validateSelfEvolutionApplyBody(
            parseJsonBody(await readTextBody(req))
          );
          const { proposal, mutation } =
            this.selfEvolutionMutations.applyProposal(proposalId, body);
          this.json(res, 200, { requestId, proposal, mutation });
          return;
        }
        if (action === "rollback") {
          const body = validateSelfEvolutionRollbackBody(
            parseJsonBody(await readTextBody(req))
          );
          const { proposal, mutation } =
            this.selfEvolutionMutations.rollbackProposal(
              proposalId,
              body.rolledBackBy
            );
          this.json(res, 200, { requestId, proposal, mutation });
          return;
        }
        throw new HttpError(404, "Not found");
      }

      if (req.method === "GET" && url.pathname === "/admin/settings") {
        this.requireOperatorAuth(req);
        this.json(res, 200, { settings: this.settings.get() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/settings") {
        this.requireOperatorAuth(req);
        const body = validateOperatorSettingsBody(
          parseJsonBody(await readTextBody(req))
        );
        const settings = this.settings.update(body);
        this.json(res, 200, { requestId, settings });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/tools/approve") {
        this.requireOperatorAuth(req);
        const body = validateToolApprovalBody(
          parseJsonBody(await readTextBody(req))
        );
        const tool = this.governance.approve(
          body.toolId,
          body.approvedBy,
          body.notes
        );
        this.dynamicTools.activateApprovedTool(body.toolId);
        this.json(res, 200, { requestId, tool });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/admin/sessions/")) {
        this.requireOperatorAuth(req);
        const sessionId = decodeURIComponent(
          url.pathname.replace("/admin/sessions/", "")
        );
        const session = await this.sessions.get(sessionId);
        if (!session) {
          throw new HttpError(404, "Session not found");
        }
        this.json(res, 200, { session });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/admin/runs/")) {
        this.requireOperatorAuth(req);
        const runId = decodeURIComponent(
          url.pathname.replace("/admin/runs/", "")
        );
        const run = await this.runs.get(runId);
        if (!run) {
          throw new HttpError(404, "Run not found");
        }
        this.json(res, 200, {
          run,
          events: await this.runs.listEvents(runId),
          children: await this.runs.listChildren(runId),
        });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/admin/jobs/")) {
        this.requireOperatorAuth(req);
        const jobId = decodeURIComponent(
          url.pathname.replace("/admin/jobs/", "")
        );
        const job = (await this.scheduler.list()).find(
          (entry) => entry.id === jobId
        );
        if (!job) {
          throw new HttpError(404, "Job not found");
        }
        this.json(res, 200, { job });
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname === "/admin/memory/maintenance"
      ) {
        this.requireOperatorAuth(req);
        const limit = url.searchParams.get("limit");
        this.json(res, 200, {
          maintenance:
            this.memoryMaintenance?.list(limit ? Number(limit) : 20) ?? [],
        });
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/admin/memory/maintenance/run"
      ) {
        this.requireOperatorAuth(req);
        if (!this.memoryMaintenance) {
          throw new HttpError(409, "Memory maintenance is not configured");
        }
        const maintenance = await this.memoryMaintenance.runNow();
        this.json(res, 202, { requestId, maintenance });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/admin/memory/")) {
        this.requireOperatorAuth(req);
        const memoryId = decodeURIComponent(
          url.pathname.replace("/admin/memory/", "")
        );
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
        const entries = await this.memory.listEntries(
          limit ? Number(limit) : 50
        );
        this.json(res, 200, { entries });
        return;
      }

      if (req.method === "GET" && url.pathname === "/chat/sessions") {
        this.requireOperatorAuth(req);
        const sessions = (await this.sessions.list()).filter(
          (session) => session.channelId === "web"
        );
        this.json(res, 200, { sessions });
        return;
      }

      if (req.method === "POST" && url.pathname === "/chat/attachments") {
        this.requireOperatorAuth(req);
        const contentType = req.headers["content-type"];
        const boundary = parseMultipartBoundary(
          typeof contentType === "string" ? contentType : ""
        );
        const body = await readBufferBody(req, 25_000_000);
        const multipart = parseMultipartBody(body, boundary);
        const sessionId = requiredMultipartField(multipart, "sessionId");
        const runId = optionalMultipartField(multipart, "runId");
        const session = await this.requireWebChatSession(sessionId);
        if (runId) {
          await this.requireSessionRun(session, runId);
        }
        const files = multipart.files.filter(
          (file) => file.fieldName === "file"
        );
        const attachments = await this.chatArtifacts.uploadAttachments({
          sessionId: session.sessionId,
          runId,
          files,
        });
        this.json(res, 201, {
          requestId,
          attachments,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/chat/attachments/search") {
        this.requireOperatorAuth(req);
        const query = (url.searchParams.get("q") ?? "").trim();
        if (!query) {
          throw new HttpError(400, "q is required");
        }
        const limit = url.searchParams.get("limit");
        const matches = this.chatArtifacts.searchAttachmentText({
          query,
          limit: limit ? Number.parseInt(limit, 10) : 25,
        });
        this.json(res, 200, {
          requestId,
          query,
          matches,
        });
        return;
      }

      if (
        req.method === "GET" &&
        url.pathname.startsWith("/chat/attachments/")
      ) {
        this.requireOperatorAuth(req);
        const attachmentId = decodeURIComponent(
          url.pathname.replace("/chat/attachments/", "")
        );
        const download =
          await this.chatArtifacts.getAttachmentDownload(attachmentId);
        res.writeHead(200, {
          "Content-Type": download.contentType,
          "Content-Length": download.content.byteLength,
          "Content-Disposition": `attachment; filename="${download.fileName}"`,
        });
        res.end(download.content);
        return;
      }

      if (req.method === "POST" && url.pathname === "/chat/artifacts") {
        this.requireOperatorAuth(req);
        const body = validateChatArtifactBody(
          parseJsonBody(await readTextBody(req))
        );
        const session = await this.requireWebChatSession(body.sessionId);
        if (body.runId) {
          await this.requireSessionRun(session, body.runId);
        }
        const artifact = await this.chatArtifacts.createArtifact({
          sessionId: session.sessionId,
          runId: body.runId,
          title: body.title,
          kind: body.kind,
          contentType: body.contentType,
          content: body.content,
          metadata: body.metadata ?? null,
        });
        this.json(res, 201, {
          requestId,
          artifact,
        });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/chat/artifacts/")) {
        this.requireOperatorAuth(req);
        const artifactId = decodeURIComponent(
          url.pathname.replace("/chat/artifacts/", "")
        );
        const download =
          await this.chatArtifacts.getArtifactDownload(artifactId);
        res.writeHead(200, {
          "Content-Type": download.contentType,
          "Content-Length": download.content.byteLength,
          "Content-Disposition": `attachment; filename="${download.fileName}"`,
        });
        res.end(download.content);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/chat/sessions/")) {
        this.requireOperatorAuth(req);
        const sessionId = decodeURIComponent(
          url.pathname.replace("/chat/sessions/", "")
        );
        const session = await this.requireWebChatSession(sessionId);
        const persistedRunIds = session.runIds.filter(
          (runId) => runId.startsWith("coord_") || runId.startsWith("sub_")
        );
        const runs = (
          await Promise.all(
            persistedRunIds.map((runId) => this.runs.get(runId))
          )
        ).filter((run) => run !== null);
        const artifactState = await this.chatArtifacts.listSessionArtifactState(
          session.sessionId
        );
        this.json(res, 200, {
          session,
          runs,
          ...artifactState,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/chat/message") {
        this.requireOperatorAuth(req);
        const body = validateChatBody(parseJsonBody(await readTextBody(req)));
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "Cache-Control": "no-cache",
          "X-Request-Id": requestId,
        });
        const wire = new ChatWireEventBuilder(requestId);
        const emitWire = (
          type: Parameters<ChatWireEventBuilder["build"]>[0],
          payload: JsonValue,
          options: Parameters<ChatWireEventBuilder["build"]>[2] = {}
        ): void => {
          res.write(formatSseEvent(wire.build(type, payload, options)));
        };
        emitWire("request.started", {
          conversationId: body.conversationId ?? "web-chat",
          attachmentCount: body.attachments?.length ?? 0,
        });
        const extractedArtifacts: ExtractedArtifactDraft[] = [];
        const collectExtractedArtifacts = (
          drafts: ExtractedArtifactDraft[]
        ): void => {
          for (const draft of drafts) {
            if (extractedArtifacts.length >= MAX_EXTRACTED_ARTIFACTS_PER_RUN) {
              return;
            }
            extractedArtifacts.push(draft);
          }
        };
        const emit = (event: AgentRunEvent): void => {
          emitWire("agent.event", event as unknown as JsonValue, {
            sessionId: "sessionId" in event ? event.sessionId : undefined,
            runId: event.runId,
            rawEvent: event,
          });
          collectExtractedArtifacts(
            extractArtifactDraftsFromEvent(
              event,
              MAX_EXTRACTED_ARTIFACTS_PER_RUN - extractedArtifacts.length
            )
          );
        };
        try {
          const result = await this.orchestration.runCoordinator(
            {
              sessionId: body.sessionId,
              channelId: "web",
              conversationId: body.conversationId ?? "web-chat",
              message: body.message,
              subagents: body.subagents,
              timeoutMs: body.timeoutMs,
            },
            emit
          );
          const session = await this.sessions.get(result.sessionId);
          if (session) {
            await this.sessions.upsert({
              ...session,
              runIds: session.runIds.includes(result.runId)
                ? session.runIds
                : [...session.runIds, result.runId],
              updatedAt: new Date().toISOString(),
            });
            if (!session.title) {
              await this.sessions.rename(
                result.sessionId,
                buildAutoTitle(body.message),
                "auto"
              );
            }
          }
          if (body.attachmentIds && body.attachmentIds.length > 0) {
            await this.chatArtifacts.linkAttachmentsToRun({
              sessionId: result.sessionId,
              runId: result.runId,
              attachmentIds: body.attachmentIds,
            });
          }
          if (body.attachments && body.attachments.length > 0) {
            await this.chatArtifacts.recordMessageAttachments({
              sessionId: result.sessionId,
              runId: result.runId,
              attachments: body.attachments,
            });
          }
          collectExtractedArtifacts(
            extractArtifactDraftsFromOutputText(
              result.outputText,
              MAX_EXTRACTED_ARTIFACTS_PER_RUN - extractedArtifacts.length
            )
          );
          const persistedArtifacts =
            await this.chatArtifacts.persistExtractedArtifacts({
              sessionId: result.sessionId,
              runId: result.runId,
              drafts: extractedArtifacts,
            });
          emit({
            type: "final",
            runId: result.runId,
            outputText: result.outputText,
          });
          emitWire(
            "run.completed",
            {
              outputText: result.outputText,
              artifacts: persistedArtifacts,
            },
            {
              sessionId: result.sessionId,
              runId: result.runId,
            }
          );
          emitWire(
            "request.completed",
            {
              status: "completed",
            },
            {
              sessionId: result.sessionId,
              runId: result.runId,
            }
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Chat run failed";
          const rawEvent: AgentRunEvent = {
            type: "error",
            runId: "request_error",
            message,
            retryable: false,
          };
          emit(rawEvent);
          emitWire(
            "request.failed",
            { message, retryable: false },
            { runId: "request_error" }
          );
        }
        res.end();
        return;
      }

      if (req.method === "POST" && url.pathname === "/channels/webhook") {
        const rawBody = await readTextBody(req);
        const request = toRequest(req, rawBody);
        if (
          !validateWebhookSecret(
            request,
            this.config.externalChannelSecret,
            rawBody
          )
        ) {
          throw new HttpError(401, "Unauthorized");
        }
        const body = validateWebhookBody(parseJsonBody(rawBody));
        const events: AgentRunEvent[] = [];
        const routed = await this.inboundRouter.routeSync(
          {
            sessionId: body.sessionId,
            channelId: "webhook",
            providerEventId: `webhook:${requestId}`,
            conversationId: body.conversationId ?? "webhook",
            message: body.message,
            responseTarget: { type: "webhook" },
            rawPayload: parseJsonBody(rawBody) as JsonValue,
            subagents: body.subagents,
            timeoutMs: body.timeoutMs,
          },
          async (event) => {
            events.push(event);
          }
        );
        this.json(res, 200, {
          requestId,
          sessionId: routed.result.sessionId,
          runId: routed.result.runId,
          outputText: routed.result.outputText,
          events,
          inboundEvent: routed.record,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/channels/slack/events") {
        const rawBody = await readTextBody(req);
        if (!this.config.slackSigningSecret) {
          throw new HttpError(
            412,
            "SLACK_SIGNING_SECRET is required for Slack inbound events"
          );
        }
        const request = toRequest(req, rawBody);
        if (
          !validateSlackRequest(
            request.headers,
            this.config.slackSigningSecret,
            rawBody
          )
        ) {
          throw new HttpError(401, "Unauthorized");
        }
        const payload = parseJsonBody(rawBody) as SlackEventsPayload;
        if (payload.type === "url_verification" && payload.challenge) {
          this.json(res, 200, { challenge: payload.challenge });
          return;
        }
        const reactionFeedback = mapSlackReactionFeedback(payload);
        if (reactionFeedback?.messageTs) {
          const inboundEvent = this.channelInbound.findBySlackMessageTs(
            reactionFeedback.messageTs
          );
          if (inboundEvent) {
            const recorded = this.slackFeedback.record({
              inboundEvent,
              channelId: "slack",
              providerEventId: reactionFeedback.providerEventId,
              rating: reactionFeedback.rating,
              source: "reaction",
              userId: reactionFeedback.userId,
              slackChannel: reactionFeedback.slackChannel,
              messageTs: reactionFeedback.messageTs,
              threadTs: reactionFeedback.threadTs ?? inboundEvent.threadId,
              rawPayload: reactionFeedback.rawPayload,
            });
            this.json(res, 202, {
              requestId,
              status: recorded.duplicate ? "duplicate" : "feedback",
              duplicate: recorded.duplicate,
              feedback: recorded.record,
            });
            return;
          }
        }
        const message = mapSlackEventToInboundMessage(payload, {
          botUserId: this.config.slackBotUserId,
        });
        if (!message) {
          this.json(res, 202, { requestId, status: "ignored" });
          return;
        }
        const routed = this.inboundRouter.routeAsync(message, {
          ...this.inboundResponses.callbacks(),
        });
        this.json(res, 202, {
          requestId,
          inboundEventId: routed.record.id,
          status: routed.duplicate ? "duplicate" : "accepted",
          duplicate: routed.duplicate,
        });
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/channels/slack/interactions"
      ) {
        const rawBody = await readTextBody(req);
        if (!this.config.slackSigningSecret) {
          throw new HttpError(
            412,
            "SLACK_SIGNING_SECRET is required for Slack interactions"
          );
        }
        const request = toRequest(req, rawBody);
        if (
          !validateSlackRequest(
            request.headers,
            this.config.slackSigningSecret,
            rawBody
          )
        ) {
          throw new HttpError(401, "Unauthorized");
        }
        const payloadText = new URLSearchParams(rawBody).get("payload");
        if (!payloadText) {
          throw new HttpError(400, "Slack interaction payload is required");
        }
        const payload = parseJsonBody(payloadText) as Record<string, unknown>;
        const feedback = mapSlackInteractionFeedback(payload);
        if (!feedback) {
          this.json(res, 200, { requestId, status: "ignored" });
          return;
        }
        const inboundEvent = this.channelInbound.get(feedback.inboundEventId);
        if (!inboundEvent) {
          throw new HttpError(404, "Inbound event not found for feedback");
        }
        const recorded = this.slackFeedback.record({
          inboundEvent,
          channelId: "slack",
          providerEventId: feedback.providerEventId,
          rating: feedback.rating,
          source: "button",
          userId: feedback.userId,
          slackChannel: feedback.slackChannel,
          messageTs: feedback.messageTs,
          threadTs: feedback.threadTs,
          rawPayload: payload as JsonValue,
        });
        this.json(res, 200, {
          requestId,
          status: recorded.duplicate ? "duplicate" : "recorded",
          duplicate: recorded.duplicate,
          feedback: recorded.record,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/channels/slack/message") {
        this.requireOperatorAuth(req);
        const body = validateSlackMessageBody(
          parseJsonBody(await readTextBody(req))
        );
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
        const body = validateScheduleBody(
          parseJsonBody(await readTextBody(req))
        );
        const job = await this.scheduler.schedule(body.name, body.message, {
          delayMs: body.delayMs,
          scheduledAt: body.scheduledAt,
          subagents: body.subagents,
          maxAttempts: body.maxAttempts,
        });
        this.json(res, 200, { requestId, job });
        return;
      }

      if (req.method === "POST" && url.pathname === "/mcp") {
        const rateLimitKey = req.socket.remoteAddress ?? "unknown";
        const mcpAuthorization = req.headers.authorization;
        const hasMcpAuth =
          mcpAuthorization?.startsWith("Bearer ") === true &&
          this.matchesMcpToken(mcpAuthorization.slice("Bearer ".length));
        if (!hasMcpAuth && !this.mcpRateLimiter.allow(rateLimitKey)) {
          this.metrics.increment("mcp.rate_limited");
          this.json(res, 429, {
            error: "Too many MCP requests",
            requestId,
            status: 429,
          });
          return;
        }
        const bodyText = await readTextBody(req);
        validateMcpBody(parseJsonBody(bodyText));
        const response = await this.mcp.handle(
          toRequest(req, bodyText, { "x-request-id": requestId })
        );
        const text = await response.text();
        res.writeHead(response.status, {
          "Content-Type": "application/json",
          "X-Request-Id": requestId,
        });
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
        const body = validateDynamicToolBody(
          parseJsonBody(await readTextBody(req))
        );
        const tool = this.dynamicTools.register(body);
        this.json(res, 200, { requestId, tool });
        return;
      }

      if (
        req.method === "DELETE" &&
        url.pathname.startsWith("/tools/dynamic/")
      ) {
        this.requireOperatorAuth(req);
        const toolId = decodeURIComponent(
          url.pathname.replace("/tools/dynamic/", "")
        );
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
            events: await this.runs.listEvents(run.runId),
          }))
        );
        this.json(res, 200, { runs: withEvents });
        return;
      }

      throw new HttpError(404, "Not found");
    } catch (error) {
      const normalizedError = normalizeHttpError(error);
      const status =
        normalizedError instanceof HttpError ? normalizedError.status : 500;
      const message =
        normalizedError instanceof Error
          ? normalizedError.message
          : "Internal Server Error";
      requestLogger.error("request_failed", {
        status,
        error: message,
      });
      if (normalizedError instanceof OperatorAuthError) {
        res.setHeader(
          "WWW-Authenticate",
          'Basic realm="codex-phantom operator"'
        );
      }
      this.json(res, status, {
        error: message,
        requestId,
        status,
      });
    } finally {
      requestLogger.info("request_complete", {
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
      try {
        this.requestAudits.record({
          requestId,
          method: req.method ?? "UNKNOWN",
          path: url.pathname,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        requestLogger.error("request_audit_failed", {
          error:
            error instanceof Error ? error.message : "Request audit failed",
        });
      }
      this.metrics.increment(
        `http.${req.method?.toLowerCase() ?? "unknown"}.${url.pathname}`
      );
      this.metrics.observe("http.request.duration_ms", Date.now() - startedAt);
    }
  }

  private enableToolBundle(
    importId: string,
    actor: string,
    notes?: string
  ): ReturnType<ToolBundleImportStore["markEnabled"]> {
    const bundle = this.toolBundles.get(importId);
    if (!bundle) {
      throw new HttpError(404, "Tool bundle import not found");
    }
    if (bundle.status !== "valid") {
      throw new HttpError(409, "Only valid tool bundle imports can be enabled");
    }
    if (!["approved", "disabled"].includes(bundle.lifecycleState)) {
      throw new HttpError(
        409,
        "Tool bundle must be approved before it can be enabled"
      );
    }
    try {
      for (const tool of extractBundleTools(bundle.manifest)) {
        this.dynamicTools.registerApproved(tool, {
          approvedBy: actor,
          notes: notes ?? `enabled from bundle ${bundle.bundleId}`,
        });
      }
      return this.toolBundles.markEnabled(importId, actor, notes);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to enable tool bundle";
      const failed = this.toolBundles.markFailed(importId, actor, message);
      throw new HttpError(400, message, failed as unknown as JsonValue);
    }
  }

  private disableToolBundle(
    importId: string,
    actor: string,
    notes?: string
  ): ReturnType<ToolBundleImportStore["markDisabled"]> {
    const bundle = this.toolBundles.get(importId);
    if (!bundle) {
      throw new HttpError(404, "Tool bundle import not found");
    }
    if (bundle.lifecycleState !== "enabled") {
      throw new HttpError(409, "Only enabled tool bundles can be disabled");
    }
    for (const tool of extractBundleTools(bundle.manifest)) {
      this.dynamicTools.unregister(tool.id);
    }
    return this.toolBundles.markDisabled(importId, actor, notes);
  }

  private uninstallToolBundle(
    importId: string,
    actor: string,
    notes?: string
  ): ReturnType<ToolBundleImportStore["markUninstalled"]> {
    const bundle = this.toolBundles.get(importId);
    if (!bundle) {
      throw new HttpError(404, "Tool bundle import not found");
    }
    for (const tool of extractBundleTools(bundle.manifest)) {
      this.dynamicTools.unregister(tool.id);
    }
    return this.toolBundles.markUninstalled(importId, actor, notes);
  }

  private async requireWebChatSession(sessionId: string) {
    const session = await this.sessions.get(sessionId);
    if (!session || session.channelId !== "web") {
      throw new HttpError(404, "Chat session not found");
    }
    return session;
  }

  private async requireSessionRun(
    session: Awaited<ReturnType<SessionStore["get"]>> & {},
    runId: string
  ): Promise<void> {
    if (!session.runIds.includes(runId)) {
      throw new HttpError(404, "Run not found for chat session");
    }
    const run = await this.runs.get(runId);
    if (!run) {
      throw new HttpError(404, "Run not found for chat session");
    }
  }

  private buildDiagnostics(
    memoryStatus: ReturnType<MemoryStore["getStatus"]>,
    channels: ReturnType<ChannelRegistry["list"]>,
    setupReadiness: ReturnType<typeof buildSetupReadiness>
  ) {
    return buildStartupDiagnostics(
      this.config,
      memoryStatus,
      channels,
      this.runtimeChannels.emailStatus(),
      this.listRecentFailedDeliveries("email"),
      setupReadiness,
      this.orchestration.getRolePolicyStatus()
    );
  }

  private listRecentFailedDeliveries(
    channelId: string
  ): ChannelDeliveryRecord[] {
    return this.channelDeliveries
      .list(channelId, 10)
      .filter((delivery) => delivery.status === "failed");
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
    if (
      authorization?.startsWith("Bearer ") &&
      this.matchesOperatorToken(authorization.slice("Bearer ".length))
    ) {
      return true;
    }
    if (authorization?.startsWith("Basic ")) {
      const credentials = Buffer.from(
        authorization.slice("Basic ".length),
        "base64"
      ).toString("utf8");
      const [, password] = credentials.split(":", 2);
      if (this.matchesOperatorToken(password ?? "")) {
        return true;
      }
    }
    const operatorHeader = req.headers["x-operator-token"];
    return (
      typeof operatorHeader === "string" &&
      this.matchesOperatorToken(operatorHeader)
    );
  }

  private matchesOperatorToken(candidate: string): boolean {
    const candidateHash = hashToken(candidate);
    return (
      candidateHash.length === this.operatorTokenHash.length &&
      timingSafeEqual(candidateHash, this.operatorTokenHash)
    );
  }

  private matchesMcpToken(candidate: string): boolean {
    const candidateHash = hashToken(candidate);
    return (
      candidateHash.length === this.mcpTokenHash.length &&
      timingSafeEqual(candidateHash, this.mcpTokenHash)
    );
  }
}

class OperatorAuthError extends HttpError {
  constructor() {
    super(401, "Unauthorized");
  }
}

function normalizeHttpError(error: unknown): unknown {
  if (error instanceof SelfEvolutionMutationError) {
    return toSelfEvolutionHttpError(error);
  }
  if (error instanceof AssignmentNotFoundError) {
    return new HttpError(404, error.message);
  }
  if (error instanceof AssignmentValidationError) {
    return new HttpError(400, error.message);
  }
  return error;
}

function toSelfEvolutionHttpError(
  error: SelfEvolutionMutationError
): HttpError {
  if (error.code === "not_found") {
    return new HttpError(404, error.message);
  }
  if (
    error.code === "invalid_state" ||
    error.code === "confirmation_required"
  ) {
    return new HttpError(409, error.message);
  }
  return new HttpError(
    400,
    error.message,
    error.mutation as unknown as JsonValue | undefined
  );
}

function parseAssignmentLifecycleQuery(
  value: string | null
): AssignmentLifecycleState | undefined {
  if (!value) {
    return undefined;
  }
  if (
    !ASSIGNMENT_LIFECYCLE_STATES.includes(value as AssignmentLifecycleState)
  ) {
    throw new HttpError(400, "lifecycleState must be a valid assignment state");
  }
  return value as AssignmentLifecycleState;
}

function parseAssignmentAutonomyQuery(
  value: string | null
): AssignmentAutonomyLevel | undefined {
  if (!value) {
    return undefined;
  }
  if (!ASSIGNMENT_AUTONOMY_LEVELS.includes(value as AssignmentAutonomyLevel)) {
    throw new HttpError(
      400,
      "autonomyLevel must be a valid assignment autonomy level"
    );
  }
  return value as AssignmentAutonomyLevel;
}

function parseOptionalPositiveIntegerQuery(
  value: string | null,
  field: string
): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, `${field} must be a positive integer`);
  }
  return parsed;
}

function trimTrailingSlash(pathname: string): string {
  return pathname.replace(/\/$/, "");
}

class SimpleRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const recentHits = (this.hits.get(key) ?? []).filter(
      (hit) => hit > windowStart
    );
    if (recentHits.length >= this.limit) {
      this.hits.set(key, recentHits);
      return false;
    }
    recentHits.push(now);
    this.hits.set(key, recentHits);
    return true;
  }
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function buildAutoTitle(message: string): string {
  const words = message
    .replace(/[^\w\s-]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  const title = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
  return title || "New Chat";
}

async function readTextBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_MAX_BODY_BYTES
): Promise<string> {
  return (await readBufferBody(req, maxBytes)).toString("utf8");
}

async function readBufferBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_MAX_BODY_BYTES
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let bodyExceededLimit = false;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (bodyExceededLimit || totalBytes > maxBytes) {
      bodyExceededLimit = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (bodyExceededLimit) {
    throw new HttpError(413, `Request body exceeds ${maxBytes} bytes`);
  }
  return Buffer.concat(chunks);
}

function toRequest(
  req: IncomingMessage,
  body?: string,
  extraHeaders?: Record<string, string>
): Request {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers(req.headers as HeadersInit);
  for (const [key, value] of Object.entries(extraHeaders ?? {})) {
    headers.set(key, value);
  }
  return new Request(url, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
}

type MultipartFile = {
  fieldName: string;
  fileName: string;
  contentType: string;
  content: Buffer;
};

type MultipartBody = {
  fields: Map<string, string>;
  files: MultipartFile[];
};

function parseMultipartBoundary(contentType: string): string {
  const boundary = contentType
    .match(/boundary=([^;]+)/)?.[1]
    ?.trim()
    .replace(/^"|"$/g, "");
  if (!boundary) {
    throw new HttpError(400, "multipart boundary is required");
  }
  return boundary;
}

function parseMultipartBody(body: Buffer, boundary: string): MultipartBody {
  const fields = new Map<string, string>();
  const files: MultipartFile[] = [];
  const boundaryText = `--${boundary}`;
  const parts = body.toString("latin1").split(boundaryText).slice(1, -1);
  for (const rawPart of parts) {
    const part = rawPart.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      continue;
    }
    const rawHeaders = part.slice(0, headerEnd);
    const content = Buffer.from(part.slice(headerEnd + 4), "latin1");
    const headers = parsePartHeaders(rawHeaders);
    const disposition = headers.get("content-disposition") ?? "";
    const fieldName = disposition.match(/name="([^"]+)"/)?.[1];
    if (!fieldName) {
      continue;
    }
    const fileName = disposition.match(/filename="([^"]*)"/)?.[1];
    if (fileName !== undefined) {
      files.push({
        fieldName,
        fileName: safeDownloadName(fileName || "upload.bin"),
        contentType: headers.get("content-type") ?? "application/octet-stream",
        content,
      });
    } else {
      fields.set(fieldName, content.toString("utf8"));
    }
  }
  return { fields, files };
}

function parsePartHeaders(rawHeaders: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of rawHeaders.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    headers.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim()
    );
  }
  return headers;
}

function requiredMultipartField(body: MultipartBody, field: string): string {
  const value = optionalMultipartField(body, field);
  if (!value) {
    throw new HttpError(400, `${field} is required`);
  }
  return value;
}

function optionalMultipartField(
  body: MultipartBody,
  field: string
): string | undefined {
  const value = body.fields.get(field)?.trim();
  return value || undefined;
}

function parseSelfEvolutionActionPath(pathname: string): {
  proposalId: string;
  action: string;
} {
  const suffix = pathname.replace("/admin/self-evolution/proposals/", "");
  const [encodedProposalId, action] = suffix.split("/");
  if (!encodedProposalId || !action) {
    throw new HttpError(404, "Not found");
  }
  return {
    proposalId: decodeURIComponent(encodedProposalId),
    action,
  };
}

function parseToolBundleActionPath(pathname: string): {
  importId: string;
  action: string;
} {
  const suffix = pathname.replace("/admin/tools/bundles/", "");
  const [encodedImportId, action] = suffix.split("/");
  if (!encodedImportId || !action || action === "preview") {
    throw new HttpError(404, "Not found");
  }
  return {
    importId: decodeURIComponent(encodedImportId),
    action,
  };
}

function extractBundleTools(manifest: JsonValue): Array<{
  id: string;
  description: string;
  scopes: string[];
  inputSchema?: JsonValue;
  responseTemplate: string;
}> {
  const manifestObject = asJsonObject(manifest, "manifest");
  if (!Array.isArray(manifestObject.tools)) {
    throw new Error("manifest.tools must be an array");
  }
  return manifestObject.tools.map((item, index) => {
    const tool = asJsonObject(item, `manifest.tools[${index}]`);
    if (
      typeof tool.id !== "string" ||
      typeof tool.description !== "string" ||
      typeof tool.responseTemplate !== "string"
    ) {
      throw new Error(`manifest.tools[${index}] is missing required fields`);
    }
    const scopes = tool.scopes === undefined ? ["read"] : tool.scopes;
    if (
      !Array.isArray(scopes) ||
      scopes.some((scope) => typeof scope !== "string")
    ) {
      throw new Error(`manifest.tools[${index}].scopes must be strings`);
    }
    const stringScopes = scopes as string[];
    return {
      id: tool.id,
      description: tool.description,
      scopes: stringScopes,
      inputSchema: tool.inputSchema,
      responseTemplate: tool.responseTemplate,
    };
  });
}

function asJsonObject(
  value: JsonValue | undefined,
  field: string
): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}
