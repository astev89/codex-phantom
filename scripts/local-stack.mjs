#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const appBaseUrl = "http://localhost:3210";
const qdrantHealthUrl = "http://localhost:6333/healthz";
const appHealthUrl = `${appBaseUrl}/health`;
const localEnvDefaults = {
  OPERATOR_BEARER_TOKEN: "local-dev-operator-token",
  MCP_BEARER_TOKEN: "local-dev-mcp-token",
  EXTERNAL_CHANNEL_SECRET: "local-dev-channel-secret",
  REJECT_DEFAULT_SECRETS: "false",
};

if (isMain(import.meta.url, process.argv[1])) {
  await main(process.argv.slice(2));
}

async function main(args) {
  const command = args[0] ?? "help";
  const options = parseOptions(args.slice(1));

  if (command === "up") {
    await up({ build: false });
    return;
  }
  if (command === "up-build") {
    await up({ build: true });
    return;
  }
  if (command === "status") {
    await status();
    return;
  }
  if (command === "stop-app") {
    await run("docker", ["compose", "stop", "codex-phantom"]);
    return;
  }
  if (command === "down") {
    await run("docker", ["compose", "down"]);
    return;
  }
  if (command === "tunnel") {
    await tunnel({ baseUrl: options.url ?? appBaseUrl });
    return;
  }

  printHelp();
}

async function up({ build }) {
  await ensureEnvFile();
  await requireCommand("docker");

  console.log("Starting Qdrant...");
  await run("docker", ["compose", "up", "-d", "qdrant"]);
  await waitForHttp(qdrantHealthUrl, 60_000, "Qdrant");

  console.log(
    build
      ? "Building and starting Codex Phantom..."
      : "Starting Codex Phantom..."
  );
  const appArgs = ["compose", "up", "-d", "--no-deps"];
  if (build) {
    appArgs.push("--build");
  }
  appArgs.push("codex-phantom");
  await run("docker", appArgs);
  await waitForHttp(appHealthUrl, 60_000, "Codex Phantom");

  await printSummary();
}

async function status() {
  await requireCommand("docker");
  await run("docker", ["compose", "ps"]);
  await printProbe("App health", appHealthUrl);
  await printProbe("Qdrant health", qdrantHealthUrl);
  await printTunnelStatus();
  await printSummary();
}

async function tunnel({ baseUrl }) {
  await requireCommand("cloudflared");
  console.log(`Starting Cloudflare tunnel for ${baseUrl}`);
  console.log(
    "Leave this process running while Slack should reach this laptop."
  );

  const child = spawn("cloudflared", [
    "tunnel",
    "--url",
    baseUrl,
    "--no-autoupdate",
  ]);
  let printed = false;

  const handleChunk = (chunk, stream) => {
    const text = chunk.toString();
    stream.write(text);
    const match = text.match(/https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/);
    if (!printed && match) {
      printed = true;
      printSlackUrls(match[0]);
    }
  };

  child.stdout.on("data", (chunk) => handleChunk(chunk, process.stdout));
  child.stderr.on("data", (chunk) => handleChunk(chunk, process.stderr));

  await new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolvePromise();
        return;
      }
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`cloudflared exited with code ${code}`));
    });
  });
}

async function ensureEnvFile() {
  if (existsSync(".env")) {
    const currentEnv = await readFile(".env", "utf8");
    const repairedEnv = buildLocalEnvText(currentEnv);
    if (repairedEnv !== currentEnv) {
      await writeFile(".env", repairedEnv);
      console.log(
        "Updated .env placeholder secrets for local development startup."
      );
    }
    return;
  }
  if (!existsSync(".env.example")) {
    return;
  }
  const exampleEnv = await readFile(".env.example", "utf8");
  await writeFile(".env", buildLocalEnvText(exampleEnv));
  console.log(
    "Created .env with local development secrets. Fill real Slack and OpenAI secrets there when needed."
  );
}

async function printSummary() {
  const env = parseEnvText(
    existsSync(".env") ? await readFile(".env", "utf8") : ""
  );
  const tokenSource = env.OPERATOR_BEARER_TOKEN
    ? ".env OPERATOR_BEARER_TOKEN"
    : "Compose fallback OPERATOR_BEARER_TOKEN";
  console.log("");
  console.log("Local URLs");
  console.log(`- Operator console: ${appBaseUrl}`);
  console.log("- Browser username: any non-empty value");
  console.log(`- Browser password: ${tokenSource}`);
  console.log("- MCP endpoint: http://localhost:3210/mcp");
  console.log("- Qdrant: http://localhost:6333");
  console.log("");
  console.log("Next commands");
  console.log("- Rebuild stale app container: npm run local:up:build");
  console.log(
    "- Stop app on port 3210, leaving tunnel and Qdrant alone: npm run local:stop-app"
  );
  console.log("- Start public tunnel for Slack: npm run local:tunnel");
}

