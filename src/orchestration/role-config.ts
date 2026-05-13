import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { PermissionPolicy } from "../shared/types.ts";
import type { SubagentRole } from "./types.ts";
import { compiledRoleBaselines, type RolePolicyBaselines } from "./roles.ts";

const ROLE_NAMES = ["explorer", "builder", "verifier", "researcher"] as const;
const MODES = new Set<PermissionPolicy["mode"]>([
  "read_only",
  "scoped_write",
  "full_access",
]);

export type RolePolicyConfigStatus = {
  source: "compiled_fallback" | "yaml";
  sourcePath?: string;
  valid: boolean;
  roles: SubagentRole[];
  loadedAt: string;
};

export type LoadedRolePolicyConfig = {
  baselines: RolePolicyBaselines;
  status: RolePolicyConfigStatus;
};

export function compiledRolePolicyConfig(): LoadedRolePolicyConfig {
  return {
    baselines: compiledRoleBaselines(),
    status: {
      source: "compiled_fallback",
      valid: true,
      roles: [...ROLE_NAMES],
      loadedAt: new Date().toISOString(),
    },
  };
}

export function loadRolePolicyConfig(path: string): LoadedRolePolicyConfig {
  const content = readFileSync(path, "utf8");
  const parsed = parse(content) as unknown;
  const root = recordValue(parsed, "role config root");
  const roles = recordValue(root.roles, "roles");
  const baselines = compiledRoleBaselines();

  for (const role of ROLE_NAMES) {
    if (roles[role] !== undefined) {
      baselines[role] = parsePolicy(roles[role], role);
    }
  }

  for (const role of Object.keys(roles)) {
    if (!ROLE_NAMES.includes(role as SubagentRole)) {
      throw new Error(`Unknown role in ROLE_CONFIG_PATH: ${role}`);
    }
  }

  return {
    baselines,
    status: {
      source: "yaml",
      sourcePath: path,
      valid: true,
      roles: [...ROLE_NAMES],
      loadedAt: new Date().toISOString(),
    },
  };
}

function parsePolicy(value: unknown, role: SubagentRole): PermissionPolicy {
  const record = recordValue(value, `roles.${role}`);
  const mode = stringValue(record.mode, `roles.${role}.mode`);
  if (!MODES.has(mode as PermissionPolicy["mode"])) {
    throw new Error(
      `roles.${role}.mode must be read_only, scoped_write, or full_access`
    );
  }
  return {
    mode: mode as PermissionPolicy["mode"],
    fileGlobs: stringArray(record.fileGlobs, `roles.${role}.fileGlobs`),
    allowedToolIds: stringArray(
      record.allowedToolIds,
      `roles.${role}.allowedToolIds`
    ),
    allowedMcpServers: stringArray(
      record.allowedMcpServers,
      `roles.${role}.allowedMcpServers`
    ),
  };
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value];
}
