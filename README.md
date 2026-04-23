# codex-phantom

`codex-phantom` is a Codex-first autonomous agent runtime with durable SQLite-backed app state, resumable sessions, scoped subagents, MCP tool exposure, scheduling, a lightweight operator console, and hybrid long-term memory with Qdrant-backed vector recall plus SQLite fallback.

## Run locally

```bash
npm install
cp .env.example .env
node --experimental-strip-types src/index.ts
```

The service starts on `http://localhost:3210` by default.

## What is implemented

- SQLite persistence for sessions, runs, run events, memory, and jobs
- Qdrant-backed vector memory with SQLite fallback and metadata provenance in SQLite
- hybrid memory retrieval with embeddings, summaries, and fact/procedure extraction
- request validation and structured HTTP errors
- scheduler boot on startup plus graceful shutdown
- OpenAI/Fallback adapter support with real tool execution loops
- health and metrics endpoints
- operator console at `/`

## Verification

```bash
npm run typecheck
npm test
```
