import { loadConfig } from "./config.ts";
import { SessionStore } from "./chat/session-store.ts";
import { ChannelRegistry } from "./channels/registry.ts";
import { MemoryStore } from "./memory/store.ts";
import { OpenAiEmbeddingService } from "./memory/embedding.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { DynamicToolRegistry } from "./tools/dynamic-registry.ts";
import { ToolGovernanceService } from "./tools/governance.ts";
import { CodexAdapter } from "./agent/codex-adapter.ts";
import { AgentRuntime } from "./agent/runtime.ts";
import { RunGraphStore } from "./orchestration/run-graph-store.ts";
import { OrchestrationService } from "./orchestration/service.ts";
import { SchedulerService } from "./scheduler/service.ts";
import { McpAuditStore } from "./mcp/audit.ts";
import { McpServer } from "./mcp/server.ts";
import { HttpServer } from "./server/http-server.ts";
import { AppDatabase } from "./platform/database.ts";
import { Logger } from "./platform/logger.ts";
import { MetricsStore } from "./platform/metrics.ts";

const config = loadConfig();
const logger = new Logger(config.logLevel);
const metrics = new MetricsStore();
const database = new AppDatabase(config.datastorePath);
const sessions = new SessionStore(database);
const channels = new ChannelRegistry(database, config);
const embeddings = new OpenAiEmbeddingService(config);
const memory = new MemoryStore(database, config, embeddings);
const tools = new ToolRegistry();
const dynamicTools = new DynamicToolRegistry(database, tools);
const governance = new ToolGovernanceService(database);
const runs = new RunGraphStore(database);
const mcpAudit = new McpAuditStore(database);

tools.register({
  id: "memory.query",
  description: "Read current persisted memory slices.",
  scopes: ["read"],
  kind: "in_process",
  handler: async (input) => memory.query(typeof input === "string" ? input : JSON.stringify(input))
});
tools.register({
  id: "echo.summary",
  description: "Return a compact textual summary.",
  scopes: ["read"],
  kind: "in_process",
  handler: async (input) => ({ summary: `summary:${JSON.stringify(input)}` })
});
tools.register({
  id: "dynamic.note",
  description: "A mutable note tool used by builders in scoped mode.",
  scopes: ["write"],
  kind: "in_process",
  handler: async (input) => ({ saved: true, input, createdAt: new Date().toISOString() })
});

const adapter = new CodexAdapter(config);
const runtime = new AgentRuntime(config, adapter, sessions, memory, tools);
const orchestration = new OrchestrationService(runtime, tools, runs);
const scheduler = new SchedulerService(database, orchestration);
const mcp = new McpServer(config.mcpBearerToken, tools, metrics, undefined, mcpAudit);
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
  governance
);

await memory.backfillEmbeddings();
await memory.initializeVectorStore();
await memory.backfillVectors();
await scheduler.start();
await server.listen();
logger.info("server_listening", {
  port: config.port,
  agent: config.agentName,
  datastorePath: config.datastorePath
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info("shutdown_requested", { signal });
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
