import type { AppConfig } from "../config.ts";
import { decodeJson } from "../platform/database.ts";
import type { MemoryCategory } from "../shared/types.ts";
import type { VectorPoint, VectorSearchResult, VectorStore } from "./types.ts";

type SqliteCandidateRow = {
  id: string;
  embedding_json: string | null;
  category: MemoryCategory;
  is_summary: number;
  importance: number;
  created_at: string;
};

type SqliteStoreReader = {
  all<T>(sql: string, ...values: Array<string | number | bigint | Uint8Array | null>): T[];
};

export class SQLiteVectorStore implements VectorStore {
  readonly backend = "sqlite_fallback" as const;
  private readonly reader: SqliteStoreReader;

  constructor(reader: SqliteStoreReader) {
    this.reader = reader;
  }

  isConfigured(): boolean {
    return true;
  }

  isAvailable(): boolean {
    return true;
  }

  async initialize(): Promise<void> {
    return;
  }

  async upsert(): Promise<void> {
    return;
  }

  async search(vector: number[], limit: number, filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
    const category = typeof filter?.category === "string" ? filter.category : null;
    const rows = this.reader.all<SqliteCandidateRow>(
      `
        SELECT id, embedding_json, category, is_summary, importance, created_at
        FROM memory_entries
        ${category ? "WHERE category = ?" : ""}
        ORDER BY created_at DESC
        LIMIT 240
      `,
      ...(category ? [category] : [])
    );

    return rows
      .map((row) => ({
        id: row.id,
        score: cosineSimilarity(vector, decodeJson(row.embedding_json, [])) + row.importance / 10
      }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  async delete(): Promise<void> {
    return;
  }

  async hasPoint(id: string): Promise<boolean> {
    return this.reader.all<{ id: string }>("SELECT id FROM memory_entries WHERE id = ? AND embedding_json IS NOT NULL", id).length > 0;
  }
}

export class QdrantVectorStore implements VectorStore {
  readonly backend = "qdrant" as const;
  private available = false;
  private readonly enabled: boolean;
  private readonly url?: string;
  private readonly apiKey?: string;
  private readonly collectionName: string;
  private readonly timeoutMs: number;

  constructor(config: AppConfig) {
    this.enabled = config.qdrantEnabled;
    this.url = config.qdrantUrl?.replace(/\/$/, "");
    this.apiKey = config.qdrantApiKey;
    this.collectionName = config.qdrantCollectionName;
    this.timeoutMs = config.qdrantTimeoutMs;
  }

  isConfigured(): boolean {
    return this.enabled && Boolean(this.url);
  }

  isAvailable(): boolean {
    return this.available;
  }

  async initialize(dimension: number): Promise<void> {
    if (!this.isConfigured()) {
      this.available = false;
      return;
    }

    try {
      const existing = await this.request("GET", `/collections/${this.collectionName}`, undefined, true);
      if (!existing.ok) {
        await this.request("PUT", `/collections/${this.collectionName}`, {
          vectors: {
            size: dimension,
            distance: "Cosine"
          }
        });
      }
      this.available = true;
    } catch {
      this.available = false;
    }
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    if (!this.available || points.length === 0) {
      return;
    }
    await this.request("PUT", `/collections/${this.collectionName}/points`, {
      points: points.map((point) => ({
        id: point.id,
        vector: point.vector,
        payload: point.payload
      }))
    });
  }

  async search(vector: number[], limit: number, filter?: Record<string, unknown>): Promise<VectorSearchResult[]> {
    if (!this.available) {
      return [];
    }
    const result = await this.request("POST", `/collections/${this.collectionName}/points/search`, {
      vector,
      limit,
      filter: buildQdrantFilter(filter)
    });
    const json = await result.json() as { result?: Array<{ id: string; score: number }> };
    return (json.result ?? []).map((item) => ({ id: String(item.id), score: item.score }));
  }

  async delete(ids: string[]): Promise<void> {
    if (!this.available || ids.length === 0) {
      return;
    }
    await this.request("POST", `/collections/${this.collectionName}/points/delete`, {
      points: ids
    });
  }

  async hasPoint(id: string): Promise<boolean> {
    if (!this.available) {
      return false;
    }
    const result = await this.request("GET", `/collections/${this.collectionName}/points/${id}`, undefined, true);
    return result.ok;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    allowNotFound = false
  ): Promise<Response> {
    if (!this.url) {
      throw new Error("Qdrant URL is not configured");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.url}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { "api-key": this.apiKey } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok && !(allowNotFound && response.status === 404)) {
        throw new Error(`Qdrant request failed with status ${response.status}`);
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildQdrantFilter(filter?: Record<string, unknown>): unknown {
  if (!filter || Object.keys(filter).length === 0) {
    return undefined;
  }
  return {
    must: Object.entries(filter).map(([key, value]) => ({
      key,
      match: { value }
    }))
  };
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
