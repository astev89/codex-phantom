---
name: cluster-29
description: "Skill for the Cluster_29 area of codex-phantom. 6 symbols across 1 files."
---

# Cluster_29

6 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `src/`
- Understanding how loadConfig work
- Modifying cluster_29-related functionality

## Key Files

| File            | Symbols                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `src/config.ts` | loadConfig, normalizeEnvironment, normalizeLogLevel, parsePositiveInteger, validateConfig (+1) |

## Entry Points

Start here when exploring this area:

- **`loadConfig`** (Function) — `src/config.ts:49`

## Key Symbols

| Symbol                 | Type     | File            | Line |
| ---------------------- | -------- | --------------- | ---- |
| `loadConfig`           | Function | `src/config.ts` | 49   |
| `normalizeEnvironment` | Function | `src/config.ts` | 176  |
| `normalizeLogLevel`    | Function | `src/config.ts` | 183  |
| `parsePositiveInteger` | Function | `src/config.ts` | 195  |
| `validateConfig`       | Function | `src/config.ts` | 210  |
| `validateSecret`       | Function | `src/config.ts` | 270  |

## Execution Flows

| Flow                          | Type            | Steps |
| ----------------------------- | --------------- | ----- |
| `LoadConfig → ValidateSecret` | intra_community | 3     |

## How to Explore

1. `gitnexus_context({name: "loadConfig"})` — see callers and callees
2. `gitnexus_query({query: "cluster_29"})` — find related execution flows
3. Read key files listed above for implementation details
