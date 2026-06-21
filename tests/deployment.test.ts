import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("package scripts and build config target a compiled production runtime", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const buildTsconfig = await readFile("tsconfig.build.json", "utf8");

  assert.equal(packageJson.scripts?.build, "tsc -p tsconfig.build.json");
  assert.equal(packageJson.scripts?.start, "node dist/index.js");
  assert.equal(
    packageJson.scripts?.["smoke:mailbox:live"],
    "node scripts/mailbox-live-smoke.mjs"
  );
  assert.match(buildTsconfig, /"outDir":\s*"dist"/);
  assert.match(buildTsconfig, /"rootDir":\s*"src"/);
  assert.match(buildTsconfig, /"rewriteRelativeImportExtensions":\s*true/);
  assert.match(buildTsconfig, /"include":\s*\[\s*"src\/\*\*\/\*\.ts"\s*\]/);
});

test("Dockerfile runs as a non-root service with a healthcheck and writable data directory", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");

  assert.match(dockerfile, /^FROM node:24-slim AS build$/m);
  assert.match(dockerfile, /^FROM node:24-slim$/m);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /COPY --from=build \/app\/dist \.\/dist/);
  assert.match(dockerfile, /COPY config \.\/config/);
  assert.match(dockerfile, /mkdir -p \/app\/data/);
  assert.match(dockerfile, /chown -R node:node \/app/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK\b/m);
  assert.match(dockerfile, /http:\/\/127\.0\.0\.1:\$PORT\/health/);
  assert.doesNotMatch(
    dockerfile,
    /CMD \["node", "--experimental-strip-types", "src\/index\.ts"\]/
  );
  assert.match(dockerfile, /CMD \["node", "dist\/index\.js"\]/);
});

test("docker compose defines local dev runtime with persistent SQLite and Qdrant", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");

  assert.match(compose, /restart: unless-stopped/);
  assert.match(compose, /required: false/);
  assert.match(compose, /APP_ENV: \$\{APP_ENV:-development\}/);
  assert.match(compose, /CODEX_PHANTOM_DATA_DIR: \/app\/data/);
  assert.match(
    compose,
    /CODEX_PHANTOM_DATABASE_PATH: \/app\/data\/codex-phantom\.sqlite/
  );
  assert.match(
    compose,
    /OPERATOR_BEARER_TOKEN: \$\{OPERATOR_BEARER_TOKEN:-local-dev-operator-token\}/
  );
  assert.match(compose, /OPENAI_API_KEY: \$\{OPENAI_API_KEY:-\}/);
  assert.match(compose, /OPENAI_MODEL: \$\{OPENAI_MODEL:-gpt-5\}/);
  assert.match(
    compose,
    /OPENAI_REASONING_EFFORT: \$\{OPENAI_REASONING_EFFORT:-medium\}/
  );
  assert.match(
    compose,
    /OPENAI_MEMORY_REASONING_EFFORT: \$\{OPENAI_MEMORY_REASONING_EFFORT:-low\}/
  );
  assert.match(compose, /QDRANT_ENABLED: "true"/);
  assert.match(compose, /QDRANT_URL: http:\/\/qdrant:6333/);
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /GET \/healthz HTTP\/1\.1/);
  assert.match(compose, /codex-phantom-data:\/app\/data/);
  assert.match(compose, /qdrant-data:\/qdrant\/storage/);
});

