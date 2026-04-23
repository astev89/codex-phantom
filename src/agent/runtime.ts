import type { AppConfig } from "../config.ts";
import { SessionStore } from "../chat/session-store.ts";
import { MemoryStore } from "../memory/store.ts";
import type { MemoryInsightSet, MemoryTurnRecord } from "../memory/types.ts";
import { assemblePrompt } from "../prompts/assembler.ts";
import { toJsonValue } from "../platform/database.ts";
import { createId } from "../shared/ids.ts";
import type { ChatMessage, PermissionPolicy, SessionRecord, ToolCapabilityDescriptor } from "../shared/types.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { AgentAdapter, AgentRunEvent, AgentRunRequest, AgentRunResult } from "./types.ts";

export class AgentRuntime {
  private readonly config: AppConfig;
  private readonly adapter: AgentAdapter;
  private readonly sessions: SessionStore;
  private readonly memory: MemoryStore;
  private readonly tools: ToolRegistry;

  constructor(
    config: AppConfig,
    adapter: AgentAdapter,
    sessions: SessionStore,
    memory: MemoryStore,
    tools: ToolRegistry
  ) {
    this.config = config;
    this.adapter = adapter;
    this.sessions = sessions;
    this.memory = memory;
    this.tools = tools;
  }

  async run(
    input: {
      sessionId?: string;
      channelId: string;
      conversationId: string;
      messages: ChatMessage[];
      permissionPolicy: PermissionPolicy;
      toolCapabilities: ToolCapabilityDescriptor[];
      role: AgentRunRequest["role"];
      timeoutMs?: number;
    },
    onEvent: (event: AgentRunEvent) => Promise<void> | void
  ): Promise<{ session: SessionRecord; result: AgentRunResult }> {
    const now = new Date().toISOString();
    const sessionId = input.sessionId ?? createId("session");
    const existing = await this.sessions.get(sessionId);
    const session: SessionRecord = existing ?? {
      sessionId,
      channelId: input.channelId,
      conversationId: input.conversationId,
      resumability: { supportsResume: this.adapter.capabilities.supportsResume },
      createdAt: now,
      updatedAt: now,
      runIds: []
    };

    if (!this.adapter.capabilities.supportsResume && session.previousResponseId) {
      throw new Error("Adapter does not support resume, but session attempted a resumed run");
    }

    const runId = createId("run");
    const memoryQueryText = buildMemoryQueryText(input.messages);
    const memory = await this.memory.query(memoryQueryText);
    const abortController = new AbortController();
    const timeoutMs = input.timeoutMs ?? this.config.defaultRunTimeoutMs;
    const timeout = setTimeout(() => abortController.abort(new Error("Run timed out")), timeoutMs);

    let requestMessages = [...input.messages];
    let previousResponseId = session.previousResponseId;
    let providerSessionId = session.providerSessionId;
    let finalResult: AgentRunResult | null = null;
    let toolCallsExecuted = 0;

    try {
      while (true) {
        const request: AgentRunRequest = {
          runId,
          sessionId,
          role: input.role,
          systemPrompt: assemblePrompt(this.config, memory),
          messages: requestMessages,
          memory,
          toolCapabilities: input.toolCapabilities,
          permissionPolicy: input.permissionPolicy,
          model: this.config.model,
          reasoningEffort: "medium",
          providerSessionId,
          previousResponseId,
          signal: abortController.signal,
          timeoutMs,
          maxToolCalls: this.config.defaultMaxToolCalls
        };

        const iterationResult = await this.adapter.run(request, onEvent);
        previousResponseId = iterationResult.previousResponseId ?? previousResponseId;
        providerSessionId = iterationResult.providerSessionId ?? providerSessionId;
        finalResult = iterationResult;

        if (iterationResult.toolCalls.length === 0) {
          break;
        }

        for (const toolCall of iterationResult.toolCalls) {
          toolCallsExecuted += 1;
          if (toolCallsExecuted > this.config.defaultMaxToolCalls) {
            throw new Error(`Run exceeded max tool calls (${this.config.defaultMaxToolCalls})`);
          }

          await onEvent({
            type: "tool_call_started",
            runId,
            sessionId,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName
          });

          try {
            const parsedInput = parseToolArguments(toolCall.argumentsText);
            const output = await this.tools.call(
              toolCall.toolName,
              toJsonValue(parsedInput),
              input.permissionPolicy
            );
            const outputText = JSON.stringify(output);
            await onEvent({
              type: "tool_call_succeeded",
              runId,
              sessionId,
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              output: outputText
            });

            const toolMessage: ChatMessage = {
              role: "tool",
              content: JSON.stringify({
                toolName: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                output
              })
            };
            requestMessages = [...iterationResult.transcript, toolMessage];
            await onEvent({
              type: "tool_output_attached",
              runId,
              sessionId,
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              content: toolMessage.content
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Tool call failed";
            await onEvent({
              type: "tool_call_failed",
              runId,
              sessionId,
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              message
            });
            throw new Error(`Tool ${toolCall.toolName} failed: ${message}`);
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!finalResult) {
      throw new Error("Run completed without a result");
    }

    const updated: SessionRecord = {
      ...session,
      providerSessionId,
      previousResponseId,
      lastEventCursor: previousResponseId ?? providerSessionId ?? session.lastEventCursor,
      updatedAt: new Date().toISOString(),
      runIds: [...session.runIds, finalResult.runId]
    };
    await this.sessions.upsert(updated);
    const turnRecord: MemoryTurnRecord = {
      sessionId,
      runId,
      queryText: memoryQueryText,
      recentMessagesText: buildConversationTranscript(input.messages),
      userInput: input.messages.filter((message) => message.role === "user").at(-1)?.content ?? "",
      assistantOutput: finalResult.outputText
    };
    await this.memory.recordTurn(turnRecord);
    await this.memory.consolidate(turnRecord, async (record) => this.generateMemoryInsights(record));

    return { session: updated, result: finalResult };
  }

  private async generateMemoryInsights(record: MemoryTurnRecord): Promise<MemoryInsightSet> {
    if (!this.config.openAiApiKey) {
      return heuristicInsights(record);
    }

    try {
      const request: AgentRunRequest = {
        runId: createId("memrun"),
        sessionId: record.sessionId,
        role: "researcher",
        systemPrompt: [
          "Extract compact memory insights from the turn.",
          "Return strict JSON with keys semanticFacts, proceduralNotes, summary.",
          "semanticFacts: stable truths learned from the exchange.",
          "proceduralNotes: reusable operating guidance only when clearly established.",
          "summary: one compact episodic summary sentence."
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              recentMessagesText: record.recentMessagesText,
              userInput: record.userInput,
              assistantOutput: record.assistantOutput
            })
          }
        ],
        memory: { episodic: [], semantic: [], procedural: [], summaries: [] },
        toolCapabilities: [],
        permissionPolicy: {
          mode: "read_only",
          fileGlobs: [],
          allowedToolIds: [],
          allowedMcpServers: []
        },
        model: this.config.model,
        reasoningEffort: "low"
      };

      const result = await this.adapter.run(request, async () => {});
      return parseInsights(result.outputText, record);
    } catch {
      return heuristicInsights(record);
    }
  }
}

function parseToolArguments(argumentsText: string): unknown {
  if (!argumentsText.trim()) {
    return null;
  }
  try {
    return JSON.parse(argumentsText) as unknown;
  } catch {
    throw new Error("Tool arguments must be valid JSON");
  }
}

function buildMemoryQueryText(messages: ChatMessage[]): string {
  return buildConversationTranscript(messages.slice(-6));
}

function buildConversationTranscript(messages: ChatMessage[]): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
}

function parseInsights(outputText: string, record: MemoryTurnRecord): MemoryInsightSet {
  try {
    const parsed = JSON.parse(outputText) as Partial<MemoryInsightSet>;
    return {
      semanticFacts: Array.isArray(parsed.semanticFacts) ? parsed.semanticFacts.filter(isString) : [],
      proceduralNotes: Array.isArray(parsed.proceduralNotes) ? parsed.proceduralNotes.filter(isString) : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : heuristicInsights(record).summary
    };
  } catch {
    return heuristicInsights(record);
  }
}

function heuristicInsights(record: MemoryTurnRecord): MemoryInsightSet {
  const semanticFacts: string[] = [];
  const proceduralNotes: string[] = [];
  const normalizedUser = record.userInput.toLowerCase();
  const normalizedAssistant = record.assistantOutput.toLowerCase();

  if (normalizedUser.includes("remember") || normalizedAssistant.includes("always") || normalizedAssistant.includes("prefer")) {
    semanticFacts.push(`User preference or standing context: ${trimInsight(record.userInput || record.assistantOutput)}`);
  }
  if (
    normalizedUser.includes("how do") ||
    normalizedAssistant.includes("step") ||
    normalizedAssistant.includes("procedure") ||
    normalizedAssistant.includes("first")
  ) {
    proceduralNotes.push(`Procedure guidance: ${trimInsight(record.assistantOutput)}`);
  }
  if (semanticFacts.length === 0 && normalizedAssistant.includes("is ")) {
    semanticFacts.push(`Learned fact: ${trimInsight(record.assistantOutput)}`);
  }

  return {
    semanticFacts,
    proceduralNotes,
    summary: `Summary: ${trimInsight(`${record.userInput} -> ${record.assistantOutput}`)}`
  };
}

function trimInsight(value: string): string {
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
