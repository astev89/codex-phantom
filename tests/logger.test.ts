import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createLogger } from "../src/platform/logger.ts";

test("pino logger emits structured JSON with child bindings", async () => {
  const destination = new PassThrough();
  const chunks: string[] = [];
  destination.on("data", (chunk) => {
    chunks.push(chunk.toString("utf8"));
  });

  const logger = createLogger("info", { destination });
  const child = logger.child({ requestId: "req_123" });
  child.info("request_complete", { path: "/health", status: 200 });

  await new Promise((resolve) => setImmediate(resolve));

  const line = chunks.join("").trim().split("\n").filter(Boolean).at(-1);
  assert.ok(line);
  const payload = JSON.parse(line) as {
    level: number;
    msg: string;
    requestId: string;
    path: string;
    status: number;
  };
  assert.equal(payload.msg, "request_complete");
  assert.equal(payload.requestId, "req_123");
  assert.equal(payload.path, "/health");
  assert.equal(payload.status, 200);
});
