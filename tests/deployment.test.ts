import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("package scripts and build config target a compiled production runtime", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const buildTsconfig = await readFile("tsconfig.build.json", "utf8");

  assert.equal(packageJson.scripts?.build, "tsc -p tsconfig.build.json");
  assert.equal(packageJson.scripts?.start, "node dist/index.js");
  assert.match(buildTsconfig, /"outDir":\s*"dist"/);
  assert.match(buildTsconfig, /"rootDir":\s*"src"/);
  assert.match(buildTsconfig, /"rewriteRelativeImportExtensions":\s*true/);
  assert.match(buildTsconfig, /"include":\s*\[\s*"src\/\*\*\/\*\.ts"\s*\]/);
});

test("Dockerfile runs as a non-root service with a healthcheck and writable data directory", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");

  assert.match(dockerfile, /^FROM node:24-slim AS build$/m);
  assert.match(dockerfile, /^FROM node:24-slim$/m);
  assert.match(dockerfile, /COPY --from=build \/app\/dist \.\/dist/);
  assert.match(dockerfile, /mkdir -p \/app\/data/);
  assert.match(dockerfile, /chown -R node:node \/app/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK\b/m);
  assert.match(dockerfile, /http:\/\/127\.0\.0\.1:\$PORT\/health/);
  assert.doesNotMatch(dockerfile, /CMD \["node", "--experimental-strip-types", "src\/index\.ts"\]/);
  assert.match(dockerfile, /CMD \["node", "dist\/index\.js"\]/);
});

test("docker compose defines restart and persistence settings for local production proof", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");

  assert.match(compose, /restart: unless-stopped/);
  assert.match(compose, /required: false/);
  assert.match(compose, /OPERATOR_BEARER_TOKEN: \$\{OPERATOR_BEARER_TOKEN:\?Set OPERATOR_BEARER_TOKEN\}/);
  assert.match(compose, /OPENAI_API_KEY: \$\{OPENAI_API_KEY:\?Set OPENAI_API_KEY\}/);
  assert.match(compose, /QDRANT_ENABLED: "true"/);
  assert.match(compose, /QDRANT_URL: http:\/\/qdrant:6333/);
  assert.match(compose, /codex-phantom-data:\/app\/data/);
  assert.match(compose, /qdrant-data:\/qdrant\/storage/);
});

test("deployment smoke script and docs cover boot, restart persistence, and backup restore", async () => {
  const script = await readFile("scripts/deployment-smoke.sh", "utf8");
  const readme = await readFile("README.md", "utf8");
  const parity = await readFile("docs/phantom-parity.md", "utf8");

  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /docker compose up -d --build/);
  assert.match(script, /docker compose restart codex-phantom/);
  assert.match(script, /\/admin\/summary/);
  assert.match(script, /OPERATOR_BEARER_TOKEN/);
  assert.match(readme, /Deployment smoke/);
  assert.match(readme, /npm run build/);
  assert.match(readme, /node dist\/index\.js/);
  assert.match(readme, /Backup and restore/);
  assert.match(readme, /codex-phantom-data/);
  assert.match(parity, /Compiled production runtime/);
  assert.match(parity, /dist\/index\.js/);
});
