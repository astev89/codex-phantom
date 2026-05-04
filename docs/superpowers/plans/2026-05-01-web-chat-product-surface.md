# Web Chat Product Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real `/chat` browser product surface with streamed runs, session management, attachment metadata, markdown rendering, local multi-tab sync, push-permission affordance, and auto-renamed sessions.

**Architecture:** Build the first Codex-native chat SPA as server-rendered static HTML plus authenticated JSON/SSE APIs. Reuse `SessionStore`, `RunGraphStore`, and `OrchestrationService.runCoordinator`; add only the persistence needed for chat session titles and attachment metadata.

**Tech Stack:** TypeScript ESM, Node `node:http`, SQLite, `node:test`, browser `fetch`, `ReadableStream`, `BroadcastChannel`, `localStorage`, and vanilla HTML/CSS/JS.

---

## Scope

- Implement now: `/chat`, `/chat/sessions`, `/chat/sessions/:id`, `/chat/message` SSE enhancements, attachment metadata, markdown rendering, auto-title, multi-tab refresh signals, and push-notification permission UI.
- Defer explicitly: full Phantom 32-event protocol completeness, binary attachment storage, service-worker push delivery, and full offline transcript cache.

## Tasks

### Task 1: Chat Persistence And APIs

**Files:**
- Modify: `src/platform/database.ts`
- Modify: `src/chat/session-store.ts`
- Modify: `src/server/validation.ts`
- Modify: `src/server/http-server.ts`
- Test: `tests/server.test.ts`

- [x] Add failing tests for chat session listing/detail, auto-renamed title, and attachment metadata.
- [x] Add `sessions.title`, `sessions.title_source`, and a `chat_attachments` table.
- [x] Extend `SessionStore` with `rename`, `listAttachments`, and `recordAttachments`.
- [x] Add `GET /chat/sessions`, `GET /chat/sessions/:id`, and attachment-aware `POST /chat/message`.
- [x] Keep existing operator auth requirements.
- [x] Verify with `node --experimental-strip-types --test tests/server.test.ts`.

### Task 2: Chat SSE Wire Envelope

**Files:**
- Create: `src/chat/wire-events.ts`
- Modify: `src/server/http-server.ts`
- Test: `tests/server.test.ts`

- [x] Add failing tests that `/chat/message` emits named SSE events with `request.started`, agent event envelopes, `run.completed`, and `request.completed`.
- [x] Map existing `AgentRunEvent` values into a versioned chat wire envelope.
- [x] Preserve legacy `data: <AgentRunEvent>` compatibility by keeping the raw event inside each envelope.
- [x] Verify with `node --experimental-strip-types --test tests/server.test.ts`.

### Task 3: Browser Chat Surface

**Files:**
- Create: `src/server/chat-ui.ts`
- Modify: `src/server/http-server.ts`
- Test: `tests/server.test.ts`

- [x] Add failing tests that `GET /chat` serves the SPA with expected hooks.
- [x] Implement responsive chat layout: session rail, message stream, composer, attachment list, push toggle, and status strip.
- [x] Implement markdown rendering for common Markdown without external dependencies.
- [x] Implement streaming response consumption with incremental assistant output.
- [x] Implement `BroadcastChannel` and `storage` refresh signals for multi-tab session sync.
- [x] Verify with `node --experimental-strip-types --test tests/server.test.ts`.

### Task 4: Docs And Ledger

**Files:**
- Modify: `docs/phantom-parity.md`
- Modify: `docs/project-status.md`
- Modify: `docs/channels.md`

- [x] Mark the Codex-native web chat product surface as implemented with explicit Phantom gaps.
- [x] Record verification commands and next follow-ups.
- [x] Keep Web Chat distinct from Slack/Telegram channel parity.

### Final Verification

Run:

```bash
node --experimental-strip-types --test tests/server.test.ts
npm run typecheck
npm test
npm run build
```

Before commit, run GitNexus staged `detect_changes` and confirm changed flows match HTTP routing, session persistence, and chat UI rendering.
