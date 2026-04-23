---
name: server
description: "Skill for the Server area of codex-phantom. 33 symbols across 9 files."
---

# Server

33 symbols | 9 files | Cohesion: 80%

## When to Use

- Working with code in `src/`
- Understanding how modelAdapterMode, parseJsonBody, renderOperatorConsole work
- Modifying server-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/server/validation.ts` | parseJsonBody, HttpError, validateChatBody, validateWebhookBody, validateScheduleBody (+9) |
| `src/server/http-server.ts` | constructor, handle, emit, json, readTextBody (+2) |
| `src/platform/metrics.ts` | increment, observe, snapshot |
| `src/server/ui.ts` | renderOperatorConsole, escapeHtml |
| `src/scheduler/service.ts` | isRunning, stop |
| `src/platform/database.ts` | isReady, close |
| `src/config.ts` | modelAdapterMode |
| `src/channels/webhook.ts` | validateWebhookSecret |
| `src/index.ts` | shutdown |

## Entry Points

Start here when exploring this area:

- **`modelAdapterMode`** (Function) — `src/config.ts:82`
- **`parseJsonBody`** (Function) — `src/server/validation.ts:40`
- **`renderOperatorConsole`** (Function) — `src/server/ui.ts:0`
- **`escapeHtml`** (Function) — `src/server/ui.ts:156`
- **`emit`** (Function) — `src/server/http-server.ts:122`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `HttpError` | Class | `src/server/validation.ts` | 3 |
| `modelAdapterMode` | Function | `src/config.ts` | 82 |
| `parseJsonBody` | Function | `src/server/validation.ts` | 40 |
| `renderOperatorConsole` | Function | `src/server/ui.ts` | 0 |
| `escapeHtml` | Function | `src/server/ui.ts` | 156 |
| `emit` | Function | `src/server/http-server.ts` | 122 |
| `validateWebhookSecret` | Function | `src/channels/webhook.ts` | 8 |
| `validateChatBody` | Function | `src/server/validation.ts` | 52 |
| `validateWebhookBody` | Function | `src/server/validation.ts` | 64 |
| `validateScheduleBody` | Function | `src/server/validation.ts` | 72 |
| `validateMcpBody` | Function | `src/server/validation.ts` | 90 |
| `constructor` | Method | `src/server/http-server.ts` | 38 |
| `handle` | Method | `src/server/http-server.ts` | 78 |
| `json` | Method | `src/server/http-server.ts` | 237 |
| `isRunning` | Method | `src/scheduler/service.ts` | 70 |
| `increment` | Method | `src/platform/metrics.ts` | 9 |
| `observe` | Method | `src/platform/metrics.ts` | 13 |
| `snapshot` | Method | `src/platform/metrics.ts` | 20 |
| `isReady` | Method | `src/platform/database.ts` | 17 |
| `close` | Method | `src/server/http-server.ts` | 72 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Constructor → EscapeHtml` | intra_community | 4 |
| `Constructor → Json` | intra_community | 3 |
| `Constructor → IsReady` | intra_community | 3 |
| `Constructor → IsRunning` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Orchestration | 6 calls |
| Scheduler | 1 calls |
| Memory | 1 calls |
| Tools | 1 calls |

## How to Explore

1. `gitnexus_context({name: "modelAdapterMode"})` — see callers and callees
2. `gitnexus_query({query: "server"})` — find related execution flows
3. Read key files listed above for implementation details
