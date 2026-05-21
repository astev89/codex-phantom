import type { AgentRunEvent } from "../agent/types.ts";
import type { ChatArtifactKind } from "./artifact-store.ts";
import type { JsonValue } from "../shared/types.ts";

export const MAX_EXTRACTED_ARTIFACTS_PER_RUN = 5;
export const MAX_EXTRACTED_ARTIFACT_BYTES = 1_000_000;

export type ExtractedArtifactDraft = {
  title: string;
  kind: ChatArtifactKind;
  contentType: string;
  content: Buffer;
  metadata: JsonValue;
};

type ArtifactSourceMetadata = {
  sourceType: "tool_event" | "final_output";
  eventType?: string;
  toolName?: string;
  toolCallId?: string;
};

export function extractArtifactDraftsFromEvent(
  event: AgentRunEvent,
  remaining = MAX_EXTRACTED_ARTIFACTS_PER_RUN
): ExtractedArtifactDraft[] {
  if (remaining <= 0 || event.type !== "tool_call_succeeded") {
    return [];
  }
  const parsed = parseJsonValue(event.output);
  if (!parsed) {
    return [];
  }
  return extractArtifactDrafts(parsed, {
    remaining,
    source: {
      sourceType: "tool_event",
      eventType: event.type,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
    },
  });
}

export function extractArtifactDraftsFromOutputText(
  outputText: string,
  remaining = MAX_EXTRACTED_ARTIFACTS_PER_RUN
): ExtractedArtifactDraft[] {
  if (remaining <= 0) {
    return [];
  }
  const parsed = parseJsonValue(outputText);
  if (!parsed) {
    return [];
  }
  return extractArtifactDrafts(parsed, {
    remaining,
    source: { sourceType: "final_output" },
  });
}

function extractArtifactDrafts(
  value: JsonValue,
  options: {
    remaining: number;
    source: ArtifactSourceMetadata;
  }
): ExtractedArtifactDraft[] {
  const candidates = artifactCandidates(value).slice(0, options.remaining);
  const drafts: ExtractedArtifactDraft[] = [];
  for (const candidate of candidates) {
    const draft = toArtifactDraft(candidate, options.source);
    if (draft) {
      drafts.push(draft);
    }
  }
  return drafts;
}

function artifactCandidates(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) {
    return value.flatMap(artifactCandidates);
  }
  if (!isRecord(value)) {
    return [];
  }
  if (Array.isArray(value.artifacts)) {
    return value.artifacts;
  }
  if (value.artifact) {
    return [value.artifact];
  }
  if (typeof value.title === "string" && value.content !== undefined) {
    return [value];
  }
  return [];
}

function toArtifactDraft(
  value: JsonValue,
  source: ArtifactSourceMetadata
): ExtractedArtifactDraft | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const title = normalizeTitle(value.title);
  const kind = normalizeKind(value.kind);
  if (!title || !kind || value.content === undefined) {
    return undefined;
  }
  const contentType = normalizeContentType(value.contentType, kind);
  if (!contentType) {
    return undefined;
  }
  const content = artifactContent(kind, value.content);
  if (!content || content.byteLength > MAX_EXTRACTED_ARTIFACT_BYTES) {
    return undefined;
  }
  return {
    title,
    kind,
    contentType,
    content,
    metadata: {
      autoExtracted: true,
      source,
      extraction: {
        maxBytes: MAX_EXTRACTED_ARTIFACT_BYTES,
      },
      originalMetadata: isJsonValue(value.metadata) ? value.metadata : null,
    },
  };
}

function artifactContent(
  kind: ChatArtifactKind,
  content: JsonValue
): Buffer | undefined {
  if (kind === "json") {
    return Buffer.from(JSON.stringify(content, null, 2), "utf8");
  }
  if (typeof content !== "string") {
    return undefined;
  }
  return Buffer.from(content, "utf8");
}

function normalizeTitle(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const title = value.trim().replace(/\s+/g, " ").slice(0, 120);
  return title || undefined;
}

function normalizeKind(
  value: JsonValue | undefined
): ChatArtifactKind | undefined {
  if (value === "text" || value === "json" || value === "file") {
    return value;
  }
  return undefined;
}

function normalizeContentType(
  value: JsonValue | undefined,
  kind: ChatArtifactKind
): string | undefined {
  const contentType =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (kind === "json") {
    return contentType === "application/json" || contentType.endsWith("+json")
      ? contentType
      : "application/json";
  }
  const resolved = contentType || "text/plain";
  return isSafeExtractedContentType(resolved) ? resolved : undefined;
}

function isSafeExtractedContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType.endsWith("+json") ||
    contentType === "application/markdown" ||
    contentType === "application/x-ndjson" ||
    contentType === "application/yaml" ||
    contentType === "application/x-yaml"
  );
}

function parseJsonValue(value: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}
