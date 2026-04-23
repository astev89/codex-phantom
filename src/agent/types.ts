import type { ChatMessage, MemoryContextEnvelope, PermissionPolicy, ToolCapabilityDescriptor } from "../shared/types.ts";

export type AgentCapabilityFlags = {
  supportsResume: boolean;
  supportsStreaming: boolean;
  supportsToolStreaming: boolean;
  supportsStructuredOutput: boolean;
  supportsParallelToolCalls: boolean;
  supportsReasoningEffort: boolean;
};

export type AgentAdapterMode = "auto" | "openai" | "fallback";

export type AgentRunRequest = {
  runId: string;
  sessionId: string;
  role: "coordinator" | "explorer" | "builder" | "verifier" | "researcher";
  systemPrompt: string;
  messages: ChatMessage[];
  memory: MemoryContextEnvelope;
  toolCapabilities: ToolCapabilityDescriptor[];
  permissionPolicy: PermissionPolicy;
  providerSessionId?: string;
  previousResponseId?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxToolCalls?: number;
};

export type AgentToolCall = {
  toolCallId: string;
  toolName: string;
  argumentsText: string;
};

export type AgentRunEvent =
  | { type: "init"; runId: string; sessionId: string; providerSessionId?: string; model?: string }
  | { type: "text_delta"; runId: string; sessionId?: string; messageId?: string; delta: string }
  | { type: "message_complete"; runId: string; sessionId?: string; messageId?: string; content: string }
  | { type: "structured_message"; runId: string; message: ChatMessage }
  | { type: "tool_call_requested"; runId: string; sessionId?: string; toolCallId: string; toolName?: string; argumentsText?: string }
  | { type: "tool_call_started"; runId: string; sessionId?: string; toolCallId: string; toolName?: string }
  | { type: "tool_call_delta"; runId: string; sessionId?: string; toolCallId: string; delta: string }
  | { type: "tool_call_succeeded"; runId: string; sessionId?: string; toolCallId: string; toolName?: string; output: string }
  | { type: "tool_call_failed"; runId: string; sessionId?: string; toolCallId: string; toolName?: string; message: string }
  | { type: "tool_output_attached"; runId: string; sessionId?: string; toolCallId: string; toolName?: string; content: string }
  | { type: "subagent_spawned"; runId: string; subagentRunId: string; role: string; objective: string }
  | { type: "subagent_progress"; runId: string; subagentRunId: string; status: string; summary: string }
  | { type: "warning"; runId: string; sessionId?: string; message: string }
  | { type: "error"; runId: string; sessionId?: string; message: string; retryable?: boolean }
  | { type: "final_result"; runId: string; sessionId?: string; result: AgentRunResult }
  | { type: "final"; runId: string; outputText: string; previousResponseId?: string; providerSessionId?: string };

export type AgentRunResult = {
  runId: string;
  outputText: string;
  providerSessionId?: string;
  previousResponseId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  usedFallback?: boolean;
  transcript: ChatMessage[];
  toolCalls: AgentToolCall[];
};

export type AgentAdapter = {
  readonly name: string;
  readonly capabilities: AgentCapabilityFlags;
  run(
    request: AgentRunRequest,
    onEvent: (event: AgentRunEvent) => Promise<void> | void
  ): Promise<AgentRunResult>;
};
