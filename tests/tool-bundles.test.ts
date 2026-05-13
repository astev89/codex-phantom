import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "../src/platform/database.ts";
import { ToolBundleImportStore } from "../src/tools/bundles.ts";

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
  assert.equal(preview.bundleId, "internal.research");
  assert.equal(preview.importedBy, "operator");
  assert.ok(preview.diagnostics.some((item) => item.level === "warning"));
  assert.equal(store.summary().valid, 1);
  assert.equal(store.list()[0]?.id, preview.id);
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
