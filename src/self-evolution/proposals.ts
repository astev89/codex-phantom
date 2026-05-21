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

export type SelfEvolutionProposalStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "applied"
  | "failed"
  | "rolled_back";

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
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
  appliedBy?: string;
  appliedAt?: string;
  rolledBackBy?: string;
  rolledBackAt?: string;
  applyError?: string;
  createdAt: string;
  updatedAt: string;
};

export type SelfEvolutionMutationRecord = {
  id: string;
  proposalId: string;
  target: SelfEvolutionTarget;
  mutationType: string;
  status: "applied" | "failed" | "rolled_back";
  before: JsonValue;
  after: JsonValue;
  rollback: JsonValue;
  actor: string;
  errorMessage?: string;
  createdAt: string;
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
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  applied_by: string | null;
  applied_at: string | null;
  rolled_back_by: string | null;
  rolled_back_at: string | null;
  apply_error: string | null;
  created_at: string;
  updated_at: string;
};

type MutationRow = {
  id: string;
  proposal_id: string;
  target: SelfEvolutionTarget;
  mutation_type: string;
  status: "applied" | "failed" | "rolled_back";
  before_json: string;
  after_json: string;
  rollback_json: string;
  actor: string;
  error_message: string | null;
  created_at: string;
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
          metadata_json, status, proposed_by, reviewed_by, reviewed_at,
          review_notes, applied_by, applied_at, rolled_back_by,
          rolled_back_at, apply_error, created_at, updated_at
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
            metadata_json, status, proposed_by, reviewed_by, reviewed_at,
            review_notes, applied_by, applied_at, rolled_back_by,
            rolled_back_at, apply_error, created_at, updated_at
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
    approved: number;
    applied: number;
    failed: number;
    rolledBack: number;
    highRisk: number;
    criticalRisk: number;
    recent: SelfEvolutionProposalRecord[];
    recentMutations: SelfEvolutionMutationRecord[];
  } {
    const statusRows = this.database.all<{
      status: SelfEvolutionProposalStatus;
      count: number;
    }>(
      `
        SELECT status, COUNT(*) AS count
        FROM self_evolution_proposals
        GROUP BY status
      `
    );
    const riskRows = this.database.all<{
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
    const statusCounts = new Map(
      statusRows.map((row) => [row.status, row.count])
    );
    const riskCounts = new Map(
      riskRows.map((row) => [row.risk_class, row.count])
    );
    return {
      proposed: statusCounts.get("proposed") ?? 0,
      approved: statusCounts.get("approved") ?? 0,
      applied: statusCounts.get("applied") ?? 0,
      failed: statusCounts.get("failed") ?? 0,
      rolledBack: statusCounts.get("rolled_back") ?? 0,
      highRisk: riskCounts.get("high") ?? 0,
      criticalRisk: riskCounts.get("critical") ?? 0,
      recent: this.list(5),
      recentMutations: this.listMutations(undefined, 5),
    };
  }

  approve(
    id: string,
    input: { reviewedBy: string; notes?: string }
  ): SelfEvolutionProposalRecord {
    const proposal = this.getRequired(id);
    if (proposal.status !== "proposed") {
      throw new Error("Only proposed self-evolution proposals can be approved");
    }
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE self_evolution_proposals
        SET status = 'approved',
            reviewed_by = ?,
            reviewed_at = ?,
            review_notes = ?,
            apply_error = NULL,
            updated_at = ?
        WHERE id = ?
      `,
      requireText(input.reviewedBy, "reviewedBy"),
      now,
      input.notes ?? null,
      now,
      id
    );
    return this.getRequired(id);
  }

  reject(
    id: string,
    input: { reviewedBy: string; notes?: string }
  ): SelfEvolutionProposalRecord {
    const proposal = this.getRequired(id);
    if (proposal.status === "applied") {
      throw new Error("Applied self-evolution proposals cannot be rejected");
    }
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE self_evolution_proposals
        SET status = 'rejected',
            reviewed_by = ?,
            reviewed_at = ?,
            review_notes = ?,
            updated_at = ?
        WHERE id = ?
      `,
      requireText(input.reviewedBy, "reviewedBy"),
      now,
      input.notes ?? null,
      now,
      id
    );
    return this.getRequired(id);
  }

  recordApplySuccess(input: {
    proposalId: string;
    target: SelfEvolutionTarget;
    mutationType: string;
    before: JsonValue;
    after: JsonValue;
    rollback: JsonValue;
    actor: string;
  }): SelfEvolutionMutationRecord {
    const now = new Date().toISOString();
    const mutationId = createId("sem");
    this.database.transaction(() => {
      this.database.run(
        `
          INSERT INTO self_evolution_mutations (
            id, proposal_id, target, mutation_type, status, before_json,
            after_json, rollback_json, actor, error_message, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        mutationId,
        input.proposalId,
        input.target,
        input.mutationType,
        "applied",
        encodeJson(input.before),
        encodeJson(input.after),
        encodeJson(input.rollback),
        requireText(input.actor, "actor"),
        null,
        now
      );
      this.database.run(
        `
          UPDATE self_evolution_proposals
          SET status = 'applied',
              applied_by = ?,
              applied_at = ?,
              apply_error = NULL,
              updated_at = ?
          WHERE id = ?
        `,
        input.actor,
        now,
        now,
        input.proposalId
      );
    });
    return this.getMutationRequired(mutationId);
  }

  recordApplyFailure(input: {
    proposalId: string;
    target: SelfEvolutionTarget;
    mutationType: string;
    actor: string;
    errorMessage: string;
  }): SelfEvolutionMutationRecord {
    const now = new Date().toISOString();
    const mutationId = createId("sem");
    this.database.transaction(() => {
      this.database.run(
        `
          INSERT INTO self_evolution_mutations (
            id, proposal_id, target, mutation_type, status, before_json,
            after_json, rollback_json, actor, error_message, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        mutationId,
        input.proposalId,
        input.target,
        input.mutationType,
        "failed",
        encodeJson({}),
        encodeJson({}),
        encodeJson({}),
        requireText(input.actor, "actor"),
        input.errorMessage,
        now
      );
      this.database.run(
        `
          UPDATE self_evolution_proposals
          SET status = 'failed',
              apply_error = ?,
              updated_at = ?
          WHERE id = ?
        `,
        input.errorMessage,
        now,
        input.proposalId
      );
    });
    return this.getMutationRequired(mutationId);
  }

  recordRollback(input: {
    proposalId: string;
    mutationId: string;
    actor: string;
  }): SelfEvolutionProposalRecord {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const mutation = this.database.get<MutationRow>(
        `
          SELECT * FROM self_evolution_mutations
          WHERE id = ? AND proposal_id = ? AND status = 'applied'
        `,
        input.mutationId,
        input.proposalId
      );
      if (!mutation) {
        throw new Error("Expected an applied mutation owned by the proposal");
      }
      this.database.run(
        `
          UPDATE self_evolution_mutations
          SET status = 'rolled_back'
          WHERE id = ? AND proposal_id = ? AND status = 'applied'
        `,
        input.mutationId,
        input.proposalId
      );
      this.database.run(
        `
          UPDATE self_evolution_proposals
          SET status = 'rolled_back',
              rolled_back_by = ?,
              rolled_back_at = ?,
              updated_at = ?
          WHERE id = ?
        `,
        requireText(input.actor, "actor"),
        now,
        now,
        input.proposalId
      );
    });
    return this.getRequired(input.proposalId);
  }

  listMutations(
    proposalId?: string,
    limit = 50
  ): SelfEvolutionMutationRecord[] {
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    if (proposalId) {
      return this.database
        .all<MutationRow>(
          `
            SELECT
              id, proposal_id, target, mutation_type, status, before_json,
              after_json, rollback_json, actor, error_message, created_at
            FROM self_evolution_mutations
            WHERE proposal_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `,
          proposalId,
          boundedLimit
        )
        .map(toMutationRecord);
    }
    return this.database
      .all<MutationRow>(
        `
          SELECT
            id, proposal_id, target, mutation_type, status, before_json,
            after_json, rollback_json, actor, error_message, created_at
          FROM self_evolution_mutations
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
        boundedLimit
      )
      .map(toMutationRecord);
  }

  private getRequired(id: string): SelfEvolutionProposalRecord {
    const proposal = this.get(id);
    if (!proposal) {
      throw new Error(`Failed to create self-evolution proposal: ${id}`);
    }
    return proposal;
  }

  private getMutationRequired(id: string): SelfEvolutionMutationRecord {
    const mutation = this.database.get<MutationRow>(
      `
        SELECT
          id, proposal_id, target, mutation_type, status, before_json,
          after_json, rollback_json, actor, error_message, created_at
        FROM self_evolution_mutations
        WHERE id = ?
      `,
      id
    );
    if (!mutation) {
      throw new Error(`Failed to record self-evolution mutation: ${id}`);
    }
    return toMutationRecord(mutation);
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
    reviewedBy: row.reviewed_by ?? undefined,
    reviewedAt: row.reviewed_at ?? undefined,
    reviewNotes: row.review_notes ?? undefined,
    appliedBy: row.applied_by ?? undefined,
    appliedAt: row.applied_at ?? undefined,
    rolledBackBy: row.rolled_back_by ?? undefined,
    rolledBackAt: row.rolled_back_at ?? undefined,
    applyError: row.apply_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMutationRecord(row: MutationRow): SelfEvolutionMutationRecord {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    target: row.target,
    mutationType: row.mutation_type,
    status: row.status,
    before: decodeJson(row.before_json, {}),
    after: decodeJson(row.after_json, {}),
    rollback: decodeJson(row.rollback_json, {}),
    actor: row.actor,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
  };
}
