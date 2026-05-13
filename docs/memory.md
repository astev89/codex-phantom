# Memory Operations

`codex-phantom` stores long-term memory in SQLite and can sync embeddings to Qdrant when semantic retrieval is enabled. Memory maintenance is restart-safe and records every scheduled, manual, completed, interrupted, or failed run in `memory_maintenance_runs`.

## Lifecycle States

Memory entries are active by default. Newer entries can supersede or contradict older entries through `memory_lifecycle_links`. Superseded and contradicted entries remain auditable, but retrieval and duplicate detection exclude them so stale facts do not re-enter prompts.

Inspect memory through:

- `GET /memory`: recent memory entries, including lifecycle state.
- `GET /admin/memory/:id`: one entry plus lifecycle link details.

## Scheduled Maintenance

`MemoryMaintenanceService` creates one future scheduled maintenance run at startup and recovers interrupted `running` rows as `failed`. The default cadence is hourly. Operators can inspect or trigger maintenance with:

- `GET /admin/memory/maintenance`
- `POST /admin/memory/maintenance/run`

## Promote, Summarize, And Prune

V1 maintenance is deterministic and bounded:

- Summarize: once enough raw episodic rows accumulate, the oldest configured cluster is compacted into one summary memory.
- Promote: that summary becomes the promoted durable memory for the clustered raw turns.
- Prune: active semantic, procedural, and episodic rows are trimmed to existing caps; inactive superseded or contradicted audit rows are not pruned by this pass.

Remaining memory parity work is decay/reinforcement scoring and retrieval tuning.
