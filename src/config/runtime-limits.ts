import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../platform/database.ts";

const ROW_ID = "runtime";
const LEGACY_ROLLBACK_MARKER = "legacy_runtime_config_limits_rollback";

const RUNTIME_CONFIG_LIMIT_FIELDS = [
  "defaultRunTimeoutMs",
  "defaultMaxToolCalls",
  "openAiRequestTimeoutMs",
  "emailPollIntervalMs",
  "emailPollBatchSize",
  "emailMaxMessageBytes",
] as const;

type RuntimeConfigLimitField = (typeof RUNTIME_CONFIG_LIMIT_FIELDS)[number];

export type RuntimeConfigLimitValues = {
  defaultRunTimeoutMs: number;
  defaultMaxToolCalls: number;
  openAiRequestTimeoutMs: number;
  emailPollIntervalMs: number;
  emailPollBatchSize: number;
  emailMaxMessageBytes: number;
};

export type RuntimeConfigLimitsPatch = Partial<RuntimeConfigLimitValues>;

export type RuntimeConfigLimitsRecord = RuntimeConfigLimitValues & {
  id: "runtime";
  overlay: RuntimeConfigLimitsPatch;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeConfigLimitsSnapshot = {
  hasOverlay: boolean;
  legacy?: boolean;
  overlay: RuntimeConfigLimitsPatch;
  values: RuntimeConfigLimitValues;
};

type RuntimeConfigLimitsRow = {
  id: string;
  default_run_timeout_ms: number | null;
  default_max_tool_calls: number | null;
  openai_request_timeout_ms: number | null;
  email_poll_interval_ms: number | null;
  email_poll_batch_size: number | null;
  email_max_message_bytes: number | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

const BOUNDS: Record<RuntimeConfigLimitField, { min: number; max: number }> = {
  defaultRunTimeoutMs: { min: 1_000, max: 300_000 },
  defaultMaxToolCalls: { min: 1, max: 50 },
  openAiRequestTimeoutMs: { min: 1_000, max: 300_000 },
  emailPollIntervalMs: { min: 1_000, max: 3_600_000 },
  emailPollBatchSize: { min: 1, max: 100 },
  emailMaxMessageBytes: { min: 1_024, max: 10_485_760 },
};

export function defaultRuntimeConfigLimits(
  config: AppConfig
): RuntimeConfigLimitValues {
  return {
    defaultRunTimeoutMs: config.defaultRunTimeoutMs,
    defaultMaxToolCalls: config.defaultMaxToolCalls,
    openAiRequestTimeoutMs: config.openAiRequestTimeoutMs,
    emailPollIntervalMs: config.emailPollIntervalMs,
    emailPollBatchSize: config.emailPollBatchSize,
    emailMaxMessageBytes: config.emailMaxMessageBytes,
  };
}

export function runtimeConfigLimitValues(
  limits: RuntimeConfigLimitsRecord | RuntimeConfigLimitValues
): RuntimeConfigLimitValues {
  return {
    defaultRunTimeoutMs: limits.defaultRunTimeoutMs,
    defaultMaxToolCalls: limits.defaultMaxToolCalls,
    openAiRequestTimeoutMs: limits.openAiRequestTimeoutMs,
    emailPollIntervalMs: limits.emailPollIntervalMs,
    emailPollBatchSize: limits.emailPollBatchSize,
    emailMaxMessageBytes: limits.emailMaxMessageBytes,
  };
}

export function normalizeRuntimeConfigLimitsPatch(
  input: unknown
): RuntimeConfigLimitsPatch {
  if (!isPlainRecord(input)) {
    throw new Error("runtimeLimits must be an object");
  }
  const patch: RuntimeConfigLimitsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isRuntimeConfigLimitField(key)) {
      throw new Error(`runtimeLimits.${key} is not supported`);
    }
    patch[key] = normalizeIntegerField(key, value);
  }
  return patch;
}

