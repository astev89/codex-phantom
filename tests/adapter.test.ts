import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOpenAiEvent, CodexAdapter } from "../src/agent/codex-adapter.ts";
import type { AgentRunRequest } from "../src/agent/types.ts";
import { makeConfig } from "./helpers.ts";

const baseConfig = makeConfig();

function makeRequest(): AgentRunRequest {
  return {
    runId: "run_x",
    sessionId: "session_x",
    role: "coordinator",
    systemPrompt: "system",
    messages: [{ role: "user", content: "hello world" }],
    memory: { episodic: [], semantic: [], procedural: [], summaries: [] },
    toolCapabilities: [],
    permissionPolicy: {
      mode: "full_access",
      fileGlobs: ["**/*"],
      allowedToolIds: [],
      allowedMcpServers: []
    },
    model: "gpt-5",
    reasoningEffort: "medium"
  };
}

test("normalizes OpenAI streaming text and completion events", () => {
  const state = {
    outputText: "",
    toolCalls: new Map<string, { name: string; argumentsText: string }>()
  };

  const created = normalizeOpenAiEvent({ runId: "run_1", sessionId: "session_1" }, {
    type: "response.created",
    response: { id: "resp_1", model: "gpt-5" }
  }, state);
  const delta = normalizeOpenAiEvent({ runId: "run_1", sessionId: "session_1" }, {
    type: "response.output_text.delta",
    item_id: "msg_1",
    delta: "hello"
  }, state);
  const done = normalizeOpenAiEvent({ runId: "run_1", sessionId: "session_1" }, {
    type: "response.output_text.done"
  }, state);

  assert.deepEqual(created, [
    {
      type: "init",
      runId: "run_1",
      sessionId: "session_1",
      providerSessionId: "resp_1",
      model: "gpt-5"
    }
  ]);
  assert.deepEqual(delta, [
    {
      type: "text_delta",
      runId: "run_1",
      sessionId: "session_1",
      messageId: "msg_1",
      delta: "hello"
    }
  ]);
  assert.deepEqual(done, [
    {
      type: "message_complete",
      runId: "run_1",
      sessionId: "session_1",
      messageId: "msg_1",
      content: "hello"
    },
    {
      type: "structured_message",
      runId: "run_1",
      message: { role: "assistant", content: "hello" }
    }
  ]);
});

test("normalizes tool call request events", () => {
  const state = {
    outputText: "",
    toolCalls: new Map<string, { name: string; argumentsText: string }>()
  };

  const delta = normalizeOpenAiEvent({ runId: "run_2", sessionId: "session_2" }, {
    type: "response.function_call_arguments.delta",
    item_id: "tool_1",
    name: "repo.search",
    arguments_delta: "{\"query\":\"cod"
  }, state);
  const done = normalizeOpenAiEvent({ runId: "run_2", sessionId: "session_2" }, {
    type: "response.function_call_arguments.done",
    item_id: "tool_1",
    name: "repo.search",
    arguments: "{\"query\":\"codex\"}"
  }, state);

  assert.deepEqual(delta, [
    {
      type: "tool_call_delta",
      runId: "run_2",
      sessionId: "session_2",
      toolCallId: "tool_1",
      delta: "{\"query\":\"cod"
    }
  ]);
  assert.deepEqual(done, [
    {
      type: "tool_call_requested",
      runId: "run_2",
      sessionId: "session_2",
      toolCallId: "tool_1",
      toolName: "repo.search",
      argumentsText: "{\"query\":\"codex\"}"
    }
  ]);
});

test("fallback adapter emits deterministic output and normalized completion", async () => {
  const adapter = new CodexAdapter(baseConfig, { mode: "fallback" });
  const events: string[] = [];
  const request = makeRequest();

  const result = await adapter.run(request, async (event) => {
    events.push(event.type);
  });

  assert.match(result.outputText, /Fallback mode engaged/);
  assert.equal(result.usedFallback, true);
  assert.equal(result.toolCalls.length, 0);
  assert.equal(events[0], "init");
  assert.ok(events.includes("message_complete"));
  assert.ok(events.includes("final_result"));
  assert.equal(events.at(-1), "final");
});

test("openai mode can return tool requests without network access", async () => {
  const adapter = new CodexAdapter(
    {
      ...baseConfig,
      openAiApiKey: "test-key"
    },
    {
      mode: "openai",
      transport: async function* () {
        yield {
          type: "response.created",
          response: { id: "resp_live", model: "gpt-5" }
        };
        yield {
          type: "response.function_call_arguments.done",
          item_id: "call_1",
          name: "echo.summary",
          arguments: "{\"message\":\"hi\"}"
        };
        yield {
          type: "response.completed",
          response: {
            id: "resp_live",
            usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
          }
        };
      }
    }
  );

  const result = await adapter.run(makeRequest(), async () => {});

  assert.equal(result.outputText, "");
  assert.equal(result.previousResponseId, "resp_live");
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(result.toolCalls[0], {
    toolCallId: "call_1",
    toolName: "echo.summary",
    argumentsText: "{\"message\":\"hi\"}"
  });
});

test("openai mode aborts outbound responses requests after the configured timeout", async () => {
  const originalFetch = globalThis.fetch;
  const adapter = new CodexAdapter(
    {
      ...baseConfig,
      openAiApiKey: "test-key",
      openAiRequestTimeoutMs: 20
    },
    { mode: "openai" }
  );

  globalThis.fetch = (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
      setTimeout(() => reject(new Error("request did not abort")), 100);
    });

    throw signal.reason ?? new Error("aborted");
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => adapter.run(makeRequest(), async () => {}),
      /timed out/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("openai mode honors caller abort signals for outbound responses requests", async () => {
  const originalFetch = globalThis.fetch;
  const adapter = new CodexAdapter(
    {
      ...baseConfig,
      openAiApiKey: "test-key"
    },
    { mode: "openai" }
  );
  const controller = new AbortController();

  globalThis.fetch = (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    assert.equal(signal.aborted, true);
    throw signal.reason ?? new Error("caller aborted");
  }) as typeof fetch;

  controller.abort(new Error("caller aborted"));

  try {
    await assert.rejects(
      () => adapter.run({ ...makeRequest(), signal: controller.signal }, async () => {}),
      /caller aborted/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
