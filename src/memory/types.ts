import type { MemoryCategory, MemorySourceType } from "../shared/types.ts";

export type MemoryInsightSet = {
  semanticFacts: string[];
  proceduralNotes: string[];
  summary?: string;
};

export type MemoryTurnRecord = {
  sessionId: string;
  runId: string;
  queryText: string;
  recentMessagesText: string;
  userInput: string;
  assistantOutput: string;
};

export type StoreMemoryEntryInput = {
  category: MemoryCategory;
  content: string;
  sourceType: MemorySourceType;
  importance: number;
  isSummary?: boolean;
  isFact?: boolean;
  parentSummaryId?: string;
  supersedesMemoryIds?: string[];
  contradictsMemoryIds?: string[];
  lifecycleReason?: string;
  sourceSessionId?: string;
  sourceRunId?: string;
  sourceUserInput?: string;
  sourceAssistantOutput?: string;
};

export type MemoryStatus = {
  semanticRetrievalEnabled: boolean;
  embeddingModel: string;
  pendingBackfillCount: number;
  pendingVectorSyncCount: number;
  vectorBackend: "qdrant" | "sqlite_fallback";
  qdrantConfigured: boolean;
  qdrantReachable: boolean;
};

export type MemoryMaintenanceOutcome = {
  summarizedCount: number;
  promotedCount: number;
  prunedCount: number;
  summaryMemoryIds: string[];
  promotedMemoryIds: string[];
  prunedMemoryIds: string[];
};

export type VectorSearchResult = {
  id: string;
  score: number;
};

export type VectorPoint = {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
};

export type VectorStore = {
  readonly backend: "qdrant" | "sqlite_fallback";
  isConfigured(): boolean;
  isAvailable(): boolean;
  initialize(dimension: number): Promise<void>;
  upsert(points: VectorPoint[]): Promise<void>;
  search(
    vector: number[],
    limit: number,
    filter?: Record<string, unknown>
  ): Promise<VectorSearchResult[]>;
  delete(ids: string[]): Promise<void>;
  hasPoint(id: string): Promise<boolean>;
};