export function normalizeRuntimeConfigLimitsSnapshot(
  input: unknown
): RuntimeConfigLimitsSnapshot {
  if (!isPlainRecord(input)) {
    throw new Error("runtimeLimitsOverlay must be an object");
  }
  if (typeof input.hasOverlay !== "boolean") {
    throw new Error("runtimeLimitsOverlay.hasOverlay must be a boolean");
  }
  const legacy = input.legacy === true;
  const overlay = legacy
    ? normalizePositiveRuntimeConfigLimitValues(input.overlay)
    : normalizeRuntimeConfigLimitsPatch(input.overlay);
  const values = normalizePositiveRuntimeConfigLimitValues(input.values);
  if (!input.hasOverlay && Object.keys(overlay).length > 0) {
    throw new Error(
      "runtimeLimitsOverlay.overlay must be empty without overlay"
    );
  }
  return {
    hasOverlay: input.hasOverlay,
    legacy,
    overlay,
    values,
  };
}

export class RuntimeConfigLimitsStore {
  private readonly database: AppDatabase;
  private readonly config: AppConfig;
  private readonly defaults: RuntimeConfigLimitValues;

  constructor(database: AppDatabase, config: AppConfig) {
    this.database = database;
    this.config = config;
    this.defaults = defaultRuntimeConfigLimits(config);
    this.applyToConfig(runtimeConfigLimitValues(this.get()));
  }

  get(): RuntimeConfigLimitsRecord {
    const row = this.database.get<RuntimeConfigLimitsRow>(
      "SELECT * FROM runtime_config_limits WHERE id = ?",
      ROW_ID
    );
    if (!row) {
      const now = new Date().toISOString();
      return {
        id: "runtime",
        overlay: {},
        ...this.defaults,
        createdAt: now,
        updatedAt: now,
      };
    }
    const record = this.toRecord(row);
    this.applyToConfig(runtimeConfigLimitValues(record));
    return record;
  }

  update(
    patch: RuntimeConfigLimitsPatch,
    actor?: string
  ): RuntimeConfigLimitsRecord {
    const current = this.get();
    const normalizedPatch = normalizeRuntimeConfigLimitsPatch(patch);
    const nextOverlay = {
      ...strictRuntimeConfigLimitsOverlay(current.overlay),
      ...normalizedPatch,
    };
    const now = new Date().toISOString();
    this.writeOverlay(nextOverlay, actor, current.createdAt, now);
    return this.get();
  }

  snapshot(): RuntimeConfigLimitsSnapshot {
    const current = this.get();
    return {
      hasOverlay: Object.keys(current.overlay).length > 0,
      legacy: current.updatedBy?.startsWith(LEGACY_ROLLBACK_MARKER),
      overlay: current.overlay,
      values: runtimeConfigLimitValues(current),
    };
  }

  restoreSnapshot(
    snapshot: RuntimeConfigLimitsSnapshot,
    actor?: string
  ): RuntimeConfigLimitsRecord {
    const normalizedSnapshot = normalizeRuntimeConfigLimitsSnapshot(snapshot);
    if (!normalizedSnapshot.hasOverlay) {
      this.deleteOverlay();
      return this.get();
    }
    if (normalizedSnapshot.legacy) {
      this.writeLegacyValues(
        normalizedSnapshot.values,
        actor,
        this.get().createdAt,
        new Date().toISOString()
      );
      return this.get();
    }
    const current = this.get();
    const now = new Date().toISOString();
    this.writeOverlay(
      normalizedSnapshot.overlay,
      actor,
      current.createdAt,
      now
    );
    return this.get();
  }

  restoreLegacyValues(
    values: unknown,
    actor?: string
  ): RuntimeConfigLimitsRecord {
    const legacyValues = normalizePositiveRuntimeConfigLimitValues(values);
    if (sameLimitValues(legacyValues, this.defaults)) {
      this.deleteOverlay();
      return this.get();
    }
    const current = this.get();
    const now = new Date().toISOString();
    this.writeLegacyValues(legacyValues, actor, current.createdAt, now);
    return this.get();
  }

