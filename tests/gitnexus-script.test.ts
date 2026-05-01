import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("gitnexus refresh script runs thorough analysis before syncing codex skills", async () => {
  const script = await readFile("scripts/gitnexus-refresh-skills.sh", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.["gitnexus:refresh"], "scripts/gitnexus-refresh-skills.sh");
  assert.ok(script.includes('npx gitnexus analyze --skills --embeddings "$@"'));
  assert.ok(script.includes('source_root=".claude/skills"'));
  assert.ok(script.includes('dest_root=".agents/skills"'));
  assert.ok(script.includes('sync_dirs=("generated" "gitnexus")'));
  assert.ok(script.includes('rm -rf "$dest_root/$dir"'));
});
