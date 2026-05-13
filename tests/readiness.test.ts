import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelRegistry } from "../src/channels/registry.ts";
import { AppDatabase } from "../src/platform/database.ts";
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
