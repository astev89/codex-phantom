---
name: scheduler
description: "Skill for the Scheduler area of codex-phantom. 9 symbols across 1 files."
---

# Scheduler

9 symbols | 1 files | Cohesion: 60%

## When to Use

- Working with code in `src/`
- Understanding how timer, start, list work
- Modifying scheduler-related functionality

## Key Files

| File                       | Symbols                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `src/scheduler/service.ts` | start, list, recoverStaleRunningJobs, get, toJobRecord (+4) |

## Entry Points

Start here when exploring this area:

- **`timer`** (Function) — `src/scheduler/service.ts:167`
- **`start`** (Method) — `src/scheduler/service.ts:51`
- **`list`** (Method) — `src/scheduler/service.ts:131`
- **`recoverStaleRunningJobs`** (Method) — `src/scheduler/service.ts:137`
- **`get`** (Method) — `src/scheduler/service.ts:241`

## Key Symbols

| Symbol                    | Type     | File                       | Line |
| ------------------------- | -------- | -------------------------- | ---- |
| `timer`                   | Function | `src/scheduler/service.ts` | 167  |
| `start`                   | Method   | `src/scheduler/service.ts` | 51   |
| `list`                    | Method   | `src/scheduler/service.ts` | 131  |
| `recoverStaleRunningJobs` | Method   | `src/scheduler/service.ts` | 137  |
| `get`                     | Method   | `src/scheduler/service.ts` | 241  |
| `arm`                     | Method   | `src/scheduler/service.ts` | 160  |
| `execute`                 | Method   | `src/scheduler/service.ts` | 178  |
| `toJobRecord`             | Function | `src/scheduler/service.ts` | 276  |
| `retryDelayMs`            | Function | `src/scheduler/service.ts` | 272  |

## Execution Flows

| Flow                            | Type            | Steps |
| ------------------------------- | --------------- | ----- |
| `Timer → Get`                   | cross_community | 6     |
| `Timer → EmbedOrNull`           | cross_community | 6     |
| `Timer → All`                   | cross_community | 6     |
| `Timer → DecodeJson`            | cross_community | 5     |
| `Timer → IsAllowedByAllowedIds` | cross_community | 5     |
| `Timer → Run`                   | cross_community | 5     |
| `Timer → EncodeJson`            | cross_community | 5     |

## Connected Areas

| Area          | Connections |
| ------------- | ----------- |
| Memory        | 6 calls     |
| Server        | 1 calls     |
| Orchestration | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "timer"})` — see callers and callees
2. `gitnexus_query({query: "scheduler"})` — find related execution flows
3. Read key files listed above for implementation details
