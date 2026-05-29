import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/platform/database.ts";
import { SessionStore } from "../src/chat/session-store.ts";
import { RunGraphStore } from "../src/orchestration/run-graph-store.ts";
import { ChatBlobStore } from "../src/chat/blob-store.ts";
import { ChatArtifactStore } from "../src/chat/artifact-store.ts";
import { AttachmentTextIndexStore } from "../src/chat/attachment-text-index.ts";
import { ChatArtifactService } from "../src/chat/artifacts.ts";
import {
  MAX_ATTACHMENT_TEXT_INDEX_BYTES,
  MAX_EXTRACTED_ARTIFACTS_PER_RUN,
  extractSearchableAttachmentText,
} from "../src/chat/content-policy.ts";
import { extractArtifactDraftsFromOutputText } from "../src/chat/artifact-extraction.ts";

test("uploads attachments, indexes safe text, skips binary, and caps indexed bytes", async (t) => {
  const { database, service } = await makeHarness(t);
  await seedWebSession(database);

  const boundedText = `${"a".repeat(MAX_ATTACHMENT_TEXT_INDEX_BYTES)}outside-boundary`;
  const attachments = await service.uploadAttachments({
    sessionId: "sess_web",
    runId: "run_1",
    files: [
      {
        fileName: "notes.txt",
        contentType: "text/plain",
        content: Buffer.from("hello indexed attachment", "utf8"),
      },
      {
        fileName: "photo.png",
        contentType: "image/png",
        content: Buffer.from("binary-secret", "utf8"),
      },
      {
        fileName: "bounded.txt",
        contentType: "text/plain",
        content: Buffer.from(boundedText, "utf8"),
      },
    ],
  });

  assert.equal(attachments.length, 3);
  assert.equal(attachments[0].name, "notes.txt");
  assert.match(String(attachments[0].downloadUrl), /^\/chat\/attachments\//);

  const textMatches = service.searchAttachmentText({
    query: "indexed attachment",
  });
  assert.equal(textMatches.length, 1);
  assert.equal(textMatches[0].name, "notes.txt");

  assert.deepEqual(
    service.searchAttachmentText({ query: "binary-secret" }),
    []
  );
  assert.equal(
    service.searchAttachmentText({ query: "outside-boundary" }).length,
    0
  );

  const state = await service.listSessionArtifactState("sess_web");
  assert.equal(state.attachments.length, 3);
  assert.equal(state.artifacts.length, 0);
  assert.equal(state.attachmentTextIndexes.length, 3);
  assert.deepEqual(
    state.attachmentTextIndexes.map((record) => record.skippedReason),
    [undefined, "unsafe_content_type", undefined]
  );
  assert.equal(
    state.attachmentTextIndexes[2].indexedBytes,
    MAX_ATTACHMENT_TEXT_INDEX_BYTES
  );
});

test("downloads attachments only through owned web sessions", async (t) => {
  const { database, service, sessions } = await makeHarness(t);
  await seedWebSession(database);

  const [attachment] = await service.uploadAttachments({
    sessionId: "sess_web",
    files: [
      {
        fileName: "../report.md",
        contentType: "text/markdown",
        content: Buffer.from("# Report", "utf8"),
      },
    ],
  });

  const download = await service.getAttachmentDownload(String(attachment.id));
  assert.equal(download.fileName, ".._report.md");
  assert.equal(download.contentType, "text/markdown");
  assert.equal(download.content.toString("utf8"), "# Report");

  await sessions.upsert({
    sessionId: "sess_slack",
    channelId: "slack",
    conversationId: "C123:T123",
    resumability: { supportsResume: false },
    createdAt: NOW,
    updatedAt: NOW,
    runIds: [],
  });
  const inserted = await sessions.recordUploadedAttachment({
    id: "att_slack",
    sessionId: "sess_slack",
    name: "slack.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    storagePath: "missing",
    sha256: "sha",
  });
  await assert.rejects(
    service.getAttachmentDownload(inserted.id),
    /Chat session not found/
  );
});

test("creates manual artifacts with stable summaries and download handles", async (t) => {
  const { database, service } = await makeHarness(t);
  await seedWebSession(database);

  const text = await service.createArtifact({
    sessionId: "sess_web",
    runId: "run_1",
    title: "Research Summary",
    kind: "text",
    contentType: "text/markdown",
    content: "# Summary\nDone",
    metadata: { source: "manual" },
  });
  const json = await service.createArtifact({
    sessionId: "sess_web",
    runId: "run_1",
    title: "Structured",
    kind: "json",
    contentType: "application/json",
    content: { ok: true },
  });
  const file = await service.createArtifact({
    sessionId: "sess_web",
    title: "Opaque",
    kind: "file",
    contentType: "application/octet-stream",
    content: "opaque bytes",
  });

  assert.equal(text.kind, "text");
  assert.equal(text.sizeBytes, Buffer.byteLength("# Summary\nDone"));
  assert.match(String(text.sha256), /^[a-f0-9]{64}$/);
  assert.equal(text.downloadUrl, `/chat/artifacts/${text.id}`);
  assert.equal(json.sizeBytes, Buffer.byteLength('{\n  "ok": true\n}'));
  assert.equal(file.contentType, "application/octet-stream");

  const textDownload = await service.getArtifactDownload(String(text.id));
  assert.equal(textDownload.fileName, "Research Summary.md");
  assert.equal(textDownload.content.toString("utf8"), "# Summary\nDone");
});

test("persists auto-extracted artifacts through shared content policy", async (t) => {
  const { database, service } = await makeHarness(t);
  await seedWebSession(database);

  const drafts = extractArtifactDraftsFromOutputText(
    JSON.stringify({
      artifacts: [
        {
          title: "One",
          kind: "text",
          contentType: "text/plain",
          content: "one",
        },
        {
          title: "Unsafe",
          kind: "file",
          contentType: "application/octet-stream",
          content: "binary",
        },
        ...Array.from({ length: 10 }, (_, index) => ({
          title: `Extra ${index}`,
          kind: "json",
          content: { index },
        })),
      ],
    }),
    MAX_EXTRACTED_ARTIFACTS_PER_RUN
  );

  assert.equal(drafts.length, MAX_EXTRACTED_ARTIFACTS_PER_RUN);
  assert.equal(
    drafts.some((draft) => draft.title === "Unsafe"),
    false
  );

  const artifacts = await service.persistExtractedArtifacts({
    sessionId: "sess_web",
    runId: "run_1",
    drafts,
  });
  assert.equal(artifacts.length, MAX_EXTRACTED_ARTIFACTS_PER_RUN);
  const metadata = artifacts[0].metadata as {
    autoExtracted?: boolean;
    source?: { sourceType?: string };
  };
  assert.equal(metadata.autoExtracted, true);
  assert.equal(metadata.source?.sourceType, "final_output");
});

test("content policy exposes no-op extraction outcomes for unsafe or empty attachment text", () => {
  assert.deepEqual(
    extractSearchableAttachmentText(
      "application/octet-stream",
      Buffer.from("secret")
    ),
    { bytes: 0, skippedReason: "unsafe_content_type" }
  );
  assert.deepEqual(
    extractSearchableAttachmentText("text/plain", Buffer.from("   \0")),
    { bytes: 0, skippedReason: "empty_text" }
  );
});

async function makeHarness(t: TestContext): Promise<{
  database: AppDatabase;
  sessions: SessionStore;
  runs: RunGraphStore;
  service: ChatArtifactService;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "chat-artifacts-"));
  const database = new AppDatabase(join(dataDir, "chat-artifacts.sqlite"));
  const sessions = new SessionStore(database);
  const runs = new RunGraphStore(database);
  const service = new ChatArtifactService({
    sessions,
    runs,
    blobs: new ChatBlobStore(dataDir),
    artifacts: new ChatArtifactStore(database),
    attachmentTextIndexes: new AttachmentTextIndexStore(database),
  });
  t.after(() => database.close());
  return { database, sessions, runs, service };
}

async function seedWebSession(database: AppDatabase): Promise<void> {
  const sessions = new SessionStore(database);
  const runs = new RunGraphStore(database);
  await runs.upsert({
    runId: "run_1",
    role: "coordinator",
    objective: "chat",
    status: "completed",
    permissionPolicy: {
      mode: "read_only",
      fileGlobs: [],
      allowedToolIds: [],
      allowedMcpServers: [],
    },
    allowedMcpServers: [],
    allowedToolIds: [],
    childRunIds: [],
    transcript: [],
    startedAt: NOW,
    finishedAt: NOW,
  });
  await sessions.upsert({
    sessionId: "sess_web",
    channelId: "web",
    conversationId: "web-chat",
    resumability: { supportsResume: false },
    createdAt: NOW,
    updatedAt: NOW,
    runIds: ["run_1"],
  });
}

const NOW = "2026-05-27T00:00:00.000Z";
