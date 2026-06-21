# Governed Self-Evolution

Governed self-evolution lets Codex Phantom change its own behavior under explicit policy, audit, rollback, and operator-interruption controls. [ADR-0003](adr/0003-delegate-autonomous-assignments-and-self-evolution.md) extends the target model beyond proposal-only HITL: autonomous assignments may use delegated autonomous self-evolution when assignment policy grants `evolve` or higher authority.

The current implementation is still narrower than that target. Today, Codex Phantom can create auditable proposals, apply approved proposal-based operator-settings mutations through operator-authenticated APIs, and apply assignment-authorized autonomous operator-settings, assignment-policy, runtime config-limits overlay, approved read-only tool-bundle enable, prompt runtime-guidance overlay, managed prompt fragments, memory policy runtime-bounds overlay, memory entry lifecycle changes, role permission-policy overlay, project-file draft-record mutations, high-risk single-draft project-file apply mutations, high-risk patch-draft/apply-patch mutations, and high-risk draft-bundle project-file apply mutations for `evolve` assignments. Unrestricted filesystem mutation, source-file prompt rewrites, secret/auth mutation, package installs, git staging/commit/push mutation, MCP write capability, and broader configuration beyond the explicit adapters remain future work or out of scope.

## Proposal Scope

Supported proposal targets:

- `prompt`
- `memory_policy`
- `tool`
- `role`
- `configuration`

Every proposal records a title, rationale, risk class, structured proposed change metadata, optional operator/agent identity, and timestamps. Risk classes are `low`, `medium`, `high`, and `critical`.

Direct proposal mutation remains out of scope. Proposal payloads that request immediate apply behavior, such as `applyNow: true` or `mutationMode: "direct"`, are rejected because proposal review/apply remains separate from assignment-scoped delegated mutation.

## Operator APIs

Create a proposal:

```bash
curl -X POST http://localhost:3210/admin/self-evolution/proposals \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "role",
    "title": "Allow verifier docs reads",
    "rationale": "Verifier agents need docs context for parity checks.",
    "riskClass": "medium",
    "proposedChange": {
      "summary": "Add docs/**/* to verifier file globs.",
      "fileGlobs": ["src/**/*", "tests/**/*", "docs/**/*"]
    }
  }'
```

List recent proposals:

```bash
curl http://localhost:3210/admin/self-evolution/proposals \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN"
```

Proposals also appear in `/admin/summary`, `/admin/timeline`, and `/admin/export?scope=governance`.

Review a proposal:

```bash
curl -X POST http://localhost:3210/admin/self-evolution/proposals/sep_123/approve \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reviewedBy":"operator","notes":"Safe operator settings change."}'
```

Apply an approved proposal:

```bash
curl -X POST http://localhost:3210/admin/self-evolution/proposals/sep_123/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"appliedBy":"operator"}'
```

High- and critical-risk proposals require an explicit confirmation flag:

```json
{ "appliedBy": "operator", "confirmHighRisk": true }
```

Rollback an applied proposal:

```bash
curl -X POST http://localhost:3210/admin/self-evolution/proposals/sep_123/rollback \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rolledBackBy":"operator"}'
```

Current proposal apply support is intentionally narrow. Only `configuration` proposals with `proposedChange.operatorSettings` can apply. The mutation record captures `before`, `after`, and rollback metadata before the operator settings are changed. Prompt, memory policy, tool, role, project-file, and broader runtime configuration proposals remain auditable proposals until safe proposal mutation classes are added for them. The assignment-authorized runtime config-limits, prompt runtime-guidance, managed prompt-fragment, memory policy runtime-bounds, memory entry-lifecycle, role permission-policy, and project-file draft/apply paths described below are separate autonomous mutation paths and do not make proposals directly apply-capable.

Apply and rollback execution lives behind the self-evolution mutation module. HTTP routes validate operator requests and serialize responses; target adapters own mutation validation, before/after/rollback payload construction, failure audit, and rollback effects.

## Assignment-Authorized Autonomous Apply

Autonomous assignments with `autonomyLevel: "evolve"` can apply bounded delegated mutation classes through assignment admin APIs. This path is separate from proposal apply and writes to the autonomous mutation ledger, not the proposal mutation table.

