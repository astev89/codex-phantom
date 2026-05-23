import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelRegistry } from "../src/channels/registry.ts";
import { AppDatabase } from "../src/platform/database.ts";
import { buildStartupDiagnostics } from "../src/server/diagnostics.ts";
import { buildSetupReadiness } from "../src/server/readiness.ts";
import { makeConfig } from "./helpers.ts";

const memoryStatus = {
  semanticRetrievalEnabled: true,
  embeddingModel: "text-embedding-3-small",
  pendingBackfillCount: 0,
  pendingVectorSyncCount: 0,
  vectorBackend: "sqlite_fallback" as const,
  qdrantConfigured: false,
  qdrantReachable: false,
};

test("operator readiness reports unsafe first-run setup gaps", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-readiness-"));
  const config = makeConfig(dataDir, {
    appEnv: "production",
    operatorBearerToken: "dev-operator-token",
    roleConfigPath: join(dataDir, "missing-roles.yaml"),
    operatorConfigPath: join(dataDir, "missing-operator.yaml"),
  });
  const database = new AppDatabase(join(dataDir, "readiness.sqlite"));
  const channels = new ChannelRegistry(database, config);

  try {
    channels.upsert({ id: "webhook", enabled: false });
    const readiness = buildSetupReadiness({
      config,
      memory: memoryStatus,
      channels: channels.list(),
      databaseReady: database.isReady(),
    });

    assert.equal(readiness.ok, false);
    assert.equal(readiness.status, "blocked");
    assert.ok(readiness.summary.failures >= 4);
    assert.ok(
      readiness.checks.some(
        (check) =>
          check.id === "operator-token" &&
          check.status === "fail" &&
          check.action?.includes("OPERATOR_BEARER_TOKEN")
      )
    );
    assert.ok(
      readiness.checks.some(
        (check) => check.id === "role-config" && check.status === "fail"
      )
    );
    assert.ok(
      readiness.checks.some(
        (check) => check.id === "operator-config" && check.status === "fail"
      )
    );
    assert.ok(
      readiness.checks.some(
        (check) =>
          check.id === "channel-webhook-enabled" && check.status === "fail"
      )
    );
    assert.ok(
      readiness.checks.some(
        (check) => check.id === "openai-api-key" && check.status === "fail"
      )
    );
  } finally {
    database.close();
  }
});

test("email channel is available but disabled by default", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "codex-phantom-email-readiness-"));
  const config = makeConfig(dataDir);
  const database = new AppDatabase(join(dataDir, "readiness.sqlite"));
  const channels = new ChannelRegistry(database, config);

  try {
    const email = channels.get("email");
    assert.ok(email);
    assert.equal(email.enabled, false);
    assert.equal(email.secretPresent, false);

    const readiness = buildSetupReadiness({
      config,
      memory: memoryStatus,
      channels: channels.list(),
      databaseReady: database.isReady(),
    });

    assert.ok(
      !readiness.checks.some(
        (check) =>
          check.status === "fail" && check.id.startsWith("channel-email-")
      )
    );
  } finally {
    database.close();
  }
});

test("enabled email treats blank required config as missing", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "codex-phantom-email-blanks-"));
  const config = makeConfig(dataDir, {
    emailImapHost: " ",
    emailImapUsername: "\t",
    emailImapPassword: "   ",
    emailSmtpHost: "\n",
    emailSmtpUsername: " ",
    emailSmtpPassword: "  ",
    emailFromAddress: "\t ",
  });
  const database = new AppDatabase(join(dataDir, "readiness.sqlite"));
  const channels = new ChannelRegistry(database, config);

  try {
    channels.upsert({ id: "email", enabled: true });
    const email = channels.get("email");
    assert.ok(email);
    assert.equal(email.enabled, true);
    assert.equal(email.secretPresent, false);

    const readiness = buildSetupReadiness({
      config,
      memory: memoryStatus,
      channels: channels.list(),
      databaseReady: database.isReady(),
    });
    const diagnostics = buildStartupDiagnostics(
      config,
      memoryStatus,
      channels.list(),
      {
        enabled: true,
        running: false,
        configComplete: false,
        lastPollAt: "2026-05-23T15:30:00.000Z",
        lastError:
          "Email channel is enabled but IMAP/SMTP configuration is incomplete",
      },
      [],
      readiness
    );

    assert.ok(
      readiness.checks.some(
        (check) =>
          check.id === "channel-email-secrets" && check.status === "fail"
      )
    );
    assert.deepEqual(diagnostics.missingRecommendedEnv, [
      "EMAIL_FROM_ADDRESS",
      "EMAIL_IMAP_HOST",
      "EMAIL_IMAP_PASSWORD",
      "EMAIL_IMAP_USERNAME",
      "EMAIL_SMTP_HOST",
      "EMAIL_SMTP_PASSWORD",
      "EMAIL_SMTP_USERNAME",
      "OPENAI_API_KEY",
    ]);
    assert.deepEqual(diagnostics.email, {
      enabled: true,
      running: false,
      configComplete: false,
      lastPollAt: "2026-05-23T15:30:00.000Z",
      lastError:
        "Email channel is enabled but IMAP/SMTP configuration is incomplete",
      recentDeliveryFailures: [],
    });
  } finally {
    database.close();
  }
});

