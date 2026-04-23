---
name: tools
description: "Skill for the Tools area of codex-phantom. 5 symbols across 3 files."
---

# Tools

5 symbols | 3 files | Cohesion: 67%

## When to Use

- Working with code in `src/`
- Understanding how list, call, isAllowedByPolicy work
- Modifying tools-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/tools/registry.ts` | list, call, isAllowedByPolicy |
| `src/orchestration/service.ts` | listTools |
| `src/mcp/server.ts` | handle |

## Entry Points

Start here when exploring this area:

- **`list`** (Method) — `src/tools/registry.ts:34`
- **`call`** (Method) — `src/tools/registry.ts:45`
- **`isAllowedByPolicy`** (Method) — `src/tools/registry.ts:60`
- **`listTools`** (Method) — `src/orchestration/service.ts:27`
- **`handle`** (Method) — `src/mcp/server.ts:21`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `list` | Method | `src/tools/registry.ts` | 34 |
| `call` | Method | `src/tools/registry.ts` | 45 |
| `isAllowedByPolicy` | Method | `src/tools/registry.ts` | 60 |
| `listTools` | Method | `src/orchestration/service.ts` | 27 |
| `handle` | Method | `src/mcp/server.ts` | 21 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Schedule → List` | cross_community | 5 |
| `Start → List` | cross_community | 5 |

## How to Explore

1. `gitnexus_context({name: "list"})` — see callers and callees
2. `gitnexus_query({query: "tools"})` — find related execution flows
3. Read key files listed above for implementation details
