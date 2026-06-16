# Governed Self-Evolution

Governed self-evolution lets Codex Phantom change its own behavior under explicit policy, audit, rollback, and operator-interruption controls. [ADR-0003](adr/0003-delegate-autonomous-assignments-and-self-evolution.md) extends the target model beyond proposal-only HITL: autonomous assignments may use delegated autonomous self-evolution when assignment policy grants `evolve` or higher authority.

The current implementation is still narrower than that target. Today, Codex Phantom can create auditable proposals, apply approved proposal-based operator-settings mutations through operator-authenticated APIs, and apply assignment-authorized autonomous operator-settings, assignment-policy, approved read-only tool-bundle enable, prompt runtime-guidance overlay, and memory policy runtime-bounds overlay mutations for `evolve` assignments. Role, project-file, broader prompt rewriting, broader memory mutation, and broader configuration mutation classes remain future work.

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

Current proposal apply support is intentionally narrow. Only `configuration` proposals with `proposedChange.operatorSettings` can apply. The mutation record captures `before`, `after`, and rollback metadata before the operator settings are changed. Prompt, memory policy, tool, role, project-file, and broader runtime configuration proposals remain auditable proposals until safe mutation classes are added for them. The assignment-authorized prompt runtime-guidance and memory policy runtime-bounds overlays described below are separate autonomous mutation paths and do not make prompt or memory-policy proposals directly apply-capable.

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

Roll back an applied autonomous mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/asgnmut_123/rollback \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actor":"operator"}'
```

The default assignment self-evolution policy allows only low- or medium-risk `configuration.operator_settings` mutations, and only assignments at `evolve` authority may use it. Unsupported classes, disallowed classes, malformed settings, malformed assignment-policy patches, unsafe tool-bundle enable attempts, malformed prompt runtime-guidance attempts, and malformed memory policy runtime-bounds attempts are rejected without changing state and are audited as failed autonomous mutation evidence when policy permits the attempt to reach the mutation executor.

## Planner-Driven Mutation Markers

Mutation-authorized assignment wakeups may request one bounded autonomous mutation by returning a single-line marker. The wakeup planner only advertises this marker to assignments with `autonomyLevel: "evolve"`, enabled self-evolution policy, and at least one allowed mutation class.

```text
ASSIGNMENT_MUTATION: {"target":"memory_policy","mutationType":"runtime_bounds","rationale":"Reduce memory context for this work.","proposedChange":{"memoryPolicy":{"memoryPerCategoryLimit":1,"memorySummaryLimit":1}}}
```

Planner-driven mutation still uses the assignment-authorized autonomous executor. The marker is bound to the current assignment and coordinator run id, uses `actor: "planner"`, and must pass the same `evolve` authority, self-evolution allow-list, risk, validation, ledger, and rollback evidence checks as the admin/internal apply route. This includes explicitly allow-listed `prompt.runtime_guidance` and `memory_policy.runtime_bounds` markers. Failed executor attempts do not fail the wakeup; the autonomous mutation ledger owns the failure evidence.

This is not MCP write capability. MCP assignment mutation tooling remains read-only, and planner markers only cover mutation classes that already have built-in adapters and explicit assignment policy.

## Agent Tool

The in-process tool `self_evolution.propose` creates the same durable proposal record with `proposedBy: "agent"`. In the current implementation, it does not approve, apply, write files, change prompts, update config, or alter tool policy. Proposal apply/rollback and assignment-authorized autonomous apply/rollback remain operator-authenticated HTTP actions; read-only MCP assignment mutation tools remain read-only.
