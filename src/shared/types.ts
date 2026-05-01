export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type SessionRecord = {
  sessionId: string;
  channelId: string;
  conversationId: string;
  title?: string;
  titleSource?: "auto" | "manual";
  providerSessionId?: string;
  previousResponseId?: string;
  lastEventCursor?: string;
  resumability: {
    supportsResume: boolean;
    cursor?: string;
  };
  createdAt: string;
  updatedAt: string;
  runIds: string[];
};

export type MemoryCategory = "episodic" | "semantic" | "procedural";
export type MemorySourceType = "raw_turn" | "semantic_fact" | "procedural_note" | "summary";

export type MemoryEntry = {
  id: string;
  category: MemoryCategory;
  content: string;
  createdAt: string;
  score: number;
  sourceType: MemorySourceType;
  importance: number;
  lastAccessedAt?: string;
  accessCount: number;
  isSummary: boolean;
  isFact: boolean;
  parentSummaryId?: string;
  embeddingModel?: string;
  vectorBackend?: "qdrant" | "sqlite_fallback";
  vectorPointId?: string;
  vectorSyncedAt?: string;
  vectorSyncError?: string;
  sourceSessionId?: string;
  sourceRunId?: string;
};

export type MemoryContextEnvelope = {
  episodic: MemoryEntry[];
  semantic: MemoryEntry[];
  procedural: MemoryEntry[];
  summaries: MemoryEntry[];
};

export type ToolCapabilityDescriptor = {
  id: string;
  name?: string;
  description: string;
  scopes: string[];
  kind: "in_process" | "mcp";
  inputSchema?: JsonValue;
};

export type PermissionPolicy = {
  mode: "read_only" | "scoped_write" | "full_access";
  fileGlobs: string[];
  allowedToolIds: string[];
  allowedMcpServers: string[];
};

export type SubagentRole = "coordinator" | "explorer" | "builder" | "verifier" | "researcher";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type StoredRunEvent = {
  sequence: number;
  createdAt: string;
  type: string;
  payload: JsonValue;
};
