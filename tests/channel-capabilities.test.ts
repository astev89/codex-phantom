import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  missingRequiredEnvVarsForChannel,
  requiredEnvVarsForChannel,
  runtimeChannelConfigComplete,
  runtimeChannelDefinitions,
} from "../src/channels/capabilities.ts";
import { ChannelRegistry } from "../src/channels/registry.ts";
import { AppDatabase } from "../src/platform/database.ts";
import { makeConfig } from "./helpers.ts";

test("runtime channel capabilities define the default channel map", () => {
  assert.deepEqual(
    runtimeChannelDefinitions().map((channel) => channel.id),
    ["web", "webhook", "scheduler", "slack", "email"]
  );
});

test("email capability keeps IMAP and SMTP config all-or-nothing", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "codex-phantom-capability-"));
  const incompleteConfig = makeConfig(dataDir, {
    emailImapHost: "imap.example.com",
    emailImapUsername: "bot@example.com",
    emailImapPassword: "secret",
    emailSmtpHost: "smtp.example.com",
    emailSmtpUsername: "bot@example.com",
    emailSmtpPassword: "secret",
    emailFromAddress: "",
  });
  const completeConfig = makeConfig(dataDir, {
    emailImapHost: "imap.example.com",
    emailImapUsername: "bot@example.com",
    emailImapPassword: "secret",
    emailSmtpHost: "smtp.example.com",
    emailSmtpUsername: "bot@example.com",
    emailSmtpPassword: "secret",
    emailFromAddress: "bot@example.com",
  });

  assert.equal(runtimeChannelConfigComplete(incompleteConfig, "email"), false);
  assert.equal(runtimeChannelConfigComplete(completeConfig, "email"), true);
});

test("required channel env vars are consistent for registry and diagnostics", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "codex-phantom-capability-"));
  const config = makeConfig(dataDir, {
    emailImapHost: " ",
    emailImapUsername: "\t",
    emailImapPassword: " ",
    emailSmtpHost: "",
    emailSmtpUsername: " ",
    emailSmtpPassword: "\n",
    emailFromAddress: " ",
  });
  const database = new AppDatabase(join(dataDir, "capabilities.sqlite"));
  const channels = new ChannelRegistry(database, config);

  try {
    channels.upsert({ id: "email", enabled: true });
    const email = channels.get("email");
    assert.ok(email);
    assert.deepEqual(requiredEnvVarsForChannel(email), [
      "EMAIL_IMAP_HOST",
      "EMAIL_IMAP_USERNAME",
      "EMAIL_IMAP_PASSWORD",
      "EMAIL_SMTP_HOST",
      "EMAIL_SMTP_USERNAME",
      "EMAIL_SMTP_PASSWORD",
      "EMAIL_FROM_ADDRESS",
    ]);
    assert.deepEqual(missingRequiredEnvVarsForChannel(config, email), [
      "EMAIL_IMAP_HOST",
      "EMAIL_IMAP_USERNAME",
      "EMAIL_IMAP_PASSWORD",
      "EMAIL_SMTP_HOST",
      "EMAIL_SMTP_USERNAME",
      "EMAIL_SMTP_PASSWORD",
      "EMAIL_FROM_ADDRESS",
    ]);
  } finally {
    database.close();
  }
});
