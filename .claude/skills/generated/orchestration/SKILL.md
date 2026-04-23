---
name: orchestration
description: "Skill for the Orchestration area of codex-phantom. 32 symbols across 7 files."
---

# Orchestration

32 symbols | 7 files | Cohesion: 63%

## When to Use

- Working with code in `src/`
- Understanding how decodeJson, defaultPolicyForRole, buildScopedPolicy work
- Modifying orchestration-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/orchestration/run-graph-store.ts` | list, listChildren, listEvents, toRunNode, get (+3) |
| `src/memory/store.ts` | backfillVectors, syncRowsToPrimary, hasSimilarMemory, normalizeText, dedupeStrings (+1) |
| `src/orchestration/roles.ts` | intersect, intersectFileGlobs, narrowMode, defaultPolicyForRole, buildScopedPolicy |
| `src/platform/database.ts` | all, decodeJson, get, toJsonValue |
| `src/chat/session-store.ts` | list, get, toSessionRecord |
| `src/tools/registry.ts` | unregisterDynamic, has, listForRole |
| `src/orchestration/service.ts` | runCoordinator, spawnSubagent, emit |

## Entry Points

Start here when exploring this area:

- **`decodeJson`** (Function) — `src/platform/database.ts:172`
- **`defaultPolicyForRole`** (Function) — `src/orchestration/roles.ts:64`
- **`buildScopedPolicy`** (Function) — `src/orchestration/roles.ts:68`
- **`emit`** (Function) — `src/orchestration/service.ts:63`
- **`toJsonValue`** (Function) — `src/platform/database.ts:184`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `decodeJson` | Function | `src/platform/database.ts` | 172 |
| `defaultPolicyForRole` | Function | `src/orchestration/roles.ts` | 64 |
| `buildScopedPolicy` | Function | `src/orchestration/roles.ts` | 68 |
| `emit` | Function | `src/orchestration/service.ts` | 63 |
| `toJsonValue` | Function | `src/platform/database.ts` | 184 |
| `list` | Method | `src/orchestration/run-graph-store.ts` | 38 |
| `listChildren` | Method | `src/orchestration/run-graph-store.ts` | 49 |
| `listEvents` | Method | `src/orchestration/run-graph-store.ts` | 129 |
| `backfillVectors` | Method | `src/memory/store.ts` | 234 |
| `syncRowsToPrimary` | Method | `src/memory/store.ts` | 511 |
| `list` | Method | `src/chat/session-store.ts` | 24 |
| `get` | Method | `src/chat/session-store.ts` | 30 |
| `all` | Method | `src/platform/database.ts` | 37 |
| `unregisterDynamic` | Method | `src/tools/registry.ts` | 25 |
| `has` | Method | `src/tools/registry.ts` | 56 |
| `hasSimilarMemory` | Method | `src/memory/store.ts` | 522 |
| `listForRole` | Method | `src/tools/registry.ts` | 38 |
| `runCoordinator` | Method | `src/orchestration/service.ts` | 31 |
| `spawnSubagent` | Method | `src/orchestration/service.ts` | 129 |
| `get` | Method | `src/orchestration/run-graph-store.ts` | 44 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Schedule → DecodeJson` | cross_community | 6 |
| `Schedule → Run` | cross_community | 6 |
| `Schedule → EncodeJson` | cross_community | 6 |
| `Schedule → CreateId` | cross_community | 6 |
| `Start → DecodeJson` | cross_community | 6 |
| `Start → Run` | cross_community | 6 |
| `SpawnSubagent → DecodeJson` | cross_community | 5 |
| `Schedule → Get` | cross_community | 5 |
| `Schedule → List` | cross_community | 5 |
| `Execute → Get` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Memory | 8 calls |
| Tools | 2 calls |
| Agent | 2 calls |

## How to Explore

1. `gitnexus_context({name: "decodeJson"})` — see callers and callees
2. `gitnexus_query({query: "orchestration"})` — find related execution flows
3. Read key files listed above for implementation details
