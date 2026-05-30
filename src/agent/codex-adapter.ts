import type { AppConfig } from "../config.ts";
import { fetchWithTimeout } from "../platform/outbound.ts";
import type { ChatMessage } from "../shared/types.ts";
import type {
  AgentAdapter,
  AgentAdapterMode,
  AgentRunEvent,
  AgentRunRequest,
  AgentRunResult,
  AgentToolCall,
} from "./types.ts";

type ResponsesStreamEvent = {
  type: string;
  delta?: string;
  item_id?: string;
  response?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  };
  output_index?: number;
  arguments_delta?: string;
  arguments?: string;
  name?: string;
  error?: { message?: string };
};

type OpenAiTransport = (
  request: AgentRunRequest,
  body: Record<string, unknown>
) =>
  | AsyncIterable<ResponsesStreamEvent>
  | Promise<AsyncIterable<ResponsesStreamEvent>>;

type NormalizerState = {
  outputText: string;
  messageId?: string;
  providerResponseId?: string;
  toolCalls: Map<string, { name: string; argumentsText: string }>;
  toolNameAliases?: Map<string, string>;
  usage?: AgentRunResult["usage"];
};

type CodexAdapterOptions = {
  mode?: AgentAdapterMode;
  transport?: OpenAiTransport;
};

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex";
  readonly capabilities = {
    supportsResume: true,
    supportsStreaming: true,
    supportsToolStreaming: true,
    supportsStructuredOutput: true,
    supportsParallelToolCalls: true,
    supportsReasoningEffort: true,
  };

  readonly config: AppConfig;
  private readonly options: CodexAdapterOptions;

  constructor(config: AppConfig, options: CodexAdapterOptions = {}) {
    this.config = config;
    this.options = options;
  }

  async run(
    request: AgentRunRequest,
    onEvent: (event: AgentRunEvent) => Promise<void> | void
  ): Promise<AgentRunResult> {
    const mode = resolveMode(this.options.mode ?? "auto", this.config);
    if (mode === "fallback") {
      return this.runFallback(request, onEvent);
    }
    return this.runWithOpenAi(request, onEvent);
  }

  private async runFallback(
    request: AgentRunRequest,
    onEvent: (event: AgentRunEvent) => Promise<void> | void
  ): Promise<AgentRunResult> {
    const userText = request.messages.at(-1)?.content ?? "";
    const outputText = [
      "Fallback mode engaged.",
      `Role: ${request.role}`,
      `Input: ${userText || "none"}`,
      `Tools available: ${request.toolCapabilities.length}`,
    ].join("\n");

    await onEvent({
      type: "init",
      runId: request.runId,
      sessionId: request.sessionId,
      model: `${request.model ?? this.config.model}-fallback`,
    });

    for (const chunk of outputText.match(/.{1,32}/g) ?? []) {
      await onEvent({
        type: "text_delta",
        runId: request.runId,
        sessionId: request.sessionId,
        messageId: "fallback-message",
        delta: chunk,
      });
    }

    await onEvent({
      type: "message_complete",
      runId: request.runId,
      sessionId: request.sessionId,
      messageId: "fallback-message",
      content: outputText,
    });
    await onEvent({
      type: "structured_message",
      runId: request.runId,
      message: { role: "assistant", content: outputText },
    });

    const result = buildResult(request, outputText, {
      providerSessionId: `fallback-${request.runId}`,
      previousResponseId: `fallback-${request.runId}`,
      usage: {
        inputTokens: estimateTokens(request.systemPrompt + userText),
        outputTokens: estimateTokens(outputText),
        totalTokens: estimateTokens(
          request.systemPrompt + userText + outputText
        ),
      },
      usedFallback: true,
      toolCalls: [],
    });

    await onEvent({
      type: "final_result",
      runId: request.runId,
      sessionId: request.sessionId,
      result,
    });
    await onEvent({
      type: "final",
      runId: request.runId,
      outputText: result.outputText,
      previousResponseId: result.previousResponseId,
      providerSessionId: result.providerSessionId,
    });

    return result;
  }

  private async runWithOpenAi(
    request: AgentRunRequest,
    onEvent: (event: AgentRunEvent) => Promise<void> | void
  ): Promise<AgentRunResult> {
    const transport =
      this.options.transport ?? defaultOpenAiTransport(this.config);
    const toolNameAliases = new Map<string, string>();
    const usedToolNames = new Set<string>();
    const body: Record<string, unknown> = {
      model: request.model ?? this.config.model,
      input: [
        { role: "system", content: request.systemPrompt },
        ...request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
      stream: true,
      tools: request.toolCapabilities.map((tool) => {
        const runtimeName = tool.name ?? tool.id;
        const openAiName = toOpenAiFunctionName(runtimeName, usedToolNames);
        toolNameAliases.set(openAiName, runtimeName);
        return {
          type: "function",
          name: openAiName,
          description: tool.description,
          parameters:
            tool.inputSchema && typeof tool.inputSchema === "object"
              ? tool.inputSchema
              : { type: "object", additionalProperties: true },
        };
      }),
    };

    if (request.reasoningEffort) {
      body.reasoning = { effort: request.reasoningEffort };
    }

    if (
      this.config.openAiConversationMode === "previous_response_id" &&
      request.previousResponseId
    ) {
      body.previous_response_id = request.previousResponseId;
    }

    const stream = await transport(request, body);
    const state: NormalizerState = {
      outputText: "",
      toolCalls: new Map(),
      toolNameAliases,
    };

    for await (const event of stream) {
      const normalized = normalizeOpenAiEvent(request, event, state);
      for (const item of normalized) {
        await onEvent(item);
      }
    }

    const toolCalls = [...state.toolCalls.entries()].map(
      ([toolCallId, value]) => ({
        toolCallId,
        toolName: value.name,
        argumentsText: value.argumentsText,
      })
    );

    const result = buildResult(request, state.outputText, {
      providerSessionId: state.providerResponseId,
      previousResponseId:
        this.config.openAiConversationMode === "previous_response_id"
          ? state.providerResponseId
          : request.previousResponseId,
      usage: state.usage,
      usedFallback: false,
      toolCalls,
    });

    await onEvent({
      type: "final_result",
      runId: request.runId,
      sessionId: request.sessionId,
      result,
    });
    await onEvent({
      type: "final",
      runId: request.runId,
      outputText: result.outputText,
      previousResponseId: result.previousResponseId,
      providerSessionId: result.providerSessionId,
    });

    return result;
  }
}

