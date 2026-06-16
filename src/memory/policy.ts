import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../platform/database.ts";

const ROW_ID = "runtime";

const MEMORY_POLICY_FIELDS = [
  "memoryTopK",
  "memoryPerCategoryLimit",
  "memorySummaryLimit",
  "memorySummaryTriggerCount",
  "memorySummaryClusterSize",
  "semanticPruneLimit",
  "proceduralPruneLimit",
  "episodicPruneLimit",
] as const;

type MemoryPolicyField = (typeof MEMORY_POLICY_FIELDS)[number];

export type MemoryPolicyRecord = {
  id: "runtime";
  memoryTopK: number;
  memoryPerCategoryLimit: number;
  memorySummaryLimit: number;
  memorySummaryTriggerCount: number;
  memorySummaryClusterSize: number;
  semanticPruneLimit: number;
  proceduralPruneLimit: number;
  episodicPruneLimit: number;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoryPolicyValues = Pick<MemoryPolicyRecord, MemoryPolicyField>;

export type MemoryPolicyPatch = Partial<MemoryPolicyValues>;

type MemoryPolicyRow = {
  id: string;
  memory_top_k: number;
  memory_per_category_limit: number;
  memory_summary_limit: number;
  memory_summary_trigger_count: number;
  memory_summary_cluster_size: number;
  semantic_prune_limit: number;
  procedural_prune_limit: number;
  episodic_prune_limit: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

const BOUNDS: Record<MemoryPolicyField, { min: number; max: number }> = {
  memoryTopK: { min: 1, max: 50 },
  memoryPerCategoryLimit: { min: 1, max: 20 },
  memorySummaryLimit: { min: 0, max: 20 },
  memorySummaryTriggerCount: { min: 2, max: 50 },
  memorySummaryClusterSize: { min: 2, max: 50 },
  semanticPruneLimit: { min: 10, max: 500 },
  proceduralPruneLimit: { min: 10, max: 500 },
  episodicPruneLimit: { min: 10, max: 500 },
};

type NormalizationMode = "strict" | "clamp";

export function defaultMemoryPolicy(config: AppConfig): MemoryPolicyValues {
  return {
    memoryTopK: config.memoryTopK,
    memoryPerCategoryLimit: config.memoryPerCategoryLimit,
    memorySummaryLimit: config.memorySummaryLimit,
    memorySummaryTriggerCount: config.memorySummaryTriggerCount,
    memorySummaryClusterSize: config.memorySummaryClusterSize,
    semanticPruneLimit: 80,
    proceduralPruneLimit: 60,
    episodicPruneLimit: 120,
  };
}

export function memoryPolicyValues(
  policy: MemoryPolicyRecord | MemoryPolicyValues
): MemoryPolicyValues {
  return {
    memoryTopK: policy.memoryTopK,
    memoryPerCategoryLimit: policy.memoryPerCategoryLimit,
    memorySummaryLimit: policy.memorySummaryLimit,
    memorySummaryTriggerCount: policy.memorySummaryTriggerCount,
    memorySummaryClusterSize: policy.memorySummaryClusterSize,
    semanticPruneLimit: policy.semanticPruneLimit,
    proceduralPruneLimit: policy.proceduralPruneLimit,
    episodicPruneLimit: policy.episodicPruneLimit,
  };
}

export function normalizeMemoryPolicyPatch(input: unknown): MemoryPolicyPatch {
  if (!isPlainRecord(input)) {
    throw new Error("memoryPolicy must be an object");
  }
  const patch: MemoryPolicyPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isMemoryPolicyField(key)) {
      throw new Error(`memoryPolicy.${key} is not supported`);
    }
    patch[key] = normalizeIntegerField(key, value);
  }
  if (
    patch.memorySummaryClusterSize !== undefined &&
    patch.memorySummaryTriggerCount !== undefined &&
    patch.memorySummaryClusterSize > patch.memorySummaryTriggerCount
  ) {
    throw new Error(
      "memoryPolicy.memorySummaryClusterSize must be less than or equal to memorySummaryTriggerCount"
    );
  }
  return patch;
}

export class MemoryPolicyStore {
  private readonly database: AppDatabase;
  private readonly defaults: MemoryPolicyValues;

  constructor(database: AppDatabase, config: AppConfig) {
    this.database = database;
    this.defaults = defaultMemoryPolicy(config);
    this.seedDefault();
  }

  get(): MemoryPolicyRecord {
    const row = this.database.get<MemoryPolicyRow>(
      "SELECT * FROM memory_policy_settings WHERE id = ?",
      ROW_ID
    );
    if (!row) {
      this.seedDefault();
      return this.get();
    }
    const record = toRecord(row);
    const repaired = validateCompletePolicy(
      memoryPolicyValues(record),
      "clamp"
    );
    if (!samePolicyValues(memoryPolicyValues(record), repaired)) {
      this.writePolicy(
        repaired,
        "memory_policy_validation",
        record.createdAt,
        new Date().toISOString()
      );
      return this.get();
    }
    return record;
  }

  update(patch: MemoryPolicyPatch, actor?: string): MemoryPolicyRecord {
    const current = this.get();
    const normalizedPatch = normalizeMemoryPolicyPatch(patch);
    const next = validateCompletePolicy(
      {
        ...memoryPolicyValues(current),
        ...normalizedPatch,
      },
      "strict"
    );
    const now = new Date().toISOString();
    this.writePolicy(next, actor, current.createdAt, now);
    return this.get();
  }

