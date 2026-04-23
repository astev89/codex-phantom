import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/agent/codex-adapter.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { SessionStore } from "../src/chat/session-store.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { AppDatabase } from "../src/platform/database.ts";
import { RunGraphStore } from "../src/orchestration/run-graph-store.ts";
import { OrchestrationService } from "../src/orchestration/service.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { makeConfig, makeDisabledEmbeddings, makeFakeVectorStore } from "./helpers.ts";

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
    handler: async (input) => input
  });
  registry.register({
    id: "memory.query",
    description: "memory",
    scopes: ["read"],
    kind: "in_process",
    allowedRoles: ["coordinator", "explorer"],
    handler: async () => ({ ok: true })
  });
  registry.registerDynamic({
    id: "dynamic.note",
    description: "note",
    scopes: ["write"],
    kind: "in_process",
    allowedRoles: ["builder", "coordinator"],
    handler: async (input) => ({ saved: input })
  });
  const runtime = new AgentRuntime(
    config,
    adapter,
    new SessionStore(database),
    new MemoryStore(
      database,
      config,
      makeDisabledEmbeddings(),
      makeFakeVectorStore({ backend: "qdrant", available: false, configured: false }),
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
        { role: "verifier", objective: "check regressions" }
      ]
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
    handler: async () => ({ ok: true })
  });
  await assert.rejects(
    () =>
      registry.call(
        "echo.summary",
        null,
        {
          mode: "read_only",
          fileGlobs: ["**/*"],
          allowedToolIds: [],
          allowedMcpServers: []
        }
      ),
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
        yield { type: "response.created", response: { id: "resp_1", model: "gpt-5" } };
        yield {
          type: "response.function_call_arguments.done",
          item_id: "call_1",
          name: "echo.summary",
          arguments: "{\"topic\":\"production\"}"
        };
        yield { type: "response.completed", response: { id: "resp_1" } };
        return;
      }
      yield { type: "response.created", response: { id: "resp_2", model: "gpt-5" } };
      yield { type: "response.output_text.delta", item_id: "msg_1", delta: "tool complete" };
      yield { type: "response.output_text.done" };
      yield { type: "response.completed", response: { id: "resp_2" } };
    }
  });
  const registry = new ToolRegistry();
  registry.register({
    id: "echo.summary",
    description: "echo",
    scopes: ["read"],
    kind: "in_process",
    handler: async (input) => ({ echoed: input })
  });

  const runtime = new AgentRuntime(
    config,
    adapter,
    new SessionStore(database),
    new MemoryStore(
      database,
      config,
      makeDisabledEmbeddings(),
      makeFakeVectorStore({ backend: "qdrant", available: false, configured: false }),
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
        allowedMcpServers: []
      },
      toolCapabilities: registry.list()
    },
    async () => {}
  );

  assert.equal(result.result.outputText, "tool complete");
  assert.equal(iteration, 2);
  database.close();
});
