import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("phantomctl loads config from .env with process env precedence", async () => {
  const result = (await runPhantomctlExpression(`
    const config = await loadConfig({
      cwd: "/tmp/phantomctl-test",
      env: {
        PHANTOM_TRANSPORT: "docker",
        OPERATOR_BEARER_TOKEN: "process-token"
      },
      existsSync: () => true,
      readFile: async () => "OPERATOR_BEARER_TOKEN=file-token\\nPHANTOM_BASE_URL=http://file.local\\n"
    });
    console.log(JSON.stringify(config));
  `)) as Record<string, string>;

  assert.equal(result.baseUrl, "http://file.local");
  assert.equal(result.operatorToken, "process-token");
  assert.equal(result.transport, "docker");
});

test("phantomctl status summarizes health, readiness, tools, and failures", async () => {
  const result = (await runPhantomctlExpression(`
    const routes = {
      "/health": { body: { ok: true, modelAdapter: "openai" } },
      "/admin/readiness": {
        body: {
          readiness: {
            status: "ready",
            summary: { passing: 15, warnings: 1, failures: 0 }
          }
        }
      },
      "/admin/summary": {
        body: {
          diagnostics: { model: { name: "gpt-5.4" } },
          channelDeliveries: { failed: 2 }
        }
      },
      "/tools/dynamic": { body: { tools: [{ id: "web.fetch" }] } }
    };
    const calls = [];
    const result = await runCommand(["status"], {
      env: { OPERATOR_BEARER_TOKEN: "token" },
      existsSync: () => false,
      requester: mockRequester(routes, calls)
    });
    console.log(JSON.stringify({ result, calls }));
  `)) as {
    result: { exitCode: number; stdout: string };
    calls: Array<{ path: string }>;
  };

  assert.equal(result.result.exitCode, 0);
  assert.match(result.result.stdout, /Phantom status \(mock\)/);
  assert.match(result.result.stdout, /Readiness: ready/);
  assert.match(
    result.result.stdout,
    /Setup checks: 15 pass, 1 warning, 0 fail/
  );
  assert.match(result.result.stdout, /Model: gpt-5.4/);
  assert.match(result.result.stdout, /Tools: 1 dynamic/);
  assert.deepEqual(result.calls.map((call) => call.path).sort(), [
    "/admin/readiness",
    "/admin/summary",
    "/health",
    "/tools/dynamic",
  ]);
});

test("phantomctl status summarizes blocked readiness instead of hard-failing", async () => {
  const result = (await runPhantomctlExpression(`
    const routes = {
      "/health": { body: { ok: true, modelAdapter: "openai" } },
      "/admin/readiness": {
        status: 503,
        body: {
          readiness: {
            status: "blocked",
            summary: { passing: 12, warnings: 0, failures: 2 }
          }
        }
      },
      "/admin/summary": { body: { channelDeliveries: { failed: 0 } } },
      "/tools/dynamic": { body: { tools: [] } }
    };
    const result = await runCommand(["status"], {
      env: { OPERATOR_BEARER_TOKEN: "token" },
      existsSync: () => false,
      requester: mockRequester(routes, [])
    });
    console.log(JSON.stringify(result));
  `)) as { exitCode: number; stdout: string };

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Readiness: blocked/);
  assert.match(result.stdout, /Setup checks: 12 pass, 0 warning, 2 fail/);
});

test("phantomctl status tolerates optional admin probe failures", async () => {
  const result = (await runPhantomctlExpression(`
    const routes = {
      "/health": { body: { ok: true, modelAdapter: "openai" } },
      "/admin/readiness": {
        body: {
          readiness: {
            status: "ready",
            summary: { passing: 15, warnings: 0, failures: 0 }
          }
        }
      },
      "/admin/summary": {
        status: 500,
        body: { error: "summary unavailable" }
      },
      "/tools/dynamic": {
        status: 503,
        body: { error: "tools unavailable" }
      }
    };
    const result = await runCommand(["status"], {
      env: { OPERATOR_BEARER_TOKEN: "token" },
      existsSync: () => false,
      requester: mockRequester(routes, [])
    });
    console.log(JSON.stringify(result));
  `)) as { exitCode: number; stdout: string };

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Health: ok/);
  assert.match(result.stdout, /Readiness: ready/);
  assert.match(result.stdout, /Model: openai/);
  assert.match(result.stdout, /Tools: 0 dynamic/);
  assert.match(result.stdout, /Warning: \/admin\/summary unavailable/);
  assert.match(result.stdout, /Warning: \/tools\/dynamic unavailable/);
});

