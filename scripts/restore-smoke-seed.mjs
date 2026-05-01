#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const databasePath = process.env.CODEX_PHANTOM_DATABASE_PATH ?? "/app/data/codex-phantom.sqlite";
const now = new Date("2026-04-28T12:00:00.000Z").toISOString();
const future = new Date("2099-01-01T00:00:00.000Z").toISOString();

mkdirSync(dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const json = (value) => JSON.stringify(value);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
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
    score REAL NOT NULL DEFAULT 0,
    source_type TEXT NOT NULL DEFAULT 'raw_turn',
    importance REAL NOT NULL DEFAULT 0.5,
    access_count INTEGER NOT NULL DEFAULT 0,
    is_summary INTEGER NOT NULL DEFAULT 0,
    is_fact INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS operator_settings (
    id TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dynamic_tools (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    input_schema_json TEXT,
    response_template TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    approval_state TEXT NOT NULL DEFAULT 'pending',
    approved_by TEXT,
    approved_at TEXT,
    governance_notes TEXT
  );

  CREATE TABLE IF NOT EXISTS tool_governance_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT,
    notes TEXT,
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
`);

db.exec("BEGIN");
try {
  db.prepare(`
    INSERT OR REPLACE INTO operator_settings (id, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run("default", json({
    dashboardRefreshSeconds: 11,
    chatDefaultConversationId: "restore-smoke",
    memoryTimelineLimit: 13
  }), now, now);

  db.prepare(`
    INSERT OR REPLACE INTO sessions (
      session_id, channel_id, conversation_id, provider_session_id, previous_response_id,
      last_event_cursor, resumability_json, created_at, updated_at, run_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "session_restore_smoke",
    "web",
    "restore-smoke",
    "provider_restore_smoke",
    "resp_restore_smoke",
    null,
    json({ supportsResume: true }),
    now,
    now,
    json(["run_restore_smoke"])
  );

  db.prepare(`
    INSERT OR REPLACE INTO runs (
      run_id, parent_run_id, role, objective, status, permission_policy_json,
      allowed_mcp_servers_json, allowed_tool_ids_json, child_run_ids_json, max_budget_usd,
      timeout_ms, summary, transcript_json, started_at, finished_at, terminal_state_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "run_restore_smoke",
    null,
    "coordinator",
    "restore smoke run",
    "completed",
    json({ mode: "read_only" }),
    json([]),
    json(["echo.summary"]),
    json([]),
    null,
    30000,
    "restore smoke summary",
    json([{ role: "user", content: "restore smoke" }, { role: "assistant", content: "restored" }]),
    now,
    now,
    json({ outputText: "restored" })
  );

  db.prepare(`
    INSERT OR REPLACE INTO jobs (
      id, name, message, scheduled_at, subagents_json, status, created_at,
      started_at, finished_at, attempt_count, max_attempts, failure_reason, last_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "job_restore_smoke",
    "restore-smoke-job",
    "restore smoke scheduled job",
    future,
    json([]),
    "scheduled",
    now,
    null,
    null,
    0,
    1,
    null,
    null
  );

  db.prepare(`
    INSERT OR REPLACE INTO memory_entries (
      id, category, content, created_at, source_user_input, source_assistant_output,
      score, source_type, importance, access_count, is_summary, is_fact
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "mem_restore_smoke",
    "procedural",
    "Restore smoke memory survived backup and restore.",
    now,
    "seed restore smoke",
    "restore smoke memory",
    0.9,
    "raw_turn",
    0.7,
    0,
    0,
    1
  );

  db.prepare(`
    INSERT OR REPLACE INTO dynamic_tools (
      id, description, scopes_json, input_schema_json, response_template,
      created_at, updated_at, approval_state, approved_by, approved_at, governance_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "restore.brief",
    "Restore smoke dynamic tool",
    json(["read"]),
    json({ type: "object", properties: { topic: { type: "string" } } }),
    "Restore brief for {{topic}}",
    now,
    now,
    "approved",
    "restore-smoke",
    now,
    "seeded for backup restore smoke"
  );

  db.prepare(`
    INSERT INTO tool_governance_audit (tool_id, action, actor, notes, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("restore.brief", "approved", "restore-smoke", "seeded restore smoke approval", now);

  db.prepare(`
    INSERT INTO mcp_audit_logs (request_id, method, tool_name, outcome, status_code, error_message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("req_restore_smoke", "tools/list", null, "success", 200, null, now);

  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}

console.log(`Seeded restore smoke data in ${databasePath}`);
