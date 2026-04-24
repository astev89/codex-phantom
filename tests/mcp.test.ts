import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "../src/mcp/server.ts";
import { MetricsStore } from "../src/platform/metrics.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

test("McpServer authenticates without retaining the raw bearer token and records audit metrics", async () => {
  const tools = new ToolRegistry();
  tools.register({
    id: "echo",
    description: "echo input",
    scopes: ["read"],
    kind: "in_process",
    handler: async (input) => ({ input })
  });
  const metrics = new MetricsStore();
  const mcp = new McpServer("mcp-secret", tools, metrics);

  assert.equal(JSON.stringify(mcp).includes("mcp-secret"), false);

  const unauthorized = await mcp.handle(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer wrong",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ method: "tools/list" })
  }));
  assert.equal(unauthorized.status, 401);

  const list = await mcp.handle(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer mcp-secret",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ method: "tools/list" })
  }));
  assert.equal(list.status, 200);

  const call = await mcp.handle(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer mcp-secret",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      method: "tools/call",
      params: {
        name: "echo",
        input: { hello: "world" }
      }
    })
  }));
  assert.equal(call.status, 200);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters["mcp.auth.failure"], 1);
  assert.equal(snapshot.counters["mcp.auth.success"], 2);
  assert.equal(snapshot.counters["mcp.method.tools_list"], 1);
  assert.equal(snapshot.counters["mcp.method.tools_call"], 1);
  assert.equal(snapshot.counters["mcp.tool_call.echo"], 1);
});

test("MetricsStore renders a Prometheus text snapshot", () => {
  const metrics = new MetricsStore();
  metrics.increment("mcp.auth.success", 2);
  metrics.observe("http.request.duration_ms", 25);
  metrics.observe("http.request.duration_ms", 75);

  const text = metrics.toPrometheus();

  assert.match(text, /codex_phantom_mcp_auth_success 2/);
  assert.match(text, /codex_phantom_http_request_duration_ms_count 2/);
  assert.match(text, /codex_phantom_http_request_duration_ms_sum 100/);
  assert.match(text, /codex_phantom_http_request_duration_ms_avg 50/);
});