test("phantomctl status still fails when health is unavailable", async () => {
  const result = (await runPhantomctlExpression(`
    const result = await runCommand(["status"], {
      env: { OPERATOR_BEARER_TOKEN: "token" },
      existsSync: () => false,
      requester: mockRequester({
        "/health": { status: 500, body: { error: "health unavailable" } }
      }, [])
    });
    console.log(JSON.stringify(result));
  `)) as { exitCode: number; stderr: string };

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /\/health returned HTTP 500/);
});

test("phantomctl status still fails when readiness is unavailable", async () => {
  const result = (await runPhantomctlExpression(`
    const result = await runCommand(["status"], {
      env: { OPERATOR_BEARER_TOKEN: "token" },
      existsSync: () => false,
      requester: mockRequester({
        "/health": { body: { ok: true, modelAdapter: "openai" } },
        "/admin/readiness": {
          status: 500,
          body: { error: "readiness unavailable" }
        }
      }, [])
    });
    console.log(JSON.stringify(result));
  `)) as { exitCode: number; stderr: string };

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /\/admin\/readiness returned HTTP 500/);
});

test("phantomctl chat parses SSE tool progress and final output", async () => {
  const sse = [
    {
      type: "agent.event",
      sessionId: "session_1",
      runId: "coord_1",
      rawEvent: {
        type: "tool_call_started",
        runId: "coord_1",
        toolCallId: "call_1",
        toolName: "browser.open",
      },
      payload: {},
    },
    {
      type: "agent.event",
      sessionId: "session_1",
      runId: "coord_1",
      rawEvent: {
        type: "tool_call_succeeded",
        runId: "coord_1",
        toolCallId: "call_1",
        toolName: "browser.open",
        output: "{}",
      },
      payload: {},
    },
    {
      type: "run.completed",
      sessionId: "session_1",
      runId: "coord_1",
      payload: { outputText: "The page is readable." },
    },
  ]
    .map(
      (event) =>
        "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n"
    )
    .join("");
  const result = (await runPhantomctlExpression(`
    const calls = [];
    const result = await runCommand(["chat", "review", "https://example.com"], {
      env: { OPERATOR_BEARER_TOKEN: "token" },
      existsSync: () => false,
      requester: mockRequester({
        "/chat/message": { text: ${JSON.stringify(sse)} }
      }, calls)
    });
    console.log(JSON.stringify({ result, calls }));
  `)) as {
    result: { exitCode: number; stdout: string };
    calls: Array<{ path: string; options: { body: { message: string } } }>;
  };

  assert.equal(result.result.exitCode, 0);
  assert.equal(result.calls[0].path, "/chat/message");
  assert.equal(
    result.calls[0].options.body.message,
    "review https://example.com"
  );
  assert.match(result.result.stdout, /Tool started: browser\.open/);
  assert.match(result.result.stdout, /Tool succeeded: browser\.open/);
  assert.match(result.result.stdout, /Session: session_1/);
  assert.match(result.result.stdout, /Run: coord_1/);
  assert.match(result.result.stdout, /The page is readable\./);
});

test("phantomctl chat prints assignment acknowledgements", async () => {
  const sse = [
    {
      type: "assignment.created",
      payload: {
        acknowledgementText: "Assignment created. I will keep working.",
        duplicate: false,
      },
    },
    {
      type: "request.completed",
      payload: { status: "assignment_created" },
    },
  ]
    .map(
      (event) =>
        "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n"
    )
    .join("");
  const result = (await runPhantomctlExpression(`
    const result = await runCommand(["chat", "keep", "watching", "this"], {
      env: { OPERATOR_BEARER_TOKEN: "token" },
      existsSync: () => false,
      requester: mockRequester({
        "/chat/message": { text: ${JSON.stringify(sse)} }
      }, [])
    });
    console.log(JSON.stringify(result));
  `)) as { exitCode: number; stdout: string };

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Assignment created\. I will keep working\./);
});

