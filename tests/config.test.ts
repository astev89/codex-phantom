import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.ts";

function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => void
): void {
  const original = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }

  try {
    run();
  } finally {
    process.env = original;
  }
}

test("production config rejects default secrets", () => {
  const original = { ...process.env };
  process.env.APP_ENV = "production";
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPERATOR_BEARER_TOKEN;
  delete process.env.MCP_BEARER_TOKEN;
  delete process.env.EXTERNAL_CHANNEL_SECRET;
  delete process.env.OPENAI_EMBEDDING_MODEL;

  try {
    assert.throws(
      () => loadConfig(),
      /OPERATOR_BEARER_TOKEN|MCP_BEARER_TOKEN|OPENAI_API_KEY/
    );
  } finally {
    process.env = original;
  }
});

test("config parses outbound OpenAI timeout settings", () => {
  withEnv(
    {
      OPENAI_REQUEST_TIMEOUT_MS: "12000",
      OPENAI_EMBEDDING_TIMEOUT_MS: "3000",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.openAiRequestTimeoutMs, 12_000);
      assert.equal(config.openAiEmbeddingTimeoutMs, 3_000);
    }
  );
});

test("config parses model and reasoning settings", () => {
  withEnv(
    {
      OPENAI_MODEL: "gpt-5.1-codex",
      OPENAI_REASONING_EFFORT: "high",
      OPENAI_MEMORY_REASONING_EFFORT: "medium",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.model, "gpt-5.1-codex");
      assert.equal(config.openAiReasoningEffort, "high");
      assert.equal(config.openAiMemoryReasoningEffort, "medium");
    }
  );
});

test("config rejects invalid reasoning settings", () => {
  withEnv({ OPENAI_REASONING_EFFORT: "maximum" }, () => {
    assert.throws(
      () => loadConfig(),
      /OPENAI_REASONING_EFFORT must be low, medium, or high/
    );
  });
  withEnv({ OPENAI_MEMORY_REASONING_EFFORT: "none" }, () => {
    assert.throws(
      () => loadConfig(),
      /OPENAI_MEMORY_REASONING_EFFORT must be low, medium, or high/
    );
  });
});

test("config rejects invalid outbound OpenAI timeout settings", () => {
  withEnv({ OPENAI_REQUEST_TIMEOUT_MS: "0" }, () => {
    assert.throws(
      () => loadConfig(),
      /OPENAI_REQUEST_TIMEOUT_MS must be a positive integer/
    );
  });
});

test("config identifies invalid email boolean settings", () => {
  withEnv({ EMAIL_IMAP_TLS: "maybe" }, () => {
    assert.throws(
      () => loadConfig(),
      /EMAIL_IMAP_TLS must be set to true or false/
    );
  });
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

test("runtime configuration reference documents every env var", async () => {
  const configSource = await readFile("src/config.ts", "utf8");
  const docs = await readFile("docs/configuration.md", "utf8");
  const envExample = await readFile(".env.example", "utf8");
  const matches = configSource.matchAll(/process\.env\.([A-Z0-9_]+)/g);
  const envVars = [...new Set([...matches].map((match) => match[1]))].sort();

  assert.ok(envVars.length > 0);
  for (const envVar of envVars) {
    assert.match(
      docs,
      new RegExp(`\\\`${envVar}\\\``),
      `${envVar} must be documented`
    );
    if (envVar !== "NODE_ENV") {
      assert.match(
        envExample,
        new RegExp(`^${envVar}=`, "m"),
        `${envVar} must appear in .env.example`
      );
    }
  }
});
