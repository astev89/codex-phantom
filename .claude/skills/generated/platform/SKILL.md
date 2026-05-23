---
name: platform
description: "Skill for the Platform area of codex-phantom. 17 symbols across 9 files."
---

# Platform

17 symbols | 9 files | Cohesion: 94%

## When to Use

- Working with code in `src/`
- Understanding how fetchWithTimeout, anySignal, abort work
- Modifying platform-related functionality

## Key Files

| File                         | Symbols                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `src/platform/database.ts`   | close, constructor, migrate, openDatabase, ensureColumn |
| `src/platform/logger.ts`     | info, Logger, createLogger                              |
| `src/platform/outbound.ts`   | fetchWithTimeout, anySignal, abort                      |
| `src/index.ts`               | shutdown                                                |
| `src/memory/maintenance.ts`  | stop                                                    |
| `src/scheduler/service.ts`   | stop                                                    |
| `src/server/http-server.ts`  | close                                                   |
| `src/agent/codex-adapter.ts` | defaultOpenAiTransport                                  |
| `src/memory/embedding.ts`    | embed                                                   |

## Entry Points

Start here when exploring this area:

- **`fetchWithTimeout`** (Function) — `src/platform/outbound.ts:4`
- **`anySignal`** (Function) — `src/platform/outbound.ts:22`
- **`abort`** (Function) — `src/platform/outbound.ts:25`
- **`createLogger`** (Function) — `src/platform/logger.ts:50`
- **`Logger`** (Class) — `src/platform/logger.ts:9`

## Key Symbols

| Symbol                   | Type     | File                         | Line |
| ------------------------ | -------- | ---------------------------- | ---- |
| `Logger`                 | Class    | `src/platform/logger.ts`     | 9    |
| `fetchWithTimeout`       | Function | `src/platform/outbound.ts`   | 4    |
| `anySignal`              | Function | `src/platform/outbound.ts`   | 22   |
| `abort`                  | Function | `src/platform/outbound.ts`   | 25   |
| `createLogger`           | Function | `src/platform/logger.ts`     | 50   |
| `stop`                   | Method   | `src/memory/maintenance.ts`  | 69   |
| `close`                  | Method   | `src/platform/database.ts`   | 21   |
| `info`                   | Method   | `src/platform/logger.ts`     | 37   |
| `stop`                   | Method   | `src/scheduler/service.ts`   | 65   |
| `close`                  | Method   | `src/server/http-server.ts`  | 205  |
| `embed`                  | Method   | `src/memory/embedding.ts`    | 24   |
| `constructor`            | Method   | `src/platform/database.ts`   | 10   |
| `migrate`                | Method   | `src/platform/database.ts`   | 53   |
| `shutdown`               | Function | `src/index.ts`               | 129  |
| `defaultOpenAiTransport` | Function | `src/agent/codex-adapter.ts` | 351  |
| `openDatabase`           | Function | `src/platform/database.ts`   | 554  |
| `ensureColumn`           | Function | `src/platform/database.ts`   | 562  |

## Execution Flows

| Flow                         | Type            | Steps |
| ---------------------------- | --------------- | ----- |
| `RunWithOpenAi → Abort`      | cross_community | 5     |
| `Constructor → EnsureColumn` | intra_community | 3     |

## How to Explore

1. `gitnexus_context({name: "fetchWithTimeout"})` — see callers and callees
2. `gitnexus_query({query: "platform"})` — find related execution flows
3. Read key files listed above for implementation details
