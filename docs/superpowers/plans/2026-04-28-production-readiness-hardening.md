# Production Readiness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the current production blockers in `codex-phantom` without expanding scope into full Phantom feature parity.

**Architecture:** Keep the existing Node runtime and SQLite-centered design. Add bounded request input, timeout-controlled outbound model calls, compiled production packaging, durable operational audit records, and deterministic scheduler recovery. Implement each area in an atomic commit with focused tests and GitNexus change detection.

**Tech Stack:** Node 24, TypeScript, `node:test`, `node:sqlite`, `node:http`, Docker multi-stage builds, Qdrant-compatible vector memory, OpenAI Responses/Embeddings APIs.

---

## Execution Model

Use subagent-driven development. Dispatch one implementation subagent per task unless two tasks touch the same hot file. Subagents are not alone in the codebase; they must not revert unrelated edits and must adapt to changes made by other workers.

Recommended order:

1. Task 1: HTTP request safety and best-effort request audit.
2. Task 2 and Task 3 may run in parallel after Task 1 starts, because they do not share write-heavy files.
3. Task 4 should start after Task 1, because it integrates with request and audit surfaces.
4. Task 5 can run after Task 1 or independently if `tests/server.test.ts` ownership is coordinated.

Before editing any function, class, or method, run GitNexus impact analysis for the target symbol. Before each commit, run GitNexus `detect_changes` for `codex-phantom`.

## File Map

- `src/server/http-server.ts`: HTTP routing, body parsing, auth, response writing, metrics, request auditing.
- `src/server/validation.ts`: input validation for API bodies.
- `src/server/request-audit.ts`: existing request audit store; may remain request-only.
- `src/platform/database.ts`: SQLite migrations and shared DB wrapper.
- `src/platform/outbound.ts`: new helper for timeout-controlled fetch.
- `src/memory/embedding.ts`: OpenAI embeddings with timeout and degrade behavior.
- `src/agent/codex-adapter.ts`: OpenAI Responses transport timeout behavior.
- `src/mcp/server.ts`: MCP authentication, tools/list, tools/call, metrics, durable audit hooks.
- `src/mcp/audit.ts`: new MCP audit store.
- `src/scheduler/service.ts`: job recovery, retry delay, deterministic retry behavior.
- `package.json`: build/start scripts for compiled production output.
- `tsconfig.json`: build output settings if not already compatible.
- `Dockerfile`: multi-stage build and runtime from `dist/index.js`.
- `docker-compose.yml`: confirm compiled runtime path and health behavior.
- `README.md`: update deployment and verification commands.
- `docs/phantom-parity.md`: update matched/deferred production hardening snapshot.
- `tests/server.test.ts`: HTTP, auth, body limit, audit, export, and scheduler route coverage.
- `tests/adapter.test.ts`: model timeout behavior and transport failure coverage.
- `tests/memory.test.ts`: embedding timeout and fallback coverage.
- `tests/mcp.test.ts`: durable MCP audit coverage.
- `tests/config.test.ts`: timeout config validation.
- `tests/deployment.test.ts`: compiled Docker runtime expectations.
- `tests/scheduler.test.ts`: new focused scheduler recovery and retry tests.

## Task 1: HTTP Request Safety And Request Audit Isolation

**Subagent ownership:** Worker A owns `src/server/http-server.ts`, `src/server/validation.ts`, and body-limit additions in `tests/server.test.ts`.

**Files:**
- Modify: `src/server/http-server.ts`
- Modify: `src/server/validation.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

Run:

```bash
# MCP tool call
mcp__gitnexus__.context({ "repo": "codex-phantom", "name": "HttpServer" })
```

Expected: `HttpServer` is called from `src/index.ts` and `tests/server.test.ts`; risk is medium because it handles all API traffic.

- [ ] **Step 2: Write failing oversized-body tests**

Add tests to `tests/server.test.ts` that start the test server and send oversized JSON bodies to unauthenticated and authenticated body-reading routes.

Use a payload larger than the configured limit:

```ts
const oversizedBody = JSON.stringify({ message: "x".repeat(1_100_000) });

