import { defineConfig } from "@playwright/test";

const port = 3220;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL,
    channel: "chrome",
    httpCredentials: {
      username: "operator",
      password: "operator-secret"
    }
  },
  webServer: {
    command: "rm -rf /tmp/codex-phantom-playwright && npm run dev",
    url: `${baseURL}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      APP_ENV: "test",
      PORT: String(port),
      CODEX_PHANTOM_DATA_DIR: "/tmp/codex-phantom-playwright",
      CODEX_PHANTOM_DATABASE_PATH: "/tmp/codex-phantom-playwright/codex-phantom.sqlite",
      OPERATOR_BEARER_TOKEN: "operator-secret",
      MCP_BEARER_TOKEN: "mcp-secret",
      EXTERNAL_CHANNEL_SECRET: "webhook-secret",
      SEMANTIC_RETRIEVAL_ENABLED: "false",
      QDRANT_ENABLED: "false",
      LOG_LEVEL: "error"
    }
  }
});
