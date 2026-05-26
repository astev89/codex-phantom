---
name: server
description: "Skill for the Server area of codex-phantom. 165 symbols across 34 files."
---

# Server

165 symbols | 34 files | Cohesion: 83%

## When to Use

- Working with code in `src/`
- Understanding how validateSlackRequest, validateWebhookSecret, renderChatApp work
- Modifying server-related functionality

## Key Files

| File                                   | Symbols                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/server/http-server.ts`            | handle, buildExportPayload, json, buildAutoTitle, readTextBody (+35)                            |
| `src/server/validation.ts`             | HttpError, parseJsonBody, validateChatBody, validateChatArtifactBody, validateWebhookBody (+29) |
| `src/server/readiness.ts`              | buildSetupReadiness, secretChecks, secretCheck, storageChecks, roleConfigChecks (+11)           |
| `src/chat/attachment-text-index.ts`    | listForSession, list, search, toIndexRecord, toSearchResult (+2)                                |
| `src/self-evolution/proposals.ts`      | list, summary, listMutations, get, toProposalRecord                                             |
| `src/memory/store.ts`                  | listEntries, getEntry, listLifecycleLinks, toMemoryEntry                                        |
| `src/orchestration/run-graph-store.ts` | list, listChildren, listEvents, toRunNode                                                       |
| `src/platform/metrics.ts`              | observe, snapshot, toPrometheus, prometheusName                                                 |
| `src/tools/bundles.ts`                 | list, summary, listAudit, listByLifecycle                                                       |
| `src/server/settings.ts`               | get, update, normalizeSettings, clampInteger                                                    |

## Entry Points

Start here when exploring this area:

- **`validateSlackRequest`** (Function) — `src/channels/slack-events.ts:13`
- **`validateWebhookSecret`** (Function) — `src/channels/webhook.ts:11`
- **`renderChatApp`** (Function) — `src/server/chat-ui.ts:0`
- **`escapeHtml`** (Function) — `src/server/chat-ui.ts:455`
- **`toScriptJson`** (Function) — `src/server/chat-ui.ts:465`

## Key Symbols

| Symbol                     | Type     | File                           | Line |
| -------------------------- | -------- | ------------------------------ | ---- |
| `ChatWireEventBuilder`     | Class    | `src/chat/wire-events.ts`      | 22   |
| `HttpError`                | Class    | `src/server/validation.ts`     | 8    |
| `HttpServer`               | Class    | `src/server/http-server.ts`    | 105  |
| `validateSlackRequest`     | Function | `src/channels/slack-events.ts` | 13   |
| `validateWebhookSecret`    | Function | `src/channels/webhook.ts`      | 11   |
| `renderChatApp`            | Function | `src/server/chat-ui.ts`        | 0    |
| `escapeHtml`               | Function | `src/server/chat-ui.ts`        | 455  |
| `toScriptJson`             | Function | `src/server/chat-ui.ts`        | 465  |
| `buildJsonExport`          | Function | `src/server/export.ts`         | 33   |
| `buildNdjsonExport`        | Function | `src/server/export.ts`         | 48   |
| `buildOperatorExport`      | Function | `src/server/export.ts`         | 63   |
| `renderOperatorConsole`    | Function | `src/server/ui.ts`             | 0    |
| `escapeHtml`               | Function | `src/server/ui.ts`             | 320  |
| `parseJsonBody`            | Function | `src/server/validation.ts`     | 112  |
| `validateChatBody`         | Function | `src/server/validation.ts`     | 124  |
| `validateChatArtifactBody` | Function | `src/server/validation.ts`     | 138  |
| `validateWebhookBody`      | Function | `src/server/validation.ts`     | 165  |
| `validateScheduleBody`     | Function | `src/server/validation.ts`     | 173  |
| `validateMcpBody`          | Function | `src/server/validation.ts`     | 195  |
| `validateDynamicToolBody`  | Function | `src/server/validation.ts`     | 205  |

## Execution Flows

| Flow                                | Type            | Steps |
| ----------------------------------- | --------------- | ----- |
| `Constructor → HashToken`           | cross_community | 6     |
| `OnFailure → HttpError`             | cross_community | 6     |
| `Timer → All`                       | cross_community | 6     |
| `Emit → IsSafeExtractedContentType` | cross_community | 6     |
| `OnEvent → HttpError`               | cross_community | 6     |
| `BuildExportPayload → All`          | cross_community | 5     |
| `OnComplete → HttpError`            | cross_community | 5     |
| `RunAsync → All`                    | cross_community | 5     |
| `Completed → HttpError`             | cross_community | 5     |
| `Reject → DecodeJson`               | cross_community | 5     |

## Connected Areas

| Area           | Connections |
| -------------- | ----------- |
| Memory         | 36 calls    |
| Channels       | 16 calls    |
| Tools          | 15 calls    |
| Agent          | 8 calls     |
| Orchestration  | 5 calls     |
| Scheduler      | 3 calls     |
| Self-evolution | 3 calls     |
| Chat           | 3 calls     |

## How to Explore

1. `gitnexus_context({name: "validateSlackRequest"})` — see callers and callees
2. `gitnexus_query({query: "server"})` — find related execution flows
3. Read key files listed above for implementation details
