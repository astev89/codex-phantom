# Docker Smoke Runbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the remaining P1 Docker smoke-script agenda into a safe, repeatable operator runbook.

**Architecture:** Keep this docs-only. Add one runbook that explains prerequisites, safety checks, command order, expected evidence, and ledger update rules. Update the living project ledger to point to the runbook instead of duplicating details.

**Tech Stack:** Markdown docs, existing Bash smoke scripts, Docker Compose.

---

### Task 1: Add Operator Runbook

**Files:**
- Create: `docs/deployment-smoke-runbook.md`

- [x] Document when to run `scripts/deployment-smoke.sh` versus `scripts/backup-restore-smoke.sh`.
- [x] Call out that backup/restore validation recreates the `codex-phantom-data` Docker volume.
- [x] Include environment variables required by Compose and the scripts.
- [x] Provide command blocks for preflight, deployment smoke, backup/restore smoke, and evidence collection.
- [x] Include failure handling and cleanup guidance.

### Task 2: Update Ledger

**Files:**
- Modify: `docs/project-status.md`

- [x] Add this docs wave under `Just Completed`.
- [x] Replace the loose Docker-smoke next-task bullets with a runbook-directed next task.
- [x] Keep the ledger concise and leave command detail in the runbook.

### Task 3: Verify Docs

**Files:**
- Read: `docs/deployment-smoke-runbook.md`
- Read: `docs/project-status.md`

- [x] Confirm the runbook mentions both smoke scripts, destructive-volume behavior, required env vars, and ledger update expectations.
- [x] Confirm the docs-only change does not require code tests.