const response = await fetch(`${baseUrl}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: oversizedBody
});

assert.equal(response.status, 413);
const json = await response.json() as { error?: string; status?: number };
assert.equal(json.status, 413);
assert.match(json.error ?? "", /body/i);
```

Also cover an authenticated route so the limit is not only MCP-specific:

```ts
const response = await fetch(`${baseUrl}/chat/message`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${operatorToken}`
  },
  body: oversizedBody
});

assert.equal(response.status, 413);
```

- [ ] **Step 3: Run the targeted test and confirm failure**

Run:

```bash
node --experimental-strip-types --test tests/server.test.ts
```

Expected before implementation: the new tests fail because `readTextBody` has no body limit.

- [ ] **Step 4: Implement a bounded body reader**

In `src/server/http-server.ts`, replace `readTextBody(req)` with a size-aware function:

```ts
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

async function readTextBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, `Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}
```

Keep all existing callers using the default limit unless a route needs a smaller limit. Do not make the body limit configurable in this task.

- [ ] **Step 5: Make request audit writes best-effort**

In the `finally` block of `HttpServer.handle`, wrap request audit persistence so audit failures do not destabilize the request path:

```ts
try {
  this.requestAudits.record({
    requestId,
    method: req.method ?? "UNKNOWN",
    path: url.pathname,
    statusCode: res.statusCode,
    durationMs: Date.now() - startedAt
  });
} catch (error) {
  requestLogger.error("request_audit_failed", {
    error: error instanceof Error ? error.message : "Request audit failed"
  });
}
```

Leave metrics increments in place after this block.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
node --experimental-strip-types --test tests/server.test.ts
```

Expected: server tests pass, including new `413` coverage.

- [ ] **Step 7: Run full verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: typecheck passes and all tests pass.

- [ ] **Step 8: Run GitNexus change detection**

Run:

```bash
# MCP tool call
mcp__gitnexus__.detect_changes({ "repo": "codex-phantom", "scope": "all" })
```

Expected: changed symbols include `HttpServer` and body-validation test coverage; affected flows should be HTTP/server routes.

- [ ] **Step 9: Commit**

Run:

```bash
git add src/server/http-server.ts src/server/validation.ts tests/server.test.ts
git commit -m "fix(server): bound request bodies and isolate audit writes"
```

## Task 2: Outbound OpenAI Timeout And Degrade Behavior

**Subagent ownership:** Worker B owns outbound helper, OpenAI embedding, OpenAI adapter, timeout config, and related tests.

**Files:**
- Create: `src/platform/outbound.ts`
- Modify: `src/config.ts`
- Modify: `src/memory/embedding.ts`
- Modify: `src/memory/store.ts`
- Modify: `src/agent/codex-adapter.ts`
- Test: `tests/config.test.ts`
- Test: `tests/memory.test.ts`
- Test: `tests/adapter.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

Run:

```bash
mcp__gitnexus__.context({ "repo": "codex-phantom", "name": "OpenAiEmbeddingService" })
mcp__gitnexus__.context({ "repo": "codex-phantom", "name": "CodexAdapter" })
mcp__gitnexus__.context({ "repo": "codex-phantom", "name": "MemoryStore" })
```

Expected: `OpenAiEmbeddingService` is constructed from `src/index.ts`; `CodexAdapter` participates in runtime tests and `src/index.ts`; `MemoryStore` is higher blast radius and needs careful tests.

- [ ] **Step 2: Write config tests for timeout fields**

Add to `tests/config.test.ts`:

```ts
test("config parses outbound OpenAI timeout settings", () => {
  withEnv({
    OPENAI_REQUEST_TIMEOUT_MS: "12000",
    OPENAI_EMBEDDING_TIMEOUT_MS: "3000"
  }, () => {
    const config = loadConfig();
    assert.equal(config.openAiRequestTimeoutMs, 12000);
    assert.equal(config.openAiEmbeddingTimeoutMs, 3000);
  });
});

test("config rejects invalid outbound OpenAI timeout settings", () => {
  withEnv({ OPENAI_REQUEST_TIMEOUT_MS: "0" }, () => {
    assert.throws(() => loadConfig(), /OPENAI_REQUEST_TIMEOUT_MS must be a positive integer/);
  });
});
```

