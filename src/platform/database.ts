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

      CREATE TABLE IF NOT EXISTS chat_attachment_text_index (
        attachment_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        content_type TEXT NOT NULL,
        indexed_text TEXT,
        indexed_bytes INTEGER NOT NULL DEFAULT 0,
        skipped_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (attachment_id) REFERENCES chat_attachments(id),
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

      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        parent_assignment_id TEXT,
        objective TEXT NOT NULL,
        title TEXT,
        lifecycle_state TEXT NOT NULL,
        autonomy_level TEXT NOT NULL,
        source_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        wakeup_count INTEGER NOT NULL DEFAULT 0,
        consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        terminal_reason TEXT,
        FOREIGN KEY (parent_assignment_id) REFERENCES assignments(id)
      );

      CREATE TABLE IF NOT EXISTS assignment_events (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        type TEXT NOT NULL,
        importance TEXT NOT NULL,
        compactable INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (assignment_id) REFERENCES assignments(id)
      );

      CREATE TABLE IF NOT EXISTS assignment_run_links (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        step_id TEXT,
        action TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (assignment_id) REFERENCES assignments(id),
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );

      CREATE TABLE IF NOT EXISTS assignment_mutations (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        run_id TEXT,
        target TEXT NOT NULL,
        mutation_type TEXT NOT NULL,
        autonomy_level TEXT NOT NULL,
        status TEXT NOT NULL,
        risk_class TEXT NOT NULL,
        authorizing_policy_json TEXT NOT NULL,
        rationale TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        rollback_json TEXT NOT NULL,
        affected_resources_json TEXT NOT NULL,
        verification_json TEXT NOT NULL,
        operator_notification_json TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        applied_at TEXT,
        failed_at TEXT,
        rolled_back_at TEXT,
        notified_at TEXT,
        FOREIGN KEY (assignment_id) REFERENCES assignments(id)
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

      CREATE TABLE IF NOT EXISTS memory_lifecycle_links (
        id TEXT PRIMARY KEY,
        source_memory_id TEXT NOT NULL,
        target_memory_id TEXT NOT NULL,
        relationship TEXT NOT NULL,
        reason TEXT,
        source_session_id TEXT,
        source_run_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (source_memory_id) REFERENCES memory_entries(id),
        FOREIGN KEY (target_memory_id) REFERENCES memory_entries(id)
      );

      CREATE TABLE IF NOT EXISTS memory_reinforcement_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        signal TEXT NOT NULL,
        weight REAL NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memory_entries(id)
      );

      CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        summarized_count INTEGER NOT NULL DEFAULT 0,
        promoted_count INTEGER NOT NULL DEFAULT 0,
        pruned_count INTEGER NOT NULL DEFAULT 0,
        summary_memory_ids_json TEXT NOT NULL,
        promoted_memory_ids_json TEXT NOT NULL,
        pruned_memory_ids_json TEXT NOT NULL,
        failure_reason TEXT,
        created_at TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS self_evolution_proposals (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        risk_class TEXT NOT NULL,
        proposed_change_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        status TEXT NOT NULL,
        proposed_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS self_evolution_mutations (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        target TEXT NOT NULL,
        mutation_type TEXT NOT NULL,
        status TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        rollback_json TEXT NOT NULL,
        actor TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES self_evolution_proposals(id)
      );

      CREATE TABLE IF NOT EXISTS tool_bundle_imports (
        id TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        status TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL DEFAULT 'previewed',
        diagnostics_json TEXT NOT NULL,
        imported_by TEXT NOT NULL,
        approved_by TEXT,
        approved_at TEXT,
        enabled_by TEXT,
        enabled_at TEXT,
        disabled_by TEXT,
        disabled_at TEXT,
        uninstalled_by TEXT,
        uninstalled_at TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_bundle_lifecycle_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        import_id TEXT NOT NULL,
        bundle_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (import_id) REFERENCES tool_bundle_imports(id)
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

      CREATE TABLE IF NOT EXISTS inbound_channel_progress (
        id TEXT PRIMARY KEY,
        inbound_event_id TEXT NOT NULL,
        state TEXT NOT NULL,
        message_ts TEXT,
        status_reaction TEXT,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (inbound_event_id) REFERENCES inbound_channel_events(id)
      );

      CREATE TABLE IF NOT EXISTS inbound_channel_feedback (
        id TEXT PRIMARY KEY,
        inbound_event_id TEXT,
        channel_id TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        rating TEXT NOT NULL,
        source TEXT NOT NULL,
        user_id TEXT,
        slack_channel TEXT,
        message_ts TEXT,
        thread_ts TEXT,
        run_id TEXT,
        raw_payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(channel_id, provider_event_id),
        FOREIGN KEY (inbound_event_id) REFERENCES inbound_channel_events(id)
      );

      CREATE TABLE IF NOT EXISTS operator_settings (
        id TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prompt_runtime_guidance (
        id TEXT PRIMARY KEY,
        guidance_text TEXT NOT NULL,
        updated_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prompt_managed_fragments (
        id TEXT PRIMARY KEY,
        fragment_text TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_policy_settings (
        id TEXT PRIMARY KEY,
        memory_top_k INTEGER NOT NULL,
        memory_per_category_limit INTEGER NOT NULL,
        memory_summary_limit INTEGER NOT NULL,
        memory_summary_trigger_count INTEGER NOT NULL,
        memory_summary_cluster_size INTEGER NOT NULL,
        semantic_prune_limit INTEGER NOT NULL,
        procedural_prune_limit INTEGER NOT NULL,
        episodic_prune_limit INTEGER NOT NULL,
        updated_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_config_limits (
        id TEXT PRIMARY KEY,
        default_run_timeout_ms INTEGER,
        default_max_tool_calls INTEGER,
        openai_request_timeout_ms INTEGER,
        email_poll_interval_ms INTEGER,
        email_poll_batch_size INTEGER,
        email_max_message_bytes INTEGER,
        updated_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS role_policy_overrides (
        id TEXT PRIMARY KEY,
        overrides_json TEXT NOT NULL,
        updated_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_file_drafts (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        run_id TEXT,
        path TEXT NOT NULL,
        content_type TEXT NOT NULL,
        content TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        status TEXT NOT NULL,
        applied_mutation_id TEXT,
        applied_at TEXT,
        applied_sha256 TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        rolled_back_at TEXT,
        FOREIGN KEY (assignment_id) REFERENCES assignments(id)
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
      CREATE INDEX IF NOT EXISTS idx_chat_attachment_text_index_session_id ON chat_attachment_text_index(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_attachment_text_index_run_id ON chat_attachment_text_index(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_artifacts_session_id ON chat_artifacts(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_status_scheduled_at ON jobs(status, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_assignments_lifecycle ON assignments(lifecycle_state, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assignments_autonomy ON assignments(autonomy_level, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assignments_parent ON assignments(parent_assignment_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assignment_events_assignment ON assignment_events(assignment_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assignment_events_expires_at ON assignment_events(expires_at);
      CREATE INDEX IF NOT EXISTS idx_assignment_run_links_assignment ON assignment_run_links(assignment_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assignment_run_links_run ON assignment_run_links(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assignment_mutations_assignment ON assignment_mutations(assignment_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assignment_mutations_run ON assignment_mutations(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assignment_mutations_target ON assignment_mutations(target, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assignment_mutations_status ON assignment_mutations(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assignment_mutations_created ON assignment_mutations(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_category_created_at ON memory_entries(category, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_links_target ON memory_lifecycle_links(target_memory_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_links_source ON memory_lifecycle_links(source_memory_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_reinforcement_events_memory ON memory_reinforcement_events(memory_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_maintenance_runs_status_scheduled_at ON memory_maintenance_runs(status, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_dynamic_tools_updated_at ON dynamic_tools(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_self_evolution_proposals_status ON self_evolution_proposals(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_self_evolution_proposals_target ON self_evolution_proposals(target, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_self_evolution_mutations_proposal ON self_evolution_mutations(proposal_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_bundle_imports_bundle ON tool_bundle_imports(bundle_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_bundle_imports_status ON tool_bundle_imports(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_bundle_imports_lifecycle ON tool_bundle_imports(lifecycle_state, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_bundle_lifecycle_audit_import ON tool_bundle_lifecycle_audit(import_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_channels_updated_at ON channels(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_governance_audit_tool_id ON tool_governance_audit(tool_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_channel_delivery_logs_channel_id ON channel_delivery_logs(channel_id, delivered_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inbound_channel_events_channel_id ON inbound_channel_events(channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inbound_channel_events_status ON inbound_channel_events(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inbound_channel_progress_event ON inbound_channel_progress(inbound_event_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inbound_channel_feedback_event ON inbound_channel_feedback(inbound_event_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_inbound_channel_feedback_channel ON inbound_channel_feedback(channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_operator_settings_updated_at ON operator_settings(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_runtime_guidance_updated_at ON prompt_runtime_guidance(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompt_managed_fragments_active ON prompt_managed_fragments(active, id);
      CREATE INDEX IF NOT EXISTS idx_memory_policy_settings_updated_at ON memory_policy_settings(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_config_limits_updated_at ON runtime_config_limits(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_role_policy_overrides_updated_at ON role_policy_overrides(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_project_file_drafts_assignment ON project_file_drafts(assignment_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_project_file_drafts_path ON project_file_drafts(path, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_project_file_drafts_status ON project_file_drafts(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_audit_logs_created_at ON request_audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_created_at ON mcp_audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mcp_audit_logs_method ON mcp_audit_logs(method, created_at DESC);
    `);

    ensureColumn(this.db, "memory_entries", "embedding_json", "TEXT");
    ensureColumn(this.db, "memory_entries", "embedding_model", "TEXT");
    ensureColumn(
      this.db,
      "memory_entries",
      "source_type",
      "TEXT NOT NULL DEFAULT 'raw_turn'"
    );
    ensureColumn(
      this.db,
      "memory_entries",
      "importance",
      "REAL NOT NULL DEFAULT 0.5"
    );
    ensureColumn(this.db, "memory_entries", "last_accessed_at", "TEXT");
    ensureColumn(
      this.db,
      "memory_entries",
      "access_count",
      "INTEGER NOT NULL DEFAULT 0"
    );
    ensureColumn(
      this.db,
      "memory_entries",
      "is_summary",
      "INTEGER NOT NULL DEFAULT 0"
    );
    ensureColumn(
      this.db,
      "memory_entries",
      "is_fact",
      "INTEGER NOT NULL DEFAULT 0"
    );
    ensureColumn(this.db, "memory_entries", "parent_summary_id", "TEXT");
    ensureColumn(this.db, "memory_entries", "source_session_id", "TEXT");
    ensureColumn(this.db, "memory_entries", "source_run_id", "TEXT");
    ensureColumn(this.db, "memory_entries", "vector_backend", "TEXT");
    ensureColumn(this.db, "memory_entries", "vector_synced_at", "TEXT");
    ensureColumn(this.db, "memory_entries", "vector_sync_error", "TEXT");
    ensureColumn(this.db, "memory_entries", "vector_point_id", "TEXT");
    ensureColumn(
      this.db,
      "memory_entries",
      "lifecycle_state",
      "TEXT NOT NULL DEFAULT 'active'"
    );
    ensureColumn(this.db, "memory_entries", "superseded_by_memory_id", "TEXT");
    ensureColumn(
      this.db,
      "memory_entries",
      "contradicted_by_memory_id",
      "TEXT"
    );
    ensureColumn(
      this.db,
      "memory_entries",
      "reinforcement_score",
      "REAL NOT NULL DEFAULT 0"
    );
    ensureColumn(
      this.db,
      "memory_entries",
      "decay_score",
      "REAL NOT NULL DEFAULT 0"
    );
    ensureColumn(this.db, "sessions", "title", "TEXT");
    ensureColumn(this.db, "sessions", "title_source", "TEXT");
    ensureColumn(this.db, "chat_attachments", "storage_path", "TEXT");
    ensureColumn(this.db, "chat_attachments", "sha256", "TEXT");
    ensureColumn(
      this.db,
      "dynamic_tools",
      "approval_state",
      "TEXT NOT NULL DEFAULT 'pending'"
    );
    ensureColumn(this.db, "self_evolution_proposals", "reviewed_by", "TEXT");
    ensureColumn(this.db, "self_evolution_proposals", "reviewed_at", "TEXT");
    ensureColumn(this.db, "self_evolution_proposals", "review_notes", "TEXT");
    ensureColumn(this.db, "self_evolution_proposals", "applied_by", "TEXT");
    ensureColumn(this.db, "self_evolution_proposals", "applied_at", "TEXT");
    ensureColumn(this.db, "self_evolution_proposals", "rolled_back_by", "TEXT");
    ensureColumn(this.db, "self_evolution_proposals", "rolled_back_at", "TEXT");
    ensureColumn(this.db, "self_evolution_proposals", "apply_error", "TEXT");
    ensureColumn(this.db, "dynamic_tools", "approved_by", "TEXT");
    ensureColumn(this.db, "dynamic_tools", "approved_at", "TEXT");
    ensureColumn(this.db, "dynamic_tools", "governance_notes", "TEXT");
    ensureColumn(
      this.db,
      "tool_bundle_imports",
      "lifecycle_state",
      "TEXT NOT NULL DEFAULT 'previewed'"
    );
    ensureColumn(this.db, "tool_bundle_imports", "approved_by", "TEXT");
    ensureColumn(this.db, "tool_bundle_imports", "approved_at", "TEXT");
    ensureColumn(this.db, "tool_bundle_imports", "enabled_by", "TEXT");
    ensureColumn(this.db, "tool_bundle_imports", "enabled_at", "TEXT");
    ensureColumn(this.db, "tool_bundle_imports", "disabled_by", "TEXT");
    ensureColumn(this.db, "tool_bundle_imports", "disabled_at", "TEXT");
    ensureColumn(this.db, "tool_bundle_imports", "uninstalled_by", "TEXT");
    ensureColumn(this.db, "tool_bundle_imports", "uninstalled_at", "TEXT");
    ensureColumn(this.db, "tool_bundle_imports", "failure_reason", "TEXT");
    ensureColumn(
      this.db,
      "channel_delivery_logs",
      "attempt_count",
      "INTEGER NOT NULL DEFAULT 1"
    );
    ensureColumn(this.db, "inbound_channel_events", "progress_state", "TEXT");
    ensureColumn(
      this.db,
      "inbound_channel_events",
      "progress_message_ts",
      "TEXT"
    );
    ensureColumn(this.db, "inbound_channel_events", "status_reaction", "TEXT");
    ensureColumn(
      this.db,
      "inbound_channel_events",
      "slack_response_message_ts",
      "TEXT"
    );
    ensureColumn(this.db, "project_file_drafts", "applied_mutation_id", "TEXT");
    ensureColumn(this.db, "project_file_drafts", "applied_at", "TEXT");
    ensureColumn(this.db, "project_file_drafts", "applied_sha256", "TEXT");
    ensureRuntimeConfigLimitsOverlaySchema(this.db);

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

function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureRuntimeConfigLimitsOverlaySchema(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info(runtime_config_limits)")
    .all() as Array<{ name: string; notnull: number }>;
  const runtimeLimitColumns = new Set([
    "default_run_timeout_ms",
    "default_max_tool_calls",
    "openai_request_timeout_ms",
    "email_poll_interval_ms",
    "email_poll_batch_size",
    "email_max_message_bytes",
  ]);
  const needsNullableMigration = columns.some(
    (column) => runtimeLimitColumns.has(column.name) && column.notnull === 1
  );
  if (!needsNullableMigration) {
    return;
  }

  db.exec(`
    ALTER TABLE runtime_config_limits RENAME TO runtime_config_limits_legacy;

    CREATE TABLE runtime_config_limits (
      id TEXT PRIMARY KEY,
      default_run_timeout_ms INTEGER,
      default_max_tool_calls INTEGER,
      openai_request_timeout_ms INTEGER,
      email_poll_interval_ms INTEGER,
      email_poll_batch_size INTEGER,
      email_max_message_bytes INTEGER,
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    DROP TABLE runtime_config_limits_legacy;

    CREATE INDEX IF NOT EXISTS idx_runtime_config_limits_updated_at
      ON runtime_config_limits(updated_at DESC);
  `);
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function decodeJson<T>(
  value: string | null | undefined,
  fallback: T
): T {
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
