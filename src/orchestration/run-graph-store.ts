import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson, toJsonValue } from "../platform/database.ts";
import type { StoredRunEvent } from "../shared/types.ts";
import type { RunNode } from "./types.ts";

type RunRow = {
  run_id: string;
  parent_run_id: string | null;
  role: RunNode["role"];
  objective: string;
  status: RunNode["status"];
  permission_policy_json: string;
  allowed_mcp_servers_json: string;
  allowed_tool_ids_json: string;
  child_run_ids_json: string;
  max_budget_usd: number | null;
  timeout_ms: number | null;
  summary: string | null;
  transcript_json: string;
  started_at: string;
  finished_at: string | null;
  terminal_state_json: string | null;
};

type RunEventRow = {
  sequence: number;
  type: string;
  created_at: string;
  payload_json: string;
};

export class RunGraphStore {
  private readonly database: AppDatabase;

  constructor(database: AppDatabase) {
    this.database = database;
  }

  async list(): Promise<RunNode[]> {
    return this.database
      .all<RunRow>("SELECT * FROM runs ORDER BY started_at DESC")
      .map((row) => toRunNode(row));
  }

  async get(runId: string): Promise<RunNode | null> {
    const row = this.database.get<RunRow>("SELECT * FROM runs WHERE run_id = ?", runId);
    return row ? toRunNode(row) : null;
  }

  async listChildren(parentRunId: string): Promise<RunNode[]> {
    return this.database
      .all<RunRow>("SELECT * FROM runs WHERE parent_run_id = ? ORDER BY started_at ASC", parentRunId)
      .map((row) => toRunNode(row));
  }

  async appendChildRun(parentRunId: string, childRunId: string): Promise<void> {
    const parent = await this.get(parentRunId);
    if (!parent) {
      throw new Error(`run not found: ${parentRunId}`);
    }
    if (!parent.childRunIds.includes(childRunId)) {
      parent.childRunIds.push(childRunId);
    }
    await this.upsert(parent);
  }

  async upsert(node: RunNode): Promise<void> {
    this.database.run(
      `
        INSERT INTO runs (
          run_id, parent_run_id, role, objective, status, permission_policy_json,
          allowed_mcp_servers_json, allowed_tool_ids_json, child_run_ids_json, max_budget_usd,
          timeout_ms, summary, transcript_json, started_at, finished_at, terminal_state_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          parent_run_id = excluded.parent_run_id,
          role = excluded.role,
          objective = excluded.objective,
          status = excluded.status,
          permission_policy_json = excluded.permission_policy_json,
          allowed_mcp_servers_json = excluded.allowed_mcp_servers_json,
          allowed_tool_ids_json = excluded.allowed_tool_ids_json,
          child_run_ids_json = excluded.child_run_ids_json,
          max_budget_usd = excluded.max_budget_usd,
          timeout_ms = excluded.timeout_ms,
          summary = excluded.summary,
          transcript_json = excluded.transcript_json,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          terminal_state_json = excluded.terminal_state_json
      `,
      node.runId,
      node.parentRunId ?? null,
      node.role,
      node.objective,
      node.status,
      encodeJson(node.permissionPolicy),
      encodeJson(node.allowedMcpServers),
      encodeJson(node.allowedToolIds),
      encodeJson(node.childRunIds),
      node.maxBudgetUsd ?? null,
      node.timeoutMs ?? null,
      node.summary ?? null,
      encodeJson(node.transcript),
      node.startedAt,
      node.finishedAt ?? null,
      encodeJson(node.terminalState ?? null)
    );
  }

  async appendEvent(runId: string, type: string, payload: unknown): Promise<void> {
    const nextSequence =
      this.database.get<{ max_sequence: number | null }>(
        "SELECT MAX(sequence) AS max_sequence FROM run_events WHERE run_id = ?",
        runId
      )?.max_sequence ?? 0;
    this.database.run(
      `
        INSERT INTO run_events (run_id, sequence, type, created_at, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `,
      runId,
      nextSequence + 1,
      type,
      new Date().toISOString(),
      encodeJson(toJsonValue(payload))
    );
  }

  async listEvents(runId: string): Promise<StoredRunEvent[]> {
    return this.database
      .all<RunEventRow>(
        "SELECT sequence, type, created_at, payload_json FROM run_events WHERE run_id = ? ORDER BY sequence ASC",
        runId
      )
      .map((row) => ({
        sequence: row.sequence,
        type: row.type,
        createdAt: row.created_at,
        payload: decodeJson(row.payload_json, null)
      }));
  }
}

function toRunNode(row: RunRow): RunNode {
  return {
    runId: row.run_id,
    parentRunId: row.parent_run_id ?? undefined,
    role: row.role,
    objective: row.objective,
    status: row.status,
    permissionPolicy: decodeJson(row.permission_policy_json, {
      mode: "read_only",
      fileGlobs: [],
      allowedToolIds: [],
      allowedMcpServers: []
    }),
    allowedMcpServers: decodeJson(row.allowed_mcp_servers_json, []),
    allowedToolIds: decodeJson(row.allowed_tool_ids_json, []),
    childRunIds: decodeJson(row.child_run_ids_json, []),
    maxBudgetUsd: row.max_budget_usd ?? undefined,
    timeoutMs: row.timeout_ms ?? undefined,
    summary: row.summary ?? undefined,
    transcript: decodeJson(row.transcript_json, []),
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    terminalState: decodeJson(row.terminal_state_json, undefined)
  };
}
