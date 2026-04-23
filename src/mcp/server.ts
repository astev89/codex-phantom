import type { JsonValue, PermissionPolicy } from "../shared/types.ts";
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
  private readonly token: string;
  private readonly tools: ToolRegistry;

  constructor(token: string, tools: ToolRegistry) {
    this.token = token;
    this.tools = tools;
  }

  async handle(request: Request): Promise<Response> {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${this.token}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as McpRequestBody;
    if (body.method === "tools/list") {
      return Response.json({ tools: this.tools.list() });
    }
    if (body.method === "tools/call" && body.params?.name) {
      try {
        const output = await this.tools.call(body.params.name, body.params.input ?? null, body.params.policy);
        return Response.json({ output });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Tool call failed" },
          { status: 400 }
        );
      }
    }
    return Response.json({ error: "Unsupported MCP method" }, { status: 400 });
  }
}