test("deployment smoke scripts and docs cover boot, restart persistence, and backup restore", async () => {
  const script = await readFile("scripts/deployment-smoke.sh", "utf8");
  const restoreScript = await readFile(
    "scripts/backup-restore-smoke.sh",
    "utf8"
  );
  const slackTunnelScript = await readFile(
    "scripts/slack-tunnel-smoke.mjs",
    "utf8"
  );
  const mailboxSmokeScript = await readFile(
    "scripts/mailbox-live-smoke.mjs",
    "utf8"
  );
  const seedScript = await readFile("scripts/restore-smoke-seed.mjs", "utf8");
  const readme = await readFile("README.md", "utf8");
  const parity = await readFile("docs/phantom-parity.md", "utf8");

  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /docker compose up -d --build/);
  assert.match(script, /docker compose restart codex-phantom/);
  assert.match(script, /\/admin\/summary/);
  assert.match(script, /\/mcp/);
  assert.match(script, /\/admin\/mcp\/audit/);
  assert.match(script, /\/metrics\?format=prometheus/);
  assert.match(script, /\/scheduler\/jobs/);
  assert.match(script, /429/);
  assert.match(script, /OPERATOR_BEARER_TOKEN/);
  assert.match(script, /MCP_BEARER_TOKEN/);
  assert.match(script, /EXTERNAL_CHANNEL_SECRET/);
  assert.match(script, /OPENAI_API_KEY/);
  assert.match(slackTunnelScript, /^#!\/usr\/bin\/env node/);
  assert.match(slackTunnelScript, /BASE_URL/);
  assert.match(slackTunnelScript, /SLACK_SMOKE_CHANNEL_ID/);
  assert.match(slackTunnelScript, /SLACK_SIGNING_SECRET/);
  assert.match(slackTunnelScript, /OPERATOR_BEARER_TOKEN/);
  assert.match(slackTunnelScript, /options\["timeout-ms"\]/);
  assert.match(slackTunnelScript, /options\["interval-ms"\]/);
  assert.match(slackTunnelScript, /readJsonResponse\(eventResponse/);
  assert.match(slackTunnelScript, /returned non-JSON response/);
  assert.match(slackTunnelScript, /if \(!inboundResponse\.ok\)/);
  assert.match(slackTunnelScript, /without a Slack response message timestamp/);
  assert.match(slackTunnelScript, /\/channels\/slack\/events/);
  assert.match(
    slackTunnelScript,
    /\/admin\/channels\/inbound\?channelId=slack/
  );
  assert.doesNotMatch(slackTunnelScript, /trycloudflare\.com/);
  assert.match(mailboxSmokeScript, /^#!\/usr\/bin\/env node/);
  assert.match(mailboxSmokeScript, /EMAIL_IMAP_HOST/);
  assert.match(mailboxSmokeScript, /EMAIL_SMTP_HOST/);
  assert.match(mailboxSmokeScript, /EMAIL_SMOKE_TO_ADDRESS/);
  assert.match(mailboxSmokeScript, /missing_credentials/);
  assert.match(mailboxSmokeScript, /client\.status/);
  assert.match(mailboxSmokeScript, /sendMail/);
  assert.doesNotMatch(mailboxSmokeScript, /console\.log\(process\.env/);
  assert.doesNotMatch(mailboxSmokeScript, /pass:\s*process\.env/);
  assert.match(restoreScript, /docker volume rm codex-phantom-data/);
  assert.match(restoreScript, /docker volume create codex-phantom-data/);
  assert.match(restoreScript, /codex-phantom-data\.tgz/);
  assert.match(restoreScript, /\/admin\/settings/);
  assert.match(restoreScript, /\/sessions/);
  assert.match(restoreScript, /\/runs/);
  assert.match(restoreScript, /\/scheduler\/jobs/);
  assert.match(restoreScript, /\/memory/);
  assert.match(restoreScript, /\/admin\/mcp\/audit/);
  assert.match(restoreScript, /\/admin\/timeline/);
  assert.match(seedScript, /session_restore_smoke/);
  assert.match(seedScript, /"operator"/);
  assert.match(seedScript, /memoryTimelineLimit: 13/);
  assert.match(seedScript, /run_restore_smoke/);
  assert.match(seedScript, /job_restore_smoke/);
  assert.match(seedScript, /mem_restore_smoke/);
  assert.match(seedScript, /req_restore_smoke/);
  assert.match(readme, /Deployment smoke/);
  assert.match(readme, /npm run build/);
  assert.match(readme, /node dist\/index\.js/);
  assert.match(readme, /Backup and restore/);
  assert.match(readme, /codex-phantom-data/);
  assert.match(parity, /Compiled production runtime/);
  assert.match(parity, /dist\/index\.js/);
});

test("mailbox live smoke skips cleanly without credentials", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/mailbox-live-smoke.mjs"],
    {
      env: { PATH: process.env.PATH ?? "" },
    }
  );
  const result = JSON.parse(stdout) as {
    status?: string;
    reason?: string;
    missing?: string[];
  };

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "missing_credentials");
  assert.ok(result.missing?.includes("EMAIL_IMAP_HOST"));
  assert.ok(result.missing?.includes("EMAIL_SMTP_HOST"));
});

test("mailbox live smoke requires an explicit non-runtime recipient", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/mailbox-live-smoke.mjs"],
    {
      env: {
        PATH: process.env.PATH ?? "",
        EMAIL_IMAP_HOST: "imap.example.test",
        EMAIL_IMAP_USERNAME: "user@example.test",
        EMAIL_IMAP_PASSWORD: "imap-password",
        EMAIL_SMTP_HOST: "smtp.example.test",
        EMAIL_SMTP_USERNAME: "user@example.test",
        EMAIL_SMTP_PASSWORD: "smtp-password",
        EMAIL_FROM_ADDRESS: "runtime@example.test",
      },
    }
  );
  const result = JSON.parse(stdout) as {
    status?: string;
    reason?: string;
    missing?: string[];
    message?: string;
  };

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "missing_recipient");
  assert.deepEqual(result.missing, ["EMAIL_SMOKE_TO_ADDRESS"]);
  assert.match(result.message ?? "", /non-runtime mailbox/);
});
