---
name: channels
description: "Skill for the Channels area of codex-phantom. 85 symbols across 17 files."
---

# Channels

85 symbols | 17 files | Cohesion: 77%

## When to Use

- Working with code in `src/`
- Understanding how beforeRun, onEvent, onComplete work
- Modifying channels-related functionality

## Key Files

| File                             | Symbols                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/channels/inbound.ts`        | recordProgress, toProgressRecord, InboundChannelEventStore, InboundChannelRouter, markIgnored (+18)         |
| `src/channels/slack.ts`          | sendMessage, updateMessage, SlackChannel, addReaction, removeReaction (+10)                                 |
| `src/channels/slack-progress.ts` | SlackProgressReporter, queued, onEvent, completed, failed (+5)                                              |
| `src/channels/slack-feedback.ts` | SlackFeedbackStore, mapSlackInteractionFeedback, mapSlackReactionFeedback, reactionRating, stringValue (+3) |
| `src/server/http-server.ts`      | beforeRun, onEvent, onComplete, onFailure, constructor (+2)                                                 |
| `src/channels/slack-events.ts`   | mapSlackEventToInboundMessage, mapReaction, stripBotMention, stringValue, recordValue (+1)                  |
| `src/channels/registry.ts`       | get, upsert, toChannelRecord, resolveSecretPresence, stringArrayValue                                       |
| `src/platform/logger.ts`         | error, warn                                                                                                 |
| `src/channels/delivery-log.ts`   | ChannelDeliveryStore                                                                                        |
| `src/chat/artifact-store.ts`     | ChatArtifactStore                                                                                           |

## Entry Points

Start here when exploring this area:

- **`beforeRun`** (Function) — `src/server/http-server.ts:1243`
- **`onEvent`** (Function) — `src/server/http-server.ts:1254`
- **`onComplete`** (Function) — `src/server/http-server.ts:1257`
- **`onFailure`** (Function) — `src/server/http-server.ts:1266`
- **`completion`** (Function) — `src/channels/inbound.ts:495`

## Key Symbols

| Symbol                          | Type     | File                                | Line |
| ------------------------------- | -------- | ----------------------------------- | ---- |
| `SlackProgressReporter`         | Class    | `src/channels/slack-progress.ts`    | 17   |
| `ChannelDeliveryStore`          | Class    | `src/channels/delivery-log.ts`      | 29   |
| `InboundChannelEventStore`      | Class    | `src/channels/inbound.ts`           | 112  |
| `InboundChannelRouter`          | Class    | `src/channels/inbound.ts`           | 399  |
| `SlackFeedbackStore`            | Class    | `src/channels/slack-feedback.ts`    | 43   |
| `SlackChannel`                  | Class    | `src/channels/slack.ts`             | 48   |
| `ChatArtifactStore`             | Class    | `src/chat/artifact-store.ts`        | 38   |
| `AttachmentTextIndexStore`      | Class    | `src/chat/attachment-text-index.ts` | 44   |
| `ChatBlobStore`                 | Class    | `src/chat/blob-store.ts`            | 10   |
| `McpAuditStore`                 | Class    | `src/mcp/audit.ts`                  | 29   |
| `SelfEvolutionProposalStore`    | Class    | `src/self-evolution/proposals.ts`   | 119  |
| `RequestAuditStore`             | Class    | `src/server/request-audit.ts`       | 20   |
| `OperatorSettingsStore`         | Class    | `src/server/settings.ts`            | 24   |
| `ToolBundleImportStore`         | Class    | `src/tools/bundles.ts`              | 102  |
| `beforeRun`                     | Function | `src/server/http-server.ts`         | 1243 |
| `onEvent`                       | Function | `src/server/http-server.ts`         | 1254 |
| `onComplete`                    | Function | `src/server/http-server.ts`         | 1257 |
| `onFailure`                     | Function | `src/server/http-server.ts`         | 1266 |
| `completion`                    | Function | `src/channels/inbound.ts`           | 495  |
| `mapSlackEventToInboundMessage` | Function | `src/channels/slack-events.ts`      | 40   |

## Execution Flows

| Flow                                | Type            | Steps |
| ----------------------------------- | --------------- | ----- |
| `Constructor → HashToken`           | cross_community | 6     |
| `OnFailure → HttpError`             | cross_community | 6     |
| `BeforeRun → Get`                   | cross_community | 6     |
| `BeforeRun → Run`                   | cross_community | 6     |
| `BeforeRun → CreateId`              | cross_community | 6     |
| `OnEvent → HttpError`               | cross_community | 6     |
| `BuildExportPayload → All`          | cross_community | 5     |
| `RouteSync → ResolveSecretPresence` | cross_community | 5     |
| `OnComplete → Run`                  | cross_community | 5     |
| `OnComplete → Get`                  | cross_community | 5     |

## Connected Areas

| Area          | Connections |
| ------------- | ----------- |
| Memory        | 20 calls    |
| Server        | 8 calls     |
| Orchestration | 2 calls     |

## How to Explore

1. `gitnexus_context({name: "beforeRun"})` — see callers and callees
2. `gitnexus_query({query: "channels"})` — find related execution flows
3. Read key files listed above for implementation details
