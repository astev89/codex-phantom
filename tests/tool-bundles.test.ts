import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/platform/database.ts";
import { ToolBundleImportStore } from "../src/tools/bundles.ts";
import {
  ToolBundleLifecycleError,
  ToolBundleLifecycleService,
} from "../src/tools/bundle-lifecycle.ts";
import { DynamicToolRegistry } from "../src/tools/dynamic-registry.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

test("tool bundle import preview records valid manifests without activating tools", () => {
  const database = new AppDatabase(":memory:");
  const store = new ToolBundleImportStore(database);

  const preview = store.preview({
    importedBy: "operator",
    manifest: {
      id: "internal.research",
      name: "Internal Research Tools",
      version: "1.0.0",
      tools: [
        {
          id: "internal.research.lookup",
          description: "Lookup internal research notes.",
          scopes: ["read"],
          inputSchema: { type: "object" },
          responseTemplate: "lookup:{{query}}",
          installation: { note: "No install is run during preview." },
        },
      ],
    },
  });

  assert.equal(preview.status, "valid");
  assert.equal(preview.lifecycleState, "previewed");
  assert.equal(preview.bundleId, "internal.research");
  assert.equal(preview.importedBy, "operator");
  assert.ok(preview.diagnostics.some((item) => item.level === "warning"));
  assert.equal(store.summary().valid, 1);
  assert.equal(store.list()[0]?.id, preview.id);
  const approved = store.approve(preview.id, "operator", "read-only bundle");
  assert.equal(approved.lifecycleState, "approved");
  assert.equal(approved.approvedBy, "operator");
  const enabled = store.markEnabled(preview.id, "operator");
  assert.equal(enabled.lifecycleState, "enabled");
  const disabled = store.markDisabled(preview.id, "operator");
  assert.equal(disabled.lifecycleState, "disabled");
  const uninstalled = store.markUninstalled(preview.id, "operator");
  assert.equal(uninstalled.lifecycleState, "uninstalled");
  assert.ok(
    store.listAudit(preview.id).some((entry) => entry.action === "uninstalled")
  );
  database.close();
});

test("tool bundle import preview records invalid over-broad manifests", () => {
  const database = new AppDatabase(":memory:");
  const store = new ToolBundleImportStore(database);

  const preview = store.preview({
    importedBy: "operator",
    manifest: {
      id: "bad.bundle",
      name: "Bad Bundle",
      version: "1.0.0",
      tools: [
        {
          id: "bad.bundle.mutate",
          description: "Mutate runtime state.",
          scopes: ["read", "write"],
          responseTemplate: "unsafe",
        },
        {
          id: "bad.bundle.mutate",
          description: "Duplicate tool.",
          scopes: ["read"],
          responseTemplate: "duplicate",
        },
      ],
    },
  });

  assert.equal(preview.status, "invalid");
  assert.ok(
    preview.diagnostics.some((item) => item.message.includes("read-only"))
  );
  assert.ok(
    preview.diagnostics.some((item) => item.message.includes("unique"))
  );
  assert.equal(store.summary().invalid, 1);
  database.close();
});

test("tool bundle lifecycle unregisters partially enabled tools after failure", () => {
  const database = new AppDatabase(":memory:");
  const store = new ToolBundleImportStore(database);
  const registered: string[] = [];
  const unregistered: string[] = [];
  const dynamicTools = {
    has() {
      return false;
    },
    registerApproved(tool: { id: string }) {
      if (tool.id === "internal.partial.second") {
        throw new Error("simulated registry failure");
      }
      registered.push(tool.id);
    },
    unregister(toolId: string) {
      unregistered.push(toolId);
      return true;
    },
  } as unknown as DynamicToolRegistry;
  const lifecycle = new ToolBundleLifecycleService({
    toolBundles: store,
    dynamicTools,
  });
  const preview = store.preview({
    importedBy: "operator",
    manifest: {
      id: "internal.partial",
      name: "Partial Bundle",
      version: "1.0.0",
      tools: [
        {
          id: "internal.partial.first",
          description: "First tool.",
          scopes: ["read"],
          responseTemplate: "first",
        },
        {
          id: "internal.partial.second",
          description: "Second tool.",
          scopes: ["read"],
          responseTemplate: "second",
        },
      ],
    },
  });
  const approved = store.approve(preview.id, "operator", "read-only bundle");

  assert.throws(
    () => lifecycle.enable(approved.id, "operator"),
    (error) =>
      error instanceof ToolBundleLifecycleError &&
      error.message === "simulated registry failure"
  );
  assert.deepEqual(registered, ["internal.partial.first"]);
  assert.deepEqual(unregistered, ["internal.partial.first"]);
  assert.equal(store.get(approved.id)?.lifecycleState, "failed");
  database.close();
});

test("tool bundle lifecycle rejects tool id collisions without replacing existing tools", async () => {
  const database = new AppDatabase(":memory:");
  const store = new ToolBundleImportStore(database);
  const tools = new ToolRegistry();
  const dynamicTools = new DynamicToolRegistry(database, tools);
  const lifecycle = new ToolBundleLifecycleService({
    toolBundles: store,
    dynamicTools,
  });
  dynamicTools.registerApproved(
    {
      id: "shared.tool",
      description: "Existing shared tool.",
      scopes: ["read"],
      responseTemplate: "existing:{{query}}",
    },
    { approvedBy: "operator", notes: "existing dynamic tool" }
  );
  const preview = store.preview({
    importedBy: "operator",
    manifest: {
      id: "internal.collision",
      name: "Collision Bundle",
      version: "1.0.0",
      tools: [
        {
          id: "shared.tool",
          description: "Conflicting bundled tool.",
          scopes: ["read"],
          responseTemplate: "bundle:{{query}}",
        },
      ],
    },
  });
  const approved = store.approve(preview.id, "operator", "read-only bundle");

  assert.throws(
    () => lifecycle.enable(approved.id, "planner"),
    (error) =>
      error instanceof ToolBundleLifecycleError &&
      error.status === 409 &&
      error.message === "Tool bundle tool id already exists: shared.tool"
  );

  assert.equal(store.get(approved.id)?.lifecycleState, "approved");
  assert.equal(dynamicTools.get("shared.tool")?.approvedBy, "operator");
  assert.deepEqual(await tools.call("shared.tool", { query: "collision" }), {
    toolId: "shared.tool",
    content: "existing:collision",
    input: { query: "collision" },
  });
  database.close();
});