async function printTunnelStatus() {
  const result = spawnSync("pgrep", ["-fl", "cloudflared.*localhost:3210"], {
    encoding: "utf8",
  });
  if (result.status === 0 && result.stdout.trim()) {
    console.log("Cloudflare tunnel process:");
    console.log(result.stdout.trim());
    return;
  }
  console.log("Cloudflare tunnel process: not detected for localhost:3210");
}

async function printProbe(label, url) {
  try {
    await fetchUrl(url, 2_000);
    console.log(`${label}: reachable`);
  } catch (error) {
    console.log(`${label}: not reachable (${formatError(error)})`);
  }
}

async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await fetchUrl(url, 2_000);
      console.log(`${label} is reachable.`);
      return;
    } catch (error) {
      lastError = error;
      await delay(1_000);
    }
  }
  throw new Error(`${label} did not become reachable: ${lastError?.message}`);
}

function fetchUrl(url, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      response.on("end", () => {
        if (isSuccessfulHttpStatus(response.statusCode)) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(`HTTP ${response.statusCode}`));
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("request timed out"));
    });
    request.on("error", rejectPromise);
  });
}

async function requireCommand(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(`${command} is not installed or is not on PATH.`);
  }
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`${command} ${args.join(" ")} exited with code ${code}`)
      );
    });
  });
}

function formatError(error) {
  if (error instanceof Error && error.name === "AggregateError") {
    return "connection failed";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  const text = String(error);
  return text && text !== "[object Object]" ? text : "connection failed";
}

export function buildLocalEnvText(text) {
  let updated = text;
  const env = parseEnvText(text);
  let repairedLocalSecrets = false;
  for (const [key, value] of Object.entries(localEnvDefaults)) {
    if (key === "REJECT_DEFAULT_SECRETS") {
      continue;
    }
    if (env[key] === undefined || env[key] === "replace-me") {
      updated = setEnvValue(updated, key, value);
      repairedLocalSecrets = true;
    }
  }
  if (
    repairedLocalSecrets ||
    env.REJECT_DEFAULT_SECRETS === undefined ||
    env.REJECT_DEFAULT_SECRETS === "replace-me"
  ) {
    updated = setEnvValue(
      updated,
      "REJECT_DEFAULT_SECRETS",
      localEnvDefaults.REJECT_DEFAULT_SECRETS
    );
  }
  return updated;
}

export function isSuccessfulHttpStatus(statusCode) {
  return Boolean(statusCode && statusCode >= 200 && statusCode < 300);
}

export function buildSlackUrls(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  return {
    baseUrl: normalized,
    eventsUrl: `${normalized}/channels/slack/events`,
    interactionsUrl: `${normalized}/channels/slack/interactions`,
  };
}

export function parseEnvText(text) {
  const parsed = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim();
    parsed[key] = stripOptionalQuotes(value);
  }
  return parsed;
}

function stripOptionalQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function setEnvValue(text, key, value) {
  const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");
  if (pattern.test(text)) {
    return text.replace(pattern, `${key}=${value}`);
  }
  const separator = text.endsWith("\n") || text.length === 0 ? "" : "\n";
  return `${text}${separator}${key}=${value}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printSlackUrls(baseUrl) {
  const urls = buildSlackUrls(baseUrl);
  console.log("");
  console.log("Cloudflare tunnel URL");
  console.log(`- Public base URL: ${urls.baseUrl}`);
  console.log(`- Slack Events Request URL: ${urls.eventsUrl}`);
  console.log(`- Slack Interactivity Request URL: ${urls.interactionsUrl}`);
  console.log("- Enable the slack channel before sending real Slack events.");
  console.log("");
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    options[key] = args[index + 1];
    index += 1;
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/local-stack.mjs <command>

Commands:
  up          Start Qdrant and the app container
  up-build    Rebuild and start Qdrant plus the app container
  status      Show Compose status and local health probes
  stop-app    Stop only the app container on port 3210
  down        Stop the full Compose stack
  tunnel      Start a foreground Cloudflare tunnel and print Slack URLs
`);
}

function isMain(metaUrl, argvPath) {
  if (!argvPath) {
    return false;
  }
  return fileURLToPath(metaUrl) === resolve(argvPath);
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