export function normalizeOpenAiEvent(
  request: Pick<AgentRunRequest, "runId" | "sessionId">,
  event: ResponsesStreamEvent,
  state: NormalizerState = {
    outputText: "",
    toolCalls: new Map(),
  }
): AgentRunEvent[] {
  switch (event.type) {
    case "response.created": {
      state.providerResponseId = event.response?.id;
      return [
        {
          type: "init",
          runId: request.runId,
          sessionId: request.sessionId,
          providerSessionId: event.response?.id,
          model: event.response?.model,
        },
      ];
    }

    case "response.output_text.delta": {
      const delta = event.delta ?? "";
      state.outputText += delta;
      if (event.item_id) {
        state.messageId = event.item_id;
      }
      return [
        {
          type: "text_delta",
          runId: request.runId,
          sessionId: request.sessionId,
          messageId: event.item_id,
          delta,
        },
      ];
    }

    case "response.output_text.done": {
      return [
        {
          type: "message_complete",
          runId: request.runId,
          sessionId: request.sessionId,
          messageId: state.messageId,
          content: state.outputText,
        },
        {
          type: "structured_message",
          runId: request.runId,
          message: { role: "assistant", content: state.outputText },
        },
      ];
    }

    case "response.function_call_arguments.delta": {
      const toolCallId = event.item_id ?? event.name ?? "tool";
      const toolName = resolveRuntimeToolName(event.name ?? toolCallId, state);
      const current = state.toolCalls.get(toolCallId);
      if (!current) {
        state.toolCalls.set(toolCallId, { name: toolName, argumentsText: "" });
      }
      const next = state.toolCalls.get(toolCallId);
      const delta = event.arguments_delta ?? event.delta ?? "";
      if (next) {
        next.argumentsText += delta;
      }
      return [
        {
          type: "tool_call_delta",
          runId: request.runId,
          sessionId: request.sessionId,
          toolCallId,
          delta,
        },
      ];
    }

    case "response.function_call_arguments.done": {
      const toolCallId = event.item_id ?? event.name ?? "tool";
      const toolName = resolveRuntimeToolName(event.name ?? toolCallId, state);
      const current = state.toolCalls.get(toolCallId);
      const argumentsText = event.arguments ?? current?.argumentsText ?? "";
      state.toolCalls.set(toolCallId, { name: toolName, argumentsText });
      return [
        {
          type: "tool_call_requested",
          runId: request.runId,
          sessionId: request.sessionId,
          toolCallId,
          toolName,
          argumentsText,
        },
      ];
    }

    case "response.completed": {
      state.providerResponseId = event.response?.id ?? state.providerResponseId;
      if (event.response?.usage) {
        state.usage = {
          inputTokens: event.response.usage.input_tokens,
          outputTokens: event.response.usage.output_tokens,
          totalTokens: event.response.usage.total_tokens,
        };
      }
      return [];
    }

    case "error": {
      return [
        {
          type: "error",
          runId: request.runId,
          sessionId: request.sessionId,
          message: event.error?.message ?? "Unknown OpenAI stream error",
          retryable: true,
        },
      ];
    }

    default:
      return [];
  }
}