test("operator readiness uses operator YAML required channels and validates role YAML", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-readiness-"));
  const roleConfigPath = join(dataDir, "roles.yaml");
  const operatorConfigPath = join(dataDir, "operator.yaml");
  await writeFile(
    roleConfigPath,
    `
version: 1
roles:
  explorer:
    mode: read_only
    fileGlobs: ["**/*"]
    allowedToolIds: ["memory.query"]
    allowedMcpServers: ["github"]
  builder:
    mode: scoped_write
    fileGlobs: ["src/**/*"]
    allowedToolIds: ["echo.summary"]
    allowedMcpServers: ["repo"]
  verifier:
    mode: read_only
    fileGlobs: ["tests/**/*"]
    allowedToolIds: ["echo.summary"]
    allowedMcpServers: ["ci"]
  researcher:
    mode: read_only
    fileGlobs: []
    allowedToolIds: ["echo.summary"]
    allowedMcpServers: ["docs"]
`
  );
  await writeFile(
    operatorConfigPath,
    `
version: 1
requiredChannels:
  - web
  - scheduler
optionalChannels:
  - webhook
  - slack
`
  );
  const config = makeConfig(dataDir, {
    roleConfigPath,
    operatorConfigPath,
  });
  const database = new AppDatabase(join(dataDir, "readiness.sqlite"));
  const channels = new ChannelRegistry(database, config);

  try {
    channels.upsert({ id: "webhook", enabled: false });
    const readiness = buildSetupReadiness({
      config,
      memory: memoryStatus,
      channels: channels.list(),
      databaseReady: database.isReady(),
    });

    assert.ok(
      readiness.checks.some(
        (check) => check.id === "role-config" && check.status === "pass"
      )
    );
    assert.ok(
      readiness.checks.some(
        (check) => check.id === "operator-config" && check.status === "pass"
      )
    );
    assert.ok(
      readiness.checks.some(
        (check) => check.id === "channel-webhook" && check.status === "warn"
      )
    );
    assert.ok(
      !readiness.checks.some((check) => check.id === "channel-webhook-enabled")
    );
  } finally {
    database.close();
  }
});

test("operator readiness parses valid YAML instead of raw line shapes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-readiness-"));
  const roleConfigPath = join(dataDir, "roles.yaml");
  const operatorConfigPath = join(dataDir, "operator.yaml");
  await writeFile(
    roleConfigPath,
    `
version: 1
roles:
  explorer:
    mode: "read_only" # comments should not invalidate YAML
    fileGlobs: ["**/*"]
    allowedToolIds: ["memory.query", "echo.summary"]
    allowedMcpServers: ["github"]
  builder:
    mode: scoped_write
    fileGlobs: ["src/**/*", "tests/**/*"]
    allowedToolIds: ["echo.summary"]
    allowedMcpServers: ["repo"]
  verifier:
    mode: read_only
    fileGlobs: ["src/**/*", "tests/**/*"]
    allowedToolIds: ["echo.summary"]
    allowedMcpServers: ["ci"]
  researcher:
    mode: read_only
    fileGlobs: []
    allowedToolIds: ["echo.summary"]
    allowedMcpServers: ["docs"]
`
  );
  await writeFile(
    operatorConfigPath,
    `
version: 1
requiredChannels: ["web", "scheduler"]
optionalChannels:
  - "webhook"
`
  );
  const config = makeConfig(dataDir, {
    roleConfigPath,
    operatorConfigPath,
  });
  const database = new AppDatabase(join(dataDir, "readiness.sqlite"));
  const channels = new ChannelRegistry(database, config);

  try {
    channels.upsert({ id: "webhook", enabled: false });
    const readiness = buildSetupReadiness({
      config,
      memory: memoryStatus,
      channels: channels.list(),
      databaseReady: database.isReady(),
    });

    assert.ok(
      readiness.checks.some(
        (check) => check.id === "role-config" && check.status === "pass"
      )
    );
    assert.ok(
      readiness.checks.some(
        (check) => check.id === "operator-config" && check.status === "pass"
      )
    );
    assert.ok(
      !readiness.checks.some((check) => check.id === "channel-webhook-enabled")
    );
  } finally {
    database.close();
  }
});

test("operator readiness fails invalid readable YAML config files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-phantom-readiness-"));
  const roleConfigPath = join(dataDir, "roles.yaml");
  const operatorConfigPath = join(dataDir, "operator.yaml");
  await writeFile(roleConfigPath, "not: roles\n");
  await writeFile(operatorConfigPath, "optionalChannels:\n  - slack\n");
  const config = makeConfig(dataDir, {
    roleConfigPath,
    operatorConfigPath,
  });
  const database = new AppDatabase(join(dataDir, "readiness.sqlite"));
  const channels = new ChannelRegistry(database, config);

  try {
    const readiness = buildSetupReadiness({
      config,
      memory: memoryStatus,
      channels: channels.list(),
      databaseReady: database.isReady(),
    });

    assert.equal(readiness.ok, false);
    assert.ok(
      readiness.checks.some(
        (check) => check.id === "role-config" && check.status === "fail"
      )
    );
    assert.ok(
      readiness.checks.some(
        (check) => check.id === "operator-config" && check.status === "fail"
      )
    );
  } finally {
    database.close();
  }
});
