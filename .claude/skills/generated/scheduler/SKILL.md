---
name: scheduler
description: "Skill for the Scheduler area of codex-phantom. 6 symbols across 1 files."
---

# Scheduler

6 symbols | 1 files | Cohesion: 64%

## When to Use

- Working with code in `src/`
- Understanding how start, list, arm work
- Modifying scheduler-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/scheduler/service.ts` | start, list, arm, execute, get (+1) |

## Entry Points

Start here when exploring this area:

- **`start`** (Method) — `src/scheduler/service.ts:49`
- **`list`** (Method) — `src/scheduler/service.ts:128`
- **`arm`** (Method) — `src/scheduler/service.ts:134`
- **`execute`** (Method) — `src/scheduler/service.ts:146`
- **`get`** (Method) — `src/scheduler/service.ts:207`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `start` | Method | `src/scheduler/service.ts` | 49 |
| `list` | Method | `src/scheduler/service.ts` | 128 |
| `arm` | Method | `src/scheduler/service.ts` | 134 |
| `execute` | Method | `src/scheduler/service.ts` | 146 |
| `get` | Method | `src/scheduler/service.ts` | 207 |
| `toJobRecord` | Function | `src/scheduler/service.ts` | 238 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Schedule → DecodeJson` | cross_community | 6 |
| `Schedule → Run` | cross_community | 6 |
| `Schedule → EncodeJson` | cross_community | 6 |
| `Schedule → CreateId` | cross_community | 6 |
| `Start → DecodeJson` | cross_community | 6 |
| `Start → Run` | cross_community | 6 |
| `Schedule → Get` | cross_community | 5 |
| `Schedule → List` | cross_community | 5 |
| `Execute → Get` | cross_community | 5 |
| `Start → Get` | cross_community | 5 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Orchestration | 5 calls |
| Memory | 1 calls |

## How to Explore

1. `gitnexus_context({name: "start"})` — see callers and callees
2. `gitnexus_query({query: "scheduler"})` — find related execution flows
3. Read key files listed above for implementation details
