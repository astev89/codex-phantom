import {
  decodeJson,
  encodeJson,
  type AppDatabase,
} from "../platform/database.ts";
import type { PermissionPolicy } from "../shared/types.ts";
import type { LoadedRolePolicyConfig } from "./role-config.ts";
import type { RolePolicyBaselines } from "./roles.ts";
import type { SubagentRole } from "./types.ts";

const ROW_ID = "runtime";
const ROLE_NAMES = ["explorer", "builder", "verifier", "researcher"] as const;
const POLICY_FIELDS = [
  "mode",
  "fileGlobs",
  "allowedToolIds",
  "allowedMcpServers",
] as const;
const MODE_ORDER: Record<PermissionPolicy["mode"], number> = {
  read_only: 0,
  scoped_write: 1,
  full_access: 2,
};

type RolePolicyOverride = Partial<PermissionPolicy>;
export type RolePolicyOverrides = Partial<
  Record<SubagentRole, RolePolicyOverride>
>;
export type RolePolicyPatch = {
  roles: RolePolicyOverrides;
};

type RolePolicyOverrideRow = {
  id: string;
  overrides_json: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type RolePolicyRuntimeRecord = {
  id: "runtime";
  overrides: RolePolicyOverrides;
  baselines: RolePolicyBaselines;
  status: LoadedRolePolicyConfig["status"];
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type RolePolicyRuntimeProvider = {
  get(): RolePolicyRuntimeRecord;
  getConfig(): LoadedRolePolicyConfig;
};

export class RolePolicyRuntimeStore implements RolePolicyRuntimeProvider {
  private readonly database: AppDatabase;
  private readonly baseConfig: LoadedRolePolicyConfig;

  constructor(database: AppDatabase, baseConfig: LoadedRolePolicyConfig) {
    this.database = database;
    this.baseConfig = structuredClone(baseConfig);
    this.seedDefault();
  }

  get(): RolePolicyRuntimeRecord {
    const row = this.database.get<RolePolicyOverrideRow>(
      "SELECT id, overrides_json, updated_by, created_at, updated_at FROM role_policy_overrides WHERE id = ?",
      ROW_ID
    );
    if (!row) {
      this.seedDefault();
      return this.get();
    }
    const decoded = decodeJson<unknown>(row.overrides_json, {});
    let overrides: RolePolicyOverrides;
    try {
      overrides = normalizeRolePolicyOverrides(
        decoded,
        this.baseConfig.baselines
      );
    } catch {
      this.replaceOverrides({}, "role_policy_validation");
      return this.get();
    }
    return toRecord(row, overrides, this.baseConfig);
  }

  getConfig(): LoadedRolePolicyConfig {
    const record = this.get();
    return {
      baselines: structuredClone(record.baselines),
      status: {
        ...record.status,
        loadedAt: record.updatedAt,
      },
    };
  }

  update(patch: RolePolicyPatch, actor?: string): RolePolicyRuntimeRecord {
    const normalizedPatch = normalizeRolePolicyPatch(
      patch,
      this.baseConfig.baselines
    );
    const current = this.get();
    const next = mergeOverrides(current.overrides, normalizedPatch.roles);
    return this.writeOverrides(next, actor, current.createdAt);
  }

  replaceOverrides(
    overrides: RolePolicyOverrides,
    actor?: string
  ): RolePolicyRuntimeRecord {
    const current = this.getExistingTimestamps();
    const normalized = normalizeRolePolicyOverrides(
      overrides,
      this.baseConfig.baselines
    );
    return this.writeOverrides(normalized, actor, current.createdAt);
  }

  private seedDefault(): void {
    const now = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO role_policy_overrides (id, overrides_json, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `,
      ROW_ID,
      encodeJson({}),
      null,
      now,
      now
    );
  }

  private getExistingTimestamps(): { createdAt: string } {
    const row = this.database.get<{ created_at: string }>(
      "SELECT created_at FROM role_policy_overrides WHERE id = ?",
      ROW_ID
    );
    if (!row) {
      this.seedDefault();
      return this.getExistingTimestamps();
    }
    return { createdAt: row.created_at };
  }

  private writeOverrides(
    overrides: RolePolicyOverrides,
    actor: string | undefined,
    createdAt: string
  ): RolePolicyRuntimeRecord {
    const now = new Date().toISOString();
    this.database.run(
      `
        INSERT INTO role_policy_overrides (id, overrides_json, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          overrides_json = excluded.overrides_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `,
      ROW_ID,
      encodeJson(overrides),
      actor ?? null,
      createdAt,
      now
    );
    return this.get();
  }
}

export function rolePolicyRuntimeSnapshot(record: RolePolicyRuntimeRecord): {
  overrides: RolePolicyOverrides;
  baselines: RolePolicyBaselines;
} {
  return {
    overrides: structuredClone(record.overrides),
    baselines: structuredClone(record.baselines),
  };
}

export function normalizeRolePolicyPatch(
  input: unknown,
  baselines: RolePolicyBaselines
): RolePolicyPatch {
  if (!isRecord(input)) {
    throw new Error("rolePolicy must be an object");
  }
  const roles = input.roles;
  if (!isRecord(roles)) {
    throw new Error("rolePolicy.roles must be an object");
  }
  const normalized = normalizeRolePolicyOverrides(roles, baselines);
  if (Object.keys(normalized).length === 0) {
    throw new Error("rolePolicy.roles must contain at least one role");
  }
  return { roles: normalized };
}

export function normalizeRolePolicyOverrides(
  input: unknown,
  baselines: RolePolicyBaselines
): RolePolicyOverrides {
  if (!isRecord(input)) {
    throw new Error("rolePolicy.roles must be an object");
  }
  const overrides: RolePolicyOverrides = {};
  for (const [role, value] of Object.entries(input)) {
    if (!isSubagentRole(role)) {
      throw new Error(`rolePolicy.roles.${role} is not supported`);
    }
    overrides[role] = normalizeRoleOverride(role, value, baselines[role]);
  }
  return overrides;
}

function normalizeRoleOverride(
  role: SubagentRole,
  input: unknown,
  baseline: PermissionPolicy
): RolePolicyOverride {
  if (!isRecord(input)) {
    throw new Error(`rolePolicy.roles.${role} must be an object`);
  }
  for (const key of Object.keys(input)) {
    if (!POLICY_FIELDS.includes(key as (typeof POLICY_FIELDS)[number])) {
      throw new Error(`rolePolicy.roles.${role}.${key} is not supported`);
    }
  }
  if (Object.keys(input).length === 0) {
    throw new Error(`rolePolicy.roles.${role} must contain at least one field`);
  }
  const override: RolePolicyOverride = {};
  if (input.mode !== undefined) {
    override.mode = normalizeMode(role, input.mode, baseline.mode);
  }
  const effectiveMode = override.mode ?? baseline.mode;
  if (effectiveMode === "full_access") {
    throw new Error(`rolePolicy.roles.${role}.mode cannot be full_access`);
  }
  if (input.fileGlobs !== undefined) {
    // A read-only role with a full-repo baseline can narrow to any glob: mode
    // enforcement still prevents writes, and scoped-write roles remain subset-only.
    override.fileGlobs = normalizeStringSubset(
      role,
      "fileGlobs",
      input.fileGlobs,
      baseline.fileGlobs,
      baseline.mode === "read_only" && baseline.fileGlobs.includes("**/*")
    );
  }
  if (input.allowedToolIds !== undefined) {
    override.allowedToolIds = normalizeStringSubset(
      role,
      "allowedToolIds",
      input.allowedToolIds,
      baseline.allowedToolIds
    );
  }
  if (input.allowedMcpServers !== undefined) {
    override.allowedMcpServers = normalizeStringSubset(
      role,
      "allowedMcpServers",
      input.allowedMcpServers,
      baseline.allowedMcpServers
    );
  }
  return override;
}

function normalizeMode(
  role: SubagentRole,
  value: unknown,
  baselineMode: PermissionPolicy["mode"]
): PermissionPolicy["mode"] {
  if (
    value !== "read_only" &&
    value !== "scoped_write" &&
    value !== "full_access"
  ) {
    throw new Error(
      `rolePolicy.roles.${role}.mode must be read_only, scoped_write, or full_access`
    );
  }
  if (value === "full_access") {
    throw new Error(`rolePolicy.roles.${role}.mode cannot be full_access`);
  }
  if (MODE_ORDER[value] > MODE_ORDER[baselineMode]) {
    throw new Error(
      `rolePolicy.roles.${role}.mode cannot exceed baseline ${baselineMode}`
    );
  }
  return value;
}

function normalizeStringSubset(
  role: SubagentRole,
  field: "fileGlobs" | "allowedToolIds" | "allowedMcpServers",
  value: unknown,
  baseline: string[],
  allowAny = false
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`rolePolicy.roles.${role}.${field} must be an array`);
  }
  const strings = value.map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(
        `rolePolicy.roles.${role}.${field} must contain non-empty strings`
      );
    }
    return item.trim();
  });
  if (strings.length === 0) {
    throw new Error(
      `rolePolicy.roles.${role}.${field} must contain at least one value`
    );
  }
  if (!allowAny) {
    const baselineSet = new Set(baseline);
    for (const item of strings) {
      if (!baselineSet.has(item)) {
        throw new Error(
          `rolePolicy.roles.${role}.${field} cannot include ${item}`
        );
      }
    }
  }
  return [...new Set(strings)];
}

function mergeOverrides(
  current: RolePolicyOverrides,
  patch: RolePolicyOverrides
): RolePolicyOverrides {
  const next: RolePolicyOverrides = structuredClone(current);
  for (const role of ROLE_NAMES) {
    if (patch[role] !== undefined) {
      next[role] = {
        ...(next[role] ?? {}),
        ...patch[role],
      };
    }
  }
  return next;
}

function applyOverrides(
  baselines: RolePolicyBaselines,
  overrides: RolePolicyOverrides
): RolePolicyBaselines {
  const next = structuredClone(baselines);
  for (const role of ROLE_NAMES) {
    if (overrides[role]) {
      next[role] = {
        ...next[role],
        ...overrides[role],
      };
    }
  }
  return next;
}

function toRecord(
  row: RolePolicyOverrideRow,
  overrides: RolePolicyOverrides,
  baseConfig: LoadedRolePolicyConfig
): RolePolicyRuntimeRecord {
  return {
    id: "runtime",
    overrides,
    baselines: applyOverrides(baseConfig.baselines, overrides),
    status: {
      ...baseConfig.status,
      loadedAt: row.updated_at,
    },
    updatedBy: row.updated_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isSubagentRole(value: string): value is SubagentRole {
  return ROLE_NAMES.includes(value as SubagentRole);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
