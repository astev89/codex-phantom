import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson } from "../platform/database.ts";
import { createId } from "../shared/ids.ts";
import type { MemoryMaintenanceOutcome } from "./types.ts";
import type { MemoryStore } from "./store.ts";

const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type MemoryMaintenanceStatus =
  | "scheduled"
  | "running"
  | "completed"
  | "failed";

export type MemoryMaintenanceRun = MemoryMaintenanceOutcome & {
  id: string;
  status: MemoryMaintenanceStatus;
  scheduledAt: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  failureReason?: string;
};

type MemoryMaintenanceRow = {
  id: string;
  status: MemoryMaintenanceStatus;
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  summarized_count: number;
  promoted_count: number;
  pruned_count: number;
  summary_memory_ids_json: string;
  promoted_memory_ids_json: string;
  pruned_memory_ids_json: string;
  failure_reason: string | null;
  created_at: string;
};

export class MemoryMaintenanceService {
  private readonly database: AppDatabase;
  private readonly memory: MemoryStore;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    database: AppDatabase,
    memory: MemoryStore,
    intervalMs = DEFAULT_MAINTENANCE_INTERVAL_MS
  ) {
    this.database = database;
    this.memory = memory;
    this.intervalMs = Math.max(60_000, intervalMs);
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.recoverInterruptedRuns();
    this.ensureScheduledRun(new Date().toISOString());
    this.armNext();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async runNow(): Promise<MemoryMaintenanceRun> {
    const run = this.createScheduledRun(new Date().toISOString());
    return this.execute(run.id);
  }

  list(limit = 20): MemoryMaintenanceRun[] {
    const normalizedLimit = Math.max(1, Math.min(limit, 100));
    return this.database
      .all<MemoryMaintenanceRow>(
        "SELECT * FROM memory_maintenance_runs ORDER BY scheduled_at DESC LIMIT ?",
        normalizedLimit
      )
      .map(toMaintenanceRun);
  }

  private recoverInterruptedRuns(): void {
    const now = new Date().toISOString();
    this.database.run(
      `
        UPDATE memory_maintenance_runs
        SET status = 'failed',
            finished_at = ?,
            failure_reason = 'Memory maintenance was interrupted during shutdown'
        WHERE status = 'running'
      `,
      now
    );
  }

  private ensureScheduledRun(now: string): void {
    const existing = this.database.get<{ id: string }>(
      "SELECT id FROM memory_maintenance_runs WHERE status = 'scheduled' ORDER BY scheduled_at ASC LIMIT 1"
    );
    if (existing) {
      return;
    }
    this.createScheduledRun(
      new Date(Date.parse(now) + this.intervalMs).toISOString()
    );
  }

  private createScheduledRun(scheduledAt: string): MemoryMaintenanceRun {
    const now = new Date().toISOString();
    const run: MemoryMaintenanceRun = {
      id: createId("memmaint"),
      status: "scheduled",
      scheduledAt,
      createdAt: now,
      summarizedCount: 0,
      promotedCount: 0,
      prunedCount: 0,
      summaryMemoryIds: [],
      promotedMemoryIds: [],
      prunedMemoryIds: [],
    };
    this.database.run(
      `
        INSERT INTO memory_maintenance_runs (
          id, status, scheduled_at, started_at, finished_at, summarized_count,
          promoted_count, pruned_count, summary_memory_ids_json,
          promoted_memory_ids_json, pruned_memory_ids_json, failure_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      run.id,
      run.status,
      run.scheduledAt,
      null,
      null,
      run.summarizedCount,
      run.promotedCount,
      run.prunedCount,
      encodeJson(run.summaryMemoryIds),
      encodeJson(run.promotedMemoryIds),
      encodeJson(run.prunedMemoryIds),
      null,
      run.createdAt
    );
    return run;
  }

  private armNext(): void {
    if (!this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const next = this.database.get<MemoryMaintenanceRow>(
      "SELECT * FROM memory_maintenance_runs WHERE status = 'scheduled' ORDER BY scheduled_at ASC LIMIT 1"
    );
    if (!next) {
      this.ensureScheduledRun(new Date().toISOString());
      this.armNext();
      return;
    }

    const delayMs = Math.max(0, Date.parse(next.scheduled_at) - Date.now());
    const timerDelayMs = Math.min(delayMs, MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => {
      if (delayMs > MAX_TIMER_DELAY_MS) {
        this.armNext();
        return;
      }
      void this.execute(next.id).finally(() => {
        this.ensureScheduledRun(new Date().toISOString());
        this.armNext();
      });
    }, timerDelayMs);
  }

  private async execute(runId: string): Promise<MemoryMaintenanceRun> {
    const row = this.database.get<MemoryMaintenanceRow>(
      "SELECT * FROM memory_maintenance_runs WHERE id = ?",
      runId
    );
    if (!row || row.status !== "scheduled") {
      throw new Error("Memory maintenance run is not scheduled");
    }

    const startedAt = new Date().toISOString();
    this.database.run(
      "UPDATE memory_maintenance_runs SET status = 'running', started_at = ?, failure_reason = NULL WHERE id = ?",
      startedAt,
      runId
    );

    try {
      const outcome = await this.memory.runMaintenance();
      const finishedAt = new Date().toISOString();
      this.database.run(
        `
          UPDATE memory_maintenance_runs
          SET status = 'completed',
              finished_at = ?,
              summarized_count = ?,
              promoted_count = ?,
              pruned_count = ?,
              summary_memory_ids_json = ?,
              promoted_memory_ids_json = ?,
              pruned_memory_ids_json = ?,
              failure_reason = NULL
          WHERE id = ?
        `,
        finishedAt,
        outcome.summarizedCount,
        outcome.promotedCount,
        outcome.prunedCount,
        encodeJson(outcome.summaryMemoryIds),
        encodeJson(outcome.promotedMemoryIds),
        encodeJson(outcome.prunedMemoryIds),
        runId
      );
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const failureReason =
        error instanceof Error ? error.message : "Memory maintenance failed";
      this.database.run(
        `
          UPDATE memory_maintenance_runs
          SET status = 'failed', finished_at = ?, failure_reason = ?
          WHERE id = ?
        `,
        finishedAt,
        failureReason,
        runId
      );
    }

    const updated = this.database.get<MemoryMaintenanceRow>(
      "SELECT * FROM memory_maintenance_runs WHERE id = ?",
      runId
    );
    if (!updated) {
      throw new Error("Memory maintenance run disappeared after execution");
    }
    return toMaintenanceRun(updated);
  }
}

function toMaintenanceRun(row: MemoryMaintenanceRow): MemoryMaintenanceRun {
  return {
    id: row.id,
    status: row.status,
    scheduledAt: row.scheduled_at,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    summarizedCount: row.summarized_count,
    promotedCount: row.promoted_count,
    prunedCount: row.pruned_count,
    summaryMemoryIds: decodeJson(row.summary_memory_ids_json, []),
    promotedMemoryIds: decodeJson(row.promoted_memory_ids_json, []),
    prunedMemoryIds: decodeJson(row.pruned_memory_ids_json, []),
    failureReason: row.failure_reason ?? undefined,
  };
}
