---
name: platform
description: "Skill for the Platform area of codex-phantom. 5 symbols across 1 files."
---

# Platform

5 symbols | 1 files | Cohesion: 86%

## When to Use

- Working with code in `src/`
- Understanding how constructor, exec, migrate work
- Modifying platform-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/platform/database.ts` | constructor, exec, migrate, openDatabase, ensureColumn |

## Entry Points

Start here when exploring this area:

- **`constructor`** (Method) — `src/platform/database.ts:10`
- **`exec`** (Method) — `src/platform/database.ts:25`
- **`migrate`** (Method) — `src/platform/database.ts:53`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `constructor` | Method | `src/platform/database.ts` | 10 |
| `exec` | Method | `src/platform/database.ts` | 25 |
| `migrate` | Method | `src/platform/database.ts` | 53 |
| `openDatabase` | Function | `src/platform/database.ts` | 153 |
| `ensureColumn` | Function | `src/platform/database.ts` | 161 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Constructor → All` | cross_community | 4 |
| `Constructor → Exec` | intra_community | 4 |
| `Consolidate → Exec` | cross_community | 4 |
| `SyncRowsToPrimary → Exec` | cross_community | 4 |
| `CompactEpisodicMemories → Exec` | cross_community | 3 |
| `BackfillEmbeddings → Exec` | cross_community | 3 |
| `PruneByCategory → Exec` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Orchestration | 1 calls |

## How to Explore

1. `gitnexus_context({name: "constructor"})` — see callers and callees
2. `gitnexus_query({query: "platform"})` — find related execution flows
3. Read key files listed above for implementation details
