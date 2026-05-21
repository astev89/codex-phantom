import type { AppConfig } from "../src/config.ts";
import type { EmbeddingService } from "../src/memory/embedding.ts";
import type {
  VectorPoint,
  VectorSearchResult,
  VectorStore,
} from "../src/memory/types.ts";

export function makeConfig(
  dataDir = ".",
  overrides: Partial<AppConfig> = {}
): AppConfig {
  return {
    appEnv: "test",
    logLevel: "error",
    port: 1,
    dataDir,
    datastorePath: `${dataDir}/test.sqlite`,
    model: "gpt-5",
    agentName: "Test Codex Phantom",
    roleConfigPath: "config/roles.yaml",
    operatorConfigPath: "config/operator.yaml",
    operatorBearerToken: "operator-secret",
    mcpBearerToken: "mcp-secret",
    externalChannelSecret: "webhook-secret",
    openAiApiKey: undefined,
    openAiBaseUrl: undefined,
    openAiConversationMode: "previous_response_id",
    openAiRequestTimeoutMs: 60_000,
    openAiEmbeddingModel: "text-embedding-3-small",
    openAiEmbeddingTimeoutMs: 10_000,
    semanticRetrievalEnabled: true,
    qdrantEnabled: false,
    qdrantUrl: undefined,
    qdrantApiKey: undefined,
    qdrantCollectionName: "codex-phantom-memory-test",
    qdrantTimeoutMs: 5_000,
    memoryEmbeddingBatchSize: 8,
    memoryTopK: 12,
    memoryPerCategoryLimit: 3,
    memorySummaryLimit: 2,
    memorySummaryTriggerCount: 6,
    memorySummaryClusterSize: 4,
    defaultRunTimeoutMs: 5_000,
    defaultMaxToolCalls: 4,
    rejectDefaultSecrets: false,
    ...overrides,
  };
}

export function makeFakeEmbeddings(
  values: Record<string, number[]>
): EmbeddingService {
  return {
    enabled: true,
    model: "fake-embedding-model",
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => values[text] ?? hashEmbedding(text));
    },
  };
}

export function makeDisabledEmbeddings(): EmbeddingService {
  return {
    enabled: false,
    model: "disabled",
    async embed(): Promise<null> {
      return null;
    },
  };
}

export function makeFakeVectorStore(options?: {
  backend?: "qdrant" | "sqlite_fallback";
  configured?: boolean;
  available?: boolean;
  initialPoints?: Record<string, VectorPoint>;
}): VectorStore & { points: Map<string, VectorPoint> } {
  const points = new Map<string, VectorPoint>(
    Object.entries(options?.initialPoints ?? {})
  );
  let available = options?.available ?? true;
  let configured = options?.configured ?? true;

  return {
    backend: options?.backend ?? "qdrant",
    points,
    isConfigured(): boolean {
      return configured;
    },
    isAvailable(): boolean {
      return available;
    },
    async initialize(): Promise<void> {
      return;
    },
    async upsert(nextPoints: VectorPoint[]): Promise<void> {
      for (const point of nextPoints) {
        points.set(point.id, point);
      }
    },
    async search(
      vector: number[],
      limit: number
    ): Promise<VectorSearchResult[]> {
      return [...points.values()]
        .map((point) => ({
          id: point.id,
          score: cosineSimilarity(vector, point.vector),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    },
    async delete(ids: string[]): Promise<void> {
      for (const id of ids) {
        points.delete(id);
      }
    },
    async hasPoint(id: string): Promise<boolean> {
      return points.has(id);
    },
  };
}

function hashEmbedding(text: string): number[] {
  const lowered = text.toLowerCase();
  return [
    lowered.includes("deploy") ? 1 : 0,
    lowered.includes("email") ? 1 : 0,
    lowered.includes("schedule") ? 1 : 0,
    lowered.length / 100,
  ];
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
