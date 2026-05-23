<!-- gitnexus:start -->

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **codex-phantom** (2370 symbols, 6616 relationships, 178 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource                                       | Use for                                  |
| ---------------------------------------------- | ---------------------------------------- |
| `gitnexus://repo/codex-phantom/context`        | Codebase overview, check index freshness |
| `gitnexus://repo/codex-phantom/clusters`       | All functional areas                     |
| `gitnexus://repo/codex-phantom/processes`      | All execution flows                      |
| `gitnexus://repo/codex-phantom/process/{name}` | Step-by-step execution trace             |

## Cross-Repo Groups

This repository is listed under GitNexus **group(s): phantoms** (see `~/.gitnexus/groups/`). For cross-repo analysis, use MCP tools `impact`, `query`, and `context` with `repo` set to `@<groupName>` or `@<groupName>/<memberPath>` (paths match keys in that group’s `group.yaml`). Use `group_list` / `group_sync` for membership and sync. From the terminal: `npx gitnexus group list`, `npx gitnexus group sync <name>`, `npx gitnexus group impact <name> --target <symbol> --repo <group-path>`.

## CLI

| Task                                         | Read this skill file                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md`       |
| Blast radius / "What breaks if I change X?"  | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?"             | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md`       |
| Rename / extract / split / refactor          | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md`     |
| Tools, resources, schema reference           | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md`           |
| Index, status, clean, wiki CLI commands      | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md`             |
| Work in the Server area (165 symbols)        | `.claude/skills/generated/server/SKILL.md`                  |
| Work in the Memory area (98 symbols)         | `.claude/skills/generated/memory/SKILL.md`                  |
| Work in the Channels area (85 symbols)       | `.claude/skills/generated/channels/SKILL.md`                |
| Work in the Tools area (39 symbols)          | `.claude/skills/generated/tools/SKILL.md`                   |
| Work in the Orchestration area (20 symbols)  | `.claude/skills/generated/orchestration/SKILL.md`           |
| Work in the Agent area (19 symbols)          | `.claude/skills/generated/agent/SKILL.md`                   |
| Work in the Platform area (17 symbols)       | `.claude/skills/generated/platform/SKILL.md`                |
| Work in the Chat area (16 symbols)           | `.claude/skills/generated/chat/SKILL.md`                    |
| Work in the Tests area (11 symbols)          | `.claude/skills/generated/tests/SKILL.md`                   |
| Work in the Mcp area (10 symbols)            | `.claude/skills/generated/mcp/SKILL.md`                     |
| Work in the Prompts area (9 symbols)         | `.claude/skills/generated/prompts/SKILL.md`                 |
| Work in the Scheduler area (9 symbols)       | `.claude/skills/generated/scheduler/SKILL.md`               |
| Work in the Self-evolution area (8 symbols)  | `.claude/skills/generated/self-evolution/SKILL.md`          |
| Work in the Cluster_29 area (6 symbols)      | `.claude/skills/generated/cluster-29/SKILL.md`              |

<!-- gitnexus:end -->
