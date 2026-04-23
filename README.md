# codex-phantom

`codex-phantom` is a Codex-first autonomous agent runtime with durable SQLite-backed app state, resumable sessions, scoped subagents, MCP tool exposure, scheduling, a lightweight operator console, and hybrid long-term memory with Qdrant-backed vector recall plus SQLite fallback.

This branch also adds the first operator-trust foundation layer:

- `pino`-backed structured logging
- an operator-managed channel registry
- approval-gated dynamic tools
- richer admin/dashboard APIs
- Docker and Compose boot paths for local self-hosting

## Run locally

```bash
npm install
cp .env.example .env
node --experimental-strip-types src/index.ts
```

The service starts on `http://localhost:3210` by default.

## Operator surfaces

- `GET /health`
  Runtime readiness plus memory, channel, governance, and logging summaries.
- `GET /admin/summary`
  Deployment-oriented overview for logging, database path, Qdrant config, channels, and tool governance.
- `GET /admin/channels`
  List registered channels such as `web`, `webhook`, `scheduler`, and planned `slack`.
- `POST /admin/channels`
  Enable or disable a registered channel.
- `GET /admin/channels/deliveries`
  Inspect recent outbound channel delivery attempts and their final status.
- `GET /admin/tools/governance`
  Inspect dynamic tool approval state.
- `POST /admin/tools/approve`
  Approve a pending dynamic tool so it becomes visible to MCP/runtime callers.
- `GET /tools/dynamic`
  Inspect persisted dynamic tools.
- `POST /tools/dynamic`
  Submit a new read-only dynamic tool. New tools start in `pending` state until approved.
- `GET /memory`
  Inspect recently persisted memory rows for operator debugging.
- `POST /channels/slack/message`
  Send an outbound Slack message through the configured bot token when the `slack` channel is enabled.

The root console at `/` now exposes panels for:

- health and admin summary
- sessions, runs, jobs, and memory
- dynamic tool registration
- tool approval
- channel enablement
- Slack test-send and delivery log inspection

## Logging

`codex-phantom` now uses `pino` for structured logs. Request handlers emit completion and failure records with request ids, and the logger supports child bindings for run- or request-scoped context.

Control log verbosity with:

```bash
LOG_LEVEL=debug
```

## Channels and governance

Built-in channels are tracked in SQLite:

- `web`
- `webhook`
- `scheduler`
- `slack` as the first planned external channel

Dynamic tools are no longer activated immediately on creation. They are persisted first, surfaced as `pending`, and must be approved through `/admin/tools/approve` before they appear in MCP tool listings or runtime execution.

Slack is now the first real external channel path. The current implementation focuses on outbound delivery:

- the `slack` channel must be enabled through `/admin/channels`
- `SLACK_BOT_TOKEN` must be configured
- each delivery attempt is recorded in `channel_delivery_logs`
- operators can inspect delivery history through `/admin/channels/deliveries`

## Deployment

### Docker

```bash
docker build -t codex-phantom .
docker run --env-file .env -p 3210:3210 codex-phantom
```

### Docker Compose

```bash
docker compose up --build
```

The compose stack includes:

- `codex-phantom`
- `qdrant`

## What is implemented

- SQLite persistence for sessions, runs, run events, memory, and jobs
- Qdrant-backed vector memory with SQLite fallback and metadata provenance in SQLite
- hybrid memory retrieval with embeddings, summaries, and fact/procedure extraction
- request validation and structured HTTP errors
- scheduler boot on startup plus graceful shutdown
- OpenAI/Fallback adapter support with real tool execution loops
- health and metrics endpoints
- operator console at `/`
- channel registry and tool governance APIs
- `pino` structured logging
- Dockerfile and Compose scaffolding for local self-hosting

## Verification

```bash
npm run typecheck
npm test
```
