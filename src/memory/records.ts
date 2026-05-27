import { decodeJson } from "../platform/database.ts";
import type {
  MemoryCategory,
  MemoryEntry,
  MemoryLifecycleLink,
} from "../shared/types.ts";
import type { VectorPoint } from "./types.ts";

export type MemoryRow = {
  id: string;
  category: MemoryCategory;
  content: string;
  created_at: string;
  source_type: MemoryEntry["sourceType"];
  importance: number;
  reinforcement_score?: number | null;
  decay_score?: number | null;
  last_accessed_at: string | null;
  access_count: number;
  is_summary: number;
  is_fact: number;
  parent_summary_id: string | null;
  embedding_model: string | null;
  embedding_json: string | null;
  source_session_id: string | null;
  source_run_id: string | null;
  lifecycle_state?: "active" | "superseded" | "contradicted" | null;
  superseded_by_memory_id?: string | null;
  contradicted_by_memory_id?: string | null;
  vector_backend: "qdrant" | "sqlite_fallback" | null;
  vector_synced_at: string | null;
  vector_sync_error: string | null;
  vector_point_id: string | null;
};

export type MemoryLifecycleLinkRow = {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  relationship: MemoryLifecycleLink["relationship"];
  reason: string | null;
  source_session_id: string | null;
  source_run_id: string | null;
  created_at: string;
};

export const MEMORY_ROW_COLUMNS = `
  id, category, content, created_at, source_type, importance, last_accessed_at,
  reinforcement_score, decay_score, access_count, is_summary, is_fact,
  parent_summary_id, embedding_model, embedding_json,
  source_session_id, source_run_id, lifecycle_state, superseded_by_memory_id,
  contradicted_by_memory_id, vector_backend, vector_synced_at, vector_sync_error,
  vector_point_id
`;

export function toMemoryEntry(entry: {
  row: MemoryRow;
  score: number;
}): MemoryEntry {
  return {
    id: entry.row.id,
    category: entry.row.category,
    content: entry.row.content,
    createdAt: entry.row.created_at,
    score: entry.score,
    sourceType: entry.row.source_type,
    importance: entry.row.importance,
    reinforcementScore: entry.row.reinforcement_score ?? 0,
    decayScore: entry.row.decay_score ?? 0,
    rankingScore: entry.score,
    lastAccessedAt: entry.row.last_accessed_at ?? undefined,
    accessCount: entry.row.access_count,
    isSummary: entry.row.is_summary === 1,
    isFact: entry.row.is_fact === 1,
    parentSummaryId: entry.row.parent_summary_id ?? undefined,
    lifecycleState: entry.row.lifecycle_state ?? "active",
    supersededByMemoryId: entry.row.superseded_by_memory_id ?? undefined,
    contradictedByMemoryId: entry.row.contradicted_by_memory_id ?? undefined,
    embeddingModel: entry.row.embedding_model ?? undefined,
    vectorBackend: entry.row.vector_backend ?? undefined,
    vectorPointId: entry.row.vector_point_id ?? undefined,
    vectorSyncedAt: entry.row.vector_synced_at ?? undefined,
    vectorSyncError: entry.row.vector_sync_error ?? undefined,
    sourceSessionId: entry.row.source_session_id ?? undefined,
    sourceRunId: entry.row.source_run_id ?? undefined,
  };
}

export function buildVectorPayload(row: {
  category: MemoryCategory;
  source_type: MemoryEntry["sourceType"];
  is_summary: number;
  is_fact: number;
  importance: number;
  created_at: string;
  source_session_id: string | null;
  source_run_id: string | null;
}): VectorPoint["payload"] {
  return {
    category: row.category,
    sourceType: row.source_type,
    isSummary: row.is_summary === 1,
    isFact: row.is_fact === 1,
    importance: row.importance,
    createdAt: row.created_at,
    sourceSessionId: row.source_session_id,
    sourceRunId: row.source_run_id,
  };
}

export function isActive(row: MemoryRow): boolean {
  return !row.lifecycle_state || row.lifecycle_state === "active";
}

export function vectorPointForRow(row: MemoryRow): VectorPoint | undefined {
  if (!row.embedding_json) {
    return undefined;
  }
  return {
    id: row.id,
    vector: decodeJson(row.embedding_json, []),
    payload: buildVectorPayload(row),
  };
}

export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

export function trimLine(value: string): string {
  return value.length > 320 ? `${value.slice(0, 317)}...` : value;
}

export function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(value.trim());
  }
  return output;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
