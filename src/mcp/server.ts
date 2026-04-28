import { createHash, timingSafeEqual } from "node:crypto";
import type { JsonValue, PermissionPolicy } from "../shared/types.ts";
import type { McpAuditStore } from "./audit.ts";
import type { MetricsStore } from "../platform/metrics.ts";
import { ToolRegistry } from "../tools/registry.ts";

type McpRequestBody = {
  method?: string;
  params?: {
    name?: string;
    input?: JsonValue;
    policy?: PermissionPolicy;
  };
};

export class McpServer {
  private readonly tokenHash: Buffer;
  private readonly tools: ToolRegistry;
  private readonly metrics?: MetricsStore;
  private readonly fixedPolicy?: PermissionPolicy;
  private readonly audit?: McpAuditStore;

  constructor(
    token: string,
    tools: ToolRegistry,
    metrics?: MetricsStore,
    policy?: PermissionPolicy,
    audit?: McpAuditStore
  ) {
    this.tokenHash = hashToken(token);
    this.tools = tools;
    this.metrics = metrics;
    this.fixedPolicy = policy;
    this.audit = audit;
  }

  async handle(request: Request): Promise<Response> {
    const auth = request.headers.get("authorization");
    const requestId = request.headers.get("x-request-id") ?? undefined;
    if (!auth?.startsWith("Bearer ") || !this.matchesToken(auth.slice("Bearer ".length))) {
      this.metrics?.increment("mcp.auth.failure");
      this.audit?.record({
        requestId,
        method: "unknown",
        outcome: "auth_failed",
        statusCode: 401
      });
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    this.metrics?.increment("mcp.auth.success");

    const body = (await request.json()) as McpRequestBody;
    const method = body.method ?? "unknown";
    if (body.method === "tools/list") {
      const policy = this.currentPolicy();
      this.metrics?.increment("mcp.method.tools_list");
      this.audit?.record({
        requestId,
        method,
        outcome: "success",
        statusCode: 200
      });
      return Response.json({ tools: this.tools.listForRole("coordinator", policy) });
    }
    if (body.method === "tools/call" && body.params?.name) {
      const policy = this.currentPolicy();
      this.metrics?.increment("mcp.method.tools_call");
      const toolName = body.params.name;
      if (!policy.allowedToolIds.includes(toolName)) {
        this.metrics?.increment("mcp.tool_call.denied");
        const errorMessage = `Tool ${toolName} is not permitted for MCP`;
        this.audit?.record({
          requestId,
          method,
          toolName,
          outcome: "denied",
          statusCode: 400,
          errorMessage
        });
        return Response.json({ error: errorMessage }, { status: 400 });
      }
      try {
        this.metrics?.increment(`mcp.tool_call.${toolName}`);
        const output = await this.tools.call(toolName, body.params.input ?? null, policy);
        this.audit?.record({
          requestId,
          method,
          toolName,
          outcome: "success",
          statusCode: 200
        });
        return Response.json({ output });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Tool call failed";
        this.audit?.record({
          requestId,
          method,
          toolName,
          outcome: "failed",
          statusCode: 400,
          errorMessage
        });
        return Response.json(
          { error: errorMessage },
          { status: 400 }
        );
      }
    }
    this.metrics?.increment("mcp.method.unsupported");
    this.audit?.record({
      requestId,
      method,
      toolName: body.params?.name,
      outcome: "unsupported",
      statusCode: 400,
      errorMessage: "Unsupported MCP method"
    });
    return Response.json({ error: "Unsupported MCP method" }, { status: 400 });
  }

  private matchesToken(candidate: string): boolean {
    const candidateHash = hashToken(candidate);
    return candidateHash.length === this.tokenHash.length && timingSafeEqual(candidateHash, this.tokenHash);
  }

  private currentPolicy(): PermissionPolicy {
    if (this.fixedPolicy) {
      return this.fixedPolicy;
    }
    return {
      mode: "read_only",
      fileGlobs: [],
      allowedToolIds: this.tools.list().filter((tool) => !tool.scopes.includes("write")).map((tool) => tool.id),
      allowedMcpServers: []
    };
  }
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
