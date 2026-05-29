import { createId } from "../shared/ids.ts";
import type { JsonValue, SessionRecord } from "../shared/types.ts";
import type { RunGraphStore } from "../orchestration/run-graph-store.ts";
import { HttpError } from "../server/validation.ts";
import type { ChatArtifactRecord, ChatArtifactKind } from "./artifact-store.ts";
import { ChatArtifactStore } from "./artifact-store.ts";
import { ChatBlobStore } from "./blob-store.ts";
import type {
  AttachmentTextIndexRecord,
  AttachmentTextSearchResult,
} from "./attachment-text-index.ts";
import { AttachmentTextIndexStore } from "./attachment-text-index.ts";
import type {
  ChatAttachmentInput,
  ChatAttachmentRecord,
  SessionStore,
} from "./session-store.ts";
import type { ExtractedArtifactDraft } from "./artifact-extraction.ts";
import {
  artifactContentBuffer,
  artifactFileName,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_UPLOAD_FILES,
  safeDownloadName,
} from "./content-policy.ts";

export type ChatArtifactUploadFile = {
  fileName: string;
  contentType: string;
  content: Buffer;
};

export type ChatDownload = {
  content: Buffer;
  contentType: string;
  fileName: string;
};

export class ChatArtifactService {
  private readonly sessions: SessionStore;
  private readonly runs: RunGraphStore;
  private readonly blobs: ChatBlobStore;
  private readonly artifacts: ChatArtifactStore;
  private readonly attachmentTextIndexes: AttachmentTextIndexStore;

  constructor(input: {
    sessions: SessionStore;
    runs: RunGraphStore;
    blobs: ChatBlobStore;
    artifacts: ChatArtifactStore;
    attachmentTextIndexes: AttachmentTextIndexStore;
  }) {
    this.sessions = input.sessions;
    this.runs = input.runs;
    this.blobs = input.blobs;
    this.artifacts = input.artifacts;
    this.attachmentTextIndexes = input.attachmentTextIndexes;
  }

  async uploadAttachments(input: {
    sessionId: string;
    runId?: string;
    files: ChatArtifactUploadFile[];
  }): Promise<Array<Record<string, JsonValue>>> {
    const session = await this.requireWebChatSession(input.sessionId);
    if (input.runId) {
      await this.requireSessionRun(session, input.runId);
    }
    if (input.files.length === 0) {
      throw new HttpError(400, "At least one file is required");
    }
    if (input.files.length > MAX_CHAT_UPLOAD_FILES) {
      throw new HttpError(
        400,
        `file must contain ${MAX_CHAT_UPLOAD_FILES} or fewer items`
      );
    }

    const attachments = [];
    for (const file of input.files) {
      if (file.content.byteLength > MAX_CHAT_ATTACHMENT_BYTES) {
        throw new HttpError(
          413,
          `Attachment exceeds ${MAX_CHAT_ATTACHMENT_BYTES} bytes`
        );
      }
      const id = createId("att");
      const blob = await this.blobs.write(id, file.content);
      const attachment = await this.sessions.recordUploadedAttachment({
        id,
        sessionId: session.sessionId,
        runId: input.runId,
        name: safeDownloadName(file.fileName || "upload.bin"),
        contentType: file.contentType || "application/octet-stream",
        sizeBytes: blob.sizeBytes,
        storagePath: blob.storagePath,
        sha256: blob.sha256,
      });
      this.attachmentTextIndexes.indexAttachment(attachment, file.content);
      attachments.push(attachment);
    }

    return attachments.map(toAttachmentSummary);
  }

  searchAttachmentText(input: {
    query: string;
    limit?: number;
  }): Array<Record<string, JsonValue>> {
    const query = input.query.trim();
    if (!query) {
      throw new HttpError(400, "q is required");
    }
    return this.attachmentTextIndexes
      .search(query, input.limit ?? 25)
      .map(toAttachmentTextSearchSummary);
  }

