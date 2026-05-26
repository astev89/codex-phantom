---
name: self-evolution
description: "Skill for the Self-evolution area of codex-phantom. 8 symbols across 1 files."
---

# Self-evolution

8 symbols | 1 files | Cohesion: 56%

## When to Use

- Working with code in `src/`
- Understanding how validateCreateInput, approve, reject work
- Modifying self-evolution-related functionality

## Key Files

| File                              | Symbols                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `src/self-evolution/proposals.ts` | approve, reject, recordRollback, getRequired, validateCreateInput (+3) |

## Entry Points

Start here when exploring this area:

- **`validateCreateInput`** (Function) — `src/self-evolution/proposals.ts:500`
- **`approve`** (Method) — `src/self-evolution/proposals.ts:238`
- **`reject`** (Method) — `src/self-evolution/proposals.ts:267`
- **`recordRollback`** (Method) — `src/self-evolution/proposals.ts:392`
- **`getRequired`** (Method) — `src/self-evolution/proposals.ts:474`

## Key Symbols

| Symbol                 | Type     | File                              | Line |
| ---------------------- | -------- | --------------------------------- | ---- |
| `validateCreateInput`  | Function | `src/self-evolution/proposals.ts` | 500  |
| `approve`              | Method   | `src/self-evolution/proposals.ts` | 238  |
| `reject`               | Method   | `src/self-evolution/proposals.ts` | 267  |
| `recordRollback`       | Method   | `src/self-evolution/proposals.ts` | 392  |
| `getRequired`          | Method   | `src/self-evolution/proposals.ts` | 474  |
| `requireText`          | Function | `src/self-evolution/proposals.ts` | 531  |
| `rejectDirectMutation` | Function | `src/self-evolution/proposals.ts` | 538  |
| `isJsonObject`         | Function | `src/self-evolution/proposals.ts` | 551  |

## Execution Flows

| Flow                                          | Type            | Steps |
| --------------------------------------------- | --------------- | ----- |
| `Reject → DecodeJson`                         | cross_community | 5     |
| `Reject → Get`                                | cross_community | 4     |
| `Handler → RequireText`                       | cross_community | 4     |
| `Handler → ToJsonValue`                       | cross_community | 4     |
| `Handler → IsJsonObject`                      | cross_community | 4     |
| `Handler → RejectDirectMutation`              | cross_community | 4     |
| `RollbackSelfEvolutionProposal → Transaction` | cross_community | 3     |

## Connected Areas

| Area   | Connections |
| ------ | ----------- |
| Memory | 7 calls     |
| Server | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "validateCreateInput"})` — see callers and callees
2. `gitnexus_query({query: "self-evolution"})` — find related execution flows
3. Read key files listed above for implementation details
