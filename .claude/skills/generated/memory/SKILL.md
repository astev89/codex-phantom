---
name: memory
description: "Skill for the Memory area of codex-phantom. 98 symbols across 23 files."
---

# Memory

98 symbols | 23 files | Cohesion: 69%

## When to Use

- Working with code in `src/`
- Understanding how records, emit, encodeJson work
- Modifying memory-related functionality

## Key Files

| File                              | Symbols                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `src/memory/store.ts`             | query, recordTurn, consolidate, runMaintenance, backfillEmbeddings (+26)              |
| `src/memory/vector-store.ts`      | search, cosineSimilarity, isConfigured, initialize, upsert (+7)                       |
| `src/memory/maintenance.ts`       | createScheduledRun, toMaintenanceRun, start, runNow, recoverInterruptedRuns (+4)      |
| `src/chat/session-store.ts`       | upsert, rename, recordAttachments, records, recordUploadedAttachment (+3)             |
| `src/platform/database.ts`        | run, transaction, encodeJson, toJsonValue, decodeJson (+1)                            |
| `src/self-evolution/proposals.ts` | create, recordApplySuccess, recordApplyFailure, getMutationRequired, toMutationRecord |
| `src/channels/slack-feedback.ts`  | record, findByProviderEvent, toRecord                                                 |
| `src/chat/artifact-store.ts`      | create, get, toArtifactRecord                                                         |
| `src/index.ts`                    | handler, parseSelfEvolutionToolInput, requireToolString                               |
| `src/channels/registry.ts`        | constructor, seedDefaults                                                             |

## Entry Points

Start here when exploring this area:

- **`records`** (Function) — `src/chat/session-store.ts:122`
- **`emit`** (Function) — `src/orchestration/service.ts:83`
- **`encodeJson`** (Function) — `src/platform/database.ts:576`
- **`toJsonValue`** (Function) — `src/platform/database.ts:595`
- **`createId`** (Function) — `src/shared/ids.ts:2`

## Key Symbols

| Symbol                    | Type     | File                                | Line |
| ------------------------- | -------- | ----------------------------------- | ---- |
| `SQLiteVectorStore`       | Class    | `src/memory/vector-store.ts`        | 18   |
| `QdrantVectorStore`       | Class    | `src/memory/vector-store.ts`        | 74   |
| `records`                 | Function | `src/chat/session-store.ts`         | 122  |
| `emit`                    | Function | `src/orchestration/service.ts`      | 83   |
| `encodeJson`              | Function | `src/platform/database.ts`          | 576  |
| `toJsonValue`             | Function | `src/platform/database.ts`          | 595  |
| `createId`                | Function | `src/shared/ids.ts`                 | 2    |
| `points`                  | Function | `src/memory/store.ts`               | 671  |
| `decodeJson`              | Function | `src/platform/database.ts`          | 580  |
| `record`                  | Method   | `src/channels/delivery-log.ts`      | 36   |
| `recordReceived`          | Method   | `src/channels/inbound.ts`           | 119  |
| `constructor`             | Method   | `src/channels/registry.ts`          | 87   |
| `seedDefaults`            | Method   | `src/channels/registry.ts`          | 162  |
| `record`                  | Method   | `src/channels/slack-feedback.ts`    | 50   |
| `create`                  | Method   | `src/chat/artifact-store.ts`        | 45   |
| `updateRunForAttachments` | Method   | `src/chat/attachment-text-index.ts` | 96   |
| `write`                   | Method   | `src/chat/blob-store.ts`            | 17   |
| `upsert`                  | Method   | `src/chat/session-store.ts`         | 75   |
| `rename`                  | Method   | `src/chat/session-store.ts`         | 110  |
| `recordAttachments`       | Method   | `src/chat/session-store.ts`         | 120  |

## Execution Flows

| Flow                               | Type            | Steps |
| ---------------------------------- | --------------- | ----- |
| `DisableToolBundle → DecodeJson`   | cross_community | 6     |
| `UninstallToolBundle → DecodeJson` | cross_community | 6     |
| `Timer → Get`                      | cross_community | 6     |
| `Timer → EmbedOrNull`              | cross_community | 6     |
| `Timer → All`                      | cross_community | 6     |
| `BeforeRun → Get`                  | cross_community | 6     |
| `BeforeRun → Run`                  | cross_community | 6     |
| `BeforeRun → CreateId`             | cross_community | 6     |
| `OnComplete → Run`                 | cross_community | 5     |
| `OnComplete → Get`                 | cross_community | 5     |

## Connected Areas

| Area           | Connections |
| -------------- | ----------- |
| Server         | 8 calls     |
| Self-evolution | 4 calls     |
| Scheduler      | 1 calls     |
| Channels       | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "records"})` — see callers and callees
2. `gitnexus_query({query: "memory"})` — find related execution flows
3. Read key files listed above for implementation details
