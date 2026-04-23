---
name: agent
description: "Skill for the Agent area of codex-phantom. 17 symbols across 2 files."
---

# Agent

17 symbols | 2 files | Cohesion: 69%

## When to Use

- Working with code in `src/`
- Understanding how normalizeOpenAiEvent, run, runWithOpenAi work
- Modifying agent-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/agent/codex-adapter.ts` | run, runWithOpenAi, normalizeOpenAiEvent, resolveMode, defaultOpenAiTransport (+4) |
| `src/agent/runtime.ts` | run, parseToolArguments, buildMemoryQueryText, buildConversationTranscript, generateMemoryInsights (+3) |

## Entry Points

Start here when exploring this area:

- **`normalizeOpenAiEvent`** (Function) — `src/agent/codex-adapter.ts:217`
- **`run`** (Method) — `src/agent/codex-adapter.ts:61`
- **`runWithOpenAi`** (Method) — `src/agent/codex-adapter.ts:140`
- **`run`** (Method) — `src/agent/runtime.ts:32`
- **`generateMemoryInsights`** (Method) — `src/agent/runtime.ts:197`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `normalizeOpenAiEvent` | Function | `src/agent/codex-adapter.ts` | 217 |
| `run` | Method | `src/agent/codex-adapter.ts` | 61 |
| `runWithOpenAi` | Method | `src/agent/codex-adapter.ts` | 140 |
| `run` | Method | `src/agent/runtime.ts` | 32 |
| `generateMemoryInsights` | Method | `src/agent/runtime.ts` | 197 |
| `runFallback` | Method | `src/agent/codex-adapter.ts` | 69 |
| `resolveMode` | Function | `src/agent/codex-adapter.ts` | 343 |
| `defaultOpenAiTransport` | Function | `src/agent/codex-adapter.ts` | 350 |
| `parseToolArguments` | Function | `src/agent/runtime.ts` | 244 |
| `buildMemoryQueryText` | Function | `src/agent/runtime.ts` | 255 |
| `buildConversationTranscript` | Function | `src/agent/runtime.ts` | 259 |
| `parseInsights` | Function | `src/agent/runtime.ts` | 265 |
| `heuristicInsights` | Function | `src/agent/runtime.ts` | 278 |
| `trimInsight` | Function | `src/agent/runtime.ts` | 306 |
| `buildResult` | Function | `src/agent/codex-adapter.ts` | 395 |
| `assistantMessage` | Function | `src/agent/codex-adapter.ts` | 418 |
| `estimateTokens` | Function | `src/agent/codex-adapter.ts` | 422 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Schedule → CreateId` | cross_community | 6 |
| `Execute → Get` | cross_community | 5 |
| `GenerateMemoryInsights → DecodeJson` | cross_community | 5 |
| `GenerateMemoryInsights → CosineSimilarity` | cross_community | 5 |
| `RunCoordinator → DecodeJson` | cross_community | 5 |
| `RunCoordinator → CosineSimilarity` | cross_community | 5 |
| `Run → AssistantMessage` | cross_community | 4 |
| `GenerateMemoryInsights → Get` | cross_community | 4 |
| `GenerateMemoryInsights → BuildConversationTranscript` | cross_community | 4 |
| `GenerateMemoryInsights → Tokenize` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Memory | 6 calls |
| Orchestration | 2 calls |
| Prompts | 1 calls |
| Tools | 1 calls |

## How to Explore

1. `gitnexus_context({name: "normalizeOpenAiEvent"})` — see callers and callees
2. `gitnexus_query({query: "agent"})` — find related execution flows
3. Read key files listed above for implementation details
