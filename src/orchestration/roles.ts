import type { PermissionPolicy } from "../shared/types.ts";
import type { SubagentRequest, SubagentRole } from "./types.ts";

const ROLE_BASELINES: Record<SubagentRole, PermissionPolicy> = {
  explorer: {
    mode: "read_only",
    fileGlobs: ["**/*"],
    allowedToolIds: ["memory.query", "echo.summary"],
    allowedMcpServers: ["github", "docs"]
  },
  builder: {
    mode: "scoped_write",
    fileGlobs: ["src/**/*", "tests/**/*"],
    allowedToolIds: ["echo.summary", "dynamic.note"],
    allowedMcpServers: ["repo"]
  },
  verifier: {
    mode: "read_only",
    fileGlobs: ["src/**/*", "tests/**/*"],
    allowedToolIds: ["echo.summary"],
    allowedMcpServers: ["browser", "ci"]
  },
  researcher: {
    mode: "read_only",
    fileGlobs: [],
    allowedToolIds: ["echo.summary"],
    allowedMcpServers: ["docs", "web"]
  }
};

const MODE_ORDER: Record<PermissionPolicy["mode"], number> = {
  read_only: 0,
  scoped_write: 1,
  full_access: 2
};

function intersect(base: string[], requested?: string[]): string[] {
  if (!requested || requested.length === 0) {
    return [...base];
  }

  const baseSet = new Set(base);
  return requested.filter((item) => baseSet.has(item));
}

function intersectFileGlobs(base: string[], requested?: string[]): string[] {
  if (!requested || requested.length === 0) {
    return [...base];
  }
  if (base.includes("**/*")) {
    return [...requested];
  }
  if (requested.includes("**/*")) {
    return [...base];
  }

  const baseSet = new Set(base);
  return requested.filter((item) => baseSet.has(item));
}

function narrowMode(left: PermissionPolicy["mode"], right: PermissionPolicy["mode"]): PermissionPolicy["mode"] {
  return MODE_ORDER[left] < MODE_ORDER[right] ? left : right;
}

export function defaultPolicyForRole(role: SubagentRole): PermissionPolicy {
  return structuredClone(ROLE_BASELINES[role]);
}

export function buildScopedPolicy(
  parentPolicy: PermissionPolicy,
  request: Pick<SubagentRequest, "role" | "allowedToolIds" | "allowedMcpServers" | "fileGlobs">
): PermissionPolicy {
  const baseline = defaultPolicyForRole(request.role);

  return {
    mode: narrowMode(parentPolicy.mode, baseline.mode),
    allowedToolIds: intersect(
      intersect(parentPolicy.allowedToolIds, baseline.allowedToolIds),
      request.allowedToolIds
    ),
    allowedMcpServers: intersect(
      intersect(parentPolicy.allowedMcpServers, baseline.allowedMcpServers),
      request.allowedMcpServers
    ),
    fileGlobs: intersectFileGlobs(
      intersectFileGlobs(parentPolicy.fileGlobs, baseline.fileGlobs),
      request.fileGlobs
    )
  };
}
