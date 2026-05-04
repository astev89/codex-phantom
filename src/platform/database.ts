import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "../shared/types.ts";

type SqliteValue = string | number | bigint | Uint8Array | null;

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = openDatabase(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  isReady(): boolean {
    return true;
  }

  close(): void {
    this.db.close();
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...values: SqliteValue[]): void {
    this.db.prepare(sql).run(...values);
  }

  get<T>(sql: string, ...values: SqliteValue[]): T | null {
    return (this.db.prepare(sql).get(...values) as T | undefined) ?? null;
  }

  all<T>(sql: string, ...values: SqliteValue[]): T[] {
    return this.db.prepare(sql).all(...values) as T[];
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        title TEXT,
        title_source TEXT,
        provider_session_id TEXT,
        previous_response_id TEXT,
        last_event_cursor TEXT,
        resumability_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        run_ids_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        parent_run_id TEXT,
        role TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        permission_policy_json TEXT NOT NULL,
        allowed_mcp_servers_json TEXT NOT NULL,
        allowed_tool_ids_json TEXT NOT NULL,
        child_run_ids_json TEXT NOT NULL,
        max_budget_usd REAL,
        timeout_ms INTEGER,
        summary TEXT,
        transcript_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        terminal_state_json TEXT
      );

      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS chat_attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        description TEXT,
        storage_path TEXT,
        sha256 TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS chat_artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        message TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        subagents_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        failure_reason TEXT,
        last_run_id TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_user_input TEXT,
        source_assistant_output TEXT,
        score REAL NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS dynamic_tools (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        input_schema_json TEXT,
        response_template TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        secret_env_var TEXT,
        webhook_path TEXT,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_governance_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT,
        notes TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_delivery_logs (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        error_message TEXT,
        delivered_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbound_channel_events (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_id TEXT,
        message TEXT NOT NULL,
        thread_id TEXT,
        response_target_json TEXT,
        raw_payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        run_id TEXT,
        output_text TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel_id, provider_event_id)
      );

      CREATE TABLE IF NOT EXISTS operator_settings (
        id TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS request_audit_logs (
        request_id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT,
        method TEXT NOT NULL,
        tool_name TEXT,
        outcome TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runs_parent_run_id ON runs(parent_run_id);
      CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_chat_attachments_session_id ON chat_attachments(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_artifacts_session_id ON chat_artifacts(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_status_scheduled_at ON jobs(status, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_category_created_at ON memory_entries(category, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dynamic_tools_updated_at ON dynamic_tools(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_channels_updated_at ON channels(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_governance_audit_tool_id ON tool_governance_audit(tool_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_channel_delivery_logs_channel_id ON channel_delivery_logs(channel_id, delivered_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inbound_channel_events_channel_id ON inbound_channel_events(channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inbound_channel_events_status ON inbound_channel_events(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_operator_settings_updated_at ON operator_settings(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_audit_logs_created_at ON request_audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_created_at ON mcp_audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_method ON mcp_audit_logs(method, created_at DESC);
    `);

    ensureColumn(this.db, "memory_entries", "embedding_json", "TEXT");
    ensureColumn(this.db, "memory_entries", "embedding_model", "TEXT");
    ensureColumn(this.db, "memory_entries", "source_type", "TEXT NOT NULL DEFAULT 'raw_turn'");
    ensureColumn(this.db, "memory_entries", "importance", "REAL NOT NULL DEFAULT 0.5");
    ensureColumn(this.db, "memory_entries", "last_accessed_at", "TEXT");
    ensureColumn(this.db, "memory_entries", "access_count", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.db, "memory_entries", "is_summary", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.db, "memory_entries", "is_fact", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.db, "memory_entries", "parent_summary_id", "TEXT");
    ensureColumn(this.db, "memory_entries", "source_session_id", "TEXT");
    ensureColumn(this.db, "memory_entries", "source_run_id", "TEXT");
    ensureColumn(this.db, "memory_entries", "vector_backend", "TEXT");
    ensureColumn(this.db, "memory_entries", "vector_synced_at", "TEXT");
    ensureColumn(this.db, "memory_entries", "vector_sync_error", "TEXT");
    ensureColumn(this.db, "memory_entries", "vector_point_id", "TEXT");
    ensureColumn(this.db, "sessions", "title", "TEXT");
    ensureColumn(this.db, "sessions", "title_source", "TEXT");
    ensureColumn(this.db, "chat_attachments", "storage_path", "TEXT");
    ensureColumn(this.db, "chat_attachments", "sha256", "TEXT");
    ensureColumn(this.db, "dynamic_tools", "approval_state", "TEXT NOT NULL DEFAULT 'pending'");
    ensureColumn(this.db, "dynamic_tools", "approved_by", "TEXT");
    ensureColumn(this.db, "dynamic_tools", "approved_at", "TEXT");
    ensureColumn(this.db, "dynamic_tools", "governance_notes", "TEXT");
    ensureColumn(this.db, "channel_delivery_logs", "attempt_count", "INTEGER NOT NULL DEFAULT 1");

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_entries_summary ON memory_entries(is_summary, category, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_embedding ON memory_entries(embedding_model, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_vector_sync ON memory_entries(vector_backend, vector_synced_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dynamic_tools_approval_state ON dynamic_tools(approval_state, updated_at DESC);
    `);
  }
}

function openDatabase(path: string): DatabaseSync {
  const normalized = path === ":memory:" ? path : path;
  if (normalized !== ":memory:") {
    mkdirSync(dirname(normalized), { recursive: true });
  }
  return new DatabaseSync(normalized);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function decodeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
