---
name: prompts
description: "Skill for the Prompts area of codex-phantom. 9 symbols across 1 files."
---

# Prompts

9 symbols | 1 files | Cohesion: 94%

## When to Use

- Working with code in `src/`
- Understanding how assemblePrompt work
- Modifying prompts-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/prompts/assembler.ts` | assemblePrompt, buildIdentitySection, buildEnvironmentSection, buildRoleSection, buildLearnedBehaviorSection (+4) |

## Entry Points

Start here when exploring this area:

- **`assemblePrompt`** (Function) — `src/prompts/assembler.ts:3`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `assemblePrompt` | Function | `src/prompts/assembler.ts` | 3 |
| `buildIdentitySection` | Function | `src/prompts/assembler.ts` | 17 |
| `buildEnvironmentSection` | Function | `src/prompts/assembler.ts` | 24 |
| `buildRoleSection` | Function | `src/prompts/assembler.ts` | 33 |
| `buildLearnedBehaviorSection` | Function | `src/prompts/assembler.ts` | 41 |
| `buildSafetySection` | Function | `src/prompts/assembler.ts` | 49 |
| `buildToolingSection` | Function | `src/prompts/assembler.ts` | 57 |
| `buildMemorySection` | Function | `src/prompts/assembler.ts` | 65 |
| `render` | Function | `src/prompts/assembler.ts` | 66 |

## How to Explore

1. `gitnexus_context({name: "assemblePrompt"})` — see callers and callees
2. `gitnexus_query({query: "prompts"})` — find related execution flows
3. Read key files listed above for implementation details
