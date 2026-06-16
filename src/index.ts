import { loadConfig } from "./config.ts";
import { SessionStore } from "./chat/session-store.ts";
import { ChannelDeliveryStore } from "./channels/delivery-log.ts";
import { RuntimeChannelCapabilities } from "./channels/capabilities.ts";
import { EmailChannelService } from "./channels/email.ts";
import {
  InboundResponseDispatcher,
  createEmailInboundResponseAdapter,
} from "./channels/inbound-response-dispatcher.ts";
import {
  ImapEmailPollTransport,
  SmtpEmailSendTransport,
} from "./channels/email-transports.ts";
import {
  InboundChannelEventStore,
  InboundChannelRouter,
} from "./channels/inbound.ts";
import { ChannelRegistry } from "./channels/registry.ts";
import { MemoryStore } from "./memory/store.ts";
import { MemoryMaintenanceService } from "./memory/maintenance.ts";
import { OpenAiEmbeddingService } from "./memory/embedding.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { DynamicToolRegistry } from "./tools/dynamic-registry.ts";
import { ToolGovernanceService } from "./tools/governance.ts";
import {
  SelfEvolutionProposalStore,
  type CreateSelfEvolutionProposalInput,
} from "./self-evolution/proposals.ts";
import { AutonomousAssignmentService } from "./assignments/service.ts";
import { registerAssignmentTools } from "./assignments/tools.ts";
import { AssignmentIntakeService } from "./assignments/intake.ts";
import {
  ASSIGNMENT_WAKEUP_JOB_NAME,
  AssignmentWakeupPlanner,
} from "./assignments/wakeup-planner.ts";
import { AutonomousMutationLedger } from "./assignments/mutation-ledger.ts";
import { AutonomousMutationExecutor } from "./assignments/autonomous-mutations.ts";
import { CodexAdapter } from "./agent/codex-adapter.ts";
import { AgentRuntime } from "./agent/runtime.ts";
import { RunGraphStore } from "./orchestration/run-graph-store.ts";
import { OrchestrationService } from "./orchestration/service.ts";
import { loadRolePolicyConfig } from "./orchestration/role-config.ts";
import { SchedulerService } from "./scheduler/service.ts";
import { McpAuditStore } from "./mcp/audit.ts";
import { McpServer } from "./mcp/server.ts";
import { HttpServer } from "./server/http-server.ts";
import { AppDatabase } from "./platform/database.ts";
import { Logger } from "./platform/logger.ts";
import { MetricsStore } from "./platform/metrics.ts";
import { OperatorSettingsStore } from "./server/settings.ts";
import type { JsonValue } from "./shared/types.ts";

const config = loadConfig();
const logger = new Logger(config.logLevel);
const metrics = new MetricsStore();
const database = new AppDatabase(config.datastorePath);
const sessions = new SessionStore(database);
const channels = new ChannelRegistry(database, config);
const channelDeliveries = new ChannelDeliveryStore(database);
const channelInbound = new InboundChannelEventStore(database);
const embeddings = new OpenAiEmbeddingService(config);
const memory = new MemoryStore(database, config, embeddings);
const memoryMaintenance = new MemoryMaintenanceService(database, memory);
const tools = new ToolRegistry();
const dynamicTools = new DynamicToolRegistry(database, tools);
const governance = new ToolGovernanceService(database);
const selfEvolution = new SelfEvolutionProposalStore(database);
const assignments = new AutonomousAssignmentService(database);
const assignmentMutations = new AutonomousMutationLedger(database, assignments);
const operatorSettings = new OperatorSettingsStore(database);
const assignmentMutationExecutor = new AutonomousMutationExecutor({
  assignments,
  ledger: assignmentMutations,
  settings: operatorSettings,
});
const runs = new RunGraphStore(database);
const mcpAudit = new McpAuditStore(database);
const rolePolicy = loadRolePolicyConfig(config.roleConfigPath);

tools.register({
  id: "memory.query",
  description: "Read current persisted memory slices.",
  scopes: ["read"],
  kind: "in_process",
  handler: async (input) =>
    memory.query(typeof input === "string" ? input : JSON.stringify(input)),
});
tools.register({
  id: "echo.summary",
  description: "Return a compact textual summary.",
  scopes: ["read"],
  kind: "in_process",
  handler: async (input) => ({ summary: `summary:${JSON.stringify(input)}` }),
});
tools.register({
  id: "dynamic.note",
  description: "A mutable note tool used by builders in scoped mode.",
  scopes: ["write"],
  kind: "in_process",
  handler: async (input) => ({
    saved: true,
    input,
    createdAt: new Date().toISOString(),
  }),
});
tools.register({
  id: "self_evolution.propose",
  description:
    "Create an auditable self-evolution proposal without applying the change.",
  scopes: ["write"],
  kind: "in_process",
  handler: async (input) =>
    selfEvolution.create({
      ...parseSelfEvolutionToolInput(input),
      proposedBy: "agent",
    }) as unknown as JsonValue,
});
registerAssignmentTools(tools, assignments, assignmentMutations);

