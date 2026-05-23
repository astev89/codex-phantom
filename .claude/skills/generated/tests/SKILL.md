---
name: tests
description: "Skill for the Tests area of codex-phantom. 11 symbols across 3 files."
---

# Tests

11 symbols | 3 files | Cohesion: 100%

## When to Use

- Working with code in `tests/`
- Understanding how makeConfig, makeDisabledEmbeddings, makeFakeVectorStore work
- Modifying tests-related functionality

## Key Files

| File                               | Symbols                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `tests/helpers.ts`                 | makeConfig, makeDisabledEmbeddings, makeFakeVectorStore, embed, hashEmbedding (+2) |
| `tests/memory-maintenance.test.ts` | makeMemory, maintenanceOutcome, runMaintenance                                     |
| `src/memory/store.ts`              | MemoryStore                                                                        |

## Entry Points

Start here when exploring this area:

- **`makeConfig`** (Function) — `tests/helpers.ts:8`
- **`makeDisabledEmbeddings`** (Function) — `tests/helpers.ts:62`
- **`makeFakeVectorStore`** (Function) — `tests/helpers.ts:72`
- **`MemoryStore`** (Class) — `src/memory/store.ts:60`
- **`embed`** (Method) — `tests/helpers.ts:56`

## Key Symbols

| Symbol                   | Type     | File                               | Line |
| ------------------------ | -------- | ---------------------------------- | ---- |
| `MemoryStore`            | Class    | `src/memory/store.ts`              | 60   |
| `makeConfig`             | Function | `tests/helpers.ts`                 | 8    |
| `makeDisabledEmbeddings` | Function | `tests/helpers.ts`                 | 62   |
| `makeFakeVectorStore`    | Function | `tests/helpers.ts`                 | 72   |
| `embed`                  | Method   | `tests/helpers.ts`                 | 56   |
| `search`                 | Method   | `tests/helpers.ts`                 | 101  |
| `makeMemory`             | Function | `tests/memory-maintenance.test.ts` | 11   |
| `hashEmbedding`          | Function | `tests/helpers.ts`                 | 124  |
| `cosineSimilarity`       | Function | `tests/helpers.ts`                 | 134  |
| `maintenanceOutcome`     | Function | `tests/memory-maintenance.test.ts` | 25   |
| `runMaintenance`         | Function | `tests/memory-maintenance.test.ts` | 93   |

## How to Explore

1. `gitnexus_context({name: "makeConfig"})` — see callers and callees
2. `gitnexus_query({query: "tests"})` — find related execution flows
3. Read key files listed above for implementation details
