# Operator Trust Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the next production-facing trust layer for `codex-phantom` across channels, admin/dashboard surfaces, deployment ergonomics, tool governance, and structured logging.

**Architecture:** Extend the existing single-process Node runtime rather than introducing a second service. Keep SQLite as the authoritative admin/config store, expose operator APIs through the current HTTP server, and make every new surface observable with structured `pino` logs and explicit governance records.

**Tech Stack:** TypeScript, Node built-in test runner, SQLite, existing HTTP server/UI, `pino`

---

## File Map

- Modify: `src/config.ts`
  Add logging and deployment-oriented config, plus channel toggles and operator settings defaults.
- Modify: `src/platform/database.ts`
  Add persistent tables for channel registrations, tool approvals/audit, and operator settings snapshots.
- Modify: `src/platform/logger.ts`
  Replace the custom console JSON shim with a `pino`-backed logger and child logger support.
- Create: `src/channels/registry.ts`
  Persist and manage enabled channels, secrets metadata, and readiness summaries.
- Create: `src/tools/governance.ts`
  Persist dynamic tool approval state, audit decisions, and operator-facing summaries.
- Modify: `src/tools/dynamic-registry.ts`
  Require governance approval before dynamic tools become active in runtime/MCP listings.
- Modify: `src/server/http-server.ts`
  Add admin APIs for channels, governance, settings, and richer health/config summaries.
- Modify: `src/server/ui.ts`
  Expand the operator console with admin panels for channels, approved/pending tools, and deployment/config visibility.
- Modify: `src/index.ts`
  Wire the logger, channel registry, governance service, and updated server dependencies.
- Create: `Dockerfile`
  Provide a documented local/prod container entrypoint for the current Node runtime.
- Create: `docker-compose.yml`
  Provide a local self-hosting stack for `codex-phantom` plus optional Qdrant.
- Modify: `README.md`
  Document the operator surfaces, deployment flow, channel/tool governance, and log behavior.
- Modify: `.env.example`
  Add the new config surface for channels, logging, and deployment-friendly defaults.
- Modify: `package.json`
  Add `pino` dependency and any supporting scripts.
- Modify: `tests/server.test.ts`
  Cover the new admin APIs and governance enforcement.
- Create: `tests/logger.test.ts`
  Cover `pino` logger behavior and child bindings.

## Milestones

### Milestone 1: Operator Trust Foundation

- [ ] Replace the current logger with `pino`, preserving the existing `Logger` interface plus child logger support.
- [ ] Add persistent channel registry and governance tables to SQLite.
- [ ] Require explicit approval for dynamic tools before they are exposed to the runtime.
- [ ] Add admin APIs and console panels for channels, governance, and deployment/config summaries.
- [ ] Add `Dockerfile` and `docker-compose.yml` for self-hosted local/prod-style boot.
- [ ] Update docs and env scaffolding.

### Milestone 2: Channel Expansion

- [ ] Add a first real external channel, preferably Slack, using the registry/governance model from Milestone 1.
- [ ] Add channel delivery logs, secret presence checks, and operator actions for enable/disable.

### Milestone 3: Richer Dashboard/Admin Experience

- [ ] Add timelines and drill-down views for sessions, runs, jobs, memory, and governance audit events.
- [ ] Add operator settings persistence and edit flows.

### Milestone 4: Deployment and Runtime Maturity

- [ ] Add startup diagnostics, readiness details, and environment validation surfacing into the UI.
- [ ] Add structured request/run/channel audit logs and operator export paths.

## Execution Choice

This session will execute **Milestone 1** inline as the first bounded productionization slice. Milestones 2-4 remain queued follow-up work after the foundation lands and verifies cleanly.