Apply an autonomous operator-settings mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "configuration",
    "mutationType": "operator_settings",
    "rationale": "Slow down operator-console refresh while autonomous work is active.",
    "proposedChange": {
      "operatorSettings": { "dashboardRefreshSeconds": 12 }
    }
  }'
```

Apply an explicitly allowed assignment-policy mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "configuration",
    "mutationType": "assignment_policy",
    "rationale": "Give this long-running assignment a wider wakeup budget.",
    "proposedChange": {
      "assignmentPolicy": {
        "maxWakeups": 8,
        "wakeupDelayMinMinutes": 10,
        "wakeupDelayMaxMinutes": 120,
        "childAssignments": {
          "maxDepth": 2,
          "maxActiveChildren": 2
        },
        "notificationCadence": {
          "activeProgressIntervalMinutes": 45
        }
      }
    }
  }'
```

`configuration.assignment_policy` is not in the default assignment self-evolution allow-list. Operators must explicitly include it in `assignment.policy.selfEvolution.allowedMutationClasses`. Autonomous assignment-policy mutations may tune execution bounds and notification cadence, but they cannot change `assignmentPolicy.selfEvolution`; mutation authority cannot be widened through this adapter.

Apply an explicitly allowed runtime config-limits mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "configuration",
    "mutationType": "runtime_limits",
    "riskClass": "medium",
    "rationale": "Allow a longer autonomous run budget for this assignment.",
    "proposedChange": {
      "runtimeLimits": {
        "defaultRunTimeoutMs": 45000,
        "defaultMaxToolCalls": 9
      }
    }
  }'
```

`configuration.runtime_limits` is not in the default assignment self-evolution allow-list. Operators must explicitly include it in `assignment.policy.selfEvolution.allowedMutationClasses`. The adapter is classified as at least medium risk by the executor even if a caller omits or understates `riskClass`, so assignments with `maxRiskClass: "low"` cannot apply it. It updates only a durable sparse numeric runtime config overlay for fields that existing runtime components read from the shared config object during normal execution: `defaultRunTimeoutMs` (`1000..300000`), `defaultMaxToolCalls` (`1..50`), `openAiRequestTimeoutMs` (`1000..300000`), `emailPollIntervalMs` (`1000..3600000`), `emailPollBatchSize` (`1..100`), and `emailMaxMessageBytes` (`1024..10485760`). Unchanged fields continue to resolve from startup/env config rather than being persisted as sibling overlay values. It records before/after/rollback evidence in the autonomous mutation ledger, restores the prior overlay state on rollback including deleting the overlay row when there was no prior overlay, preserves env-derived startup values until an overlay is explicitly applied, and blocks stale rollback across assignments because the overlay is shared runtime configuration. It does not edit secrets, auth tokens, model names, base URLs, file paths, channel enablement, prompts, memory entries, tools, roles, project files, source files, install state, MCP write capability, or runtime fields captured by already-created transports/services such as embedding timeout, Qdrant timeout, SMTP send timeout, or IMAP attachment size.

Apply an explicitly allowed channel-state mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "configuration",
    "mutationType": "channel_state",
    "riskClass": "high",
    "rationale": "Pause noisy webhook intake while the provider is degraded.",
    "proposedChange": {
      "channelState": {
        "channelId": "webhook",
        "enabled": false
      }
    }
  }'
```

`configuration.channel_state` is explicit opt-in and is treated as high risk. It can only enable or disable a known runtime channel through `proposedChange.channelState: { channelId, enabled }`, rejects unknown channel ids, rejects enabling a channel whose required provider config or secrets are absent, rejects secret/config edits, and records before/after/rollback evidence for the channel enabled state. It updates the durable channel registry and invokes the existing runtime channel lifecycle hook so live channel workers such as email polling are started or stopped consistently with normal admin channel updates. Admin summary and readiness surfaces reflect the changed registry state. Rollback restores the prior enabled state, and stale rollback is scoped to later mutations touching the same channel.

Apply an explicitly allowed tool-bundle enable mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "tool",
    "mutationType": "bundle_enable",
    "rationale": "Make an already-approved read-only internal tool bundle available.",
    "proposedChange": {
      "toolBundle": { "importId": "tbi_123" }
    }
  }'
