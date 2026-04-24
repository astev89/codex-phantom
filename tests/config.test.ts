import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("production config rejects default secrets", () => {
  const original = { ...process.env };
  process.env.APP_ENV = "production";
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPERATOR_BEARER_TOKEN;
  delete process.env.MCP_BEARER_TOKEN;
  delete process.env.EXTERNAL_CHANNEL_SECRET;
  delete process.env.OPENAI_EMBEDDING_MODEL;

  try {
    assert.throws(() => loadConfig(), /OPERATOR_BEARER_TOKEN|MCP_BEARER_TOKEN|OPENAI_API_KEY/);
  } finally {
    process.env = original;
  }
});

test("production config rejects blank and placeholder secrets", () => {
  const original = { ...process.env };
  process.env.APP_ENV = "production";
  process.env.OPENAI_API_KEY = "openai-secret";
  process.env.OPERATOR_BEARER_TOKEN = "replace-me";
  process.env.MCP_BEARER_TOKEN = "mcp-secret";
  process.env.EXTERNAL_CHANNEL_SECRET = "webhook-secret";

  try {
    assert.throws(() => loadConfig(), /OPERATOR_BEARER_TOKEN/);

    process.env.OPERATOR_BEARER_TOKEN = "operator-secret";
    process.env.MCP_BEARER_TOKEN = " ";
    assert.throws(() => loadConfig(), /MCP_BEARER_TOKEN/);

    process.env.MCP_BEARER_TOKEN = "mcp-secret";
    process.env.EXTERNAL_CHANNEL_SECRET = "replace-me";
    assert.throws(() => loadConfig(), /EXTERNAL_CHANNEL_SECRET/);

    process.env.OPERATOR_BEARER_TOKEN = " dev-operator-token ";
    process.env.EXTERNAL_CHANNEL_SECRET = "webhook-secret";
    assert.throws(() => loadConfig(), /OPERATOR_BEARER_TOKEN/);

    process.env.OPERATOR_BEARER_TOKEN = "operator-secret";
    process.env.EXTERNAL_CHANNEL_SECRET = " replace-me ";
    assert.throws(() => loadConfig(), /EXTERNAL_CHANNEL_SECRET/);

    process.env.REJECT_DEFAULT_SECRETS = "false";
    process.env.OPERATOR_BEARER_TOKEN = "dev-operator-token";
    process.env.EXTERNAL_CHANNEL_SECRET = "webhook-secret";
    assert.throws(() => loadConfig(), /OPERATOR_BEARER_TOKEN/);
  } finally {
    process.env = original;
  }
});