If `withEnv` does not exist in this file, use the local env save/restore pattern already used by existing config tests.

- [ ] **Step 3: Add timeout config fields**

In `src/config.ts`, add fields to `AppConfig`:

```ts
openAiRequestTimeoutMs: number;
openAiEmbeddingTimeoutMs: number;
```

In `loadConfig`, parse:

```ts
openAiRequestTimeoutMs: parsePositiveInteger(process.env.OPENAI_REQUEST_TIMEOUT_MS, 60_000, "OPENAI_REQUEST_TIMEOUT_MS"),
openAiEmbeddingTimeoutMs: parsePositiveInteger(process.env.OPENAI_EMBEDDING_TIMEOUT_MS, 10_000, "OPENAI_EMBEDDING_TIMEOUT_MS"),
```

- [ ] **Step 4: Create timeout helper**

Create `src/platform/outbound.ts`:

```ts
export type TimeoutFetchOptions = RequestInit & {
  timeoutMs: number;
};

export async function fetchWithTimeout(url: string, options: TimeoutFetchOptions): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${options.timeoutMs}ms`));
  }, options.timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: options.signal ? anySignal([options.signal, controller.signal]) : controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const abort = (signal: AbortSignal): void => {
    controller.abort(signal.reason ?? new Error("Request aborted"));
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }

  return controller.signal;
}
```

- [ ] **Step 5: Add embedding timeout and graceful degradation**

In `src/memory/embedding.ts`, use `fetchWithTimeout`:

```ts
const response = await fetchWithTimeout(`${this.baseUrl ?? "https://api.openai.com/v1"}/embeddings`, {
  method: "POST",
  timeoutMs: this.timeoutMs,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${this.apiKey}`
  },
  body: JSON.stringify({
    model: this.model,
    input: texts
  })
});
```

Add `timeoutMs` as a private field from `config.openAiEmbeddingTimeoutMs`.

In `src/memory/store.ts`, catch embedding failures in `query`, `backfillEmbeddings`, and `storeEntries` paths where embeddings are requested. On failure, proceed with keyword/SQLite fallback and record `embedding_json = null` rather than throwing.

- [ ] **Step 6: Add adapter timeout behavior**

In `src/agent/codex-adapter.ts`, ensure `defaultOpenAiTransport` passes `request.signal` and `config.openAiRequestTimeoutMs` into `fetchWithTimeout`. If the stream request times out, let the error propagate through the existing runtime failure path.

Expected behavior: model timeouts fail the run clearly; embedding timeouts degrade memory retrieval.

- [ ] **Step 7: Write memory timeout fallback test**

In `tests/memory.test.ts`, add a fake embedding service that throws:

```ts
const failingEmbeddings = {
  enabled: true,
  model: "test-embedding",
  async embed(): Promise<number[][] | null> {
    throw new Error("embedding timeout");
  }
};
```

Assert:

```ts
await memory.recordTurn({
  sessionId: "session-timeout",
  runId: "run-timeout",
  queryText: "alpha",
  recentMessagesText: "alpha",
  userInput: "alpha",
  assistantOutput: "beta"
});

const results = await memory.query("alpha");
assert.ok(results.episodic.length >= 1);
```

- [ ] **Step 8: Write adapter timeout test**

In `tests/adapter.test.ts`, inject a transport that throws an abort-style timeout error:

```ts
const adapter = new CodexAdapter(config, {
  mode: "openai",
  transport: async () => {
    throw new Error("Request timed out after 5ms");
  }
});

await assert.rejects(
  () => adapter.run(request, async () => undefined),
  /timed out/
);
```

- [ ] **Step 9: Run targeted tests**

Run:

```bash
node --experimental-strip-types --test tests/config.test.ts tests/memory.test.ts tests/adapter.test.ts
```

Expected: targeted tests pass.

- [ ] **Step 10: Run full verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: typecheck passes and all tests pass.

- [ ] **Step 11: Run GitNexus change detection**

Run:

```bash
mcp__gitnexus__.detect_changes({ "repo": "codex-phantom", "scope": "all" })
```

Expected: changed symbols include `OpenAiEmbeddingService`, `CodexAdapter`, `MemoryStore`, and config parsing.

- [ ] **Step 12: Commit**

Run:

```bash
git add src/platform/outbound.ts src/config.ts src/memory/embedding.ts src/memory/store.ts src/agent/codex-adapter.ts tests/config.test.ts tests/memory.test.ts tests/adapter.test.ts
git commit -m "fix(agent): add outbound timeouts and memory fallback"
```

## Task 3: Compiled Production Runtime

**Subagent ownership:** Worker C owns packaging, Docker, deployment docs, and deployment tests.

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tsconfig.build.json`
- Modify: `tsconfig.json`
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `docs/phantom-parity.md`
- Test: `tests/deployment.test.ts`

- [ ] **Step 1: Inspect current build settings**

Run:

```bash
cat package.json
cat tsconfig.json
cat Dockerfile
```

Expected current issue: production starts with `node --experimental-strip-types src/index.ts`.

- [ ] **Step 2: Write failing deployment test**

In `tests/deployment.test.ts`, assert:

```ts
assert.match(dockerfile, /RUN npm run build/);
assert.match(dockerfile, /CMD \["node", "dist\/index\.js"\]/);
assert.doesNotMatch(dockerfile, /experimental-strip-types/);
```

Also assert `package.json` includes:

```ts
assert.equal(packageJson.scripts.build, "tsc -p tsconfig.build.json");
assert.equal(packageJson.scripts.start, "node dist/index.js");
assert.ok(packageJson.devDependencies.typescript);
```

- [ ] **Step 3: Run deployment test and confirm failure**

Run:

```bash
node --experimental-strip-types --test tests/deployment.test.ts
```

Expected before implementation: deployment test fails because Dockerfile and scripts still use strip-types runtime.

- [ ] **Step 4: Update package scripts**

Modify `package.json` scripts:

```json
{
  "scripts": {
    "dev": "node --experimental-strip-types src/index.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "node --experimental-strip-types --test tests/*.test.ts"
  }
}
```

Add `typescript` to `devDependencies` if it is not already declared:

```json
{
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^5.7.0"
  }
}
```

Run `npm install --save-dev typescript` if `package-lock.json` needs to be updated. Keep tests on strip-types for now; production runtime is the target.

- [ ] **Step 5: Add a build-specific TypeScript config**

Keep `tsconfig.json` as the development/typecheck config with `noEmit: true` and test includes. Create `tsconfig.build.json` for production compilation:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "allowImportingTsExtensions": false,
    "rewriteRelativeImportExtensions": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": [
    "src/**/*.ts"
  ],
  "exclude": [
    "tests/**/*.ts"
  ]
}
```

This avoids compiling tests into `dist` and rewrites local `.ts` import specifiers to `.js` in emitted files.

- [ ] **Step 6: Replace Dockerfile with multi-stage compiled runtime**

Use this structure:

```dockerfile
FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci

COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY README.md ./
COPY .env.example ./

RUN mkdir -p /app/data && chown -R node:node /app

ENV APP_ENV=production
ENV PORT=3210

EXPOSE 3210

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
```

- [ ] **Step 7: Update docs**

In `README.md`, keep local development command as:

```bash
npm run dev
```

Set production commands:

```bash
npm run build
npm start
```

In `docs/phantom-parity.md`, add compiled production runtime to matched coverage.

- [ ] **Step 8: Run build and deployment tests**

Run:

```bash
npm run build
node --experimental-strip-types --test tests/deployment.test.ts
```

Expected: TypeScript emits `dist`, and deployment tests pass.

- [ ] **Step 9: Run full verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: typecheck passes and all tests pass.

- [ ] **Step 10: Run GitNexus change detection**

Run:

```bash
mcp__gitnexus__.detect_changes({ "repo": "codex-phantom", "scope": "all" })
```

Expected: changed files are packaging, Docker, docs, deployment tests; no unexpected runtime flow changes.

- [ ] **Step 11: Commit**

Run:

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json Dockerfile docker-compose.yml README.md docs/phantom-parity.md tests/deployment.test.ts
git commit -m "build(runtime): run compiled javascript in production"
```

## Task 4: Durable MCP And Tool Audit

**Subagent ownership:** Worker D owns MCP audit storage, MCP server integration, operator visibility, and audit tests. Start after Task 1.

**Files:**
- Modify: `src/platform/database.ts`
- Create: `src/mcp/audit.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/server/http-server.ts`
- Modify: `src/server/export.ts`
- Test: `tests/mcp.test.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

Run:

```bash
mcp__gitnexus__.context({ "repo": "codex-phantom", "name": "McpServer" })
mcp__gitnexus__.context({ "repo": "codex-phantom", "name": "AppDatabase" })
mcp__gitnexus__.context({ "repo": "codex-phantom", "name": "HttpServer" })
```

Expected: `AppDatabase` is broad blast radius; migration must be additive only.

- [ ] **Step 2: Add audit table migration**

In `src/platform/database.ts`, add:

```sql
CREATE TABLE IF NOT EXISTS mcp_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  method TEXT NOT NULL,
  tool_name TEXT,
  outcome TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_created_at ON mcp_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_method ON mcp_audit_logs(method, created_at DESC);
```

- [ ] **Step 3: Create MCP audit store**

Create `src/mcp/audit.ts`:

```ts
import type { AppDatabase } from "../platform/database.ts";

export type McpAuditInput = {
  requestId?: string;
  method: string;
  toolName?: string;
  outcome: "auth_failed" | "success" | "denied" | "failed" | "unsupported";
  statusCode: number;
  errorMessage?: string;
};

export type McpAuditRecord = McpAuditInput & {
  id: number;
  createdAt: string;
};

type McpAuditRow = {
  id: number;
  request_id: string | null;
  method: string;
  tool_name: string | null;
  outcome: McpAuditInput["outcome"];
  status_code: number;
  error_message: string | null;
  created_at: string;
};

export class McpAuditStore {
  constructor(private readonly database: AppDatabase) {}

  record(input: McpAuditInput): void {
    this.database.run(
      `
        INSERT INTO mcp_audit_logs (request_id, method, tool_name, outcome, status_code, error_message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      input.requestId ?? null,
      input.method,
      input.toolName ?? null,
      input.outcome,
      input.statusCode,
      input.errorMessage ?? null,
      new Date().toISOString()
    );
  }

  list(limit = 50): McpAuditRecord[] {
    return this.database
      .all<McpAuditRow>(
        `
          SELECT id, request_id, method, tool_name, outcome, status_code, error_message, created_at
          FROM mcp_audit_logs
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
        Math.max(1, Math.min(limit, 250))
      )
      .map((row) => ({
        id: row.id,
        requestId: row.request_id ?? undefined,
        method: row.method,
        toolName: row.tool_name ?? undefined,
        outcome: row.outcome,
        statusCode: row.status_code,
        errorMessage: row.error_message ?? undefined,
        createdAt: row.created_at
      }));
  }
}
```

- [ ] **Step 4: Integrate MCP audit into McpServer**

Update `McpServer` constructor to accept an optional `McpAuditStore`.

Record:

```ts
this.audit?.record({ method: body.method ?? "unknown", outcome: "success", statusCode: 200 });
```

Use these outcomes:

- `auth_failed` for invalid bearer token.
- `success` for successful `tools/list` or `tools/call`.
- `denied` when policy rejects a tool.
- `failed` when a tool throws.
- `unsupported` for unsupported methods.

Do not store raw bearer tokens or request payloads.

- [ ] **Step 5: Add operator visibility**

In `HttpServer`, construct `McpAuditStore` and pass it to `McpServer` from `src/index.ts`, or pass a preconstructed store into both server and MCP during wiring.

Add:

```ts
GET /admin/mcp/audit
```

Response shape:

```ts
this.json(res, 200, { audit: this.mcpAudit.list(limit ? Number(limit) : 50) });
```

Add export support for scope `mcp`:

```ts
case "mcp":
  return { items: this.mcpAudit.list(250) };
```

- [ ] **Step 6: Write MCP audit tests**

In `tests/mcp.test.ts`, assert that auth failure, tools/list success, denied tool call, and unsupported method create durable audit rows.

Example assertion:

```ts
const audit = new McpAuditStore(database);
const mcp = new McpServer("secret", tools, metrics, undefined, audit);

await mcp.handle(new Request("http://localhost/mcp", {
  method: "POST",
  headers: { Authorization: "Bearer wrong" },
  body: JSON.stringify({ method: "tools/list" })
}));

assert.equal(audit.list(10)[0]?.outcome, "auth_failed");
```

- [ ] **Step 7: Write operator route test**

In `tests/server.test.ts`, call:

```ts
const response = await fetch(`${baseUrl}/admin/mcp/audit`, {
  headers: { Authorization: `Bearer ${operatorToken}` }
});

assert.equal(response.status, 200);
const json = await response.json() as { audit?: unknown[] };
assert.ok(Array.isArray(json.audit));
```

- [ ] **Step 8: Run targeted tests**

Run:

```bash
node --experimental-strip-types --test tests/mcp.test.ts tests/server.test.ts
```

Expected: targeted tests pass.

- [ ] **Step 9: Run full verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: typecheck passes and all tests pass.

- [ ] **Step 10: Run GitNexus change detection**

Run:

```bash
mcp__gitnexus__.detect_changes({ "repo": "codex-phantom", "scope": "all" })
```

Expected: affected flows include MCP handling and operator export/admin surfaces.

- [ ] **Step 11: Commit**

Run:

```bash
git add src/platform/database.ts src/mcp/audit.ts src/mcp/server.ts src/server/http-server.ts src/server/export.ts tests/mcp.test.ts tests/server.test.ts
git commit -m "feat(ops): persist MCP audit events"
```

## Task 5: Scheduler Recovery And Retry Semantics

**Subagent ownership:** Worker E owns scheduler service and focused scheduler tests. Coordinate with Worker A if both need `tests/server.test.ts`.

**Files:**
- Modify: `src/scheduler/service.ts`
- Modify: `src/server/validation.ts`
- Test: `tests/scheduler.test.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: Run GitNexus impact analysis**

Run:

```bash
mcp__gitnexus__.context({ "repo": "codex-phantom", "name": "SchedulerService" })
```

Expected: `SchedulerService` is imported by `src/index.ts`, `src/server/http-server.ts`, and server tests.

- [ ] **Step 2: Create focused scheduler tests**

Create `tests/scheduler.test.ts` with an in-memory database and fake orchestration service.

Use a fake orchestration shape:

```ts
const orchestration = {
  async runCoordinator() {
    return { sessionId: "session", runId: "run", outputText: "ok" };
  }
} as unknown as OrchestrationService;
```

Test startup recovery:

```ts
database.run(
  `
    INSERT INTO jobs (
      id, name, message, scheduled_at, subagents_json, status, created_at,
      started_at, finished_at, attempt_count, max_attempts, failure_reason, last_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  "job-stale",
  "stale",
  "run me",
  new Date(Date.now() - 1000).toISOString(),
  "[]",
  "running",
  new Date().toISOString(),
  new Date(Date.now() - 60000).toISOString(),
  null,
  1,
  3,
  null,
  null
);

const scheduler = new SchedulerService(database, orchestration);
await scheduler.start();
const job = (await scheduler.list()).find((item) => item.id === "job-stale");
assert.equal(job?.status, "scheduled");
```

Test retry exhaustion with fake orchestration that throws.

- [ ] **Step 3: Run scheduler test and confirm failure**

Run:

```bash
node --experimental-strip-types --test tests/scheduler.test.ts
```

Expected before implementation: recovery test fails because `running` jobs are ignored on startup.

- [ ] **Step 4: Implement stale running recovery**

In `SchedulerService.start`, before arming scheduled jobs:

```ts
await this.recoverStaleRunningJobs();
const jobs = await this.list();
for (const job of jobs) {
  if (job.status === "scheduled") {
    this.arm(job);
  }
}
```

Add:

```ts
private async recoverStaleRunningJobs(): Promise<void> {
  const jobs = await this.list();
  for (const job of jobs) {
    if (job.status !== "running") {
      continue;
    }
    const exhausted = job.attemptCount >= job.maxAttempts;
    await this.update({
      ...job,
      status: exhausted ? "failed" : "scheduled",
      scheduledAt: exhausted ? job.scheduledAt : new Date().toISOString(),
      finishedAt: exhausted ? new Date().toISOString() : undefined,
      failureReason: exhausted ? "Job was running during shutdown and attempts are exhausted" : "Recovered after interrupted run"
    });
  }
}
```

- [ ] **Step 5: Add bounded retry delay**

Replace fixed retry delay with a helper:

```ts
function retryDelayMs(attemptCount: number): number {
  return Math.min(60_000, 1_000 * Math.max(1, 2 ** Math.max(0, attemptCount - 1)));
}
```

Use:

```ts
scheduledAt: shouldRetry ? new Date(Date.now() + retryDelayMs(job.attemptCount + 1)).toISOString() : job.scheduledAt,
```

- [ ] **Step 6: Validate scheduler inputs remain bounded**

In `src/server/validation.ts`, keep `maxAttempts` as positive integer and add an upper bound:

```ts
maxAttempts: optionalBoundedPositiveInteger(value.maxAttempts, "maxAttempts", 10)
```

Implement:

```ts
function optionalBoundedPositiveInteger(value: unknown, field: string, max: number): number | undefined {
  const parsed = optionalPositiveInteger(value, field);
  if (parsed !== undefined && parsed > max) {
    throw new HttpError(400, `${field} must be less than or equal to ${max}`);
  }
  return parsed;
}
```

- [ ] **Step 7: Run targeted tests**

Run:

```bash
node --experimental-strip-types --test tests/scheduler.test.ts tests/server.test.ts
```

Expected: scheduler tests and server validation tests pass.

- [ ] **Step 8: Run full verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: typecheck passes and all tests pass.

- [ ] **Step 9: Run GitNexus change detection**

Run:

```bash
mcp__gitnexus__.detect_changes({ "repo": "codex-phantom", "scope": "all" })
```

Expected: affected flows include scheduler start/schedule/execute.

- [ ] **Step 10: Commit**

Run:

```bash
git add src/scheduler/service.ts src/server/validation.ts tests/scheduler.test.ts tests/server.test.ts
git commit -m "fix(scheduler): recover stale jobs and bound retries"
```

## Final Integration And Review

- [ ] **Step 1: Run full verification**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: all commands pass.

- [ ] **Step 2: Run GitNexus change detection**

Run:

```bash
mcp__gitnexus__.detect_changes({ "repo": "codex-phantom", "scope": "all" })
```

Expected: changed symbols align with HTTP, outbound calls, Docker/build, MCP audit, and scheduler hardening.

- [ ] **Step 3: Optional deployment smoke**

Run only when Docker and required env vars are available:

```bash
set -a
source .env
set +a
scripts/deployment-smoke.sh
```

Expected: Compose stack builds, boots, rejects unauthenticated admin access, accepts operator-token access, persists settings across restart.

- [ ] **Step 4: Final reviewer subagent**

Dispatch a reviewer subagent with:

```text
Review the full production readiness hardening implementation in /Users/aaronstevens/dev/codex-phantom.

Scope:
- bounded HTTP request bodies
- outbound OpenAI timeouts and memory fallback
- compiled production Docker/runtime path
- durable MCP audit
- scheduler stale-job recovery and bounded retries

Focus on regressions, missed tests, production failure modes, and scope creep. Do not make edits. Return findings ordered by severity with file/line references.
```

- [ ] **Step 5: Update parity notes if needed**

If implementation changed operator claims, update `docs/phantom-parity.md` so matched/deferred status remains accurate.

## Completion Criteria

- Oversized request bodies return HTTP 413.
- Request audit write failures are logged and do not break response handling.
- OpenAI embedding calls have a timeout and degrade memory recall instead of blocking service startup or chat flow.
- OpenAI model calls have timeout behavior that fails runs clearly.
- Production Docker runtime runs compiled JavaScript.
- MCP auth and tool operations are persisted to SQLite audit records without storing raw tokens.
- Operator API can read/export MCP audit history.
- Scheduler recovers stale `running` jobs after process restart.
- Scheduler retry delay is bounded and deterministic.
- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- GitNexus `detect_changes` reports the expected affected symbols and no surprising high-risk flow expansion.
