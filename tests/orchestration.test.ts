import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/agent/codex-adapter.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import type { AgentAdapter, AgentRunRequest } from "../src/agent/types.ts";
import { SessionStore } from "../src/chat/session-store.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { AppDatabase } from "../src/platform/database.ts";
import { PromptRuntimeGuidanceStore } from "../src/prompts/runtime-guidance.ts";
import { RunGraphStore } from "../src/orchestration/run-graph-store.ts";
import { loadRolePolicyConfig } from "../src/orchestration/role-config.ts";
import { RolePolicyRuntimeStore } from "../src/orchestration/role-policy-runtime.ts";
import { OrchestrationService } from "../src/orchestration/service.ts";
import { buildScopedPolicy } from "../src/orchestration/roles.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import {
  makeConfig,
  makeDisabledEmbeddings,
  makeFakeVectorStore,
} from "./helpers.ts";

test("tracks deterministic subagents and stores run events", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-orch-"));
  const database = new AppDatabase(join(dataDir, "test.sqlite"));
  const config = makeConfig(dataDir);
  const adapter = new CodexAdapter(config, { mode: "fallback" });
  const registry = new ToolRegistry();
  registry.register({
    id: "echo.summary",
    description: "echo",
    scopes: ["read"],
    kind: "in_process",
    allowedRoles: ["coordinator", "explorer", "verifier"],
    handler: async (input) => input,
  });
  registry.register({
    id: "memory.query",
    description: "memory",
    scopes: ["read"],
    kind: "in_process",
    allowedRoles: ["coordinator", "explorer"],
    handler: async () => ({ ok: true }),
  });
  registry.registerDynamic({
    id: "dynamic.note",
    description: "note",
    scopes: ["write"],
    kind: "in_process",
    allowedRoles: ["builder", "coordinator"],
    handler: async (input) => ({ saved: input }),
  });
  const runtime = new AgentRuntime(
    config,
    adapter,
    new SessionStore(database),
    new MemoryStore(
      database,
      config,
      makeDisabledEmbeddings(),
      makeFakeVectorStore({
        backend: "qdrant",
        available: false,
        configured: false,
      }),
      makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
    ),
    registry
  );
  const runs = new RunGraphStore(database);
  const orchestration = new OrchestrationService(runtime, registry, runs);
  const events: string[] = [];

  await orchestration.runCoordinator(
    {
      channelId: "web",
      conversationId: "conv",
      message: "build summary",
      subagents: [
        { role: "explorer", objective: "inspect architecture" },
        { role: "verifier", objective: "check regressions" },
      ],
    },
    async (event) => {
      events.push(event.type);
    }
  );

  const stored = await runs.list();
  assert.equal(stored.length, 3);
  const root = stored.find((run) => run.role === "coordinator");
  assert.equal(root?.childRunIds.length, 2);
  assert.ok(events.includes("subagent_spawned"));
  assert.ok(events.includes("subagent_progress"));
  assert.ok(stored.every((run) => run.status === "completed"));
  const rootEvents = await runs.listEvents(root?.runId ?? "");
  assert.ok(rootEvents.some((event) => event.type === "subagent_spawned"));
  database.close();
});

test("enforces permission-scoped tools", async () => {
  const registry = new ToolRegistry();
  registry.register({
    id: "echo.summary",
    description: "echo",
    scopes: ["read"],
    kind: "in_process",
    handler: async () => ({ ok: true }),
  });
  await assert.rejects(
    () =>
      registry.call("echo.summary", null, {
        mode: "read_only",
        fileGlobs: ["**/*"],
        allowedToolIds: [],
        allowedMcpServers: [],
      }),
    /not permitted/
  );
});

test("runtime executes tool calls before returning the final answer", async () => {
  const database = new AppDatabase(":memory:");
  const config = makeConfig();
  let iteration = 0;
  const adapter = new CodexAdapter(config, {
    mode: "openai",
    transport: async function* () {
      iteration += 1;
      if (iteration === 1) {
        yield {
          type: "response.created",
          response: { id: "resp_1", model: "gpt-5" },
        };
        yield {
          type: "response.function_call_arguments.done",
          item_id: "call_1",
          name: "echo.summary",
          arguments: '{"topic":"production"}',
        };
        yield { type: "response.completed", response: { id: "resp_1" } };
        return;
      }
      yield {
        type: "response.created",
        response: { id: "resp_2", model: "gpt-5" },
      };
      yield {
        type: "response.output_text.delta",
        item_id: "msg_1",
        delta: "tool complete",
      };
      yield { type: "response.output_text.done" };
      yield { type: "response.completed", response: { id: "resp_2" } };
    },
  });
  const registry = new ToolRegistry();
  registry.register({
    id: "echo.summary",
    description: "echo",
    scopes: ["read"],
    kind: "in_process",
    handler: async (input) => ({ echoed: input }),
  });

  const runtime = new AgentRuntime(
    config,
    adapter,
    new SessionStore(database),
    new MemoryStore(
      database,
      config,
      makeDisabledEmbeddings(),
      makeFakeVectorStore({
        backend: "qdrant",
        available: false,
        configured: false,
      }),
      makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
    ),
    registry
  );
  const result = await runtime.run(
    {
      channelId: "web",
      conversationId: "conv",
      role: "coordinator",
      messages: [{ role: "user", content: "use a tool" }],
      permissionPolicy: {
        mode: "full_access",
        fileGlobs: ["**/*"],
        allowedToolIds: ["echo.summary"],
        allowedMcpServers: [],
      },
      toolCapabilities: registry.list(),
    },
    async () => {}
  );

  assert.equal(result.result.outputText, "tool complete");
  assert.equal(iteration, 2);
  database.close();
});