```

`tool.bundle_enable` is not in the default assignment self-evolution allow-list. Operators must explicitly include it in `assignment.policy.selfEvolution.allowedMutationClasses`, and the target bundle must already be a valid, approved internal tool-bundle import. This adapter does not preview, approve, install arbitrary files, enable write-scoped tools, or add MCP write capability. Rollback disables the same bundle and unregisters its dynamic tools.

Apply an explicitly allowed prompt runtime-guidance overlay mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "prompt",
    "mutationType": "runtime_guidance",
    "rationale": "Prefer evidence-first wakeup summaries.",
    "proposedChange": {
      "runtimeGuidance": {
        "text": "Prefer evidence-first wakeup summaries."
      }
    }
  }'
```

`prompt.runtime_guidance` is not in the default assignment self-evolution allow-list. Operators must explicitly include it in `assignment.policy.selfEvolution.allowedMutationClasses`. The adapter writes a single bounded runtime guidance overlay that is appended to assembled system prompts, records before/after/rollback evidence in the autonomous mutation ledger, and rolls back to the previous overlay text. It does not rewrite bundled role prompts, edit prompt source files, or create write-capable MCP tooling.

`prompt.managed_fragment` is also explicit opt-in and is treated as high risk. It upserts or clears a named runtime prompt fragment through `proposedChange.promptFragment: { id, mode: "upsert" | "clear", text? }`, assembles active fragments in deterministic id order after runtime guidance, and records exact active, inactive, or absent rollback evidence. It does not rewrite prompt source files or grant MCP write capability.

Apply an explicitly allowed memory policy runtime-bounds overlay mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "memory_policy",
    "mutationType": "runtime_bounds",
    "rationale": "Reduce memory retrieval context for autonomous work.",
    "proposedChange": {
      "memoryPolicy": {
        "memoryPerCategoryLimit": 1,
        "memorySummaryLimit": 1
      }
    }
  }'
```

`memory_policy.runtime_bounds` is not in the default assignment self-evolution allow-list. Operators must explicitly include it in `assignment.policy.selfEvolution.allowedMutationClasses`. The adapter updates only a durable numeric policy overlay used by memory retrieval and scheduled maintenance bounds: top-k retrieval (`1..50`), per-category retrieval (`1..20`), summary limits (`0..20`), summary trigger/cluster size (`2..50`, with cluster size no greater than trigger count), and semantic/procedural/episodic prune limits (`10..500`). It records before/after/rollback evidence in the autonomous mutation ledger, restores prior bounds on rollback, repairs invalid persisted policy rows before runtime use, and blocks stale rollback across assignments because the overlay is a shared runtime resource. It does not create, delete, rewrite, reinforce, supersede, contradict, or re-embed memory entries; it does not edit vector stores, memory source files, prompt text, role policy, runtime source files, or MCP tooling.

`memory.entry_lifecycle` is explicit opt-in and high risk. It supports bounded `create`, `deactivate`, and `supersede` actions through `proposedChange.memoryEntry`, limited to safe `episodic`, `semantic`, or `procedural` text and metadata. Retrieval excludes deactivated or superseded rows through the normal memory lifecycle filters, and rollback deletes created rows or restores the prior lifecycle state for affected rows. It does not mutate secrets, prompt source files, runtime source files, MCP write tools, package installs, git state, or vector-store credentials.

Apply an explicitly allowed role permission-policy overlay mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "role",
    "mutationType": "permission_policy",
    "rationale": "Limit explorer subagents to docs reads for this assignment.",
    "proposedChange": {
      "rolePolicy": {
        "roles": {
          "explorer": {
            "fileGlobs": ["docs/**/*"],
            "allowedToolIds": ["echo.summary"],
            "allowedMcpServers": ["docs"]
          }
        }
      }
    }
  }'
```

`role.permission_policy` is not in the default assignment self-evolution allow-list. Operators must explicitly include it in `assignment.policy.selfEvolution.allowedMutationClasses`. The adapter writes a durable runtime role-policy overlay for known subagent roles only: `explorer`, `builder`, `verifier`, and `researcher`. Autonomous role-policy mutations can only narrow permissions relative to the loaded startup YAML or compiled role baseline. They cannot grant `full_access`, introduce unknown roles, add new tool ids, add new MCP servers, or broaden scoped-write file globs. New subagent spawns read the current effective overlay without requiring a restart. Rollback restores the previous overlay and stale rollback is blocked across assignments because role policy is shared runtime state. This does not edit `config/roles.yaml`, source files, prompts, memory entries, tool bundles, auth, channel policy, or MCP write capability.