  async getAttachmentDownload(attachmentId: string): Promise<ChatDownload> {
    const attachment = await this.sessions.getAttachment(attachmentId);
    if (!attachment?.storagePath) {
      throw new HttpError(404, "Attachment not found");
    }
    await this.requireWebChatSession(attachment.sessionId);
    return {
      content: await this.blobs.read(attachment.storagePath),
      contentType: attachment.contentType,
      fileName: safeDownloadName(attachment.name),
    };
  }

  async createArtifact(input: {
    sessionId: string;
    runId?: string;
    title: string;
    kind: ChatArtifactKind;
    contentType: string;
    content: JsonValue;
    metadata?: JsonValue;
  }): Promise<Record<string, JsonValue>> {
    const session = await this.requireWebChatSession(input.sessionId);
    if (input.runId) {
      await this.requireSessionRun(session, input.runId);
    }
    const artifact = await this.createArtifactRecord({
      sessionId: session.sessionId,
      runId: input.runId,
      title: input.title,
      kind: input.kind,
      contentType: input.contentType,
      content: artifactContentBuffer(input.kind, input.content),
      metadata: input.metadata ?? null,
    });
    return toArtifactSummary(artifact);
  }

  async getArtifactDownload(artifactId: string): Promise<ChatDownload> {
    const artifact = await this.artifacts.get(artifactId);
    if (!artifact) {
      throw new HttpError(404, "Artifact not found");
    }
    await this.requireWebChatSession(artifact.sessionId);
    return {
      content: await this.blobs.read(artifact.storagePath),
      contentType: artifact.contentType,
      fileName: safeDownloadName(artifactFileName(artifact)),
    };
  }

  async listSessionArtifactState(sessionId: string): Promise<{
    attachments: Array<Record<string, JsonValue>>;
    artifacts: Array<Record<string, JsonValue>>;
    attachmentTextIndexes: Array<Record<string, JsonValue>>;
  }> {
    const session = await this.requireWebChatSession(sessionId);
    const attachments = await this.sessions.listAttachments(session.sessionId);
    const artifacts = await this.artifacts.listForSession(session.sessionId);
    const attachmentTextIndexes = this.attachmentTextIndexes.listForSession(
      session.sessionId
    );
    return {
      attachments: attachments.map(toAttachmentSummary),
      artifacts: artifacts.map(toArtifactSummary),
      attachmentTextIndexes: attachmentTextIndexes.map(
        toAttachmentTextIndexSummary
      ),
    };
  }

  async linkAttachmentsToRun(input: {
    sessionId: string;
    runId: string;
    attachmentIds: string[];
  }): Promise<void> {
    const session = await this.requireWebChatSession(input.sessionId);
    await this.requireSessionRun(session, input.runId);
    await this.sessions.linkAttachmentsToRun(
      input.sessionId,
      input.runId,
      input.attachmentIds
    );
    this.attachmentTextIndexes.updateRunForAttachments(
      input.sessionId,
      input.runId,
      input.attachmentIds
    );
  }

  async recordMessageAttachments(input: {
    sessionId: string;
    runId: string;
    attachments: ChatAttachmentInput[];
  }): Promise<void> {
    const session = await this.requireWebChatSession(input.sessionId);
    await this.requireSessionRun(session, input.runId);
    await this.sessions.recordAttachments(
      input.sessionId,
      input.runId,
      input.attachments
    );
  }

  async persistExtractedArtifacts(input: {
    sessionId: string;
    runId: string;
    drafts: ExtractedArtifactDraft[];
  }): Promise<Array<Record<string, JsonValue>>> {
    const session = await this.requireWebChatSession(input.sessionId);
    await this.requireSessionRun(session, input.runId);
    const artifacts: ChatArtifactRecord[] = [];
    for (const draft of input.drafts) {
      artifacts.push(
        await this.createArtifactRecord({
          sessionId: input.sessionId,
          runId: input.runId,
          title: draft.title,
          kind: draft.kind,
          contentType: draft.contentType,
          content: draft.content,
          metadata: draft.metadata,
        })
      );
    }
    return artifacts.map(toArtifactSummary);
  }

