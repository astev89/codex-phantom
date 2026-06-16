import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "../src/mcp/server.ts";
import { McpAuditStore } from "../src/mcp/audit.ts";
import { AppDatabase } from "../src/platform/database.ts";
import { MetricsStore } from "../src/platform/metrics.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { AutonomousAssignmentService } from "../src/assignments/service.ts";
import { registerAssignmentTools } from "../src/assignments/tools.ts";
import { AutonomousMutationLedger } from "../src/assignments/mutation-ledger.ts";

test("McpServer authenticates without retaining the raw bearer token and records audit metrics", async () => {
  const tools = new ToolRegistry();
  tools.register({
    id: "echo",
    description: "echo input",
    scopes: ["read"],
    kind: "in_process",
    handler: async (input) => ({ input }),
  });
  tools.register({
    id: "write.note",
    description: "write note",
    scopes: ["write"],
    kind: "in_process",
    handler: async (input) => ({ saved: input }),
  });
  const metrics = new MetricsStore();
  const mcp = new McpServer("mcp-secret", tools, metrics, {
    mode: "read_only",
    fileGlobs: [],
    allowedToolIds: ["echo"],
    allowedMcpServers: [],
  });

  assert.equal(JSON.stringify(mcp).includes("mcp-secret"), false);

  const unauthorized = await mcp.handle(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method: "tools/list" }),
    })
  );
  assert.equal(unauthorized.status, 401);

  const list = await mcp.handle(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer mcp-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method: "tools/list" }),
    })
  );
  assert.equal(list.status, 200);

  const call = await mcp.handle(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer mcp-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        method: "tools/call",
        params: {
          name: "echo",
          input: { hello: "world" },
        },
      }),
    })
  );
  assert.equal(call.status, 200);

  const blockedWrite = await mcp.handle(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer mcp-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        method: "tools/call",
        params: {
          name: "write.note",
          input: { secret: true },
          policy: {
            mode: "full_access",
            fileGlobs: ["**/*"],
            allowedToolIds: ["write.note"],
            allowedMcpServers: [],
          },
        },
      }),
    })
  );
  assert.equal(blockedWrite.status, 400);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters["mcp.auth.failure"], 1);
  assert.equal(snapshot.counters["mcp.auth.success"], 3);
  assert.equal(snapshot.counters["mcp.method.tools_list"], 1);
  assert.equal(snapshot.counters["mcp.method.tools_call"], 2);
  assert.equal(snapshot.counters["mcp.tool_call.echo"], 1);
  assert.equal(snapshot.counters["mcp.tool_call.write.note"], undefined);
  assert.equal(snapshot.counters["mcp.tool_call.denied"], 1);
});

test("McpServer records durable audit rows for auth failures and tool outcomes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-mcp-audit-"));
  const database = new AppDatabase(join(dataDir, "mcp-audit.sqlite"));
  const audit = new McpAuditStore(database);
  const tools = new ToolRegistry();
  tools.register({
    id: "echo",
    description: "echo input",
    scopes: ["read"],
    kind: "in_process",
    handler: async (input) => ({ input }),
  });
  tools.register({
    id: "explode",
    description: "throw an error",
    scopes: ["read"],
    kind: "in_process",
    handler: async () => {
      throw new Error("boom");
    },
  });
  const mcp = new McpServer(
    "secret",
    tools,
    new MetricsStore(),
    {
      mode: "read_only",
      fileGlobs: [],
      allowedToolIds: ["echo", "explode"],
      allowedMcpServers: [],
    },
    audit
  );

  try {
    await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method: "tools/list" }),
      })
    );

    await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method: "tools/list" }),
      })
    );

    await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method: "tools/call",
          params: {
            name: "echo",
            input: { hello: "world" },
          },
        }),
      })
    );

    await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method: "tools/call",
          params: {
            name: "missing.tool",
          },
        }),
      })
    );

    await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method: "tools/call",
          params: {
            name: "explode",
          },
        }),
      })
    );

    await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method: "tools/nope" }),
      })
    );

    const rows = audit.list(10);
    assert.equal(rows.length, 6);
    assert.equal(rows[0]?.outcome, "unsupported");
    assert.equal(rows[1]?.outcome, "failed");
    assert.equal(rows[1]?.toolName, "explode");
    assert.equal(rows[2]?.outcome, "denied");
    assert.equal(rows[2]?.toolName, "missing.tool");
    assert.equal(rows[3]?.outcome, "success");
    assert.equal(rows[3]?.toolName, "echo");
    assert.equal(rows[4]?.outcome, "success");
    assert.equal(rows[4]?.method, "tools/list");
    assert.equal(rows[5]?.outcome, "auth_failed");
    assert.equal(
      rows.every((row) => row.errorMessage !== "secret"),
      true
    );
    assert.equal(JSON.stringify(rows).includes("Bearer secret"), false);
    assert.equal(JSON.stringify(rows).includes("hello"), false);
  } finally {
    database.close();
  }
});

