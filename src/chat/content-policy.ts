import type { ChatArtifactKind } from "./artifact-store.ts";
import type { JsonValue } from "../shared/types.ts";

export const MAX_CHAT_ATTACHMENT_BYTES = 25_000_000;
export const MAX_CHAT_UPLOAD_FILES = 10;
export const MAX_ATTACHMENT_TEXT_INDEX_BYTES = 200_000;
export const MAX_EXTRACTED_ARTIFACTS_PER_RUN = 5;
export const MAX_EXTRACTED_ARTIFACT_BYTES = 1_000_000;

export function extractSearchableAttachmentText(
  contentType: string,
  content: Buffer
): { text?: string; bytes: number; skippedReason?: string } {
  if (!isSafeTextContentType(contentType)) {
    return { bytes: 0, skippedReason: "unsafe_content_type" };
  }
  const bounded = content.subarray(0, MAX_ATTACHMENT_TEXT_INDEX_BYTES);
  const text = bounded.toString("utf8").replace(/\u0000/g, "");
  if (!text.trim()) {
    return { bytes: 0, skippedReason: "empty_text" };
  }
  return { text, bytes: bounded.byteLength };
}

export function artifactContentBuffer(
  kind: ChatArtifactKind,
  content: JsonValue
): Buffer {
  if (kind === "json") {
    return Buffer.from(JSON.stringify(content, null, 2), "utf8");
  }
  if (typeof content !== "string") {
    throw new Error("content must be a string");
  }
  return Buffer.from(content, "utf8");
}

export function extractedArtifactContentBuffer(
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

export function normalizeExtractedArtifactContentType(
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
  return isSafeTextContentType(resolved) ? resolved : undefined;
}

export function artifactFileName(input: {
  title: string;
  contentType: string;
}): string {
  return `${input.title}${extensionForContentType(input.contentType)}`;
}

export function safeDownloadName(name: string): string {
  return name.replace(/[\\/\r\n"]/g, "_").trim() || "download";
}

export function isSafeTextContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized.endsWith("+json") ||
    normalized === "application/markdown" ||
    normalized === "application/x-ndjson" ||
    normalized === "application/yaml" ||
    normalized === "application/x-yaml"
  );
}

function extensionForContentType(contentType: string): string {
  switch (contentType.toLowerCase()) {
    case "text/markdown":
      return ".md";
    case "application/json":
      return ".json";
    case "text/plain":
      return ".txt";
    default:
      return "";
  }
}