  private seedDefault(): void {
    const now = new Date().toISOString();
    const next = validateCompletePolicy(this.defaults, "clamp");
    this.database.run(
      `
        INSERT INTO memory_policy_settings (
          id, memory_top_k, memory_per_category_limit, memory_summary_limit,
          memory_summary_trigger_count, memory_summary_cluster_size,
          semantic_prune_limit, procedural_prune_limit, episodic_prune_limit,
          updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `,
      ROW_ID,
      next.memoryTopK,
      next.memoryPerCategoryLimit,
      next.memorySummaryLimit,
      next.memorySummaryTriggerCount,
      next.memorySummaryClusterSize,
      next.semanticPruneLimit,
      next.proceduralPruneLimit,
      next.episodicPruneLimit,
      null,
      now,
      now
    );
  }

  private writePolicy(
    next: MemoryPolicyValues,
    actor: string | undefined,
    createdAt: string,
    updatedAt: string
  ): void {
    this.database.run(
      `
        INSERT INTO memory_policy_settings (
          id, memory_top_k, memory_per_category_limit, memory_summary_limit,
          memory_summary_trigger_count, memory_summary_cluster_size,
          semantic_prune_limit, procedural_prune_limit, episodic_prune_limit,
          updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          memory_top_k = excluded.memory_top_k,
          memory_per_category_limit = excluded.memory_per_category_limit,
          memory_summary_limit = excluded.memory_summary_limit,
          memory_summary_trigger_count = excluded.memory_summary_trigger_count,
          memory_summary_cluster_size = excluded.memory_summary_cluster_size,
          semantic_prune_limit = excluded.semantic_prune_limit,
          procedural_prune_limit = excluded.procedural_prune_limit,
          episodic_prune_limit = excluded.episodic_prune_limit,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `,
      ROW_ID,
      next.memoryTopK,
      next.memoryPerCategoryLimit,
      next.memorySummaryLimit,
      next.memorySummaryTriggerCount,
      next.memorySummaryClusterSize,
      next.semanticPruneLimit,
      next.proceduralPruneLimit,
      next.episodicPruneLimit,
      actor ?? null,
      createdAt,
      updatedAt
    );
  }
}

function validateCompletePolicy(
  input: MemoryPolicyValues,
  mode: NormalizationMode
): MemoryPolicyValues {
  const values: MemoryPolicyValues = {
    memoryTopK: normalizeIntegerField("memoryTopK", input.memoryTopK, mode),
    memoryPerCategoryLimit: normalizeIntegerField(
      "memoryPerCategoryLimit",
      input.memoryPerCategoryLimit,
      mode
    ),
    memorySummaryLimit: normalizeIntegerField(
      "memorySummaryLimit",
      input.memorySummaryLimit,
      mode
    ),
    memorySummaryTriggerCount: normalizeIntegerField(
      "memorySummaryTriggerCount",
      input.memorySummaryTriggerCount,
      mode
    ),
    memorySummaryClusterSize: normalizeIntegerField(
      "memorySummaryClusterSize",
      input.memorySummaryClusterSize,
      mode
    ),
    semanticPruneLimit: normalizeIntegerField(
      "semanticPruneLimit",
      input.semanticPruneLimit,
      mode
    ),
    proceduralPruneLimit: normalizeIntegerField(
      "proceduralPruneLimit",
      input.proceduralPruneLimit,
      mode
    ),
    episodicPruneLimit: normalizeIntegerField(
      "episodicPruneLimit",
      input.episodicPruneLimit,
      mode
    ),
  };
  if (values.memorySummaryClusterSize > values.memorySummaryTriggerCount) {
    if (mode === "clamp") {
      values.memorySummaryClusterSize = values.memorySummaryTriggerCount;
      return values;
    }
    throw new Error(
      "memoryPolicy.memorySummaryClusterSize must be less than or equal to memorySummaryTriggerCount"
    );
  }
  return values;
}

function normalizeIntegerField(
  field: MemoryPolicyField,
  value: unknown,
  mode: NormalizationMode = "strict"
): number {
  const bound = BOUNDS[field];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < bound.min ||
    value > bound.max
  ) {
    if (mode === "clamp") {
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.min(bound.max, Math.max(bound.min, Math.trunc(value)));
      }
      return bound.min;
    }
    throw new Error(
      `memoryPolicy.${field} must be an integer between ${bound.min} and ${bound.max}`
    );
  }
  return value;
}

function samePolicyValues(
  left: MemoryPolicyValues,
  right: MemoryPolicyValues
): boolean {
  return MEMORY_POLICY_FIELDS.every((field) => left[field] === right[field]);
}

function isMemoryPolicyField(key: string): key is MemoryPolicyField {
  return MEMORY_POLICY_FIELDS.includes(key as MemoryPolicyField);
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function toRecord(row: MemoryPolicyRow): MemoryPolicyRecord {
  return {
    id: "runtime",
    memoryTopK: row.memory_top_k,
    memoryPerCategoryLimit: row.memory_per_category_limit,
    memorySummaryLimit: row.memory_summary_limit,
    memorySummaryTriggerCount: row.memory_summary_trigger_count,
    memorySummaryClusterSize: row.memory_summary_cluster_size,
    semanticPruneLimit: row.semantic_prune_limit,
    proceduralPruneLimit: row.procedural_prune_limit,
    episodicPruneLimit: row.episodic_prune_limit,
    updatedBy: row.updated_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