test("phantomctl lists and drills into runs, sessions, and tools", async () => {
  const result = (await runPhantomctlExpression(`
    const routes = {
      "/runs": { body: { runs: [{ runId: "coord_1", status: "completed", role: "coordinator" }] } },
      "/admin/runs/coord_1": { body: { run: { runId: "coord_1" }, events: [] } },
      "/chat/sessions": { body: { sessions: [{ sessionId: "session_1", title: "URL review" }] } },
      "/chat/sessions/session_1": { body: { session: { sessionId: "session_1" }, runs: [] } },
      "/tools/dynamic": { body: { tools: [{ id: "browser.open", status: "active" }] } },
      "/admin/tools/governance": { body: { tools: [{ toolId: "browser.open", status: "approved" }] } }
    };
    const calls = [];
    const runs = await runCommand(["runs"], {
      env: { OPERATOR_BEARER_TOKEN: "token" },
      existsSync: () => false,
      requester: mockRequester(routes, calls)
    });
    const run = await runCommand(["run", "coord_1"], {
      env: { OPERATOR_BEARER_TOKEN: "token" },
      existsSync: () => false,
      requester: mockRequester(routes, calls)
    });
    const sessions = await runCommand(["sessions"], {
      env: { OPERATOR_BEARER_TOKEN: "token" },
      existsSync: () => false,
      requester: mockRequester(routes, calls)
    });
    const session = await runCommand(["session", "session_1"], {
      env: { OPERATOR_BEARER_TOKEN: "token" },
      existsSync: () => false,
      requester: mockRequester(routes, calls)
    });
    const tools = await runCommand(["tools"], {
      env: { OPERATOR_BEARER_TOKEN: "token" },
      existsSync: () => false,
      requester: mockRequester(routes, calls)
    });
    console.log(JSON.stringify({ runs, run, sessions, session, tools }));
  `)) as Record<string, { stdout: string; exitCode: number }>;

  assert.match(result.runs.stdout, /coord_1 completed coordinator/);
  assert.match(result.run.stdout, /"runId": "coord_1"/);
  assert.match(result.sessions.stdout, /session_1 URL review/);
  assert.match(result.session.stdout, /"sessionId": "session_1"/);
  assert.match(result.tools.stdout, /browser\.open active/);
  assert.match(result.tools.stdout, /browser\.open approved/);
});

test("phantomctl HTTP transport reports missing operator token", async () => {
  const result = (await runPhantomctlExpression(`
    const result = await runCommand(["status"], {
      env: { PHANTOM_TRANSPORT: "http" },
      existsSync: () => false,
      fetch: async () => ({ status: 200, text: async () => "{}" })
    });
    console.log(JSON.stringify(result));
  `)) as { exitCode: number; stderr: string };

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /OPERATOR_BEARER_TOKEN is required/);
});

test("phantomctl auto transport falls back from HTTP connection failure to docker", async () => {
  const result = (await runPhantomctlExpression(`
    const config = {
      baseUrl: "http://localhost:3210",
      operatorToken: "token",
      transport: "auto",
      dockerContainer: "codex-phantom-codex-phantom-1"
    };
    const requester = createRequester(config, {
      fetch: async () => {
        throw new Error("connection refused");
      },
      spawnSync: () => ({
        status: 0,
        stdout: JSON.stringify({ status: 200, text: JSON.stringify({ ok: true }) }),
        stderr: ""
      })
    });
    const response = await requester("/health", { auth: false });
    console.log(JSON.stringify(response));
  `)) as { status: number; transport: string; text: string };

  assert.equal(result.status, 200);
  assert.equal(result.transport, "docker");
  assert.equal(JSON.parse(result.text).ok, true);
});