  private writeOverlay(
    overlay: RuntimeConfigLimitsPatch,
    actor: string | undefined,
    createdAt: string,
    updatedAt: string
  ): void {
    this.database.run(
      `
        INSERT INTO runtime_config_limits (
          id, default_run_timeout_ms, default_max_tool_calls,
          openai_request_timeout_ms, email_poll_interval_ms,
          email_poll_batch_size, email_max_message_bytes,
          updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          default_run_timeout_ms = excluded.default_run_timeout_ms,
          default_max_tool_calls = excluded.default_max_tool_calls,
          openai_request_timeout_ms = excluded.openai_request_timeout_ms,
          email_poll_interval_ms = excluded.email_poll_interval_ms,
          email_poll_batch_size = excluded.email_poll_batch_size,
          email_max_message_bytes = excluded.email_max_message_bytes,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `,
      ROW_ID,
      overlay.defaultRunTimeoutMs ?? null,
      overlay.defaultMaxToolCalls ?? null,
      overlay.openAiRequestTimeoutMs ?? null,
      overlay.emailPollIntervalMs ?? null,
      overlay.emailPollBatchSize ?? null,
      overlay.emailMaxMessageBytes ?? null,
      actor ?? null,
      createdAt,
      updatedAt
    );
    this.applyToConfig({ ...this.defaults, ...overlay });
  }

  private deleteOverlay(): void {
    this.database.run("DELETE FROM runtime_config_limits WHERE id = ?", ROW_ID);
    this.applyToConfig(this.defaults);
  }

  private writeLegacyValues(
    values: RuntimeConfigLimitValues,
    actor: string | undefined,
    createdAt: string,
    updatedAt: string
  ): void {
    this.database.run(
      `
        INSERT INTO runtime_config_limits (
          id, default_run_timeout_ms, default_max_tool_calls,
          openai_request_timeout_ms, email_poll_interval_ms,
          email_poll_batch_size, email_max_message_bytes,
          updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          default_run_timeout_ms = excluded.default_run_timeout_ms,
          default_max_tool_calls = excluded.default_max_tool_calls,
          openai_request_timeout_ms = excluded.openai_request_timeout_ms,
          email_poll_interval_ms = excluded.email_poll_interval_ms,
          email_poll_batch_size = excluded.email_poll_batch_size,
          email_max_message_bytes = excluded.email_max_message_bytes,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `,
      ROW_ID,
      values.defaultRunTimeoutMs,
      values.defaultMaxToolCalls,
      values.openAiRequestTimeoutMs,
      values.emailPollIntervalMs,
      values.emailPollBatchSize,
      values.emailMaxMessageBytes,
      `${LEGACY_ROLLBACK_MARKER}:${actor ?? "autonomous_mutation_rollback"}`,
      createdAt,
      updatedAt
    );
    this.applyToConfig(values);
  }

  private applyToConfig(limits: RuntimeConfigLimitValues): void {
    this.config.defaultRunTimeoutMs = limits.defaultRunTimeoutMs;
    this.config.defaultMaxToolCalls = limits.defaultMaxToolCalls;
    this.config.openAiRequestTimeoutMs = limits.openAiRequestTimeoutMs;
    this.config.emailPollIntervalMs = limits.emailPollIntervalMs;
    this.config.emailPollBatchSize = limits.emailPollBatchSize;
    this.config.emailMaxMessageBytes = limits.emailMaxMessageBytes;
  }

