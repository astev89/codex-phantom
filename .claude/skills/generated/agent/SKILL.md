---
name: agent
description: "Skill for the Agent area of codex-phantom. 19 symbols across 4 files."
---

# Agent

19 symbols | 4 files | Cohesion: 63%

## When to Use

- Working with code in `src/`
- Understanding how normalizeOpenAiEvent, run, get work
- Modifying agent-related functionality

## Key Files

| File                         | Symbols                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/agent/runtime.ts`       | run, parseToolArguments, buildMemoryQueryText, buildConversationTranscript, generateMemoryInsights (+3) |
| `src/agent/codex-adapter.ts` | run, runFallback, resolveMode, estimateTokens, runWithOpenAi (+3)                                       |
| `src/chat/session-store.ts`  | get, toSessionRecord                                                                                    |
| `src/server/http-server.ts`  | requireWebChatSession                                                                                   |

## Entry Points

Start here when exploring this area:

- **`normalizeOpenAiEvent`** (Function) — `src/agent/codex-adapter.ts:218`
- **`run`** (Method) — `src/agent/runtime.ts:32`
- **`get`** (Method) — `src/chat/session-store.ts:70`
- **`requireWebChatSession`** (Method) — `src/server/http-server.ts:1810`
- **`run`** (Method) — `src/agent/codex-adapter.ts:62`

## Key Symbols

| Symbol                        | Type     | File                         | Line |
| ----------------------------- | -------- | ---------------------------- | ---- |
| `normalizeOpenAiEvent`        | Function | `src/agent/codex-adapter.ts` | 218  |
| `run`                         | Method   | `src/agent/runtime.ts`       | 32   |
| `get`                         | Method   | `src/chat/session-store.ts`  | 70   |
| `requireWebChatSession`       | Method   | `src/server/http-server.ts`  | 1810 |
| `run`                         | Method   | `src/agent/codex-adapter.ts` | 62   |
| `runFallback`                 | Method   | `src/agent/codex-adapter.ts` | 70   |
| `runWithOpenAi`               | Method   | `src/agent/codex-adapter.ts` | 141  |
| `generateMemoryInsights`      | Method   | `src/agent/runtime.ts`       | 197  |
| `parseToolArguments`          | Function | `src/agent/runtime.ts`       | 244  |
| `buildMemoryQueryText`        | Function | `src/agent/runtime.ts`       | 255  |
| `buildConversationTranscript` | Function | `src/agent/runtime.ts`       | 259  |
| `toSessionRecord`             | Function | `src/chat/session-store.ts`  | 233  |
| `resolveMode`                 | Function | `src/agent/codex-adapter.ts` | 344  |
| `estimateTokens`              | Function | `src/agent/codex-adapter.ts` | 424  |
| `buildResult`                 | Function | `src/agent/codex-adapter.ts` | 397  |
| `assistantMessage`            | Function | `src/agent/codex-adapter.ts` | 420  |
| `parseInsights`               | Function | `src/agent/runtime.ts`       | 265  |
| `heuristicInsights`           | Function | `src/agent/runtime.ts`       | 278  |
| `trimInsight`                 | Function | `src/agent/runtime.ts`       | 306  |

## Execution Flows

| Flow                           | Type            | Steps |
| ------------------------------ | --------------- | ----- |
| `Timer → Get`                  | cross_community | 6     |
| `Timer → EmbedOrNull`          | cross_community | 6     |
| `Timer → All`                  | cross_community | 6     |
| `RunAsync → Get`               | cross_community | 5     |
| `RunAsync → EmbedOrNull`       | cross_community | 5     |
| `RunCoordinator → DecodeJson`  | cross_community | 5     |
| `RunCoordinator → Transaction` | cross_community | 5     |
| `RunWithOpenAi → Abort`        | cross_community | 5     |
| `SpawnSubagent → EmbedOrNull`  | cross_community | 4     |
| `SpawnSubagent → All`          | cross_community | 4     |

## Connected Areas

| Area     | Connections |
| -------- | ----------- |
| Memory   | 9 calls     |
| Tools    | 1 calls     |
| Server   | 1 calls     |
| Prompts  | 1 calls     |
| Platform | 1 calls     |

## How to Explore

1. `gitnexus_context({name: "normalizeOpenAiEvent"})` — see callers and callees
2. `gitnexus_query({query: "agent"})` — find related execution flows
3. Read key files listed above for implementation details
