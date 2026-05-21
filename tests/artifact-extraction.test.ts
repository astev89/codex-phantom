import test from "node:test";
import assert from "node:assert/strict";
import {
  extractArtifactDraftsFromEvent,
  extractArtifactDraftsFromOutputText,
  MAX_EXTRACTED_ARTIFACT_BYTES,
} from "../src/chat/artifact-extraction.ts";

test("extracts bounded safe artifacts from tool output envelopes", () => {
  const event = {
    type: "tool_call_succeeded" as const,
    runId: "coord_1",
    sessionId: "sess_1",
    toolCallId: "tc_1",
    toolName: "echo.summary",
    output: JSON.stringify({
      artifacts: [
        {
          title: "One",
          kind: "text",
          contentType: "text/plain",
          content: "first",
        },
        {
          title: "Two",
          kind: "json",
          contentType: "application/json",
          content: { ok: true },
        },
        {
          title: "Unsafe",
          kind: "file",
          contentType: "application/octet-stream",
          content: "binary-ish",
        },
        {
          title: "Too Large",
          kind: "text",
          contentType: "text/plain",
          content: "x".repeat(MAX_EXTRACTED_ARTIFACT_BYTES + 1),
        },
      ],
    }),
  };

  const drafts = extractArtifactDraftsFromEvent(event, 5);
  assert.deepEqual(
    drafts.map((draft) => draft.title),
    ["One", "Two"]
  );
  const firstMetadata = drafts[0].metadata as {
    source?: { sourceType?: string; toolName?: string };
  };
  assert.equal(firstMetadata.source?.sourceType, "tool_event");
  assert.equal(firstMetadata.source?.toolName, "echo.summary");
  assert.equal(drafts[1].content.toString("utf8"), '{\n  "ok": true\n}');
});

test("extracts final-output artifacts only when the output is structured JSON", () => {
  assert.deepEqual(extractArtifactDraftsFromOutputText("plain text", 5), []);

  const drafts = extractArtifactDraftsFromOutputText(
    JSON.stringify({
      artifact: {
        title: "Final",
        kind: "text",
        contentType: "text/markdown",
        content: "# Final",
      },
    }),
    1
  );

  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].title, "Final");
  const metadata = drafts[0].metadata as { source?: { sourceType?: string } };
  assert.equal(metadata.source?.sourceType, "final_output");
});