Apply an explicitly allowed project-file draft mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "project_file",
    "mutationType": "draft",
    "rationale": "Draft a documentation update for operator review.",
    "proposedChange": {
      "projectFileDraft": {
        "path": "docs/example.md",
        "content": "# Example\n",
        "contentType": "text/markdown"
      }
    }
  }'
```

`project_file.draft` is not in the default assignment self-evolution allow-list. Operators must explicitly include it in `assignment.policy.selfEvolution.allowedMutationClasses`. The adapter creates a durable assignment-owned project-file draft record with path, safe text content, content type, byte size, SHA-256, assignment/run linkage, and rollback evidence. It rejects absolute paths, parent traversal, protected/generated locations such as `.git`, `.env`, `node_modules`, `dist`, and `coverage`, unsafe content types, empty content, and content over 200 KB. Rollback marks the draft `rolled_back` while preserving the audit row and draft content. This does not write to the repository filesystem, apply patches, stage files, commit changes, install packages, or create MCP write capability.

Create an explicitly allowed project-file patch draft:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "project_file",
    "mutationType": "patch_draft",
    "riskClass": "high",
    "rationale": "Draft a bounded documentation patch for operator review.",
    "proposedChange": {
      "projectFilePatchDraft": {
        "patch": "--- a/docs/example.md\n+++ b/docs/example.md\n@@ -1,1 +1,2 @@\n # Example\n+Updated by autonomous patch draft.\n"
      }
    }
  }'
```

`project_file.patch_draft` is not in the default assignment self-evolution allow-list. Operators must explicitly include it in `assignment.policy.selfEvolution.allowedMutationClasses`, and the executor classifies it as high risk. The adapter creates a durable assignment-owned patch draft record containing a bounded unified diff, byte size, SHA-256, assignment/run linkage, and rollback evidence. It rejects absolute paths, parent traversal, protected/generated locations, quoted or binary patches, deletes, renames, duplicate paths, malformed hunk counts, patches over 200 KB, and patches touching more than 10 files. Rollback marks the patch draft `rolled_back` while preserving the audit row and patch text. This does not write to the repository filesystem, stage files, commit changes, install packages, or create MCP write capability.

Apply an explicitly allowed project-file draft to the repository filesystem:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "project_file",
    "mutationType": "apply_draft",
    "riskClass": "high",
    "rationale": "Apply the reviewed documentation draft.",
    "proposedChange": {
      "projectFileApply": {
        "draftId": "pfd_123"
      }
    }
  }'
```

`project_file.apply_draft` is not in the default assignment self-evolution allow-list. Operators must explicitly include it in `assignment.policy.selfEvolution.allowedMutationClasses`, and the executor classifies it as at least high risk even if the caller omits or understates `riskClass`. The adapter applies only an existing active project-file draft owned by the same assignment. It writes exactly that draft's already-validated safe text content to the draft's normalized relative path under the repository root, rejects symlinked path components, records before/after/rollback evidence in the autonomous mutation ledger, marks the draft `applied`, and blocks stale rollback when a newer project-file apply mutation exists. Rollback restores the exact previous file bytes when the file already existed or deletes the file when apply created it, then marks the draft active again. This does not apply arbitrary inline content, apply patches, mutate multiple files, stage files, commit changes, push branches, install packages, edit protected/generated locations, follow symlinks, or create MCP write capability.

Apply an explicitly allowed project-file patch draft to the repository filesystem:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "project_file",
    "mutationType": "apply_patch",
    "riskClass": "high",
    "rationale": "Apply the reviewed bounded patch draft.",
    "proposedChange": {
      "projectFilePatchApply": {
        "draftId": "pfp_123"
      }
    }
  }'
```

`project_file.apply_patch` is not in the default assignment self-evolution allow-list. Operators must explicitly include it in `assignment.policy.selfEvolution.allowedMutationClasses`, and the executor classifies it as high risk. The adapter applies only an existing active project-file patch draft owned by the same assignment. It reparses the stored unified diff, validates every target path, rejects symlinked path components and binary existing files, requires context lines to match exact current file contents, writes only the patch target files, records per-file before/after/rollback byte evidence in the autonomous mutation ledger, and marks the patch draft `applied`. If a later file write fails, earlier writes in the same apply are rolled back before the failed ledger record is stored. Rollback restores exact previous file bytes or deletes files created by the patch, then marks the patch draft active again. This does not accept inline apply content, stage files, commit changes, push branches, install packages, edit protected/generated locations, follow symlinks, or create MCP write capability.

