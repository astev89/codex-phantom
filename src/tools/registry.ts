import type { JsonValue, PermissionPolicy, ToolCapabilityDescriptor } from "../shared/types.ts";
import type { SubagentRole } from "../orchestration/types.ts";

export type ToolHandler = (input: JsonValue) => Promise<JsonValue> | JsonValue;

type ToolDefinition = ToolCapabilityDescriptor & {
  dynamic?: boolean;
  allowedRoles?: Array<"coordinator" | SubagentRole>;
  mcpServer?: string;
  handler: ToolHandler;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly dynamicTools = new Set<string>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.id, { ...tool, dynamic: false });
  }

  registerDynamic(tool: ToolDefinition): void {
    this.tools.set(tool.id, { ...tool, dynamic: true });
    this.dynamicTools.add(tool.id);
  }

  unregisterDynamic(toolId: string): boolean {
    if (!this.dynamicTools.has(toolId)) {
      return false;
    }

    this.dynamicTools.delete(toolId);
    return this.tools.delete(toolId);
  }

  list(): ToolCapabilityDescriptor[] {
    return [...this.tools.values()].map(({ handler: _handler, ...tool }) => tool);
  }

  listForRole(role: "coordinator" | SubagentRole, policy?: PermissionPolicy): ToolCapabilityDescriptor[] {
    return [...this.tools.values()]
      .filter((tool) => !tool.allowedRoles || tool.allowedRoles.includes(role))
      .filter((tool) => this.isAllowedByPolicy(tool, policy))
      .map(({ handler: _handler, ...tool }) => tool);
  }

  resolveAllowedToolIds(allowedToolIds: string[]): string[] {
    return [...this.tools.values()]
      .filter((tool) => this.isAllowedByAllowedIds(tool, allowedToolIds))
      .map((tool) => tool.id);
  }

  async call(toolId: string, input: JsonValue, policy?: PermissionPolicy): Promise<JsonValue> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolId}`);
    }
    if (!this.isAllowedByPolicy(tool, policy)) {
      throw new Error(`Tool ${toolId} is not permitted for this run`);
    }
    return tool.handler(input);
  }

  has(toolId: string): boolean {
    return this.tools.has(toolId);
  }

  private isAllowedByPolicy(tool: ToolDefinition, policy?: PermissionPolicy): boolean {
    if (!policy) {
      return true;
    }

    if (!this.isAllowedByAllowedIds(tool, policy.allowedToolIds)) {
      return false;
    }

    if (tool.kind === "mcp" && tool.mcpServer && !policy.allowedMcpServers.includes(tool.mcpServer)) {
      return false;
    }

    return true;
  }

  private isAllowedByAllowedIds(tool: ToolDefinition, allowedToolIds: string[]): boolean {
    if (allowedToolIds.includes(tool.id)) {
      return true;
    }

    return tool.dynamic === true && allowedToolIds.includes("dynamic:*") && !tool.scopes.includes("write");
  }
}