test("McpServer treats audit write failures as best-effort", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "codex-phantom-mcp-audit-failure-")
  );
  const database = new AppDatabase(join(dataDir, "mcp-audit-failure.sqlite"));
  const audit = new McpAuditStore(database);
  audit.record = (() => {
    throw new Error("audit unavailable");
  }) as McpAuditStore["record"];
  const tools = new ToolRegistry();
  const metrics = new MetricsStore();
  const mcp = new McpServer(
    "secret",
    tools,
    metrics,
    {
      mode: "read_only",
      fileGlobs: [],
      allowedToolIds: [],
      allowedMcpServers: [],
    },
    audit
  );

  try {
    const response = await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method: "tools/list" }),
      })
    );

    assert.equal(response.status, 200);
    assert.equal(metrics.snapshot().counters["mcp.audit.failure"], 1);
  } finally {
    database.close();
  }
});

test("McpServer exposes read-only assignment tools with actionable missing-id errors", async () => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "codex-phantom-mcp-assignments-")
  );
  const database = new AppDatabase(join(dataDir, "assignments.sqlite"));
  const assignments = new AutonomousAssignmentService(database);
  const mutations = new AutonomousMutationLedger(database, assignments);
  const created = assignments.create({
    objective: "Track autonomous assignment MCP visibility",
    source: { channelId: "slack" },
  });
  const mutation = mutations.recordPlanned({
    assignmentId: created.assignment.id,
    target: "configuration",
    mutationType: "operator_settings",
    autonomyLevel: "evolve",
    authorizingPolicy: { rule: "mcp-test" },
    rationale: "Expose assignment mutation ledger through MCP.",
    riskClass: "low",
  });
  const tools = new ToolRegistry();
  registerAssignmentTools(tools, assignments, mutations);
  const mcp = new McpServer("secret", tools, new MetricsStore());

  try {
    const listTools = await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method: "tools/list" }),
      })
    );
    assert.equal(listTools.status, 200);
    const listToolsJson = (await listTools.json()) as {
      tools: Array<{
        id: string;
        scopes: string[];
        inputSchema: {
          properties?: Record<string, { type?: string }>;
        };
      }>;
    };
    assert.deepEqual(listToolsJson.tools.map((tool) => tool.id).sort(), [
      "assignment.get",
      "assignment.list",
      "assignment.mutations",
      "assignment.timeline",
    ]);
    assert.equal(
      listToolsJson.tools.every((tool) => tool.scopes.includes("read")),
      true
    );
    assert.equal(
      listToolsJson.tools.some((tool) => tool.id.includes("compact")),
      false
    );
    const listTool = listToolsJson.tools.find(
      (tool) => tool.id === "assignment.list"
    );
    const timelineTool = listToolsJson.tools.find(
      (tool) => tool.id === "assignment.timeline"
    );
    const mutationsTool = listToolsJson.tools.find(
      (tool) => tool.id === "assignment.mutations"
    );
    assert.equal(listTool?.inputSchema.properties?.limit?.type, "integer");
    assert.equal(timelineTool?.inputSchema.properties?.limit?.type, "integer");
    assert.equal(mutationsTool?.inputSchema.properties?.limit?.type, "integer");

    const listCall = await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method: "tools/call",
          params: {
            name: "assignment.list",
            input: { sourceChannelId: "slack" },
          },
        }),
      })
    );
    assert.equal(listCall.status, 200);
    const listCallJson = (await listCall.json()) as {
      output: {
        assignments: Array<{
          id: string;
          policy: {
            childAssignments: { maxDepth: number; maxActiveChildren: number };
          };
        }>;
      };
    };
    assert.equal(listCallJson.output.assignments[0]?.id, created.assignment.id);
    assert.deepEqual(
      listCallJson.output.assignments[0]?.policy.childAssignments,
      {
        maxDepth: 2,
        maxActiveChildren: 3,
      }
    );

    const getCall = await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method: "tools/call",
          params: {
            name: "assignment.get",
            input: { id: created.assignment.id },
          },
        }),
      })
    );
    assert.equal(getCall.status, 200);
    const getCallJson = (await getCall.json()) as {
      output: {
        assignment: {
          id: string;
          policy: {
            childAssignments: { maxDepth: number; maxActiveChildren: number };
          };
        };
      };
    };
    assert.equal(getCallJson.output.assignment.id, created.assignment.id);
    assert.deepEqual(getCallJson.output.assignment.policy.childAssignments, {
      maxDepth: 2,
      maxActiveChildren: 3,
    });

    assignments.control(created.assignment.id, {
      action: "add_context",
      context: { note: "Compactable detail visible through MCP summary" },
    });
    database.run(
      `UPDATE assignment_events
       SET expires_at = ?
       WHERE assignment_id = ? AND type = ?`,
      "2026-06-01T00:00:00.000Z",
      created.assignment.id,
      "context_added"
    );
    assignments.compactEvents({
      assignmentId: created.assignment.id,
      compactBefore: "2026-06-16T00:00:00.000Z",
    });

    const timelineCall = await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method: "tools/call",
          params: {
            name: "assignment.timeline",
            input: { id: created.assignment.id },
          },
        }),
      })
    );
    assert.equal(timelineCall.status, 200);
    const timelineCallJson = (await timelineCall.json()) as {
      output: { timeline: { events: Array<{ type: string }> } };
    };
    assert.equal(timelineCallJson.output.timeline.events[0]?.type, "created");
    assert.equal(
      timelineCallJson.output.timeline.events.some(
        (event) => event.type === "events_compacted"
      ),
      true
    );

    const mutationsCall = await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method: "tools/call",
          params: {
            name: "assignment.mutations",
            input: { assignmentId: created.assignment.id },
          },
        }),
      })
    );
    assert.equal(mutationsCall.status, 200);
    const mutationsCallJson = (await mutationsCall.json()) as {
      output: { mutations: Array<{ id: string }> };
    };
    assert.equal(mutationsCallJson.output.mutations[0]?.id, mutation.id);

    const missingCall = await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method: "tools/call",
          params: {
            name: "assignment.get",
            input: { id: "asgn_missing" },
          },
        }),
      })
    );
    assert.equal(missingCall.status, 400);
    const missingCallJson = (await missingCall.json()) as { error: string };
    assert.match(missingCallJson.error, /assignment\.list/);

    const missingMutationsCall = await mcp.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method: "tools/call",
          params: {
            name: "assignment.mutations",
            input: { assignmentId: "asgn_missing" },
          },
        }),
      })
    );
    assert.equal(missingMutationsCall.status, 400);
    const missingMutationsCallJson = (await missingMutationsCall.json()) as {
      error: string;
    };
    assert.match(missingMutationsCallJson.error, /assignment\.list/);
  } finally {
    database.close();
  }
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
