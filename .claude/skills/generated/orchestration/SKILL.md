---
name: orchestration
description: "Skill for the Orchestration area of codex-phantom. 20 symbols across 6 files."
---

# Orchestration

20 symbols | 6 files | Cohesion: 81%

## When to Use

- Working with code in `src/`
- Understanding how compiledRolePolicyConfig, loadRolePolicyConfig, compiledRoleBaselines work
- Modifying orchestration-related functionality

## Key Files

| File                                   | Symbols                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/orchestration/role-config.ts`     | compiledRolePolicyConfig, loadRolePolicyConfig, parsePolicy, recordValue, stringValue (+1)  |
| `src/orchestration/roles.ts`           | compiledRoleBaselines, intersect, intersectFileGlobs, narrowMode, defaultPolicyForRole (+1) |
| `src/orchestration/service.ts`         | constructor, runCoordinator, spawnSubagent                                                  |
| `src/orchestration/run-graph-store.ts` | get, appendChildRun, upsert                                                                 |
| `src/server/http-server.ts`            | requireSessionRun                                                                           |
| `src/tools/registry.ts`                | listForRole                                                                                 |

## Entry Points

Start here when exploring this area:

- **`compiledRolePolicyConfig`** (Function) — `src/orchestration/role-config.ts:26`
- **`loadRolePolicyConfig`** (Function) — `src/orchestration/role-config.ts:38`
- **`compiledRoleBaselines`** (Function) — `src/orchestration/roles.ts:69`
- **`defaultPolicyForRole`** (Function) — `src/orchestration/roles.ts:73`
- **`buildScopedPolicy`** (Function) — `src/orchestration/roles.ts:80`

## Key Symbols

| Symbol                     | Type     | File                                   | Line |
| -------------------------- | -------- | -------------------------------------- | ---- |
| `compiledRolePolicyConfig` | Function | `src/orchestration/role-config.ts`     | 26   |
| `loadRolePolicyConfig`     | Function | `src/orchestration/role-config.ts`     | 38   |
| `compiledRoleBaselines`    | Function | `src/orchestration/roles.ts`           | 69   |
| `defaultPolicyForRole`     | Function | `src/orchestration/roles.ts`           | 73   |
| `buildScopedPolicy`        | Function | `src/orchestration/roles.ts`           | 80   |
| `constructor`              | Method   | `src/orchestration/service.ts`         | 32   |
| `get`                      | Method   | `src/orchestration/run-graph-store.ts` | 44   |
| `appendChildRun`           | Method   | `src/orchestration/run-graph-store.ts` | 55   |
| `upsert`                   | Method   | `src/orchestration/run-graph-store.ts` | 66   |
| `runCoordinator`           | Method   | `src/orchestration/service.ts`         | 52   |
| `spawnSubagent`            | Method   | `src/orchestration/service.ts`         | 163  |
| `requireSessionRun`        | Method   | `src/server/http-server.ts`            | 1818 |
| `listForRole`              | Method   | `src/tools/registry.ts`                | 38   |
| `parsePolicy`              | Function | `src/orchestration/role-config.ts`     | 69   |
| `recordValue`              | Function | `src/orchestration/role-config.ts`     | 91   |
| `stringValue`              | Function | `src/orchestration/role-config.ts`     | 98   |
| `stringArray`              | Function | `src/orchestration/role-config.ts`     | 105  |
| `intersect`                | Function | `src/orchestration/roles.ts`           | 38   |
| `intersectFileGlobs`       | Function | `src/orchestration/roles.ts`           | 47   |
| `narrowMode`               | Function | `src/orchestration/roles.ts`           | 62   |

## Execution Flows

| Flow                            | Type            | Steps |
| ------------------------------- | --------------- | ----- |
| `Timer → Get`                   | cross_community | 6     |
| `Timer → EmbedOrNull`           | cross_community | 6     |
| `Timer → All`                   | cross_community | 6     |
| `RunAsync → Get`                | cross_community | 5     |
| `RunAsync → EmbedOrNull`        | cross_community | 5     |
| `Timer → IsAllowedByAllowedIds` | cross_community | 5     |
| `Timer → Run`                   | cross_community | 5     |
| `Timer → EncodeJson`            | cross_community | 5     |
| `RunCoordinator → DecodeJson`   | cross_community | 5     |
| `RunCoordinator → Transaction`  | cross_community | 5     |

## Connected Areas

| Area   | Connections |
| ------ | ----------- |
| Memory | 6 calls     |
| Tools  | 2 calls     |
| Agent  | 2 calls     |
| Server | 2 calls     |

## How to Explore

1. `gitnexus_context({name: "compiledRolePolicyConfig"})` — see callers and callees
2. `gitnexus_query({query: "orchestration"})` — find related execution flows
3. Read key files listed above for implementation details
