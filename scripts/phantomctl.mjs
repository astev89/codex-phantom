#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseEnvText } from "./local-stack.mjs";

const defaultBaseUrl = "http://localhost:3210";
const composeService = "codex-phantom";
const dockerContainerCache = new WeakMap();
const commandNames = new Set([
  "help",
  "status",
  "doctor",
  "chat",
  "runs",
  "run",
  "sessions",
  "session",
  "tools",
]);

if (isMain(import.meta.url, process.argv[1])) {
  const result = await runCommand(process.argv.slice(2));
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

export async function runCommand(args, context = {}) {
  const parsed = parseArgs(args);
  const output = [];
  const errors = [];

  try {
    if (parsed.command === "help") {
      output.push(helpText());
      return buildResult(output, errors, 0);
    }

    const config = await loadConfig({
      cwd: context.cwd ?? process.cwd(),
      env: context.env ?? process.env,
      readFile: context.readFile ?? readFile,
      existsSync: context.existsSync ?? existsSync,
    });
    const transportDeps = {
      fetch: context.fetch ?? globalThis.fetch,
      spawnSync: context.spawnSync ?? spawnSync,
    };
    const requester =
      context.requester ?? createRequester(config, transportDeps);
    const httpRequester =
      context.httpRequester ??
      createRequester({ ...config, transport: "http" }, transportDeps);
    const dockerRequester =
      context.dockerRequester ??
      createRequester({ ...config, transport: "docker" }, transportDeps);

    if (parsed.command === "status") {
      output.push(await statusCommand({ config, requester }));
    } else if (parsed.command === "doctor") {
      output.push(
        await doctorCommand({
          config,
          requester,
          httpRequester,
          dockerRequester,
          deps: transportDeps,
        })
      );
    } else if (parsed.command === "chat") {
      output.push(
        await chatCommand({
          config,
          requester,
          parsed,
        })
      );
    } else if (parsed.command === "runs") {
      output.push(await runsCommand({ requester }));
    } else if (parsed.command === "run") {
      output.push(await runDetailCommand({ requester, parsed }));
    } else if (parsed.command === "sessions") {
      output.push(await sessionsCommand({ requester }));
    } else if (parsed.command === "session") {
      output.push(await sessionDetailCommand({ requester, parsed }));
    } else if (parsed.command === "tools") {
      output.push(await toolsCommand({ requester }));
    }

    return buildResult(output, errors, 0);
  } catch (error) {
    errors.push(`${formatError(error)}\n`);
    return buildResult(output, errors, 1);
  }
}

export function parseArgs(args) {
  const command = commandNames.has(args[0]) ? args[0] : "help";
  const rest = command === "help" ? args.slice(1) : args.slice(1);
  const options = {};
  const positional = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex !== -1) {
      options[arg.slice(2, equalsIndex)] = arg.slice(equalsIndex + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--") || key === "json" || key === "events") {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }

  return { command, options, positional };
}

export async function loadConfig({
  cwd = process.cwd(),
  env = process.env,
  readFile: readFileFn = readFile,
  existsSync: existsSyncFn = existsSync,
} = {}) {
  const envPath = resolve(cwd, ".env");
  const envFile = existsSyncFn(envPath)
    ? parseEnvText(await readFileFn(envPath, "utf8"))
    : {};
  const transport =
    env.PHANTOM_TRANSPORT ?? envFile.PHANTOM_TRANSPORT ?? "auto";
  if (!["auto", "http", "docker"].includes(transport)) {
    throw new Error("PHANTOM_TRANSPORT must be one of auto, http, or docker.");
  }
  return {
    baseUrl: env.PHANTOM_BASE_URL ?? envFile.PHANTOM_BASE_URL ?? defaultBaseUrl,
    operatorToken:
      env.OPERATOR_BEARER_TOKEN ?? envFile.OPERATOR_BEARER_TOKEN ?? "",
    transport,
    cwd,
    dockerContainer:
      env.PHANTOM_DOCKER_CONTAINER ?? envFile.PHANTOM_DOCKER_CONTAINER ?? "",
  };
}

export function createRequester(config, deps) {
  return async function request(path, options = {}) {
    const requestOptions = {
      method: options.method ?? "GET",
      path,
      body: options.body,
      auth: options.auth ?? true,
      timeoutMs: options.timeoutMs ?? 30_000,
    };

    if (config.transport === "http") {
      return httpRequest(config, deps, requestOptions);
    }
    if (config.transport === "docker") {
      return dockerRequest(config, deps, requestOptions);
    }
    if (requestOptions.auth && !config.operatorToken) {
      return dockerRequest(config, deps, requestOptions);
    }

    if (!isSafeRequestMethod(requestOptions.method)) {
      try {
        await httpRequest(config, deps, {
          method: "GET",
          path: "/health",
          auth: false,
          timeoutMs: Math.min(requestOptions.timeoutMs, 5_000),
        });
      } catch {
        return dockerRequest(config, deps, requestOptions);
      }

      try {
        return await httpRequest(config, deps, requestOptions);
      } catch (error) {
        if (isHttpStatusError(error)) {
          throw error;
        }
        throw new Error(
          `${formatError(error)}. Not retrying ${requestOptions.method} through docker because the request may have side effects. Set PHANTOM_TRANSPORT=docker to force docker transport.`
        );
      }
    }

    try {
      return await httpRequest(config, deps, requestOptions);
    } catch (error) {
      if (isHttpStatusError(error)) {
        throw error;
      }
      return dockerRequest(config, deps, requestOptions);
    }
  };
}

export function parseSseEvents(text) {
  const events = [];
  for (const chunk of text.split(/\n\n+/)) {
    const dataLines = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "));
    if (dataLines.length === 0) {
      continue;
    }
    const data = dataLines.map((line) => line.slice(6)).join("\n");
    try {
      events.push(JSON.parse(data));
    } catch {
      events.push({ type: "parse.failed", payload: { data } });
    }
  }
  return events;
}

async function statusCommand({ config, requester }) {
  const health = await requestJson(requester, "/health", {
    auth: Boolean(config.operatorToken),
  });
  const readiness = await requestJson(requester, "/admin/readiness", {
    allowStatuses: [503],
  });
  const [summary, dynamicTools] = await Promise.all([
    requestJsonOrNull(requester, "/admin/summary"),
    requestJsonOrNull(requester, "/tools/dynamic"),
  ]);

  return formatStatus({
    transport: health.transport,
    health: health.body,
    readiness: readiness.body,
    summary: summary?.body,
    dynamicTools: dynamicTools?.body,
    warnings: [
      summary ? null : "/admin/summary unavailable",
      dynamicTools ? null : "/tools/dynamic unavailable",
    ].filter(Boolean),
  });
}

async function doctorCommand({
  config,
  requester,
  httpRequester,
  dockerRequester,
  deps,
}) {
  const lines = [
    "Phantom doctor",
    `Base URL: ${config.baseUrl}`,
    `Transport: ${config.transport}`,
    `Docker container: ${describeDockerContainer(config, deps)}`,
    `Operator token: ${config.operatorToken ? "configured" : "missing"}`,
  ];

  try {
    await requestJson(httpRequester, "/health", {
      auth: false,
      timeoutMs: 5_000,
    });
    lines.push("Direct HTTP health: reachable");
  } catch (error) {
    lines.push(`Direct HTTP health: failed - ${formatError(error)}`);
  }

  try {
    await requestJson(dockerRequester, "/health", {
      auth: false,
      timeoutMs: 5_000,
    });
    lines.push("Docker health: reachable");
  } catch (error) {
    lines.push(`Docker health: failed - ${formatError(error)}`);
  }

  try {
    const readiness = await requestJson(requester, "/admin/readiness", {
      allowStatuses: [503],
      timeoutMs: 5_000,
    });
    lines.push(
      `Effective readiness: ${readinessStatus(readiness.body)} by ${readiness.transport}`
    );
  } catch (error) {
    lines.push(`Effective readiness: failed - ${formatError(error)}`);
  }

  lines.push("");
  lines.push("Next commands");
  lines.push("- npm run local:up");
  lines.push("- npm run local:up:build");
  lines.push("- npm run phantom -- status");
  lines.push('- npm run phantom -- chat "review https://example.com"');
  return `${lines.join("\n")}\n`;
}

async function chatCommand({ requester, parsed }) {
  const message = parsed.positional.join(" ").trim();
  if (!message) {
    throw new Error("chat requires a message.");
  }
  const body = {
    message,
    sessionId: stringOption(parsed.options.session),
    conversationId: stringOption(parsed.options.conversation),
    timeoutMs: numberOption(parsed.options.timeout),
  };
  removeUndefined(body);

  const response = await requestText(requester, "/chat/message", {
    method: "POST",
    body,
    timeoutMs: body.timeoutMs ? body.timeoutMs + 5_000 : 300_000,
  });
  const events = parseSseEvents(response.text);
  if (parsed.options.json) {
    return `${JSON.stringify(summarizeChatEvents(events, response.transport), null, 2)}\n`;
  }
  return formatChatTranscript({
    message,
    events,
    transport: response.transport,
    includeEvents: Boolean(parsed.options.events),
  });
}

async function runsCommand({ requester }) {
  const response = await requestJson(requester, "/runs");
  const runs = Array.isArray(response.body.runs) ? response.body.runs : [];
  const lines = [`Runs (${runs.length})`];
  for (const run of runs.slice(0, 20)) {
    lines.push(
      `${run.runId ?? run.id ?? "(unknown)"} ${run.status ?? "unknown"} ${run.role ?? ""} ${run.updatedAt ?? run.createdAt ?? ""}`.trim()
    );
  }
  return `${lines.join("\n")}\n`;
}

async function runDetailCommand({ requester, parsed }) {
  const runId = parsed.positional[0];
  if (!runId) {
    throw new Error("run requires a run id.");
  }
  const response = await requestJson(
    requester,
    `/admin/runs/${encodeURIComponent(runId)}`
  );
  return `${JSON.stringify(response.body, null, 2)}\n`;
}

async function sessionsCommand({ requester }) {
  const response = await requestJson(requester, "/chat/sessions");
  const sessions = Array.isArray(response.body.sessions)
    ? response.body.sessions
    : [];
  const lines = [`Sessions (${sessions.length})`];
  for (const session of sessions.slice(0, 20)) {
    lines.push(
      `${session.sessionId ?? session.id ?? "(unknown)"} ${session.title ?? ""} ${session.updatedAt ?? session.createdAt ?? ""}`.trim()
    );
  }
  return `${lines.join("\n")}\n`;
}

async function sessionDetailCommand({ requester, parsed }) {
  const sessionId = parsed.positional[0];
  if (!sessionId) {
    throw new Error("session requires a session id.");
  }
  const response = await requestJson(
    requester,
    `/chat/sessions/${encodeURIComponent(sessionId)}`
  );
  return `${JSON.stringify(response.body, null, 2)}\n`;
}

async function toolsCommand({ requester }) {
  const dynamic = await requestJson(requester, "/tools/dynamic");
  let governance = null;
  try {
    governance = await requestJson(requester, "/admin/tools/governance");
  } catch {
    governance = null;
  }
  const tools = Array.isArray(dynamic.body.tools) ? dynamic.body.tools : [];
  const governed = Array.isArray(governance?.body?.tools)
    ? governance.body.tools
    : [];
  const lines = [`Dynamic tools (${tools.length})`];
  for (const tool of tools) {
    lines.push(
      `${tool.id ?? tool.name ?? "(unknown)"} ${tool.status ?? tool.state ?? ""}`.trim()
    );
  }
  lines.push(`Governed tools (${governed.length})`);
  for (const tool of governed) {
    lines.push(
      `${tool.toolId ?? tool.id ?? "(unknown)"} ${tool.status ?? ""}`.trim()
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatStatus({
  transport,
  health,
  readiness,
  summary,
  dynamicTools,
  warnings = [],
}) {
  const checks = readinessEnvelope(readiness)?.summary ?? {};
  const tools = Array.isArray(dynamicTools?.tools) ? dynamicTools.tools : [];
  const failures =
    summary?.channelDeliveries?.failed ??
    summary?.channelDeliverySummary?.failed ??
    "unknown";
  const model =
    summary?.diagnostics?.model?.name ??
    health?.model?.name ??
    health?.modelAdapter ??
    "unknown";
  const lines = [
    `Phantom status (${transport})`,
    `Health: ${health?.ok === false ? "not ok" : "ok"}`,
    `Readiness: ${readinessStatus(readiness)}`,
    `Setup checks: ${checks.passing ?? "?"} pass, ${checks.warnings ?? "?"} warning, ${checks.failures ?? "?"} fail`,
    `Model: ${model}`,
    `Tools: ${tools.length} dynamic`,
    `Recent channel failures: ${failures}`,
  ];
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatChatTranscript({ message, events, transport, includeEvents }) {
  const summary = summarizeChatEvents(events, transport);
  const lines = [`Transport: ${transport}`, `User: ${message}`];
  for (const event of events) {
    if (includeEvents) {
      lines.push(`event: ${event.type ?? "unknown"}`);
    }
    const raw = event.rawEvent;
    if (!raw || !raw.type) {
      continue;
    }
    if (raw.type === "tool_call_started") {
      lines.push(`Tool started: ${raw.toolName ?? raw.toolCallId}`);
    } else if (raw.type === "tool_call_succeeded") {
      lines.push(`Tool succeeded: ${raw.toolName ?? raw.toolCallId}`);
    } else if (raw.type === "tool_call_failed") {
      lines.push(
        `Tool failed: ${raw.toolName ?? raw.toolCallId} - ${raw.message ?? "failed"}`
      );
    }
  }
  if (summary.sessionId) {
    lines.push(`Session: ${summary.sessionId}`);
  }
  if (summary.runId) {
    lines.push(`Run: ${summary.runId}`);
  }
  lines.push("");
  lines.push(summary.outputText || "(no assistant output)");
  return `${lines.join("\n")}\n`;
}

function summarizeChatEvents(events, transport) {
  const summary = {
    transport,
    sessionId: undefined,
    runId: undefined,
    outputText: "",
    status: "unknown",
    toolEvents: [],
  };
  for (const event of events) {
    summary.sessionId = event.sessionId ?? summary.sessionId;
    summary.runId = event.runId ?? summary.runId;
    if (event.type === "run.completed") {
      summary.status = "completed";
      summary.outputText = event.payload?.outputText ?? summary.outputText;
    }
    if (event.type === "assignment.created") {
      summary.status = event.payload?.duplicate
        ? "assignment_duplicate"
        : "assignment_created";
      summary.outputText =
        event.payload?.acknowledgementText ??
        (summary.outputText || "Assignment created");
    }
    if (event.type === "request.failed") {
      summary.status = "failed";
      summary.outputText = event.payload?.message ?? summary.outputText;
    }
    if (event.rawEvent?.type === "final") {
      summary.outputText =
        event.rawEvent.outputText ??
        event.payload?.outputText ??
        summary.outputText;
    }
    if (event.rawEvent?.type?.startsWith("tool_")) {
      summary.toolEvents.push(event.rawEvent);
    }
  }
  return summary;
}

async function requestJson(requester, path, options = {}) {
  const response = await requestText(requester, path, options);
  return {
    ...response,
    body: response.text ? JSON.parse(response.text) : {},
  };
}

async function requestJsonOrNull(requester, path, options = {}) {
  try {
    return await requestJson(requester, path, options);
  } catch {
    return null;
  }
}

async function requestText(requester, path, options = {}) {
  const response = await requester(path, options);
  const allowedStatuses = new Set(options.allowStatuses ?? []);
  if (
    (response.status < 200 || response.status >= 300) &&
    !allowedStatuses.has(response.status)
  ) {
    const error = new Error(
      `${path} returned HTTP ${response.status}${response.text ? `: ${response.text}` : ""}`
    );
    error.status = response.status;
    throw error;
  }
  return response;
}

async function httpRequest(config, deps, request) {
  if (request.auth && !config.operatorToken) {
    throw new Error(
      "OPERATOR_BEARER_TOKEN is required for HTTP transport authenticated commands."
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const headers = {
      "Content-Type": "application/json",
    };
    if (request.auth) {
      headers.Authorization = `Bearer ${config.operatorToken}`;
    }
    const response = await deps.fetch(new URL(request.path, config.baseUrl), {
      method: request.method,
      headers,
      body:
        request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
    });
    return {
      status: response.status,
      text: await response.text(),
      transport: "http",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function describeDockerContainer(config, deps) {
  if (config.dockerContainer) {
    return config.dockerContainer;
  }
  try {
    return `${resolveDockerContainer(config, deps)} (from docker compose)`;
  } catch (error) {
    return `unresolved - ${formatError(error)}`;
  }
}

function resolveDockerContainer(config, deps) {
  if (config.dockerContainer) {
    return config.dockerContainer;
  }
  const cached = dockerContainerCache.get(config);
  if (cached) {
    return cached;
  }
  const container = discoverComposeContainer(config, deps);
  dockerContainerCache.set(config, container);
  return container;
}

function discoverComposeContainer(config, deps) {
  const result = deps.spawnSync(
    "docker",
    ["compose", "ps", "--format", "json", composeService],
    {
      cwd: config.cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 20 * 1024 * 1024,
    }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not resolve the ${composeService} Compose container${
        result.stderr ? `: ${result.stderr.trim()}` : ""
      }. Set PHANTOM_DOCKER_CONTAINER to target it explicitly.`
    );
  }
  const name = parseComposeContainerName(result.stdout);
  if (!name) {
    throw new Error(
      `The ${composeService} Compose container is not running. Start it with npm run local:up, or set PHANTOM_DOCKER_CONTAINER.`
    );
  }
  return name;
}

function parseComposeContainerName(stdout) {
  const text = typeof stdout === "string" ? stdout.trim() : "";
  if (!text) {
    return "";
  }
  const entries = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      entries.push(...parsed);
    } else {
      entries.push(parsed);
    }
  } catch {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        continue;
      }
    }
  }
  for (const entry of entries) {
    const name = entry?.Name ?? entry?.name;
    if (typeof name === "string" && name) {
      return name;
    }
  }
  return "";
}

async function dockerRequest(config, deps, request) {
  const container = resolveDockerContainer(config, deps);
  const dockerScript = `
const input = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => data += chunk);
  process.stdin.on("end", () => resolve(data));
});
const request = JSON.parse(input);
const token = request.token || process.env.OPERATOR_BEARER_TOKEN || "";
const headers = { "Content-Type": "application/json" };
if (request.auth && token) headers.Authorization = "Bearer " + token;
const response = await fetch("http://127.0.0.1:3210" + request.path, {
  method: request.method,
  headers,
  body: request.body === undefined ? undefined : JSON.stringify(request.body),
});
console.log(JSON.stringify({
  status: response.status,
  text: await response.text()
}));
`;
  const result = deps.spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "node",
      "--input-type=module",
      "--eval",
      dockerScript,
    ],
    {
      input: JSON.stringify({
        method: request.method,
        path: request.path,
        body: request.body,
        auth: request.auth,
        token: config.operatorToken,
      }),
      encoding: "utf8",
      timeout: request.timeoutMs + 5_000,
      maxBuffer: 20 * 1024 * 1024,
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `docker exec failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`
    );
  }
  const payload = JSON.parse(result.stdout);
  return {
    status: payload.status,
    text: payload.text,
    transport: "docker",
  };
}

function readinessStatus(body) {
  const readiness = readinessEnvelope(body);
  if (readiness?.status) {
    return readiness.status;
  }
  if (readiness?.ok === true) {
    return "ready";
  }
  return "unknown";
}

function readinessEnvelope(body) {
  return body?.readiness ?? body?.setupReadiness ?? body ?? {};
}

function isSafeRequestMethod(method) {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function removeUndefined(value) {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
}

function stringOption(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOption(value) {
  if (value === undefined || value === true || value === "") {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid numeric option: ${value}`);
  }
  return number;
}

function buildResult(output, errors, exitCode) {
  return {
    exitCode,
    stdout: output.join("").replace(/\n?$/, "\n"),
    stderr: errors.join("").replace(/\n?$/, errors.length ? "\n" : ""),
  };
}

function formatError(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function isHttpStatusError(error) {
  return error instanceof Error && typeof error.status === "number";
}

function helpText() {
  return `Usage: npm run phantom -- <command>

Commands:
  status               Show health, readiness, model, tools, and failures
  doctor               Diagnose local config, auth, and reachability
  chat <message>       Send a web chat message and stream the result summary
  runs                 List recent runs
  run <runId>          Show one run with events and children
  sessions             List web chat sessions
  session <sessionId>  Show one web chat session
  tools                List dynamic and governed tools

Options:
  --session <id>       Reuse a chat session
  --conversation <id>  Set the chat conversation id
  --timeout <ms>       Set chat timeout
  --json               Print chat summary as JSON
  --events             Include raw SSE event names in chat output

Environment:
  PHANTOM_BASE_URL defaults to http://localhost:3210
  PHANTOM_TRANSPORT auto|http|docker defaults to auto
  OPERATOR_BEARER_TOKEN is loaded from the environment or .env
`;
}

function isMain(metaUrl, argvPath) {
  if (!argvPath) {
    return false;
  }
  return fileURLToPath(metaUrl) === resolve(argvPath);
}