  async listChatExportItems(
    limit = 250
  ): Promise<Array<Record<string, JsonValue>>> {
    return [
      ...(await this.sessions.listStoredAttachments(limit)).map(
        (attachment) => ({
          ...toAttachmentSummary(attachment),
          kind: "attachment",
        })
      ),
      ...(await this.artifacts.list(limit)).map((artifact) => ({
        ...toArtifactSummary(artifact),
        kind: "artifact",
      })),
      ...this.attachmentTextIndexes.list(limit).map((record) => ({
        ...toAttachmentTextIndexSummary(record),
        kind: "attachment_text_index",
      })),
    ];
  }

  private async createArtifactRecord(input: {
    sessionId: string;
    runId?: string;
    title: string;
    kind: ChatArtifactKind;
    contentType: string;
    content: Buffer;
    metadata: JsonValue;
  }): Promise<ChatArtifactRecord> {
    const id = createId("art");
    const blob = await this.blobs.write(id, input.content);
    return this.artifacts.create({
      id,
      sessionId: input.sessionId,
      runId: input.runId,
      title: input.title,
      kind: input.kind,
      contentType: input.contentType,
      sizeBytes: blob.sizeBytes,
      storagePath: blob.storagePath,
      sha256: blob.sha256,
      metadata: input.metadata,
    });
  }

  private async requireWebChatSession(
    sessionId: string
  ): Promise<SessionRecord> {
    const session = await this.sessions.get(sessionId);
    if (!session || session.channelId !== "web") {
      throw new HttpError(404, "Chat session not found");
    }
    return session;
  }

  private async requireSessionRun(
    session: SessionRecord,
    runId: string
  ): Promise<void> {
    if (!session.runIds.includes(runId)) {
      throw new HttpError(404, "Run not found for chat session");
    }
    const run = await this.runs.get(runId);
    if (!run) {
      throw new HttpError(404, "Run not found for chat session");
    }
  }
}

export function toAttachmentSummary(
  attachment: ChatAttachmentRecord
): Record<string, JsonValue> {
  return removeUndefined({
    id: attachment.id,
    sessionId: attachment.sessionId,
    runId: attachment.runId,
    name: attachment.name,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    description: attachment.description,
    sha256: attachment.sha256,
    downloadUrl: attachment.storagePath
      ? `/chat/attachments/${attachment.id}`
      : undefined,
    createdAt: attachment.createdAt,
  });
}

export function toAttachmentTextIndexSummary(
  record: AttachmentTextIndexRecord
): Record<string, JsonValue> {
  return removeUndefined({
    attachmentId: record.attachmentId,
    sessionId: record.sessionId,
    runId: record.runId,
    contentType: record.contentType,
    indexedBytes: record.indexedBytes,
    skippedReason: record.skippedReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function toAttachmentTextSearchSummary(
  result: AttachmentTextSearchResult
): Record<string, JsonValue> {
  return removeUndefined({
    ...toAttachmentTextIndexSummary(result),
    name: result.name,
    sizeBytes: result.sizeBytes,
    sha256: result.sha256,
    downloadUrl: result.downloadUrl,
    excerpt: result.excerpt,
  });
}

export function toArtifactSummary(
  artifact: ChatArtifactRecord
): Record<string, JsonValue> {
  return removeUndefined({
    id: artifact.id,
    sessionId: artifact.sessionId,
    runId: artifact.runId,
    title: artifact.title,
    kind: artifact.kind,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    metadata: artifact.metadata,
    downloadUrl: `/chat/artifacts/${artifact.id}`,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  });
}

function removeUndefined(
  record: Record<string, JsonValue | undefined>
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  ) as Record<string, JsonValue>;
}