test("phantomctl auto transport does not replay failed side-effecting requests", async () => {
  const result = (await runPhantomctlExpression(`
    const config = {
      baseUrl: "http://localhost:3210",
      operatorToken: "token",
      transport: "auto",
      dockerContainer: "codex-phantom-codex-phantom-1"
    };
    const calls = [];
    let dockerCalls = 0;
    const requester = createRequester(config, {
      fetch: async (url, init) => {
        calls.push({ url: String(url), method: init.method });
        if (String(url).endsWith("/health")) {
          return { status: 200, text: async () => JSON.stringify({ ok: true }) };
        }
        throw new Error("stream failed");
      },
      spawnSync: () => {
        dockerCalls += 1;
        return {
          status: 0,
          stdout: JSON.stringify({ status: 200, text: "" }),
          stderr: ""
        };
      }
    });
    try {
      await requester("/chat/message", {
        method: "POST",
        body: { message: "hello" }
      });
    } catch (error) {
      console.log(JSON.stringify({
        message: error.message,
        calls,
        dockerCalls
      }));
    }
  `)) as {
    message: string;
    calls: Array<{ url: string; method: string }>;
    dockerCalls: number;
  };

  assert.match(result.message, /Not retrying POST through docker/);
  assert.equal(result.dockerCalls, 0);
  assert.deepEqual(
    result.calls.map((call) => [new URL(call.url).pathname, call.method]),
    [
      ["/health", "GET"],
      ["/chat/message", "POST"],
    ]
  );
});

test("phantomctl docker transport resolves the container from docker compose ps", async () => {
  const result = (await runPhantomctlExpression(`
    const config = {
      baseUrl: "http://localhost:3210",
      operatorToken: "token",
      transport: "docker",
      cwd: "/tmp/worktree-abc123",
      dockerContainer: ""
    };
    const spawnCalls = [];
    const requester = createRequester(config, {
      fetch: async () => { throw new Error("http disabled"); },
      spawnSync: (command, args) => {
        spawnCalls.push({ command, args });
        if (args[0] === "compose") {
          return {
            status: 0,
            stdout: JSON.stringify({ Name: "worktree-abc123-codex-phantom-1", Service: "codex-phantom" }),
            stderr: ""
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify({ status: 200, text: JSON.stringify({ ok: true }) }),
          stderr: ""
        };
      }
    });
    const response = await requester("/health", { auth: false });
    console.log(JSON.stringify({ response, spawnCalls }));
  `)) as {
    response: { status: number; transport: string; text: string };
    spawnCalls: Array<{ command: string; args: string[] }>;
  };

  assert.equal(result.response.status, 200);
  assert.equal(result.response.transport, "docker");
  const composeCall = result.spawnCalls.find(
    (call) => call.args[0] === "compose"
  );
  assert.ok(composeCall, "expected a docker compose ps call");
  assert.deepEqual(composeCall?.args, [
    "compose",
    "ps",
    "--format",
    "json",
    "codex-phantom",
  ]);
  const execCall = result.spawnCalls.find((call) => call.args[0] === "exec");
  assert.ok(execCall, "expected a docker exec call");
  assert.equal(execCall?.args[2], "worktree-abc123-codex-phantom-1");
});

test("phantomctl docker transport fails clearly when the container is not running", async () => {
  const result = (await runPhantomctlExpression(`
    const config = {
      baseUrl: "http://localhost:3210",
      operatorToken: "token",
      transport: "docker",
      cwd: "/tmp/worktree-abc123",
      dockerContainer: ""
    };
    const requester = createRequester(config, {
      fetch: async () => { throw new Error("http disabled"); },
      spawnSync: (command, args) => {
        if (args[0] === "compose") {
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error("should not exec when container is unresolved");
      }
    });
    try {
      await requester("/health", { auth: false });
      console.log(JSON.stringify({ error: null }));
    } catch (error) {
      console.log(JSON.stringify({ error: error.message }));
    }
  `)) as { error: string | null };

  assert.match(String(result.error), /container is not running/);
});

async function runPhantomctlExpression(expression: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import {
          createRequester,
          loadConfig,
          runCommand
        } from "./scripts/phantomctl.mjs";

        function mockRequester(routes, calls) {
          return async (path, options = {}) => {
            calls.push({ path, options });
            const route = routes[path];
            if (!route) {
              throw new Error("Unexpected request " + path);
            }
            return {
              status: route.status ?? 200,
              text: route.text ?? JSON.stringify(route.body ?? {}),
              transport: route.transport ?? "mock"
            };
          };
        }

        ${expression}
      `,
    ],
    { cwd: process.cwd() }
  );
  return JSON.parse(stdout);
}
