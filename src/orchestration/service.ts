import { AgentRuntime } from "../agent/runtime.ts";
import type { AgentRunEvent } from "../agent/types.ts";
import { createId } from "../shared/ids.ts";
import type { ToolCapabilityDescriptor } from "../shared/types.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { buildScopedPolicy } from "./roles.ts";
import { RunGraphStore } from "./run-graph-store.ts";
import type { RunNode, SubagentRequest } from "./types.ts";

const COORDINATOR_POLICY = {
  mode: "scoped_write" as const,
  fileGlobs: ["src/**/*", "tests/**/*", "docs/**/*"],
  allowedToolIds: ["memory.query", "echo.summary", "dynamic.note", "dynamic:*"],
  allowedMcpServers: ["repo", "docs", "github", "web"]
};

export class OrchestrationService {
  private readonly runtime: AgentRuntime;
  private readonly tools: ToolRegistry;
  private readonly graphStore: RunGraphStore;

  constructor(runtime: AgentRuntime, tools: ToolRegistry, graphStore: RunGraphStore) {
    this.runtime = runtime;
    this.tools = tools;
    this.graphStore = graphStore;
  }

  listTools(): ToolCapabilityDescriptor[] {
    return this.tools.list();
  }

  async runCoordinator(
    input: {
      sessionId?: string;
      channelId: string;
      conversationId: string;
      message: string;
      subagents?: SubagentRequest[];
      timeoutMs?: number;
    },
    onEvent: (event: AgentRunEvent) => Promise<void> | void
  ): Promise<{ sessionId: string; runId: string; outputText: string }> {
    const allowedToolIds = this.tools.resolveAllowedToolIds(COORDINATOR_POLICY.allowedToolIds);
    const rootNode: RunNode = {
      runId: createId("coord"),
      role: "coordinator",
      objective: input.message,
      status: "running",
      permissionPolicy: {
        ...COORDINATOR_POLICY,
        allowedToolIds
      },
      allowedMcpServers: [...COORDINATOR_POLICY.allowedMcpServers],
      allowedToolIds,
      childRunIds: [],
      transcript: [{ role: "user", content: input.message }],
      startedAt: new Date().toISOString()
    };
    await this.graphStore.upsert(rootNode);

    const emit = async (event: AgentRunEvent): Promise<void> => {
      await this.graphStore.appendEvent(event.runId, event.type, event);
      await onEvent(event);
    };

    try {
      const runtimeResult = await this.runtime.run(
        {
          sessionId: input.sessionId,
          channelId: input.channelId,
          conversationId: input.conversationId,
          role: "coordinator",
          messages: [{ role: "user", content: input.message }],
          permissionPolicy: rootNode.permissionPolicy,
          toolCapabilities: this.tools.listForRole("coordinator", rootNode.permissionPolicy),
          timeoutMs: input.timeoutMs
        },
        emit
      );

      let outputText = runtimeResult.result.outputText;
      const childRunIds: string[] = [];

      if (input.subagents && input.subagents.length > 0) {
        for (const subagent of input.subagents) {
          const child = await this.spawnSubagent(rootNode.runId, runtimeResult.session.sessionId, subagent, emit);
          childRunIds.push(child.runId);
          outputText = `${outputText}\n${child.role} [${child.status}]: ${child.outputText}`;
        }
      }

      const finalRoot = (await this.graphStore.get(rootNode.runId)) ?? rootNode;
      await this.graphStore.upsert({
        ...finalRoot,
        childRunIds: childRunIds.length > 0 ? childRunIds : finalRoot.childRunIds,
        status: "completed",
        summary: outputText,
        transcript: [...finalRoot.transcript, { role: "assistant", content: outputText }],
        finishedAt: new Date().toISOString(),
        terminalState: {
          outputText,
          previousResponseId: runtimeResult.result.previousResponseId,
          providerSessionId: runtimeResult.result.providerSessionId,
          usage: runtimeResult.result.usage
        }
      });

      return {
        sessionId: runtimeResult.session.sessionId,
        runId: rootNode.runId,
        outputText
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Coordinator run failed";
      const failedRoot = (await this.graphStore.get(rootNode.runId)) ?? rootNode;
      await this.graphStore.upsert({
        ...failedRoot,
        status: "failed",
        summary: message,
        finishedAt: new Date().toISOString(),
        terminalState: { outputText: message }
      });
      throw error;
    }
  }

  async spawnSubagent(
    parentRunId: string,
    sessionId: string,
    request: SubagentRequest,
    onEvent: (event: AgentRunEvent) => Promise<void> | void
  ): Promise<{ runId: string; role: string; status: string; outputText: string }> {
    const runId = createId("sub");
    const parent = await this.graphStore.get(parentRunId);
    if (!parent) {
      throw new Error(`Parent run not found: ${parentRunId}`);
    }

    const policy = buildScopedPolicy(parent.permissionPolicy, request);
    const node: RunNode = {
      runId,
      parentRunId,
      role: request.role,
      objective: request.objective,
      status: "running",
      permissionPolicy: policy,
      allowedMcpServers: policy.allowedMcpServers,
      allowedToolIds: policy.allowedToolIds,
      childRunIds: [],
      maxBudgetUsd: request.maxBudgetUsd,
      timeoutMs: request.timeoutMs ?? request.maxDurationMs,
      transcript: [{ role: "user", content: request.objective }],
      startedAt: new Date().toISOString()
    };
    await this.graphStore.appendChildRun(parent.runId, runId);
    await this.graphStore.upsert(node);
    await onEvent({
      type: "subagent_spawned",
      runId: parentRunId,
      subagentRunId: runId,
      role: request.role,
      objective: request.objective
    });

    try {
      const result = await this.runtime.run(
        {
          sessionId,
          channelId: "subagent",
          conversationId: runId,
          role: request.role,
          messages: [{ role: "user", content: request.objective }],
          permissionPolicy: policy,
          toolCapabilities: this.tools.listForRole(request.role, policy),
          timeoutMs: request.timeoutMs ?? request.maxDurationMs
        },
        async (event) => {
          await this.graphStore.appendEvent(runId, event.type, event);
          await onEvent(event);
          if (event.type === "text_delta") {
            await onEvent({
              type: "subagent_progress",
              runId: parentRunId,
              subagentRunId: runId,
              status: "running",
              summary: event.delta
            });
          }
        }
      );

      await this.graphStore.upsert({
        ...node,
        status: "completed",
        summary: result.result.outputText,
        transcript: [...node.transcript, { role: "assistant", content: result.result.outputText }],
        finishedAt: new Date().toISOString(),
        terminalState: {
          outputText: result.result.outputText,
          previousResponseId: result.result.previousResponseId,
          providerSessionId: result.result.providerSessionId,
          usage: result.result.usage
        }
      });
      await onEvent({
        type: "subagent_progress",
        runId: parentRunId,
        subagentRunId: runId,
        status: "completed",
        summary: result.result.outputText
      });

      return { runId, role: request.role, status: "completed", outputText: result.result.outputText };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Subagent failed";
      await this.graphStore.upsert({
        ...node,
        status: "failed",
        summary: message,
        finishedAt: new Date().toISOString(),
        terminalState: { outputText: message }
      });
      await onEvent({
        type: "subagent_progress",
        runId: parentRunId,
        subagentRunId: runId,
        status: "failed",
        summary: message
      });
      return { runId, role: request.role, status: "failed", outputText: message };
    }
  }
}
