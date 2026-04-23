import type { ChatMessage, PermissionPolicy } from "../shared/types.ts";

export type SubagentRole = "explorer" | "builder" | "verifier" | "researcher";

export type SubagentRequest = {
  role: SubagentRole;
  objective: string;
  allowedToolIds?: string[];
  allowedMcpServers?: string[];
  fileGlobs?: string[];
  timeoutMs?: number;
  maxBudgetUsd?: number;
  maxDurationMs?: number;
};

export type RunTerminalState = {
  outputText?: string;
  previousResponseId?: string;
  providerSessionId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

export type RunNode = {
  runId: string;
  parentRunId?: string;
  role: "coordinator" | SubagentRole;
  objective: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  permissionPolicy: PermissionPolicy;
  allowedMcpServers: string[];
  allowedToolIds: string[];
  childRunIds: string[];
  maxBudgetUsd?: number;
  timeoutMs?: number;
  summary?: string;
  transcript: ChatMessage[];
  startedAt: string;
  finishedAt?: string;
  terminalState?: RunTerminalState;
};
