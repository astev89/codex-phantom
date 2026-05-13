import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson, toJsonValue } from "../platform/database.ts";
import { createId } from "../shared/ids.ts";
import type { JsonValue } from "../shared/types.ts";

export type SelfEvolutionTarget =
  | "prompt"
  | "memory_policy"
  | "tool"
  | "role"
  | "configuration";

export type SelfEvolutionRiskClass = "low" | "medium" | "high" | "critical";

export type SelfEvolutionProposalStatus = "proposed";

export type CreateSelfEvolutionProposalInput = {
  target: SelfEvolutionTarget;
  title: string;
  rationale: string;
  riskClass: SelfEvolutionRiskClass;
  proposedChange: JsonValue;
  metadata?: JsonValue;
  proposedBy?: string;
};

export type SelfEvolutionProposalRecord = {
  id: string;
  target: SelfEvolutionTarget;
  title: string;
  rationale: string;
  riskClass: SelfEvolutionRiskClass;
  proposedChange: JsonValue;
  metadata: JsonValue;
  status: SelfEvolutionProposalStatus;
  proposedBy?: string;
  createdAt: string;
  updatedAt: string;
};

type ProposalRow = {
  id: string;
  target: SelfEvolutionTarget;
  title: string;
  rationale: string;
  risk_class: SelfEvolutionRiskClass;
  proposed_change_json: string;
  metadata_json: string;
  status: SelfEvolutionProposalStatus;
  proposed_by: string | null;
  created_at: string;
  updated_at: string;
};

const TARGETS = new Set<SelfEvolutionTarget>([
  "prompt",
  "memory_policy",
  "tool",
  "role",
  "configuration",
]);

const RISK_CLASSES = new Set<SelfEvolutionRiskClass>([
  "low",
  "medium",
  "high",
  "critical",
]);

export class SelfEvolutionProposalStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  create(input: CreateSelfEvolutionProposalInput): SelfEvolutionProposalRecord {
    const proposal = validateCreateInput(input);
    const now = new Date().toISOString();
    const id = createId("sep");
    this.database.run(
      `
        INSERT INTO self_evolution_proposals (
          id, target, title, rationale, risk_class, proposed_change_json,
          metadata_json, status, proposed_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      id,
      proposal.target,
      proposal.title,
      proposal.rationale,
      proposal.riskClass,
      encodeJson(proposal.proposedChange),
      encodeJson(proposal.metadata ?? {}),
      "proposed",
      proposal.proposedBy ?? null,
      now,
      now
    );
    return this.getRequired(id);
  }

  get(id: string): SelfEvolutionProposalRecord | null {
    const row = this.database.get<ProposalRow>(
      `
        SELECT
          id, target, title, rationale, risk_class, proposed_change_json,
          metadata_json, status, proposed_by, created_at, updated_at
        FROM self_evolution_proposals
        WHERE id = ?
      `,
      id
    );
    return row ? toProposalRecord(row) : null;
  }

  list(limit = 50): SelfEvolutionProposalRecord[] {
    return this.database
      .all<ProposalRow>(
        `
          SELECT
            id, target, title, rationale, risk_class, proposed_change_json,
            metadata_json, status, proposed_by, created_at, updated_at
          FROM self_evolution_proposals
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
        Math.max(1, Math.min(limit, 200))
      )
      .map(toProposalRecord);
  }

  summary(): {
    proposed: number;
    highRisk: number;
    criticalRisk: number;
    recent: SelfEvolutionProposalRecord[];
  } {
    const rows = this.database.all<{
      risk_class: SelfEvolutionRiskClass;
      count: number;
    }>(
      `
        SELECT risk_class, COUNT(*) AS count
        FROM self_evolution_proposals
        WHERE status = 'proposed'
        GROUP BY risk_class
      `
    );
    const counts = new Map(rows.map((row) => [row.risk_class, row.count]));
    return {
      proposed: rows.reduce((sum, row) => sum + row.count, 0),
      highRisk: counts.get("high") ?? 0,
      criticalRisk: counts.get("critical") ?? 0,
      recent: this.list(5),
    };
  }

  private getRequired(id: string): SelfEvolutionProposalRecord {
    const proposal = this.get(id);
    if (!proposal) {
      throw new Error(`Failed to create self-evolution proposal: ${id}`);
    }
    return proposal;
  }
}

export function validateCreateInput(
  input: CreateSelfEvolutionProposalInput
): CreateSelfEvolutionProposalInput {
  if (!TARGETS.has(input.target)) {
    throw new Error(
      "target must be prompt, memory_policy, tool, role, or configuration"
    );
  }
  if (!RISK_CLASSES.has(input.riskClass)) {
    throw new Error("riskClass must be low, medium, high, or critical");
  }
  const title = requireText(input.title, "title");
  const rationale = requireText(input.rationale, "rationale");
  const proposedChange = toJsonValue(input.proposedChange);
  if (!isJsonObject(proposedChange)) {
    throw new Error("proposedChange must be a JSON object");
  }
  rejectDirectMutation(proposedChange);
  return {
    target: input.target,
    title,
    rationale,
    riskClass: input.riskClass,
    proposedChange,
    metadata: input.metadata === undefined ? {} : toJsonValue(input.metadata),
    proposedBy: input.proposedBy
      ? requireText(input.proposedBy, "proposedBy")
      : undefined,
  };
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function rejectDirectMutation(proposedChange: {
  [key: string]: JsonValue;
}): void {
  const mutationMode = proposedChange.mutationMode;
  if (mutationMode === "direct" || mutationMode === "apply_now") {
    throw new Error("proposedChange cannot request direct mutation");
  }
  const apply = proposedChange.apply ?? proposedChange.applyNow;
  if (apply === true) {
    throw new Error("proposedChange cannot request immediate apply");
  }
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toProposalRecord(row: ProposalRow): SelfEvolutionProposalRecord {
  return {
    id: row.id,
    target: row.target,
    title: row.title,
    rationale: row.rationale,
    riskClass: row.risk_class,
    proposedChange: decodeJson(row.proposed_change_json, {}),
    metadata: decodeJson(row.metadata_json, {}),
    status: row.status,
    proposedBy: row.proposed_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