  private toRecord(row: RuntimeConfigLimitsRow): RuntimeConfigLimitsRecord {
    const overlay = overlayFromRow(row);
    const values = {
      ...this.defaults,
      ...overlay,
    };
    return {
      id: "runtime",
      overlay,
      ...values,
      updatedBy: row.updated_by ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function overlayFromRow(row: RuntimeConfigLimitsRow): RuntimeConfigLimitsPatch {
  const overlay: RuntimeConfigLimitsPatch = {};
  const normalize = row.updated_by?.startsWith(LEGACY_ROLLBACK_MARKER)
    ? normalizePositiveIntegerField
    : normalizeIntegerField;
  if (row.default_run_timeout_ms !== null) {
    overlay.defaultRunTimeoutMs = normalize(
      "defaultRunTimeoutMs",
      row.default_run_timeout_ms
    );
  }
  if (row.default_max_tool_calls !== null) {
    overlay.defaultMaxToolCalls = normalize(
      "defaultMaxToolCalls",
      row.default_max_tool_calls
    );
  }
  if (row.openai_request_timeout_ms !== null) {
    overlay.openAiRequestTimeoutMs = normalize(
      "openAiRequestTimeoutMs",
      row.openai_request_timeout_ms
    );
  }
  if (row.email_poll_interval_ms !== null) {
    overlay.emailPollIntervalMs = normalize(
      "emailPollIntervalMs",
      row.email_poll_interval_ms
    );
  }
  if (row.email_poll_batch_size !== null) {
    overlay.emailPollBatchSize = normalize(
      "emailPollBatchSize",
      row.email_poll_batch_size
    );
  }
  if (row.email_max_message_bytes !== null) {
    overlay.emailMaxMessageBytes = normalize(
      "emailMaxMessageBytes",
      row.email_max_message_bytes
    );
  }
  return overlay;
}

function normalizePositiveRuntimeConfigLimitValues(
  input: unknown
): RuntimeConfigLimitValues {
  if (!isPlainRecord(input)) {
    throw new Error("runtimeLimitsOverlay.values must be an object");
  }
  return {
    defaultRunTimeoutMs: normalizePositiveIntegerField(
      "defaultRunTimeoutMs",
      input.defaultRunTimeoutMs
    ),
    defaultMaxToolCalls: normalizePositiveIntegerField(
      "defaultMaxToolCalls",
      input.defaultMaxToolCalls
    ),
    openAiRequestTimeoutMs: normalizePositiveIntegerField(
      "openAiRequestTimeoutMs",
      input.openAiRequestTimeoutMs
    ),
    emailPollIntervalMs: normalizePositiveIntegerField(
      "emailPollIntervalMs",
      input.emailPollIntervalMs
    ),
    emailPollBatchSize: normalizePositiveIntegerField(
      "emailPollBatchSize",
      input.emailPollBatchSize
    ),
    emailMaxMessageBytes: normalizePositiveIntegerField(
      "emailMaxMessageBytes",
      input.emailMaxMessageBytes
    ),
  };
}

function normalizeIntegerField(
  field: RuntimeConfigLimitField,
  value: unknown
): number {
  const bounds = BOUNDS[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`runtimeLimits.${field} must be an integer`);
  }
  if (value < bounds.min) {
    throw new Error(
      `runtimeLimits.${field} must be greater than or equal to ${bounds.min}`
    );
  }
  if (value > bounds.max) {
    throw new Error(
      `runtimeLimits.${field} must be less than or equal to ${bounds.max}`
    );
  }
  return value;
}

function sameLimitValues(
  left: RuntimeConfigLimitValues,
  right: RuntimeConfigLimitValues
): boolean {
  return RUNTIME_CONFIG_LIMIT_FIELDS.every(
    (field) => left[field] === right[field]
  );
}

function strictRuntimeConfigLimitsOverlay(
  input: RuntimeConfigLimitsPatch
): RuntimeConfigLimitsPatch {
  const overlay: RuntimeConfigLimitsPatch = {};
  for (const field of RUNTIME_CONFIG_LIMIT_FIELDS) {
    const value = input[field];
    if (value === undefined) {
      continue;
    }
    try {
      overlay[field] = normalizeIntegerField(field, value);
    } catch {
      continue;
    }
  }
  return overlay;
}

function normalizePositiveIntegerField(
  field: RuntimeConfigLimitField,
  value: unknown
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`runtimeLimits.${field} must be an integer`);
  }
  if (value <= 0) {
    throw new Error(`runtimeLimits.${field} must be a positive integer`);
  }
  return value;
}

function isRuntimeConfigLimitField(
  value: string
): value is RuntimeConfigLimitField {
  return RUNTIME_CONFIG_LIMIT_FIELDS.includes(value as RuntimeConfigLimitField);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
