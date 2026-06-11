import { createId } from "../shared/ids.ts";
import type { SubagentRequest } from "../orchestration/types.ts";
import { OrchestrationService } from "../orchestration/service.ts";
import type { AppDatabase } from "../platform/database.ts";
import { decodeJson, encodeJson } from "../platform/database.ts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type JobRecord = {
  id: string;
  name: string;
  message: string;
  scheduledAt: string;
  subagents: SubagentRequest[];
  status: "scheduled" | "running" | "completed" | "failed";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  attemptCount: number;
  maxAttempts: number;
  failureReason?: string;
  lastRunId?: string;
};

type JobRow = {
  id: string;
  name: string;
  message: string;
  scheduled_at: string;
  subagents_json: string;
  status: JobRecord["status"];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  attempt_count: number;
  max_attempts: number;
  failure_reason: string | null;
  last_run_id: string | null;
};

export type SchedulerJobHandlerResult = {
  runId?: string;
};

export type SchedulerJobHandler = (
  job: JobRecord
) =>
  | Promise<SchedulerJobHandlerResult | void>
  | SchedulerJobHandlerResult
  | void;

export class SchedulerService {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly handlers = new Map<string, SchedulerJobHandler>();
  private running = false;
  private readonly database: AppDatabase;
  private readonly orchestration: OrchestrationService;

  constructor(database: AppDatabase, orchestration: OrchestrationService) {
    this.database = database;
    this.orchestration = orchestration;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.recoverStaleRunningJobs();
    const jobs = await this.list();
    for (const job of jobs) {
      if (job.status === "scheduled") {
        this.arm(job);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  registerHandler(name: string, handler: SchedulerJobHandler): void {
    this.handlers.set(name, handler);
  }

  async schedule(
    name: string,
    message: string,
    options: {
      delayMs?: number;
      scheduledAt?: string;
      subagents?: SubagentRequest[];
      maxAttempts?: number;
    }
  ): Promise<JobRecord> {
    const now = new Date();
    const scheduledAt = options.scheduledAt
      ? new Date(options.scheduledAt).toISOString()
      : new Date(now.getTime() + (options.delayMs ?? 0)).toISOString();
    const record: JobRecord = {
      id: createId("job"),
      name,
      message,
      scheduledAt,
      subagents: options.subagents ?? [],
      status: "scheduled",
      createdAt: now.toISOString(),
      attemptCount: 0,
      maxAttempts: options.maxAttempts ?? 1,
    };

    this.database.run(
      `
        INSERT INTO jobs (
          id, name, message, scheduled_at, subagents_json, status, created_at,
          started_at, finished_at, attempt_count, max_attempts, failure_reason, last_run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.id,
      record.name,
      record.message,
      record.scheduledAt,
      encodeJson(record.subagents),
      record.status,
      record.createdAt,
      null,
      null,
      record.attemptCount,
      record.maxAttempts,
      null,
      null
    );

    if (this.running) {
      this.arm(record);
    }
    return record;
  }

  async list(): Promise<JobRecord[]> {
    return this.database
      .all<JobRow>("SELECT * FROM jobs ORDER BY scheduled_at DESC")
      .map((row) => toJobRecord(row));
  }

  private async recoverStaleRunningJobs(): Promise<void> {
    const jobs = await this.list();
    const recoveredAt = new Date().toISOString();

    for (const job of jobs) {
      if (job.status !== "running") {
        continue;
      }

      const exhausted = job.attemptCount >= job.maxAttempts;
      await this.update({
        ...job,
        status: exhausted ? "failed" : "scheduled",
        scheduledAt: exhausted ? job.scheduledAt : recoveredAt,
        startedAt: exhausted ? job.startedAt : undefined,
        finishedAt: exhausted ? recoveredAt : undefined,
        failureReason: exhausted
          ? "Job was running during shutdown and attempts are exhausted"
          : "Recovered after interrupted run",
      });
    }
  }

  private arm(job: JobRecord): void {
    if (this.timers.has(job.id)) {
      clearTimeout(this.timers.get(job.id));
    }

    const delayMs = Math.max(0, Date.parse(job.scheduledAt) - Date.now());
    const timerDelayMs = Math.min(delayMs, MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      if (delayMs > MAX_TIMER_DELAY_MS) {
        this.timers.delete(job.id);
        this.arm(job);
        return;
      }
      void this.execute(job.id);
    }, timerDelayMs);
    this.timers.set(job.id, timer);
  }

  private async execute(jobId: string): Promise<void> {
    this.timers.delete(jobId);
    if (!this.running) {
      return;
    }

    const job = await this.get(jobId);
    if (!job || job.status !== "scheduled") {
      return;
    }

    const startedAt = new Date().toISOString();
    const runningJob: JobRecord = {
      ...job,
      status: "running",
      startedAt,
      attemptCount: job.attemptCount + 1,
      failureReason: undefined,
    };
    await this.update(runningJob);

    try {
      const handler = this.handlers.get(job.name);
      const result = handler
        ? await handler(runningJob)
        : await this.orchestration.runCoordinator(
            {
              channelId: "scheduler",
              conversationId: runningJob.id,
              message: runningJob.message,
              subagents: runningJob.subagents,
            },
            async () => undefined
          );

      await this.update({
        ...runningJob,
        status: "completed",
        startedAt,
        finishedAt: new Date().toISOString(),
        attemptCount: runningJob.attemptCount,
        lastRunId: result?.runId,
        failureReason: undefined,
      });
    } catch (error) {
      const failureReason =
        error instanceof Error ? error.message : "Scheduler run failed";
      const shouldRetry = job.attemptCount + 1 < job.maxAttempts;
      await this.update({
        ...job,
        status: shouldRetry ? "scheduled" : "failed",
        attemptCount: job.attemptCount + 1,
        startedAt: shouldRetry ? undefined : startedAt,
        finishedAt: shouldRetry ? undefined : new Date().toISOString(),
        scheduledAt: shouldRetry
          ? new Date(
              Date.now() + retryDelayMs(job.attemptCount + 1)
            ).toISOString()
          : job.scheduledAt,
        failureReason,
      });
      if (shouldRetry) {
        const reloaded = await this.get(jobId);
        if (reloaded) {
          this.arm(reloaded);
        }
      }
    }
  }

  private async get(jobId: string): Promise<JobRecord | null> {
    const row = this.database.get<JobRow>(
      "SELECT * FROM jobs WHERE id = ?",
      jobId
    );
    return row ? toJobRecord(row) : null;
  }

  private async update(job: JobRecord): Promise<void> {
    this.database.run(
      `
        UPDATE jobs
        SET name = ?, message = ?, scheduled_at = ?, subagents_json = ?, status = ?,
            created_at = ?, started_at = ?, finished_at = ?, attempt_count = ?, max_attempts = ?,
            failure_reason = ?, last_run_id = ?
        WHERE id = ?
      `,
      job.name,
      job.message,
      job.scheduledAt,
      encodeJson(job.subagents),
      job.status,
      job.createdAt,
      job.startedAt ?? null,
      job.finishedAt ?? null,
      job.attemptCount,
      job.maxAttempts,
      job.failureReason ?? null,
      job.lastRunId ?? null,
      job.id
    );
  }
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(
    60_000,
    1_000 * Math.max(1, 2 ** Math.max(0, attemptCount - 1))
  );
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    name: row.name,
    message: row.message,
    scheduledAt: row.scheduled_at,
    subagents: decodeJson(row.subagents_json, []),
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    failureReason: row.failure_reason ?? undefined,
    lastRunId: row.last_run_id ?? undefined,
  };
}
