import type { JsonValue } from "../shared/types.ts";
import {
  ToolBundleImportStore,
  type ToolBundleImportRecord,
} from "./bundles.ts";
import { DynamicToolRegistry } from "./dynamic-registry.ts";

export class ToolBundleLifecycleError extends Error {
  readonly status: number;
  readonly details?: JsonValue;

  constructor(status: number, message: string, details?: JsonValue) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class ToolBundleLifecycleService {
  private readonly toolBundles: ToolBundleImportStore;
  private readonly dynamicTools: DynamicToolRegistry;

  constructor(options: {
    toolBundles: ToolBundleImportStore;
    dynamicTools: DynamicToolRegistry;
  }) {
    this.toolBundles = options.toolBundles;
    this.dynamicTools = options.dynamicTools;
  }

  get(importId: string): ToolBundleImportRecord | null {
    return this.toolBundles.get(importId);
  }

  enable(
    importId: string,
    actor: string,
    notes?: string
  ): ToolBundleImportRecord {
    const bundle = this.getRequired(importId);
    if (bundle.status !== "valid") {
      throw new ToolBundleLifecycleError(
        409,
        "Only valid tool bundle imports can be enabled"
      );
    }
    if (!["approved", "disabled"].includes(bundle.lifecycleState)) {
      throw new ToolBundleLifecycleError(
        409,
        "Tool bundle must be approved before it can be enabled"
      );
    }
    const tools = extractBundleTools(bundle.manifest);
    for (const tool of tools) {
      if (this.dynamicTools.has(tool.id)) {
        throw new ToolBundleLifecycleError(
          409,
          `Tool bundle tool id already exists: ${tool.id}`
        );
      }
    }
    const registeredToolIds: string[] = [];
    try {
      for (const tool of tools) {
        this.dynamicTools.registerApproved(tool, {
          approvedBy: bundle.approvedBy ?? actor,
          notes: notes ?? `enabled from bundle ${bundle.bundleId}`,
        });
        registeredToolIds.push(tool.id);
      }
      return this.toolBundles.markEnabled(importId, actor, notes);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to enable tool bundle";
      for (const toolId of registeredToolIds) {
        try {
          this.dynamicTools.unregister(toolId);
        } catch {
          // Keep the original enable failure as the operator-visible error.
        }
      }
      const failed = this.toolBundles.markFailed(importId, actor, message);
      throw new ToolBundleLifecycleError(
        400,
        message,
        failed as unknown as JsonValue
      );
    }
  }

  disable(
    importId: string,
    actor: string,
    notes?: string
  ): ToolBundleImportRecord {
    const bundle = this.getRequired(importId);
    if (bundle.lifecycleState !== "enabled") {
      throw new ToolBundleLifecycleError(
        409,
        "Only enabled tool bundles can be disabled"
      );
    }
    for (const tool of extractBundleTools(bundle.manifest)) {
      this.dynamicTools.unregister(tool.id);
    }
    return this.toolBundles.markDisabled(importId, actor, notes);
  }

  uninstall(
    importId: string,
    actor: string,
    notes?: string
  ): ToolBundleImportRecord {
    const bundle = this.getRequired(importId);
    for (const tool of extractBundleTools(bundle.manifest)) {
      this.dynamicTools.unregister(tool.id);
    }
    return this.toolBundles.markUninstalled(importId, actor, notes);
  }

  listToolIds(bundle: ToolBundleImportRecord): string[] {
    return extractBundleTools(bundle.manifest).map((tool) => tool.id);
  }

  private getRequired(importId: string): ToolBundleImportRecord {
    const bundle = this.toolBundles.get(importId);
    if (!bundle) {
      throw new ToolBundleLifecycleError(404, "Tool bundle import not found");
    }
    return bundle;
  }
}

export function extractBundleTools(manifest: JsonValue): Array<{
  id: string;
  description: string;
  scopes: string[];
  inputSchema?: JsonValue;
  responseTemplate: string;
}> {
  const manifestObject = asJsonObject(manifest, "manifest");
  if (!Array.isArray(manifestObject.tools)) {
    throw new Error("manifest.tools must be an array");
  }
  return manifestObject.tools.map((item, index) => {
    const tool = asJsonObject(item, `manifest.tools[${index}]`);
    if (
      typeof tool.id !== "string" ||
      typeof tool.description !== "string" ||
      typeof tool.responseTemplate !== "string"
    ) {
      throw new Error(`manifest.tools[${index}] is missing required fields`);
    }
    const scopes = tool.scopes === undefined ? ["read"] : tool.scopes;
    if (
      !Array.isArray(scopes) ||
      scopes.some((scope) => typeof scope !== "string")
    ) {
      throw new Error(`manifest.tools[${index}].scopes must be strings`);
    }
    const stringScopes = scopes as string[];
    return {
      id: tool.id,
      description: tool.description,
      scopes: stringScopes,
      inputSchema: tool.inputSchema,
      responseTemplate: tool.responseTemplate,
    };
  });
}

function asJsonObject(
  value: JsonValue | undefined,
  field: string
): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value as Record<string, JsonValue>;
}