test("runtime passes configured model and reasoning efforts to adapter", async () => {
  const database = new AppDatabase(":memory:");
  const config = makeConfig(".", {
    model: "gpt-5.1-codex",
    openAiApiKey: "test-key",
    openAiReasoningEffort: "high",
    openAiMemoryReasoningEffort: "medium",
  });
  const requests: AgentRunRequest[] = [];
  const adapter: AgentAdapter = {
    name: "capturing",
    capabilities: {
      supportsResume: true,
      supportsStreaming: true,
      supportsToolStreaming: true,
      supportsStructuredOutput: true,
      supportsParallelToolCalls: false,
      supportsReasoningEffort: true,
    },
    async run(request) {
      requests.push(request);
      return {
        runId: request.runId,
        outputText:
          request.role === "researcher"
            ? JSON.stringify({
                semanticFacts: [],
                proceduralNotes: [],
                summary: "configured reasoning smoke",
              })
            : "configured reasoning complete",
        providerSessionId: "provider_configured",
        previousResponseId: "provider_configured",
        transcript: [
          { role: "user", content: request.messages.at(-1)?.content ?? "" },
          { role: "assistant", content: "configured reasoning complete" },
        ],
        toolCalls: [],
      };
    },
  };

  const runtime = new AgentRuntime(
    config,
    adapter,
    new SessionStore(database),
    new MemoryStore(
      database,
      config,
      makeDisabledEmbeddings(),
      makeFakeVectorStore({
        backend: "qdrant",
        available: false,
        configured: false,
      }),
      makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
    ),
    new ToolRegistry()
  );

  await runtime.run(
    {
      channelId: "web",
      conversationId: "conv",
      role: "coordinator",
      messages: [{ role: "user", content: "check configured reasoning" }],
      permissionPolicy: {
        mode: "read_only",
        fileGlobs: [],
        allowedToolIds: [],
        allowedMcpServers: [],
      },
      toolCapabilities: [],
    },
    async () => {}
  );

  assert.equal(requests[0]?.model, "gpt-5.1-codex");
  assert.equal(requests[0]?.reasoningEffort, "high");
  assert.equal(requests[1]?.model, "gpt-5.1-codex");
  assert.equal(requests[1]?.reasoningEffort, "medium");
  database.close();
});

test("runtime includes persisted prompt runtime guidance in system prompts", async () => {
  const database = new AppDatabase(":memory:");
  const config = makeConfig();
  const promptGuidance = new PromptRuntimeGuidanceStore(database);
  promptGuidance.update("Prefer concise verification summaries.", "operator");
  const requests: AgentRunRequest[] = [];
  const adapter: AgentAdapter = {
    name: "capturing",
    capabilities: {
      supportsResume: true,
      supportsStreaming: true,
      supportsToolStreaming: true,
      supportsStructuredOutput: true,
      supportsParallelToolCalls: false,
      supportsReasoningEffort: true,
    },
    async run(request) {
      requests.push(request);
      return {
        runId: request.runId,
        outputText: "guidance observed",
        providerSessionId: "provider_guidance",
        previousResponseId: "provider_guidance",
        transcript: [
          { role: "user", content: request.messages.at(-1)?.content ?? "" },
          { role: "assistant", content: "guidance observed" },
        ],
        toolCalls: [],
      };
    },
  };
  const runtime = new AgentRuntime(
    config,
    adapter,
    new SessionStore(database),
    new MemoryStore(
      database,
      config,
      makeDisabledEmbeddings(),
      makeFakeVectorStore({
        backend: "qdrant",
        available: false,
        configured: false,
      }),
      makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
    ),
    new ToolRegistry(),
    promptGuidance
  );

  await runtime.run(
    {
      channelId: "web",
      conversationId: "conv",
      role: "coordinator",
      messages: [{ role: "user", content: "check prompt guidance" }],
      permissionPolicy: {
        mode: "read_only",
        fileGlobs: [],
        allowedToolIds: [],
        allowedMcpServers: [],
      },
      toolCapabilities: [],
    },
    async () => {}
  );

  assert.match(
    requests[0]?.systemPrompt ?? "",
    /# Runtime Guidance Overlay\nPrefer concise verification summaries\./
  );
  database.close();
});

