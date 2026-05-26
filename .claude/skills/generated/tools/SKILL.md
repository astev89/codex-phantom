---
name: tools
description: "Skill for the Tools area of codex-phantom. 39 symbols across 4 files."
---

# Tools

39 symbols | 4 files | Cohesion: 68%

## When to Use

- Working with code in `src/`
- Understanding how handler, enableToolBundle, disableToolBundle work
- Modifying tools-related functionality

## Key Files

| File                            | Symbols                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `src/tools/bundles.ts`          | preview, get, approve, markEnabled, markDisabled (+11)                                  |
| `src/tools/dynamic-registry.ts` | unregister, deactivate, constructor, register, registerApproved (+9)                    |
| `src/tools/registry.ts`         | unregisterDynamic, registerDynamic, resolveAllowedToolIds, call, isAllowedByPolicy (+1) |
| `src/server/http-server.ts`     | enableToolBundle, disableToolBundle, uninstallToolBundle                                |

## Entry Points

Start here when exploring this area:

- **`handler`** (Function) — `src/tools/dynamic-registry.ts:238`
- **`enableToolBundle`** (Method) — `src/server/http-server.ts:1594`
- **`disableToolBundle`** (Method) — `src/server/http-server.ts:1628`
- **`uninstallToolBundle`** (Method) — `src/server/http-server.ts:1646`
- **`preview`** (Method) — `src/tools/bundles.ts:109`

## Key Symbols

| Symbol                 | Type     | File                            | Line |
| ---------------------- | -------- | ------------------------------- | ---- |
| `handler`              | Function | `src/tools/dynamic-registry.ts` | 238  |
| `enableToolBundle`     | Method   | `src/server/http-server.ts`     | 1594 |
| `disableToolBundle`    | Method   | `src/server/http-server.ts`     | 1628 |
| `uninstallToolBundle`  | Method   | `src/server/http-server.ts`     | 1646 |
| `preview`              | Method   | `src/tools/bundles.ts`          | 109  |
| `get`                  | Method   | `src/tools/bundles.ts`          | 143  |
| `approve`              | Method   | `src/tools/bundles.ts`          | 221  |
| `markEnabled`          | Method   | `src/tools/bundles.ts`          | 249  |
| `markDisabled`         | Method   | `src/tools/bundles.ts`          | 278  |
| `markUninstalled`      | Method   | `src/tools/bundles.ts`          | 306  |
| `markFailed`           | Method   | `src/tools/bundles.ts`          | 334  |
| `getRequired`          | Method   | `src/tools/bundles.ts`          | 386  |
| `recordAudit`          | Method   | `src/tools/bundles.ts`          | 416  |
| `unregister`           | Method   | `src/tools/dynamic-registry.ts` | 176  |
| `deactivate`           | Method   | `src/tools/dynamic-registry.ts` | 191  |
| `unregisterDynamic`    | Method   | `src/tools/registry.ts`         | 25   |
| `constructor`          | Method   | `src/tools/dynamic-registry.ts` | 41   |
| `register`             | Method   | `src/tools/dynamic-registry.ts` | 60   |
| `registerApproved`     | Method   | `src/tools/dynamic-registry.ts` | 125  |
| `activateApprovedTool` | Method   | `src/tools/dynamic-registry.ts` | 195  |

## Execution Flows

| Flow                               | Type            | Steps |
| ---------------------------------- | --------------- | ----- |
| `DisableToolBundle → DecodeJson`   | cross_community | 6     |
| `UninstallToolBundle → DecodeJson` | cross_community | 6     |
| `MarkFailed → DecodeJson`          | cross_community | 5     |
| `DisableToolBundle → Get`          | cross_community | 5     |
| `UninstallToolBundle → Get`        | cross_community | 5     |
| `Timer → IsAllowedByAllowedIds`    | cross_community | 5     |
| `Preview → DecodeJson`             | cross_community | 5     |
| `Approve → DecodeJson`             | cross_community | 5     |
| `MarkEnabled → DecodeJson`         | cross_community | 5     |
| `Run → IsAllowedByAllowedIds`      | cross_community | 4     |

## Connected Areas

| Area   | Connections |
| ------ | ----------- |
| Memory | 28 calls    |
| Server | 7 calls     |

## How to Explore

1. `gitnexus_context({name: "handler"})` — see callers and callees
2. `gitnexus_query({query: "tools"})` — find related execution flows
3. Read key files listed above for implementation details