function resolveRuntimeToolName(
  openAiName: string,
  state: Pick<NormalizerState, "toolNameAliases">
): string {
  return state.toolNameAliases?.get(openAiName) ?? openAiName;
}

function toOpenAiFunctionName(runtimeName: string, used: Set<string>): string {
  const normalized = runtimeName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const base = /^[a-zA-Z0-9_-]+$/.test(normalized) ? normalized : "tool";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function resolveMode(
  mode: AgentAdapterMode,
  config: AppConfig
): Exclude<AgentAdapterMode, "auto"> {
  if (mode === "openai" || mode === "fallback") {
    return mode;
  }
  return config.openAiApiKey ? "openai" : "fallback";
}

function defaultOpenAiTransport(config: AppConfig): OpenAiTransport {
  return async (request, body) => {
    const response = await fetchWithTimeout(
      `${config.openAiBaseUrl ?? "https://api.openai.com/v1"}/responses`,
      {
        method: "POST",
        timeoutMs: config.openAiRequestTimeoutMs ?? 60_000,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.openAiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      }
    );

    if (!response.ok || !response.body) {
      throw new Error(`OpenAI request failed with status ${response.status}`);
    }

    return decodeSse(response.body);
  };
}

async function* decodeSse(
  stream: ReadableStream<Uint8Array>
): AsyncIterable<ResponsesStreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.split("\n").find((item) => item.startsWith("data:"));
      if (!line) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }
      yield JSON.parse(payload) as ResponsesStreamEvent;
    }
  }
}

function buildResult(
  request: AgentRunRequest,
  outputText: string,
  extra: {
    providerSessionId?: string;
    previousResponseId?: string;
    usage?: AgentRunResult["usage"];
    usedFallback: boolean;
    toolCalls: AgentToolCall[];
  }
): AgentRunResult {
  return {
    runId: request.runId,
    outputText,
    providerSessionId: extra.providerSessionId,
    previousResponseId: extra.previousResponseId,
    usage: extra.usage,
    usedFallback: extra.usedFallback,
    transcript: [...request.messages, assistantMessage(outputText)],
    toolCalls: extra.toolCalls,
  };
}

function assistantMessage(content: string): ChatMessage {
  return { role: "assistant", content };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