const adapter = new CodexAdapter(config);
const runtime = new AgentRuntime(config, adapter, sessions, memory, tools);
const orchestration = new OrchestrationService(
  runtime,
  tools,
  runs,
  rolePolicy
);
const inboundRouter = new InboundChannelRouter(
  channels,
  channelInbound,
  orchestration
);
const scheduler = new SchedulerService(database, orchestration);
const assignmentWakeups = new AssignmentWakeupPlanner({
  assignments,
  scheduler,
  orchestration,
  mutations: assignmentMutationExecutor,
});
const assignmentIntake = new AssignmentIntakeService(
  assignments,
  assignmentWakeups
);
scheduler.registerHandler(ASSIGNMENT_WAKEUP_JOB_NAME, (job) =>
  assignmentWakeups.handleScheduledWakeup(job)
);
const mcp = new McpServer(
  config.mcpBearerToken,
  tools,
  metrics,
  undefined,
  mcpAudit
);
const emailSendTransport = new SmtpEmailSendTransport({
  host: config.emailSmtpHost ?? "",
  port: config.emailSmtpPort,
  secure: config.emailSmtpTls,
  connectionTimeout: config.emailSendTimeoutMs,
  greetingTimeout: config.emailSendTimeoutMs,
  socketTimeout: config.emailSendTimeoutMs,
  auth: {
    user: config.emailSmtpUsername ?? "",
    pass: config.emailSmtpPassword ?? "",
  },
});
const emailResponseDispatcher = new InboundResponseDispatcher({
  logger,
  adapters: {
    email_reply: createEmailInboundResponseAdapter({
      config,
      deliveries: channelDeliveries,
      sendTransport: emailSendTransport,
      logger,
    }),
  },
});
const email = new EmailChannelService({
  config,
  channels,
  inboundRouter,
  responseDispatcher: emailResponseDispatcher,
  pollTransport: new ImapEmailPollTransport({
    host: config.emailImapHost ?? "",
    port: config.emailImapPort,
    secure: config.emailImapTls,
    maxAttachmentBytes: config.emailMaxAttachmentBytes,
    auth: {
      user: config.emailImapUsername ?? "",
      pass: config.emailImapPassword ?? "",
    },
  }),
  sendTransport: emailSendTransport,
  logger,
  assignmentIntake,
});
const runtimeChannels = new RuntimeChannelCapabilities();
runtimeChannels.registerLifecycle("email", email);
const server = new HttpServer(
  config,
  orchestration,
  scheduler,
  sessions,
  runs,
  mcp,
  database,
  logger,
  metrics,
  memory,
  dynamicTools,
  channels,
  governance,
  undefined,
  memoryMaintenance,
  runtimeChannels,
  assignments,
  assignmentWakeups,
  assignmentIntake,
  assignmentMutations
);

await memory.backfillEmbeddings();
await memory.initializeVectorStore();
await memory.backfillVectors();
await memoryMaintenance.start();
await scheduler.start();
await server.listen();
await email.start();
logger.info("server_listening", {
  port: config.port,
  agent: config.agentName,
  datastorePath: config.datastorePath,
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info("shutdown_requested", { signal });
  await email.stop();
  await memoryMaintenance.stop();
  await scheduler.stop();
  await server.close();
  database.close();
  process.exit(0);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

function parseSelfEvolutionToolInput(
  input: JsonValue
): CreateSelfEvolutionProposalInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("self_evolution.propose input must be a JSON object");
  }
  const value = input as Record<string, JsonValue>;
  return {
    target: requireToolString(
      value.target,
      "target"
    ) as CreateSelfEvolutionProposalInput["target"],
    title: requireToolString(value.title, "title"),
    rationale: requireToolString(value.rationale, "rationale"),
    riskClass: requireToolString(
      value.riskClass,
      "riskClass"
    ) as CreateSelfEvolutionProposalInput["riskClass"],
    proposedChange: value.proposedChange,
    metadata: value.metadata,
  };
}

function requireToolString(
  value: JsonValue | undefined,
  field: string
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}
