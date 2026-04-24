import { createHash, timingSafeEqual } from "node:crypto";
import type { JsonValue, PermissionPolicy } from "../shared/types.ts";
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

  constructor(token: string, tools: ToolRegistry, metrics?: MetricsStore, policy?: PermissionPolicy) {
    this.tokenHash = hashToken(token);
    this.tools = tools;
    this.metrics = metrics;
    this.fixedPolicy = policy;
  }

  async handle(request: Request): Promise<Response> {
    const auth = request.headers.get("authorization");
    if (!auth?.startsWith("Bearer ") || !this.matchesToken(auth.slice("Bearer ".length))) {
      this.metrics?.increment("mcp.auth.failure");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    this.metrics?.increment("mcp.auth.success");

    const body = (await request.json()) as McpRequestBody;
    if (body.method === "tools/list") {
      const policy = this.currentPolicy();
      this.metrics?.increment("mcp.method.tools_list");
      return Response.json({ tools: this.tools.listForRole("coordinator", policy) });
    }
    if (body.method === "tools/call" && body.params?.name) {
      const policy = this.currentPolicy();
      this.metrics?.increment("mcp.method.tools_call");
      try {
        if (!policy.allowedToolIds.includes(body.params.name)) {
          this.metrics?.increment("mcp.tool_call.denied");
          throw new Error(`Tool ${body.params.name} is not permitted for MCP`);
        }
        this.metrics?.increment(`mcp.tool_call.${body.params.name}`);
        const output = await this.tools.call(body.params.name, body.params.input ?? null, policy);
        return Response.json({ output });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Tool call failed" },
          { status: 400 }
        );
      }
    }
    this.metrics?.increment("mcp.method.unsupported");
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
