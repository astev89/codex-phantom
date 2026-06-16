# Governed Self-Evolution

Governed self-evolution lets Codex Phantom change its own behavior under explicit policy, audit, rollback, and operator-interruption controls. [ADR-0003](adr/0003-delegate-autonomous-assignments-and-self-evolution.md) extends the target model beyond proposal-only HITL: autonomous assignments may use delegated autonomous self-evolution when assignment policy grants `evolve` or higher authority.

The current implementation is still narrower than that target. Today, Codex Phantom can create auditable proposals, apply approved proposal-based operator-settings mutations through operator-authenticated APIs, and apply assignment-authorized autonomous operator-settings and assignment-policy mutations for `evolve` assignments. Prompt, memory policy, tool, role, project-file, and broader configuration mutation classes remain future work.

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

Current proposal apply support is intentionally narrow. Only `configuration` proposals with `proposedChange.operatorSettings` can apply. The mutation record captures `before`, `after`, and rollback metadata before the operator settings are changed. Prompt, memory policy, tool, role, project-file, and broader runtime configuration proposals remain auditable proposals until safe mutation classes are added for them.

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
        "notificationCadence": {
          "activeProgressIntervalMinutes": 45
        }
      }
    }
  }'
```

`configuration.assignment_policy` is not in the default assignment self-evolution allow-list. Operators must explicitly include it in `assignment.policy.selfEvolution.allowedMutationClasses`. Autonomous assignment-policy mutations may tune execution bounds and notification cadence, but they cannot change `assignmentPolicy.selfEvolution`; mutation authority cannot be widened through this adapter.

Roll back an applied autonomous mutation:

```bash
curl -X POST http://localhost:3210/admin/assignments/asgn_123/mutations/asgnmut_123/rollback \
  -H "Authorization: Bearer $OPERATOR_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"actor":"operator"}'
```

The default assignment self-evolution policy allows only low- or medium-risk `configuration.operator_settings` mutations, and only assignments at `evolve` authority may use it. Unsupported classes, disallowed classes, malformed settings, and malformed assignment-policy patches are rejected without changing state and are audited as failed autonomous mutation evidence when policy permits the attempt to reach the mutation executor.

## Planner-Driven Mutation Markers

Assignment wakeups may request one bounded autonomous mutation by returning a single-line marker:

```text
ASSIGNMENT_MUTATION: {"target":"configuration","mutationType":"operator_settings","rationale":"Slow down refresh while autonomous work is active.","proposedChange":{"operatorSettings":{"dashboardRefreshSeconds":12}}}
```

Planner-driven mutation still uses the assignment-authorized autonomous executor. The marker is bound to the current assignment and coordinator run id, uses `actor: "planner"`, and must pass the same `evolve` authority, self-evolution allow-list, risk, validation, ledger, and rollback evidence checks as the admin/internal apply route. Failed mutation attempts do not fail the wakeup; the autonomous mutation ledger owns the failure evidence.

This is not MCP write capability. MCP assignment mutation tooling remains read-only, and planner markers only cover mutation classes that already have built-in adapters and explicit assignment policy.

## Agent Tool

The in-process tool `self_evolution.propose` creates the same durable proposal record with `proposedBy: "agent"`. In the current implementation, it does not approve, apply, write files, change prompts, update config, or alter tool policy. Proposal apply/rollback and assignment-authorized autonomous apply/rollback remain operator-authenticated HTTP actions; read-only MCP assignment mutation tools remain read-only.
