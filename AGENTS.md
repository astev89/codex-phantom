# Repository Guidelines

## Project Structure & Module Organization

`codex-phantom` is a TypeScript ESM service for an autonomous agent runtime. Source lives in `src/`, grouped by runtime concern: `agent/`, `channels/`, `chat/`, `mcp/`, `memory/`, `orchestration/`, `platform/`, `scheduler/`, `server/`, `shared/`, and `tools/`. The entrypoint is `src/index.ts`.

Tests live in `tests/`, with shared fixtures in `tests/helpers.ts`. Operational docs live in `docs/`, deployment helpers in `scripts/`, and local runtime configuration starts from `.env.example`. Build output is emitted to `dist/`; do not edit it by hand.

## Build, Test, and Development Commands

- `npm install`: install the pinned Node dependencies.
- `cp .env.example .env`: create local configuration before running the service.
- `npm run dev`: run `src/index.ts` directly; defaults to `http://localhost:3210`.
- `npm run typecheck`: run strict TypeScript checks without emitting files.
- `npm test`: run all `node:test` suites in `tests/*.test.ts`.
- `npm run build`: compile production JavaScript into `dist/`.
- `npm start`: run the compiled production entrypoint.
- `docker compose up --build`: boot the app with Qdrant.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports, and explicit `.ts` extensions for local imports. Follow the existing two-space indentation, double-quoted strings, semicolons, and named exports where practical. Keep modules small and domain-focused; place shared primitives in `src/shared/` or `src/platform/` only when reused.

Name classes and types in `PascalCase`, functions and variables in `camelCase`, and test files as `*.test.ts`.

## Testing Guidelines

Tests use Node's built-in `node:test` runner with `node:assert/strict`. Add focused unit or integration coverage in `tests/`. Prefer temporary directories and fake adapters/transports over real external services. Run `npm run typecheck` and `npm test` before a PR; run `scripts/deployment-smoke.sh` after Docker, env, auth, persistence, or deployment changes.

## Development Wave Ledger

Use `docs/project-status.md` as the living project ledger for production readiness and Phantom-parity work.

Before starting a non-trivial development wave:

- Read `docs/project-status.md` to understand the current state, recent completed work, and the prioritized next-task queue.
- Check `docs/phantom-parity.md` when the work changes parity with the original Phantom project.
- If the task needs a multi-step plan, create or update a dated plan under `docs/superpowers/plans/` and link back to it from the ledger only when useful.

At the end of each development wave, after verification passes:

- Update `docs/project-status.md` with the latest date, branch, and verified commit.
- Move completed items into `Just Completed` and add the exact verification commands that passed.
- Refresh `Next Tasks` so the next agent can start from the real remaining risks, not stale review notes.
- Update `docs/phantom-parity.md` if matched, deferred, or intentionally divergent Phantom behavior changed.
- Keep the ledger concise; put implementation detail in plans, commits, tests, or linked docs.

## Commit & Pull Request Guidelines

Use atomic Conventional Commits, matching history such as `fix(server): bound request bodies` or `docs(ops): add living project status ledger`. Split unrelated changes before committing.

Never push directly to `main` or `dev`. Use explicit branch pushes only: `git push origin <branch>` or `git push -u origin <branch>`.

PRs should include a summary, linked issue or plan when available, verification commands, and screenshots or sample API output for console or endpoint changes.

## Agent-Specific Instructions

This repo is indexed by GitNexus. Before editing functions, classes, or methods, run impact analysis for the target symbol and report the blast radius. Before committing, run GitNexus change detection and confirm only expected symbols and flows changed.

When a wave changes production posture, operational behavior, or Phantom parity, do not stop at code and tests. Update the ledger and parity docs in the same wave so repo state remains reconstructable from committed files.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **codex-phantom** (1266 symbols, 2991 relationships, 109 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/codex-phantom/context` | Codebase overview, check index freshness |
| `gitnexus://repo/codex-phantom/clusters` | All functional areas |
| `gitnexus://repo/codex-phantom/processes` | All execution flows |
| `gitnexus://repo/codex-phantom/process/{name}` | Step-by-step execution trace |

## Cross-Repo Groups

This repository is listed under GitNexus **group(s): phantoms** (see `~/.gitnexus/groups/`). For blast radius across repository boundaries, use MCP tools `group_impact`, `group_sync`, `group_query`, `group_contracts`, `group_status`, and `group_list`. From the terminal: `npx gitnexus group list`, `npx gitnexus group sync <name>`, `npx gitnexus group impact <name> --target <symbol> --repo <group-path>`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
