import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("local stack helper builds Slack callback URLs from a tunnel base URL", async () => {
  const urls = (await runLocalStackExpression(`
    const urls = buildSlackUrls("https://example.trycloudflare.com/");
    console.log(JSON.stringify(urls));
  `)) as Record<string, string>;

  assert.deepEqual(urls, {
    baseUrl: "https://example.trycloudflare.com",
    eventsUrl: "https://example.trycloudflare.com/channels/slack/events",
    interactionsUrl:
      "https://example.trycloudflare.com/channels/slack/interactions",
  });
});

test("local stack helper parses dotenv-style operator values", async () => {
  const envText = JSON.stringify(`
# ignored
OPERATOR_BEARER_TOKEN="local-secret"
MCP_BEARER_TOKEN='mcp-secret'
EMPTY=
`);
  const parsed = (await runLocalStackExpression(`
    const parsed = parseEnvText(${envText});
    console.log(JSON.stringify(parsed));
  `)) as Record<string, string>;

  assert.equal(parsed.OPERATOR_BEARER_TOKEN, "local-secret");
  assert.equal(parsed.MCP_BEARER_TOKEN, "mcp-secret");
  assert.equal(parsed.EMPTY, "");
});

test("local stack helper repairs first-run placeholder secrets", async () => {
  const envText = JSON.stringify(`
OPERATOR_BEARER_TOKEN=replace-me
MCP_BEARER_TOKEN=replace-me
EXTERNAL_CHANNEL_SECRET=replace-me
REJECT_DEFAULT_SECRETS=true
OPENAI_API_KEY=
`);
  const updated = (await runLocalStackExpression(`
    console.log(JSON.stringify({ updated: buildLocalEnvText(${envText}) }));
  `)) as { updated: string };

  assert.match(
    updated.updated,
    /OPERATOR_BEARER_TOKEN=local-dev-operator-token/
  );
  assert.match(updated.updated, /MCP_BEARER_TOKEN=local-dev-mcp-token/);
  assert.match(
    updated.updated,
    /EXTERNAL_CHANNEL_SECRET=local-dev-channel-secret/
  );
  assert.match(updated.updated, /REJECT_DEFAULT_SECRETS=false/);
  assert.match(updated.updated, /OPENAI_API_KEY=/);
});

test("local stack helper only treats 2xx health responses as successful", async () => {
  const result = (await runLocalStackExpression(`
    console.log(JSON.stringify({
      ok: isSuccessfulHttpStatus(200),
      created: isSuccessfulHttpStatus(201),
      unauthorized: isSuccessfulHttpStatus(401),
      missing: isSuccessfulHttpStatus(404),
      unavailable: isSuccessfulHttpStatus(503)
    }));
  `)) as Record<string, boolean>;

  assert.deepEqual(result, {
    ok: true,
    created: true,
    unauthorized: false,
    missing: false,
    unavailable: false,
  });
});

async function runLocalStackExpression(expression: string): Promise<unknown> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import {
          buildLocalEnvText,
          buildSlackUrls,
          isSuccessfulHttpStatus,
          parseEnvText
        } from "./scripts/local-stack.mjs";
        ${expression}
      `,
    ],
    { cwd: process.cwd() }
  );
  return JSON.parse(stdout);
}
