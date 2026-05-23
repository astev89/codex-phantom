---
name: chat
description: "Skill for the Chat area of codex-phantom. 16 symbols across 2 files."
---

# Chat

16 symbols | 2 files | Cohesion: 75%

## When to Use

- Working with code in `src/`
- Understanding how extractArtifactDraftsFromEvent, extractArtifactDraftsFromOutputText, indexAttachment work
- Modifying chat-related functionality

## Key Files

| File                                | Symbols                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/chat/artifact-extraction.ts`   | artifactCandidates, toArtifactDraft, artifactContent, normalizeTitle, normalizeKind (+8) |
| `src/chat/attachment-text-index.ts` | indexAttachment, extractSearchableText, isSafeTextContentType                            |

## Entry Points

Start here when exploring this area:

- **`extractArtifactDraftsFromEvent`** (Function) — `src/chat/artifact-extraction.ts:22`
- **`extractArtifactDraftsFromOutputText`** (Function) — `src/chat/artifact-extraction.ts:44`
- **`indexAttachment`** (Method) — `src/chat/attachment-text-index.ts:51`

## Key Symbols

| Symbol                                | Type     | File                                | Line |
| ------------------------------------- | -------- | ----------------------------------- | ---- |
| `extractArtifactDraftsFromEvent`      | Function | `src/chat/artifact-extraction.ts`   | 22   |
| `extractArtifactDraftsFromOutputText` | Function | `src/chat/artifact-extraction.ts`   | 44   |
| `indexAttachment`                     | Method   | `src/chat/attachment-text-index.ts` | 51   |
| `artifactCandidates`                  | Function | `src/chat/artifact-extraction.ts`   | 79   |
| `toArtifactDraft`                     | Function | `src/chat/artifact-extraction.ts`   | 98   |
| `artifactContent`                     | Function | `src/chat/artifact-extraction.ts`   | 134  |
| `normalizeTitle`                      | Function | `src/chat/artifact-extraction.ts`   | 147  |
| `normalizeKind`                       | Function | `src/chat/artifact-extraction.ts`   | 155  |
| `normalizeContentType`                | Function | `src/chat/artifact-extraction.ts`   | 164  |
| `isSafeExtractedContentType`          | Function | `src/chat/artifact-extraction.ts`   | 179  |
| `isRecord`                            | Function | `src/chat/artifact-extraction.ts`   | 200  |
| `extractArtifactDrafts`               | Function | `src/chat/artifact-extraction.ts`   | 61   |
| `parseJsonValue`                      | Function | `src/chat/artifact-extraction.ts`   | 191  |
| `isJsonValue`                         | Function | `src/chat/artifact-extraction.ts`   | 204  |
| `extractSearchableText`               | Function | `src/chat/attachment-text-index.ts` | 159  |
| `isSafeTextContentType`               | Function | `src/chat/attachment-text-index.ts` | 174  |

## Execution Flows

| Flow                                | Type            | Steps |
| ----------------------------------- | --------------- | ----- |
| `Emit → IsSafeExtractedContentType` | cross_community | 6     |
| `Emit → IsRecord`                   | cross_community | 5     |
| `Emit → NormalizeTitle`             | cross_community | 5     |
| `Emit → NormalizeKind`              | cross_community | 5     |
| `Emit → IsJsonValue`                | cross_community | 4     |

## Connected Areas

| Area   | Connections |
| ------ | ----------- |
| Memory | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "extractArtifactDraftsFromEvent"})` — see callers and callees
2. `gitnexus_query({query: "chat"})` — find related execution flows
3. Read key files listed above for implementation details