Apply an explicitly allowed project-file draft bundle to the repository filesystem:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/apply \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "project_file",
    "mutationType": "apply_bundle",
    "riskClass": "high",
    "rationale": "Apply coordinated reviewed documentation drafts.",
    "proposedChange": {
      "projectFileBundle": {
        "draftIds": ["pfd_123", "pfd_456"]
      }
    }
  }'
```

`project_file.apply_bundle` is not in the default assignment self-evolution allow-list. Operators must explicitly include it in `assignment.policy.selfEvolution.allowedMutationClasses`, and the executor classifies it as at least high risk even if the caller omits or understates `riskClass`. The adapter applies only 1 to 10 existing active project-file drafts owned by the same assignment. It validates every draft id and rejects duplicate paths before writing, applies each draft through the same real-root and symlink-safe filesystem applier as `project_file.apply_draft`, records per-file before/after/rollback byte evidence in the autonomous mutation ledger, marks all bundle drafts `applied`, and rolls back any earlier writes if a later write fails. Rollback restores exact previous file bytes or deletes files created by the bundle, then marks every bundle draft active again. This does not apply arbitrary inline content, parse patches, stage files, commit changes, push branches, install packages, edit protected/generated locations, follow symlinks, or create MCP write capability.

Roll back an applied autonomous mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/asgnmut_123/rollback \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actor":"operator"}'
```

The default assignment self-evolution policy allows only low- or medium-risk `configuration.operator_settings` mutations, and only assignments at `evolve` authority may use it. Unsupported classes, disallowed classes, malformed settings, malformed assignment-policy patches, malformed runtime config-limits attempts, unsafe channel-state attempts, unsafe tool-bundle enable attempts, malformed prompt runtime-guidance attempts, malformed memory policy runtime-bounds attempts, malformed memory entry lifecycle attempts, malformed or widening role permission-policy attempts, unsafe project-file draft attempts, unsafe project-file patch attempts, and unsafe project-file apply attempts are rejected without changing state and are audited as failed autonomous mutation evidence when policy permits the attempt to reach the mutation executor.

## Planner-Driven Mutation Markers

Mutation-authorized assignment wakeups may request one bounded autonomous mutation by returning a single-line marker. The wakeup planner only advertises this marker to assignments with `autonomyLevel: "evolve"`, enabled self-evolution policy, and at least one allowed mutation class.

```text
ASSIGNMENT_MUTATION: {"target":"configuration","mutationType":"channel_state","riskClass":"high","rationale":"Pause noisy webhook intake.","proposedChange":{"channelState":{"channelId":"webhook","enabled":false}}}
```

Planner-driven mutation still uses the assignment-authorized autonomous executor. The marker is bound to the current assignment and coordinator run id, uses `actor: "planner"`, and must pass the same `evolve` authority, self-evolution allow-list, risk, validation, ledger, and rollback evidence checks as the admin/internal apply route. This includes explicitly allow-listed `configuration.runtime_limits`, `configuration.channel_state`, `prompt.runtime_guidance`, `prompt.managed_fragment`, `memory.entry_lifecycle`, `memory_policy.runtime_bounds`, `role.permission_policy`, `project_file.draft`, `project_file.apply_draft`, `project_file.patch_draft`, `project_file.apply_patch`, and `project_file.apply_bundle` markers. Failed executor attempts do not fail the wakeup; the autonomous mutation ledger owns the failure evidence.

This is not MCP write capability. MCP assignment mutation tooling remains read-only, and planner markers only cover mutation classes that already have built-in adapters and explicit assignment policy.

## Agent Tool

The in-process tool `self_evolution.propose` creates the same durable proposal record with `proposedBy: "agent"`. In the current implementation, it does not approve, apply, write files, change prompts, update config, or alter tool policy. Proposal apply/rollback and assignment-authorized autonomous apply/rollback remain operator-authenticated HTTP actions; read-only MCP assignment mutation tools remain read-only.
