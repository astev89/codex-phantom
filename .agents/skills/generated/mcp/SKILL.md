---
name: mcp
description: "Skill for the Mcp area of codex-phantom. 10 symbols across 5 files."
---

# Mcp

10 symbols | 5 files | Cohesion: 77%

## When to Use

- Working with code in `src/`
- Understanding how record, constructor, handle work
- Modifying mcp-related functionality

## Key Files

| File                           | Symbols                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `src/mcp/server.ts`            | constructor, handle, matchesToken, recordAudit, currentPolicy (+1) |
| `src/mcp/audit.ts`             | record                                                             |
| `src/orchestration/service.ts` | listTools                                                          |
| `src/platform/metrics.ts`      | increment                                                          |
| `src/tools/registry.ts`        | list                                                               |

## Entry Points

Start here when exploring this area:

- **`record`** (Method) — `src/mcp/audit.ts:36`
- **`constructor`** (Method) — `src/mcp/server.ts:22`
- **`handle`** (Method) — `src/mcp/server.ts:36`
- **`matchesToken`** (Method) — `src/mcp/server.ts:120`
- **`recordAudit`** (Method) — `src/mcp/server.ts:125`

## Key Symbols

| Symbol          | Type     | File                           | Line |
| --------------- | -------- | ------------------------------ | ---- |
| `record`        | Method   | `src/mcp/audit.ts`             | 36   |
| `constructor`   | Method   | `src/mcp/server.ts`            | 22   |
| `handle`        | Method   | `src/mcp/server.ts`            | 36   |
| `matchesToken`  | Method   | `src/mcp/server.ts`            | 120  |
| `recordAudit`   | Method   | `src/mcp/server.ts`            | 125  |
| `currentPolicy` | Method   | `src/mcp/server.ts`            | 133  |
| `listTools`     | Method   | `src/orchestration/service.ts` | 44   |
| `increment`     | Method   | `src/platform/metrics.ts`      | 9    |
| `list`          | Method   | `src/tools/registry.ts`        | 34   |
| `hashToken`     | Function | `src/mcp/server.ts`            | 146  |

## Execution Flows

| Flow                 | Type            | Steps |
| -------------------- | --------------- | ----- |
| `Handle → Run`       | cross_community | 4     |
| `Handle → Get`       | cross_community | 4     |
| `Handle → HashToken` | intra_community | 3     |
| `Handle → Increment` | intra_community | 3     |

## Connected Areas

| Area          | Connections |
| ------------- | ----------- |
| Memory        | 2 calls     |
| Orchestration | 1 calls     |
| Tools         | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "record"})` — see callers and callees
2. `gitnexus_query({query: "mcp"})` — find related execution flows
3. Read key files listed above for implementation details