test("loads YAML role policy overlays for scoped subagent policy", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-roles-"));
  const roleConfigPath = join(dataDir, "roles.yaml");
  await writeFile(
    roleConfigPath,
    `
version: 1
roles:
  explorer:
    mode: read_only
    fileGlobs:
      - docs/**/*
    allowedToolIds:
      - echo.summary
    allowedMcpServers:
      - docs
  builder:
    mode: scoped_write
    fileGlobs:
      - src/**/*
    allowedToolIds:
      - dynamic.note
    allowedMcpServers:
      - repo
`
  );
  const loaded = loadRolePolicyConfig(roleConfigPath);

  assert.equal(loaded.status.source, "yaml");
  assert.equal(loaded.status.valid, true);
  const policy = buildScopedPolicy(
    {
      mode: "scoped_write",
      fileGlobs: ["src/**/*", "docs/**/*"],
      allowedToolIds: ["echo.summary", "dynamic.note"],
      allowedMcpServers: ["repo", "docs"],
    },
    { role: "explorer" },
    loaded.baselines
  );
  assert.deepEqual(policy.fileGlobs, ["docs/**/*"]);
  assert.deepEqual(policy.allowedToolIds, ["echo.summary"]);
  assert.deepEqual(policy.allowedMcpServers, ["docs"]);
});

test("runtime role policy overlay narrows newly spawned subagents", async () => {
  const database = new AppDatabase(":memory:");
  const config = makeConfig();
  const requests: AgentRunRequest[] = [];
  const adapter: AgentAdapter = {
    name: "capturing",
    capabilities: {
      supportsResume: true,
      supportsStreaming: true,
      supportsToolStreaming: true,
      supportsStructuredOutput: true,
      supportsParallelToolCalls: false,
      supportsReasoningEffort: true,
    },
    async run(request) {
      requests.push(request);
      return {
        runId: request.runId,
        outputText: "role policy observed",
        transcript: [
          { role: "user", content: request.messages.at(-1)?.content ?? "" },
          { role: "assistant", content: "role policy observed" },
        ],
        toolCalls: [],
      };
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    id: "echo.summary",
    description: "echo",
    scopes: ["read"],
    kind: "in_process",
    allowedRoles: ["coordinator", "explorer"],
    handler: async (input) => input,
  });
  registry.register({
    id: "memory.query",
    description: "memory",
    scopes: ["read"],
    kind: "in_process",
    allowedRoles: ["coordinator", "explorer"],
    handler: async () => ({ ok: true }),
  });
  const runtime = new AgentRuntime(
    config,
    adapter,
    new SessionStore(database),
    new MemoryStore(
      database,
      config,
      makeDisabledEmbeddings(),
      makeFakeVectorStore({
        backend: "qdrant",
        available: false,
        configured: false,
      }),
      makeFakeVectorStore({ backend: "sqlite_fallback", available: true })
    ),
    registry
  );
  const rolePolicy = new RolePolicyRuntimeStore(
    database,
    loadRolePolicyConfig(config.roleConfigPath)
  );
  rolePolicy.update(
    {
      roles: {
        explorer: {
          mode: "read_only",
          fileGlobs: ["docs/**/*"],
          allowedToolIds: ["echo.summary"],
          allowedMcpServers: ["docs"],
        },
      },
    },
    "operator"
  );
  const runs = new RunGraphStore(database);
  const orchestration = new OrchestrationService(
    runtime,
    registry,
    runs,
    rolePolicy
  );

  await orchestration.runCoordinator(
    {
      channelId: "web",
      conversationId: "conv",
      message: "inspect docs",
      subagents: [{ role: "explorer", objective: "read docs only" }],
    },
    async () => {}
  );

  const explorerRequest = requests.find(
    (request) => request.role === "explorer"
  );
  assert.deepEqual(explorerRequest?.permissionPolicy.fileGlobs, ["docs/**/*"]);
  assert.deepEqual(explorerRequest?.permissionPolicy.allowedToolIds, [
    "echo.summary",
  ]);
  assert.deepEqual(explorerRequest?.permissionPolicy.allowedMcpServers, [
    "docs",
  ]);
  assert.throws(
    () =>
      rolePolicy.update({
        roles: {
          explorer: {
            allowedMcpServers: ["repo"],
          },
        },
      }),
    /rolePolicy\.roles\.explorer\.allowedMcpServers cannot include repo/
  );
  database.close();
});

test("invalid YAML role policy fails with actionable errors", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-roles-"));
  const roleConfigPath = join(dataDir, "roles.yaml");
  await writeFile(
    roleConfigPath,
    `
version: 1
roles:
  explorer:
    mode: root
    fileGlobs: []
    allowedToolIds: []
    allowedMcpServers: []
`
  );

  assert.throws(
    () => loadRolePolicyConfig(roleConfigPath),
    /roles\.explorer\.mode/
  );
});
