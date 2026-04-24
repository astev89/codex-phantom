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
