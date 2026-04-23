---
name: memory
description: "Skill for the Memory area of codex-phantom. 36 symbols across 6 files."
---

# Memory

36 symbols | 6 files | Cohesion: 81%

## When to Use

- Working with code in `src/`
- Understanding how createId, encodeJson, SQLiteVectorStore work
- Modifying memory-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/memory/store.ts` | recordTurn, consolidate, backfillEmbeddings, compactEpisodicMemories, storeEntries (+10) |
| `src/memory/vector-store.ts` | isConfigured, initialize, upsert, search, delete (+9) |
| `src/platform/database.ts` | run, transaction, encodeJson |
| `src/scheduler/service.ts` | schedule, update |
| `src/shared/ids.ts` | createId |
| `src/chat/session-store.ts` | upsert |

## Entry Points

Start here when exploring this area:

- **`createId`** (Function) — `src/shared/ids.ts:2`
- **`encodeJson`** (Function) — `src/platform/database.ts:168`
- **`SQLiteVectorStore`** (Class) — `src/memory/vector-store.ts:18`
- **`QdrantVectorStore`** (Class) — `src/memory/vector-store.ts:74`
- **`schedule`** (Method) — `src/scheduler/service.ts:74`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `SQLiteVectorStore` | Class | `src/memory/vector-store.ts` | 18 |
| `QdrantVectorStore` | Class | `src/memory/vector-store.ts` | 74 |
| `createId` | Function | `src/shared/ids.ts` | 2 |
| `encodeJson` | Function | `src/platform/database.ts` | 168 |
| `schedule` | Method | `src/scheduler/service.ts` | 74 |
| `update` | Method | `src/scheduler/service.ts` | 212 |
| `recordTurn` | Method | `src/memory/store.ts` | 133 |
| `consolidate` | Method | `src/memory/store.ts` | 148 |
| `backfillEmbeddings` | Method | `src/memory/store.ts` | 203 |
| `compactEpisodicMemories` | Method | `src/memory/store.ts` | 292 |
| `storeEntries` | Method | `src/memory/store.ts` | 382 |
| `upsertToVectorBackend` | Method | `src/memory/store.ts` | 464 |
| `pruneByCategory` | Method | `src/memory/store.ts` | 531 |
| `markAccessed` | Method | `src/memory/store.ts` | 555 |
| `upsert` | Method | `src/chat/session-store.ts` | 35 |
| `run` | Method | `src/platform/database.ts` | 29 |
| `transaction` | Method | `src/platform/database.ts` | 41 |
| `isConfigured` | Method | `src/memory/vector-store.ts` | 91 |
| `initialize` | Method | `src/memory/vector-store.ts` | 99 |
| `upsert` | Method | `src/memory/vector-store.ts` | 121 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Schedule → DecodeJson` | cross_community | 6 |
| `Schedule → Run` | cross_community | 6 |
| `Schedule → EncodeJson` | cross_community | 6 |
| `Schedule → CreateId` | cross_community | 6 |
| `Start → Run` | cross_community | 6 |
| `Schedule → Get` | cross_community | 5 |
| `Schedule → List` | cross_community | 5 |
| `GenerateMemoryInsights → CosineSimilarity` | cross_community | 5 |
| `RunCoordinator → CosineSimilarity` | cross_community | 5 |
| `Start → EncodeJson` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Orchestration | 10 calls |
| Scheduler | 1 calls |
| Platform | 1 calls |

## How to Explore

1. `gitnexus_context({name: "createId"})` — see callers and callees
2. `gitnexus_query({query: "memory"})` — find related execution flows
3. Read key files listed above for implementation details
