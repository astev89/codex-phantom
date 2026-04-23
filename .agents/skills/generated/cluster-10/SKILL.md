---
name: cluster-10
description: "Skill for the Cluster_10 area of codex-phantom. 5 symbols across 1 files."
---

# Cluster_10

5 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `src/`
- Understanding how loadConfig work
- Modifying cluster_10-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/config.ts` | loadConfig, normalizeEnvironment, normalizeLogLevel, parsePositiveInteger, validateConfig |

## Entry Points

Start here when exploring this area:

- **`loadConfig`** (Function) — `src/config.ts:39`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `loadConfig` | Function | `src/config.ts` | 39 |
| `normalizeEnvironment` | Function | `src/config.ts` | 93 |
| `normalizeLogLevel` | Function | `src/config.ts` | 100 |
| `parsePositiveInteger` | Function | `src/config.ts` | 107 |
| `validateConfig` | Function | `src/config.ts` | 118 |

## How to Explore

1. `gitnexus_context({name: "loadConfig"})` — see callers and callees
2. `gitnexus_query({query: "cluster_10"})` — find related execution flows
3. Read key files listed above for implementation details
